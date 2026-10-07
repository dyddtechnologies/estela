import { AsyncLocalStorage } from 'node:async_hooks';
import type { MessageHeaders } from '../message';
import {
  ConcurrencyError,
  isDatabaseErrorKind,
  SagaUsageError,
  toConcurrencyError,
  type ConcurrencyErrorKind,
  type ErrorClassifier,
} from './concurrency-errors';
import { IdempotencyInProgressError } from './idempotency-ledger';
import type { LockPort, LockRequest } from './lock-port';
import { checkpointOf, delayFor, type RetryPolicy } from './retry-policy';
import type { UnitOfWork } from './saga';
import type { SagaTracer } from './saga-tracer';
import { IllegalTransitionError } from './state-machine';
import type { TransactionPort } from './transaction-port';
import { TransitionOutcomeUnknownError } from './transition';

/** Idempotency state of one run. Tentative per attempt: reverted when an attempt rolls back. */
export interface RunState<Reply> {
  key?: string;
  claimed: boolean;
  replay?: { response: Reply } | undefined;
}

/** Marks code running inside an Estela unit of work (guards nested sagas). */
export const unitOfWorkScope = new AsyncLocalStorage<{ holdsLocks: boolean; retries: boolean }>();

export interface AfterCommitErrorInfo {
  saga: string;
  unit: string;
  index: number;
  correlationId: string;
}

export interface UnitOfWorkDeps<Tx> {
  transactions: TransactionPort<Tx>;
  locks?: LockPort<Tx>;
  classifyError?: ErrorClassifier;
  onAfterCommitError?: (error: unknown, info: AfterCommitErrorInfo) => void;
  sleep: (ms: number) => Promise<void>;
  random: (maxExclusive: number) => number;
  tracer: SagaTracer;
}

export interface UnitPlan<Ctx> {
  saga: string;
  ctx: Ctx;
  state: RunState<unknown>;
  headers: MessageHeaders;
  /** Name of the unit in hop lines and errors, e.g. `tx#0`. */
  label: string;
  /** Resolved once, before attempt 1: every retry acquires the same set. */
  locks: readonly LockRequest[];
  retry?: Readonly<RetryPolicy<Ctx>> | undefined;
  /** True for the first unit of a run: nothing has committed yet, so a checkpoint failure fails
   *  the run before any transaction. Later units degrade to a single attempt instead. */
  strictCheckpoint: boolean;
}

/** Body of a unit: `acquire` takes all locks of the unit, after the ledger claim. */
export type UnitBody<Tx, T> = (
  tx: Tx,
  unit: UnitOfWork,
  acquire: () => Promise<void>,
) => Promise<T>;

type Callback = () => Promise<void> | void;
type Attempt<T> = { ok: true; value: T; callbacks: Callback[] } | { ok: false; error: unknown };

/** Errors that are logic failures: never retried, never wrapped. */
const NEVER_RETRIED = [
  IdempotencyInProgressError,
  IllegalTransitionError,
  TransitionOutcomeUnknownError,
  SagaUsageError,
];

/**
 * Runs one unit of work: checkpoint, attempt loop, locks, afterCommit and classification. Only
 * `transactions.run` is ever retried, and only before it committed.
 */
export class UnitOfWorkExecutor<Tx> {
  constructor(private readonly deps: UnitOfWorkDeps<Tx>) {}

  async execute<Ctx, T>(plan: UnitPlan<Ctx>, body: UnitBody<Tx, T>): Promise<T> {
    const policy = plan.retry;
    const restore = policy === undefined ? undefined : this.checkpoint(plan, policy);
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.runAttempt(plan, body, attempt, restore);
      if (outcome.ok) {
        await this.drainAfterCommit(outcome.callbacks, plan);
        return outcome.value;
      }
      const kind = this.classify(outcome.error);
      if (
        policy !== undefined &&
        restore !== undefined &&
        kind !== undefined &&
        this.retries(policy, kind, attempt)
      ) {
        restore();
        const ms = delayFor(policy, attempt, this.deps.random);
        await this.deps.tracer.traced(plan.saga, `retry:${kind}#${attempt + 1}`, plan.headers, () =>
          this.deps.sleep(ms),
        );
        continue;
      }
      throw this.finalError(outcome.error, kind, plan, attempt);
    }
  }

  /**
   * Snapshot before attempt 1. A later unit (a compensation, the ledger record, a unit after a
   * successful outbound) must still run when ctx cannot be snapshotted, because work already
   * committed or an external effect already happened: it runs once, without retry, and the
   * failure is reported at error level. Only the first unit lets the failure end the run.
   */
  private checkpoint<Ctx>(
    plan: UnitPlan<Ctx>,
    policy: Readonly<RetryPolicy<Ctx>>,
  ): (() => void) | undefined {
    try {
      return checkpointOf(policy, plan.ctx);
    } catch (error) {
      if (plan.strictCheckpoint) throw error;
      this.deps.tracer.error(plan.saga, `checkpoint:${plan.label}`, plan.headers, error);
      return undefined;
    }
  }

  /** Classifies an error the way the retry loop does (exposed for the runner's checks). A
   *  classifier result that is not a DatabaseErrorKind counts as "not a concurrency failure". */
  classify(error: unknown): ConcurrencyErrorKind | undefined {
    if (error instanceof ConcurrencyError) return error.kind;
    if (NEVER_RETRIED.some((type) => error instanceof type)) return undefined;
    const kind: unknown =
      this.deps.classifyError?.(error) ?? this.deps.transactions.classify?.(error);
    return isDatabaseErrorKind(kind) ? kind : undefined;
  }

  private retries<Ctx>(
    policy: Readonly<RetryPolicy<Ctx>>,
    kind: ConcurrencyErrorKind,
    attempt: number,
  ): boolean {
    return policy.on.includes(kind) && attempt < policy.attempts;
  }

  private finalError<Ctx>(
    error: unknown,
    kind: ConcurrencyErrorKind | undefined,
    plan: UnitPlan<Ctx>,
    attempts: number,
  ): unknown {
    if (kind === undefined || kind === 'stale-state' || error instanceof ConcurrencyError) {
      return error;
    }
    return toConcurrencyError(kind, error, { saga: plan.saga, unit: plan.label, attempts });
  }

  private async runAttempt<Ctx, T>(
    plan: UnitPlan<Ctx>,
    body: UnitBody<Tx, T>,
    attempt: number,
    restore: (() => void) | undefined,
  ): Promise<Attempt<T>> {
    const { state } = plan;
    const saved = { claimed: state.claimed, replay: state.replay };
    const callbacks: Callback[] = [];
    const releases: (() => void)[] = [];
    let open = true;
    let invocations = 0;
    const unit: UnitOfWork = {
      attempt,
      afterCommit: (fn) => {
        if (!open) {
          throw new SagaUsageError(
            `afterCommit called after unit ${plan.label} of saga "${plan.saga}" settled`,
          );
        }
        callbacks.push(fn);
      },
    };
    // A port may call `work` again inside one run() (e.g. its own retry on 40001): each call is a
    // fresh transaction, so whatever the rolled-back call left behind is reset first.
    const work = (tx: Tx): Promise<T> => {
      invocations += 1;
      if (invocations > 1) {
        state.claimed = saved.claimed;
        state.replay = saved.replay;
        callbacks.length = 0;
        this.release(releases, plan);
        restore?.();
      }
      return body(tx, unit, () => this.acquire(tx, plan, releases));
    };
    try {
      const scope = { holdsLocks: plan.locks.length > 0, retries: plan.retry !== undefined };
      const value = await unitOfWorkScope.run(scope, () => this.deps.transactions.run(work));
      return { ok: true, value, callbacks };
    } catch (error) {
      state.claimed = saved.claimed;
      state.replay = saved.replay;
      return { ok: false, error };
    } finally {
      open = false;
      this.release(releases, plan);
    }
  }

  private async acquire<Ctx>(tx: Tx, plan: UnitPlan<Ctx>, releases: (() => void)[]): Promise<void> {
    const port = this.deps.locks;
    if (plan.locks.length === 0) return;
    if (port === undefined) {
      throw new SagaUsageError(`saga "${plan.saga}" declares locks but the runner has no LockPort`);
    }
    await this.deps.tracer.traced(plan.saga, `locks:${plan.locks.length}`, plan.headers, () =>
      port.acquire(tx, plan.locks, { onRelease: (fn) => releases.push(fn) }),
    );
  }

  /** Runs and empties the release list, last acquired first. */
  private release<Ctx>(releases: (() => void)[], plan: UnitPlan<Ctx>): void {
    for (const fn of releases.splice(0).reverse()) {
      try {
        fn();
      } catch (error) {
        this.deps.tracer.error(plan.saga, `locks-release:${plan.label}`, plan.headers, error);
      }
    }
  }

  /** Sequential, in registration order. Never throws: the unit already committed. */
  private async drainAfterCommit<Ctx>(callbacks: Callback[], plan: UnitPlan<Ctx>): Promise<void> {
    for (const [index, callback] of callbacks.entries()) {
      const target = `after-commit:${plan.label}#${index}`;
      try {
        await this.deps.tracer.traced(plan.saga, target, plan.headers, callback);
      } catch (error) {
        this.reportAfterCommit(error, plan, target, index);
      }
    }
  }

  private reportAfterCommit<Ctx>(
    error: unknown,
    plan: UnitPlan<Ctx>,
    target: string,
    index: number,
  ): void {
    this.deps.tracer.error(plan.saga, target, plan.headers, error);
    const hook = this.deps.onAfterCommitError;
    if (hook === undefined) return;
    try {
      hook(error, {
        saga: plan.saga,
        unit: plan.label,
        index,
        correlationId: plan.headers.correlationId,
      });
    } catch (hookError) {
      this.deps.tracer.error(plan.saga, `${target}:hook`, plan.headers, hookError);
    }
  }
}
