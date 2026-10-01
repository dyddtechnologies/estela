/**
 * Saga DSL: the steps of a business operation, declared in one place, in order.
 *
 *   saga<Ctx, Tx, Reply>('complete')
 *     .idempotent((ctx) => ctx.idempotencyKey)
 *     .transaction('claim', (ctx, tx) => ...)
 *     .outbound('call-api', (ctx) => ..., { compensate: (ctx, tx) => ... })
 *     .transaction('mark-completed', (ctx, tx) => ...)
 *     .reply((ctx) => ...)
 *
 * Consecutive `transaction` steps share ONE database transaction (a unit of work): a failure
 * rolls all of them back, so they need no compensation and a crashed pod leaves nothing half
 * written. An `outbound` step talks to the outside world, so it never runs inside a transaction:
 * the unit of work before it commits first, and its `compensate` undoes that committed work if it
 * fails. Steps share state through the typed `ctx` object they receive.
 */
export type TransactionStep<Ctx, Tx> = (ctx: Ctx, tx: Tx) => Promise<void> | void;
export type OutboundStep<Ctx> = (ctx: Ctx) => Promise<void> | void;

export interface OutboundOptions<Ctx, Tx> {
  /** Runs in its own transaction when the outbound step fails; undoes the committed work. */
  compensate?: TransactionStep<Ctx, Tx>;
}

export type SagaStep<Ctx, Tx> =
  | { kind: 'transaction'; name: string; run: TransactionStep<Ctx, Tx> }
  | {
      kind: 'outbound';
      name: string;
      run: OutboundStep<Ctx>;
      compensate?: TransactionStep<Ctx, Tx>;
    };

export interface SagaDefinition<Ctx, Tx, Reply> {
  readonly name: string;
  readonly steps: readonly SagaStep<Ctx, Tx>[];
  /** Idempotency key of a run; undefined means the run is not deduplicated. */
  readonly idempotencyKey?: (ctx: Ctx) => string | undefined;
  readonly reply: (ctx: Ctx) => Reply;
}

export class SagaBuilder<Ctx, Tx, Reply> {
  private readonly steps: SagaStep<Ctx, Tx>[] = [];
  private keyOf?: (ctx: Ctx) => string | undefined;

  constructor(private readonly name: string) {}

  idempotent(keyOf: (ctx: Ctx) => string | undefined): this {
    this.keyOf = keyOf;
    return this;
  }

  transaction(name: string, run: TransactionStep<Ctx, Tx>): this {
    this.steps.push({ kind: 'transaction', name, run });
    return this;
  }

  outbound(name: string, run: OutboundStep<Ctx>, options: OutboundOptions<Ctx, Tx> = {}): this {
    this.steps.push(
      options.compensate === undefined
        ? { kind: 'outbound', name, run }
        : { kind: 'outbound', name, run, compensate: options.compensate },
    );
    return this;
  }

  reply(reply: (ctx: Ctx) => Reply): SagaDefinition<Ctx, Tx, Reply> {
    if (this.steps.length === 0) throw new Error(`saga ${this.name} has no steps`);
    const definition: SagaDefinition<Ctx, Tx, Reply> = {
      name: this.name,
      steps: Object.freeze([...this.steps]),
      reply,
      ...(this.keyOf === undefined ? {} : { idempotencyKey: this.keyOf }),
    };
    return Object.freeze(definition);
  }
}

export function saga<Ctx, Tx = unknown, Reply = Ctx>(name: string): SagaBuilder<Ctx, Tx, Reply> {
  return new SagaBuilder<Ctx, Tx, Reply>(name);
}
