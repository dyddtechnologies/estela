/**
 * Transactional idempotency: the ledger row is written with the same transaction as the saga's own
 * changes, so "the effect happened" and "the key is taken" commit or roll back together, across
 * every replica. A replay returns the response stored the first time.
 */
export type LedgerClaim =
  { status: 'new' } | { status: 'replay'; response: unknown } | { status: 'in-progress' };

export interface IdempotencyLedger<Tx = unknown> {
  /**
   * false: claim/record/release ignore `tx`, so a rollback does not undo them. The runner then
   * frees the claim itself when the attempt that took it rolls back (`release` with the same
   * handle, which such a ledger ignores), so a failed run leaves neither a stuck in-progress key
   * nor an applied entry whose writes never committed. It still refuses a retry policy on an
   * idempotent saga with such a ledger: between `record` and a failing COMMIT a concurrent
   * duplicate can replay a reply that never committed, a window a transactional ledger does not
   * have. Undefined counts as true: a production ledger writes through `tx`.
   */
  readonly transactional?: boolean;
  /** Takes `key` in this transaction, or reports the stored response / an unfinished first run. */
  claim(tx: Tx, scope: string, key: string): Promise<LedgerClaim>;
  /** Stores the response of the run that took `key`. */
  record(tx: Tx, scope: string, key: string, response: unknown): Promise<void>;
  /** Frees `key` after the run that took it failed, so the client can retry it. */
  release(tx: Tx, scope: string, key: string): Promise<void>;
}

/** Raised when the same key arrives while its first run has committed a claim but not finished. */
export class IdempotencyInProgressError extends Error {
  constructor(
    readonly scope: string,
    readonly key: string,
  ) {
    super(`IDEMPOTENCY_KEY_IN_PROGRESS: ${scope}/${key}`);
    this.name = 'IdempotencyInProgressError';
  }
}

/** `pending` from claim to record, `applied` once the reply is recorded; release deletes the entry. */
export type MemoryLedgerStatus = 'pending' | 'applied';

type MemoryLedgerEntry = { status: 'pending' } | { status: 'applied'; response: unknown };

/**
 * In-process ledger for tests and single-process apps. It ignores the transaction handle, so it is
 * NOT atomic with the app's database: production code uses a ledger backed by the same database.
 * Because `transactional` is false, the runner releases a claim whose attempt rolled back, so a
 * failed run never leaves a pending entry (stuck in-progress) or an applied one whose writes never
 * committed (false replay). It cannot be combined with a retry policy (SagaUsageError at run()).
 */
export class MemoryIdempotencyLedger<Tx = unknown> implements IdempotencyLedger<Tx> {
  readonly transactional = false;
  private readonly entries = new Map<string, MemoryLedgerEntry>();

  /** State of `key`, or undefined when it is free. */
  statusOf(scope: string, key: string): MemoryLedgerStatus | undefined {
    return this.entries.get(`${scope}::${key}`)?.status;
  }

  claim(_tx: Tx, scope: string, key: string): Promise<LedgerClaim> {
    const entry = this.entries.get(`${scope}::${key}`);
    if (entry === undefined) {
      this.entries.set(`${scope}::${key}`, { status: 'pending' });
      return Promise.resolve({ status: 'new' });
    }
    return Promise.resolve(
      entry.status === 'applied'
        ? { status: 'replay', response: entry.response }
        : { status: 'in-progress' },
    );
  }

  record(_tx: Tx, scope: string, key: string, response: unknown): Promise<void> {
    this.entries.set(`${scope}::${key}`, { status: 'applied', response });
    return Promise.resolve();
  }

  release(_tx: Tx, scope: string, key: string): Promise<void> {
    this.entries.delete(`${scope}::${key}`);
    return Promise.resolve();
  }
}
