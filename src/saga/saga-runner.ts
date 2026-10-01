import { createMessage, type MessageHeaders } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import {
  IdempotencyInProgressError,
  type IdempotencyLedger,
  type LedgerClaim,
} from './idempotency-ledger';
import type { SagaDefinition, SagaStep, TransactionStep } from './saga';
import type { TransactionPort } from './transaction-port';

export interface SagaRunnerOptions<Tx> {
  transactions: TransactionPort<Tx>;
  /** Without a ledger, `idempotent(...)` keys are ignored. */
  ledger?: IdempotencyLedger<Tx>;
  /** Optional hop logging: one line per saga and per step, like flows. */
  logger?: HopLogger;
}

export interface SagaRunOptions {
  correlationId?: string;
}

type Segment<Ctx, Tx> =
  | { kind: 'transaction'; steps: { name: string; run: TransactionStep<Ctx, Tx> }[] }
  | { kind: 'outbound'; step: Extract<SagaStep<Ctx, Tx>, { kind: 'outbound' }> };

/** Groups consecutive transaction steps: each group is one unit of work. */
function segmentsOf<Ctx, Tx>(steps: readonly SagaStep<Ctx, Tx>[]): Segment<Ctx, Tx>[] {
  const segments: Segment<Ctx, Tx>[] = [];
  for (const step of steps) {
    const last = segments[segments.length - 1];
    if (step.kind === 'outbound') segments.push({ kind: 'outbound', step });
    else if (last?.kind === 'transaction') last.steps.push(step);
    else segments.push({ kind: 'transaction', steps: [step] });
  }
  return segments;
}

interface RunState<Reply> {
  key?: string;
  claimed: boolean;
  replay?: { response: Reply };
}

/**
 * Runs saga definitions against the app's transaction port. One run walks its segments in order:
 * a transaction segment runs all its steps in one transaction; an outbound segment runs outside
 * any transaction and, when it fails, its `compensate` runs in a new one.
 *
 * Idempotency: the key is claimed inside the first unit of work and the reply is recorded inside
 * the last one when the saga ends with a transaction segment (otherwise in a short extra one), so
 * the ledger row and the saga's writes commit together. A failure after an outbound step has
 * succeeded is not compensated, because its external effect already happened.
 */
export class SagaRunner<Tx = unknown> {
  constructor(private readonly options: SagaRunnerOptions<Tx>) {}

  async run<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    ctx: Ctx,
    runOptions: SagaRunOptions = {},
  ): Promise<Reply> {
    const headers = this.traceHeaders(runOptions);
    const channel = `saga:${definition.name}`;
    const started = Date.now();
    this.options.logger?.flowStart(definition.name, channel, headers);
    try {
      const reply = await this.walk(definition, ctx, headers);
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

  private async walk<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    ctx: Ctx,
    headers: MessageHeaders,
  ): Promise<Reply> {
    const segments = segmentsOf(definition.steps);
    const key = this.options.ledger === undefined ? undefined : definition.idempotencyKey?.(ctx);
    const state: RunState<Reply> = key === undefined ? { claimed: false } : { key, claimed: false };
    let reply: { value: Reply } | undefined;

    for (const [index, segment] of segments.entries()) {
      const isLast = index === segments.length - 1;
      if (segment.kind === 'outbound') {
        await this.runOutbound(definition, segment.step, ctx, state, headers);
        continue;
      }
      reply = await this.runUnitOfWork(definition, segment.steps, ctx, state, headers, isLast);
      if (state.replay !== undefined) return state.replay.response;
    }
    if (reply !== undefined) return reply.value;
    return this.finishAfterOutbound(definition, ctx, state);
  }

  private async runUnitOfWork<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    steps: { name: string; run: TransactionStep<Ctx, Tx> }[],
    ctx: Ctx,
    state: RunState<Reply>,
    headers: MessageHeaders,
    isLast: boolean,
  ): Promise<{ value: Reply } | undefined> {
    return this.options.transactions.run(async (tx) => {
      if (!(await this.claimOnce(definition.name, tx, state))) return undefined;
      for (const step of steps) {
        await this.traced(definition.name, `transaction:${step.name}`, headers, () =>
          step.run(ctx, tx),
        );
      }
      if (!isLast) return undefined;
      const value = definition.reply(ctx);
      await this.recordIfClaimed(definition.name, tx, state, value);
      return { value };
    });
  }

  private async runOutbound<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    step: Extract<SagaStep<Ctx, Tx>, { kind: 'outbound' }>,
    ctx: Ctx,
    state: RunState<Reply>,
    headers: MessageHeaders,
  ): Promise<void> {
    if (state.key !== undefined && !state.claimed) {
      // A saga that opens with an outbound step still claims its key before calling out.
      await this.options.transactions.run((tx) => this.claimOnce(definition.name, tx, state));
      if (state.replay !== undefined) return;
    }
    try {
      await this.traced(definition.name, `outbound:${step.name}`, headers, () => step.run(ctx));
    } catch (error) {
      await this.compensate(definition.name, step.compensate, ctx, state);
      throw error;
    }
  }

  private async compensate<Ctx, Reply>(
    sagaName: string,
    compensate: TransactionStep<Ctx, Tx> | undefined,
    ctx: Ctx,
    state: RunState<Reply>,
  ): Promise<void> {
    if (compensate === undefined && !state.claimed) return;
    await this.options.transactions.run(async (tx) => {
      if (compensate !== undefined) await compensate(ctx, tx);
      if (state.claimed && state.key !== undefined) {
        await this.options.ledger?.release(tx, sagaName, state.key);
      }
    });
  }

  private async finishAfterOutbound<Ctx, Reply>(
    definition: SagaDefinition<Ctx, Tx, Reply>,
    ctx: Ctx,
    state: RunState<Reply>,
  ): Promise<Reply> {
    if (state.replay !== undefined) return state.replay.response;
    const value = definition.reply(ctx);
    if (state.claimed) {
      await this.options.transactions.run((tx) =>
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

  private async traced(
    sagaName: string,
    target: string,
    headers: MessageHeaders,
    work: () => Promise<void> | void,
  ): Promise<void> {
    const channel = `saga:${sagaName}`;
    const started = Date.now();
    this.options.logger?.hopStart(channel, target, headers);
    let ok = false;
    try {
      await work();
      ok = true;
    } finally {
      this.options.logger?.hopEnd(channel, target, headers, ok, Date.now() - started);
    }
  }

  private traceHeaders(runOptions: SagaRunOptions): MessageHeaders {
    const init =
      runOptions.correlationId === undefined ? {} : { correlationId: runOptions.correlationId };
    return createMessage(null, init).headers;
  }
}
