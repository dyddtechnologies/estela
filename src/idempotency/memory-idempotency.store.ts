import {
  idempotencyStorageKey,
  type IdempotencyRecord,
  type IdempotencyStore,
} from './idempotency-store';

interface Entry {
  status: 'in-flight' | 'completed' | 'failed';
  expiresAt: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** Adapter in-memory con TTL pereza (check on access) + `purgeExpired()` manual. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  async begin(scope: string, key: string, ttlMs: number): Promise<boolean> {
    const fullKey = idempotencyStorageKey(scope, key);
    const existing = this.entries.get(fullKey);
    if (existing !== undefined && existing.expiresAt > Date.now()) {
      return false;
    }
    this.entries.set(fullKey, { status: 'in-flight', expiresAt: Date.now() + ttlMs });
    return true;
  }

  async complete(scope: string, key: string, result: Record<string, unknown>): Promise<void> {
    const entry = this.entries.get(idempotencyStorageKey(scope, key));
    if (entry === undefined) return;
    entry.status = 'completed';
    entry.result = result;
  }

  async fail(scope: string, key: string, error: unknown): Promise<void> {
    const entry = this.entries.get(idempotencyStorageKey(scope, key));
    if (entry === undefined) return;
    entry.status = 'failed';
    entry.error = error;
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const entry = this.entries.get(idempotencyStorageKey(scope, key));
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(idempotencyStorageKey(scope, key));
      return undefined;
    }
    const record: IdempotencyRecord = { status: entry.status };
    if (entry.result !== undefined) record.result = entry.result;
    if (entry.error !== undefined) record.error = entry.error;
    return record;
  }

  async purgeExpired(): Promise<number> {
    let purged = 0;
    for (const [fullKey, entry] of this.entries) {
      if (entry.expiresAt <= Date.now()) {
        this.entries.delete(fullKey);
        purged += 1;
      }
    }
    return purged;
  }
}
