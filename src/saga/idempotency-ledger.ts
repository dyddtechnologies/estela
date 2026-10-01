/**
 * Transactional idempotency: the ledger row is written with the same transaction as the saga's own
 * changes, so "the effect happened" and "the key is taken" commit or roll back together, across
 * every replica. A replay returns the response stored the first time.
 */
export type LedgerClaim =
  { status: 'new' } | { status: 'replay'; response: unknown } | { status: 'in-progress' };

export interface IdempotencyLedger<Tx = unknown> {
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

interface LedgerEntry {
  done: boolean;
  response?: unknown;
}

/**
 * In-process ledger for tests and single-process apps. It ignores the transaction handle, so it is
 * NOT atomic with the app's database: production code uses a ledger backed by the same database.
 */
export class MemoryIdempotencyLedger<Tx = unknown> implements IdempotencyLedger<Tx> {
  private readonly entries = new Map<string, LedgerEntry>();

  claim(_tx: Tx, scope: string, key: string): Promise<LedgerClaim> {
    const entry = this.entries.get(`${scope}::${key}`);
    if (entry === undefined) {
      this.entries.set(`${scope}::${key}`, { done: false });
      return Promise.resolve({ status: 'new' });
    }
    return Promise.resolve(
      entry.done ? { status: 'replay', response: entry.response } : { status: 'in-progress' },
    );
  }

  record(_tx: Tx, scope: string, key: string, response: unknown): Promise<void> {
    this.entries.set(`${scope}::${key}`, { done: true, response });
    return Promise.resolve();
  }

  release(_tx: Tx, scope: string, key: string): Promise<void> {
    this.entries.delete(`${scope}::${key}`);
    return Promise.resolve();
  }
}
