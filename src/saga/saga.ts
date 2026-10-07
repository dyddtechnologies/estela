import { SagaDefinitionError } from './concurrency-errors';
import type { LockMode } from './lock-port';
import type { RetryPolicy } from './retry-policy';
import { validateLockDeclaration, validateRetryPolicy } from './saga-definition';

export type { JitterMode, RetryPolicy } from './retry-policy';

/**
 * Saga DSL: the steps of a business operation, declared in one place, in order.
 *
 *   saga<Ctx, Tx, Reply>('complete')
 *     .idempotent((ctx) => ctx.idempotencyKey)
 *     .lock('order', (ctx) => ctx.orderId, 'exclusive')
 *     .transaction('claim', (ctx, tx) => ...)
 *     .outbound('call-api', (ctx) => ..., { compensate: (ctx, tx) => ... })
 *     .transaction('mark-completed', (ctx, tx, unit) => unit.afterCommit(() => ...))
 *     .retry({ on: ['deadlock'], attempts: 3, backoffMs: 20 })
 *     .reply((ctx) => ...)
 *
 * Consecutive `transaction` steps share ONE database transaction (a unit of work): a failure
 * rolls all of them back, so they need no compensation and a crashed pod leaves nothing half
 * written. An `outbound` step talks to the outside world, so it never runs inside a transaction:
 * the unit of work before it commits first, and its `compensate` undoes that committed work if it
 * fails. Steps share state through the typed `ctx` object they receive.
 *
 * A `lock` binds forward to the next transaction step, and all locks of a unit of work are taken
 * once, at its start, in canonical order. Lock keys are computed from ctx as it is when the unit
 * starts.
 */
export interface UnitOfWork {
  /** 1-based attempt number of this unit of work (> 1 only under a retry policy). */
  readonly attempt: number;
  /** Runs fn after THIS unit of work commits, in registration order. Discarded if the attempt
   *  rolls back. Throws SagaUsageError when called after the attempt settled. */
  afterCommit(fn: () => Promise<void> | void): void;
}

/**
 * A transaction step. The runner always passes `unit`, and the type says so: a stored step or a
 * compensation called with two arguments is a compile error, not an `undefined` dereference at run
 * time inside a step that uses `unit.afterCommit`. A 2-argument implementation is still assignable
 * (TS allows a shorter parameter list). Tests that call a step directly pass
 * `testUnitOfWork()` from `@estela/nest/testing`.
 */
export type TransactionStep<Ctx, Tx> = (ctx: Ctx, tx: Tx, unit: UnitOfWork) => Promise<void> | void;
export type OutboundStep<Ctx> = (ctx: Ctx) => Promise<void> | void;

export type { LockMode } from './lock-port';
export type LockKeyOf<Ctx> = (ctx: Ctx) => string | readonly string[] | undefined;

export interface LockOptions {
  /** Integer ms, 1..2147483647. Undefined: the LockPort default (Postgres: session lock_timeout). */
  timeoutMs?: number;
  /** false (default): keyOf returning undefined or [] is a SagaUsageError. true: no lock taken. */
  optional?: boolean;
}

export interface LockDeclaration<Ctx> {
  readonly namespace: string;
  readonly keyOf: LockKeyOf<Ctx>;
  readonly mode: LockMode;
  readonly timeoutMs?: number;
  readonly optional: boolean;
}

export interface OutboundOptions<Ctx, Tx> {
  /** Runs in its own transaction when the outbound step fails; undoes the committed work. */
  compensate?: TransactionStep<Ctx, Tx>;
  /** 'inherit' (default): the compensation re-acquires the exact LockRequests resolved for the
   *  transaction segment right before this outbound step. 'none': no locks. */
  compensateLocks?: 'inherit' | 'none';
}

export type SagaStep<Ctx, Tx> =
  | {
      kind: 'transaction';
      name: string;
      run: TransactionStep<Ctx, Tx>;
      locks?: readonly LockDeclaration<Ctx>[];
    }
  | {
      kind: 'outbound';
      name: string;
      run: OutboundStep<Ctx>;
      compensate?: TransactionStep<Ctx, Tx>;
      compensateLocks?: 'inherit' | 'none';
    };

export interface SagaDefinition<Ctx, Tx, Reply> {
  readonly name: string;
  readonly steps: readonly SagaStep<Ctx, Tx>[];
  /** Idempotency key of a run; undefined means the run is not deduplicated. */
  readonly idempotencyKey?: (ctx: Ctx) => string | undefined;
  readonly retry?: Readonly<RetryPolicy<Ctx>>;
  readonly reply: (ctx: Ctx) => Reply;
}

type OutboundSagaStep<Ctx, Tx> = Extract<SagaStep<Ctx, Tx>, { kind: 'outbound' }>;

export class SagaBuilder<Ctx, Tx, Reply> {
  private readonly steps: SagaStep<Ctx, Tx>[] = [];
  private pendingLocks: LockDeclaration<Ctx>[] = [];
  private keyOf?: (ctx: Ctx) => string | undefined;
  private policy?: Readonly<RetryPolicy<Ctx>>;

  constructor(private readonly name: string) {}

  idempotent(keyOf: (ctx: Ctx) => string | undefined): this {
    this.keyOf = keyOf;
    return this;
  }

  transaction(name: string, run: TransactionStep<Ctx, Tx>): this {
    const locks = this.pendingLocks;
    this.pendingLocks = [];
    this.steps.push(
      locks.length === 0
        ? { kind: 'transaction', name, run }
        : { kind: 'transaction', name, run, locks: Object.freeze(locks) },
    );
    return this;
  }

  outbound(name: string, run: OutboundStep<Ctx>, options: OutboundOptions<Ctx, Tx> = {}): this {
    this.assertNoPendingLocks();
    const step: OutboundSagaStep<Ctx, Tx> = { kind: 'outbound', name, run };
    if (options.compensate !== undefined) step.compensate = options.compensate;
    if (options.compensateLocks !== undefined) step.compensateLocks = options.compensateLocks;
    this.steps.push(step);
    return this;
  }

  /** namespace doubles as the step name in logs. Mode is REQUIRED (no implicit exclusive). */
  lock(namespace: string, keyOf: LockKeyOf<Ctx>, mode: LockMode, options: LockOptions = {}): this {
    validateLockDeclaration(this.name, namespace, keyOf, mode, options.timeoutMs);
    const base = { namespace, keyOf, mode, optional: options.optional === true };
    this.pendingLocks.push(
      Object.freeze(
        options.timeoutMs === undefined ? base : { ...base, timeoutMs: options.timeoutMs },
      ),
    );
    return this;
  }

  /** Validated eagerly; a second call throws SagaDefinitionError. */
  retry(policy: RetryPolicy<Ctx>): this {
    if (this.policy !== undefined) {
      throw new SagaDefinitionError(`saga "${this.name}" already declares a retry policy`);
    }
    this.policy = validateRetryPolicy(this.name, policy);
    return this;
  }

  reply(reply: (ctx: Ctx) => Reply): SagaDefinition<Ctx, Tx, Reply> {
    this.assertNoPendingLocks();
    if (this.steps.length === 0) throw new Error(`saga ${this.name} has no steps`);
    const definition: SagaDefinition<Ctx, Tx, Reply> = {
      name: this.name,
      steps: Object.freeze([...this.steps]),
      reply,
      ...(this.keyOf === undefined ? {} : { idempotencyKey: this.keyOf }),
      ...(this.policy === undefined ? {} : { retry: this.policy }),
    };
    return Object.freeze(definition);
  }

  private assertNoPendingLocks(): void {
    const pending = this.pendingLocks[0];
    if (pending === undefined) return;
    throw new SagaDefinitionError(
      `lock "${pending.namespace}" in saga "${this.name}" is not followed by a transaction step in the same unit of work`,
    );
  }
}

export function saga<Ctx, Tx = unknown, Reply = Ctx>(name: string): SagaBuilder<Ctx, Tx, Reply> {
  return new SagaBuilder<Ctx, Tx, Reply>(name);
}
