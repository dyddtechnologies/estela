import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createMessage, type MessageHeaders } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import { SagaUsageError, type ErrorClassifier } from './concurrency-errors';
import {
  IdempotencyInProgressError,
  type IdempotencyLedger,
  type LedgerClaim,
} from './idempotency-ledger';
import type { LockPort, LockRequest } from './lock-port';
import type { RetryPolicy } from './retry-policy';
import type { SagaDefinition, SagaStep, TransactionStep } from './saga';
import { validateLockDeclaration, validateRetryPolicy } from './saga-definition';
import { SagaTracer } from './saga-tracer';
import {
  declaresLocks,
  DEFAULT_MAX_LOCKS_PER_UNIT,
  resolveLocks,
  segmentsOf,
  type TransactionSegment,
} from './segments';
import type { TransactionPort } from './transaction-port';
import {
  UnitOfWorkExecutor,
  unitOfWorkScope,
  type AfterCommitErrorInfo,
  type RunState,
  type UnitPlan,
} from './unit-of-work';

export type { AfterCommitErrorInfo } from './unit-of-work';

export interface SagaRunnerOptions<Tx> {
  transactions: TransactionPort<Tx>;
  /** Without a ledger, `idempotent(...)` keys are ignored. */
  ledger?: IdempotencyLedger<Tx>;
  /** Optional hop logging: one line per saga and per step, like flows. */
  logger?: HopLogger;
  /** Required when a definition declares locks (SagaUsageError at run(), before any tx). */
  locks?: LockPort<Tx>;
  /** Overrides transactions.classify. Order: Estela typed errors, then this, then transactions.classify. */
  classifyError?: ErrorClassifier;
  /** Called when an afterCommit callback throws; its own throw is caught and logged. */
  onAfterCommitError?: (error: unknown, info: AfterCommitErrorInfo) => void;
  /** Most lock requests one unit of work may resolve (after dedupe); default 64. Above it the run
   *  fails with SagaUsageError before the transaction: every Postgres advisory lock takes a slot
   *  in the server-wide shared lock table. */
  maxLocksPerUnit?: number;
  /** Test seam; default node:timers/promises setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam; default node:crypto randomInt. */
  random?: (maxExclusive: number) => number;
}

export interface SagaRunOptions {
  correlationId?: string;
}

type OutboundSagaStep<Ctx, Tx> = Extract<SagaStep<Ctx, Tx>, { kind: 'outbound' }>;

interface RunContext<Ctx, Tx, Reply> {
  definition: SagaDefinition<Ctx, Tx, Reply>;
  /** The definition's policy, re-validated at run(): a definition may be a plain object. */
  retry: Readonly<RetryPolicy<Ctx>> | undefined;
  ctx: Ctx;
  state: RunState<Reply>;
  headers: MessageHeaders;
}

const DATABASE_KINDS = ['lock-timeout', 'deadlock', 'serialization'];

/**
 * Runs saga definitions against the app's transaction port. One run walks its segments in order:
 * a transaction segment runs all its steps in one transaction; an outbound segment runs outside
 * any transaction and, when it fails, its `compensate` runs in a new one.
 *
 * Idempotency: the key is claimed inside the first unit of work and the reply is recorded inside
 * the last one when the saga ends with a transaction segment (otherwise in a short extra one), so
 * the ledger row and the saga's writes commit together. A failure after an outbound step has
 * succeeded is not compensated, because its external effect already happened.
 *
 * Concurrency: inside every unit of work the claim comes first, then all locks of the unit in
 * canonical order, then the steps. Under a retry policy a failed unit of work is re-run with ctx
 * and the claim state restored; a committed unit and an outbound step are never re-run.
 */
export class SagaRunner<Tx = unknown> {
  private readonly tracer: SagaTracer;
  private readonly units: UnitOfWorkExecutor<Tx>;

  private readonly maxLocksPerUnit: number;

  constructor(private readonly options: SagaRunnerOptions<Tx>) {
    const max = options.maxLocksPerUnit ?? DEFAULT_MAX_LOCKS_PER_UNIT;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new TypeError(`maxLocksPerUnit must be a positive integer, got ${String(max)}`);
    }
    this.maxLocksPerUnit = max;
    this.tracer = new SagaTracer(options.logger);
    this.units = new UnitOfWorkExecutor<Tx>({
      transactions: options.transactions,
      tracer: this.tracer,
      sleep: options.sleep ?? ((ms) => delay(ms)),
      random: options.random ?? ((max) => randomInt(max)),
      ...(options.locks === undefined ? {} : { locks: options.locks }),
      ...(options.classifyError === undefined ? {} : { classifyError: options.classifyError }),
      ...(options.onAfterCommitError === undefined
        ? {}
        : { onAfterCommitError: options.onAfterCommitError }),
    });
  }

  async run<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    ctx: Ctx,
    runOptions: SagaRunOptions = {},
  ): Promise<Reply> {
    const retry = this.assertRunnable(definition);
    const headers = this.traceHeaders(runOptions);
    const channel = `saga:${definition.name}`;
    const started = Date.now();
    this.options.logger?.flowStart(definition.name, channel, headers);
    try {
      const reply = await this.walk(definition, retry, ctx, headers);
      this.options.logger?.flowEnd(
        definition.name,
        channel,
        headers,
        'completed',
        Date.now() - started,
      );
      return reply;
    } catch (error) {
      this.options.logger?.flowEnd(
        definition.name,
        channel,
        headers,
        'failed',
        Date.now() - started,
      );
      throw error;
    }
  }

  /** Fail-fast misuse checks, before any transaction starts. Returns the validated policy. */
  private assertRunnable<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
  ): Readonly<RetryPolicy<Ctx>> | undefined {
    const retry =
      definition.retry === undefined
        ? undefined
        : validateRetryPolicy(definition.name, definition.retry);
    const hasLocks = this.assertLocks(definition);
    const scope = unitOfWorkScope.getStore();
    if (
      scope !== undefined &&
      (scope.holdsLocks || scope.retries || hasLocks || retry !== undefined)
    ) {
      throw new SagaUsageError(
        `saga "${definition.name}" started inside a unit of work that holds locks or uses retry`,
      );
    }
    if (retry !== undefined) this.assertRetryable(definition, retry);
    return retry;
  }

  /** Re-validates lock declarations (a definition may be a plain object). True when any exists. */
  private assertLocks<Ctx, Reply>(definition: SagaDefinition<Ctx, Tx, Reply>): boolean {
    for (const step of definition.steps) {
      if (step.kind !== 'transaction') continue;
      for (const lock of step.locks ?? []) {
        validateLockDeclaration(
          definition.name,
          lock.namespace,
          lock.keyOf,
          lock.mode,
          lock.timeoutMs,
        );
      }
    }
    const hasLocks = declaresLocks(definition.steps);
    if (hasLocks && this.options.locks === undefined) {
      throw new SagaUsageError(
        `saga "${definition.name}" declares locks but the runner has no LockPort (options.locks)`,
      );
    }
    return hasLocks;
  }

  private assertRetryable<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    retry: Readonly<RetryPolicy<Ctx>>,
  ): void {
    const needsClassifier = retry.on.some((kind) => DATABASE_KINDS.includes(kind));
    const hasClassifier =
      this.options.classifyError !== undefined || this.options.transactions.classify !== undefined;
    if (needsClassifier && !hasClassifier) {
      throw new SagaUsageError(
        `saga "${definition.name}" retries database errors but no classifier is configured (transactions.classify or classifyError)`,
      );
    }
    // A claim that survives a rollback would turn attempt 2 into in-progress or a false replay.
    if (definition.idempotencyKey !== undefined && this.options.ledger?.transactional === false) {
      throw new SagaUsageError(
        `saga "${definition.name}" uses retry with a ledger that is not transactional (e.g. MemoryIdempotencyLedger); use a ledger bound to the transaction`,
      );
    }
  }

  private async walk<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    retry: Readonly<RetryPolicy<Ctx>> | undefined,
    ctx: Ctx,
    headers: MessageHeaders,
  ): Promise<Reply> {
    const segments = segmentsOf(definition.steps);
    const key = this.options.ledger === undefined ? undefined : definition.idempotencyKey?.(ctx);
    const state: RunState<Reply> = key === undefined ? { claimed: false } : { key, claimed: false };
    const run: RunContext<Ctx, Tx, Reply> = { definition, retry, ctx, state, headers };
    let reply: { value: Reply } | undefined;
    let lastLocks: readonly LockRequest[] = [];

    for (const [index, segment] of segments.entries()) {
      if (segment.kind === 'outbound') {
        await this.runOutbound(run, segment.step, lastLocks, index);
        continue;
      }
      const locks = resolveLocks(definition.name, segment.locks, ctx, this.maxLocksPerUnit);
      lastLocks = locks;
      const isLast = index === segments.length - 1;
      reply = await this.runUnitOfWork(run, segment, locks, index, isLast);
      if (state.replay !== undefined) return state.replay.response;
    }
    if (reply !== undefined) return reply.value;
    return this.finishAfterOutbound(run);
  }

  /** `beforeAnyEffect`: no unit committed and no outbound step ran yet (tx#0, the first claim). */
  private plan<Ctx, Reply>(
    run: RunContext<Ctx, Tx, Reply>,
    label: string,
    locks: readonly LockRequest[],
    beforeAnyEffect = false,
  ): UnitPlan<Ctx> {
    return {
      saga: run.definition.name,
      ctx: run.ctx,
      state: run.state,
      headers: run.headers,
      label,
      locks,
      retry: run.retry,
      strictCheckpoint: beforeAnyEffect,
    };
  }

  private async runUnitOfWork<Ctx, Reply>(
    run: RunContext<Ctx, Tx, Reply>,
    segment: TransactionSegment<Ctx, Tx>,
    locks: readonly LockRequest[],
    index: number,
    isLast: boolean,
  ): Promise<{ value: Reply } | undefined> {
    const { definition, ctx, state, headers } = run;
    const plan = this.plan(run, `tx#${index}`, locks, index === 0);
    return this.units.execute(plan, async (tx, unit, acquire) => {
      // Claim first: a replay or an in-progress duplicate never takes or waits on a lock.
      if (!(await this.claimOnce(definition.name, tx, state))) return undefined;
      await acquire();
      for (const step of segment.steps) {
        await this.tracer.traced(definition.name, `transaction:${step.name}`, headers, () =>
          step.run(ctx, tx, unit),
        );
      }
      if (!isLast) return undefined;
      const value = definition.reply(ctx);
      await this.recordIfClaimed(definition.name, tx, state, value);
      return { value };
    });
  }

  private async runOutbound<Ctx, Reply>(
    run: RunContext<Ctx, Tx, Reply>,
    step: OutboundSagaStep<Ctx, Tx>,
    lastLocks: readonly LockRequest[],
    index: number,
  ): Promise<void> {
    const { definition, ctx, state, headers } = run;
    if (state.key !== undefined && !state.claimed) {
      // A saga that opens with an outbound step still claims its key before calling out.
      await this.units.execute(this.plan(run, `claim#${index}`, [], index === 0), (tx) =>
        this.claimOnce(definition.name, tx, state),
      );
      if (state.replay !== undefined) return;
    }
    try {
      await this.tracer.traced(definition.name, `outbound:${step.name}`, headers, () =>
        step.run(ctx),
      );
    } catch (error) {
      const locks = step.compensateLocks === 'none' ? [] : lastLocks;
      await this.compensate(run, step.compensate, locks, `compensate#${index}`);
      throw error;
    }
  }

  private async compensate<Ctx, Reply>(
    run: RunContext<Ctx, Tx, Reply>,
    compensate: TransactionStep<Ctx, Tx> | undefined,
    inheritedLocks: readonly LockRequest[],
    label: string,
  ): Promise<void> {
    const { definition, ctx, state } = run;
    if (compensate === undefined && !state.claimed) return;
    // Locks protect the compensation's own writes; a bare ledger release needs none.
    const locks = compensate === undefined ? [] : inheritedLocks;
    await this.units.execute(this.plan(run, label, locks), async (tx, unit, acquire) => {
      await acquire();
      if (compensate !== undefined) await compensate(ctx, tx, unit);
      if (state.claimed && state.key !== undefined) {
        await this.options.ledger?.release(tx, definition.name, state.key);
      }
    });
  }

  private async finishAfterOutbound<Ctx, Reply>(run: RunContext<Ctx, Tx, Reply>): Promise<Reply> {
    const { definition, ctx, state } = run;
    if (state.replay !== undefined) return state.replay.response;
    const value = definition.reply(ctx);
    if (state.claimed) {
      await this.units.execute(this.plan(run, 'record', []), (tx) =>
        this.recordIfClaimed(definition.name, tx, state, value),
      );
    }
    return value;
  }

  /** Claims the key once per run. Returns false when the run must stop and replay instead. */
  private async claimOnce<Reply>(
    sagaName: string,
    tx: Tx,
    state: RunState<Reply>,
  ): Promise<boolean> {
    const ledger = this.options.ledger;
    if (ledger === undefined || state.key === undefined || state.claimed) return true;
    const claim: LedgerClaim = await ledger.claim(tx, sagaName, state.key);
    if (claim.status === 'in-progress') throw new IdempotencyInProgressError(sagaName, state.key);
    if (claim.status === 'replay') {
      state.replay = { response: claim.response as Reply };
      return false;
    }
    state.claimed = true;
    return true;
  }

  private async recordIfClaimed<Reply>(
    sagaName: string,
    tx: Tx,
    state: RunState<Reply>,
    value: Reply,
  ): Promise<void> {
    if (state.claimed && state.key !== undefined) {
      await this.options.ledger?.record(tx, sagaName, state.key, value);
    }
  }

  private traceHeaders(runOptions: SagaRunOptions): MessageHeaders {
    const init =
      runOptions.correlationId === undefined ? {} : { correlationId: runOptions.correlationId };
    return createMessage(null, init).headers;
  }
}
