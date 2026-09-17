import type { IdempotencyRecord, IdempotencyStore } from './idempotency-store';

/** Null Object (GoF — plan §7.3 #20): `enabled:false` sin ramas `if` en runtime. */
export class NoopIdempotencyStore implements IdempotencyStore {
  async begin(_scope: string, _key: string, _ttlMs: number): Promise<boolean> {
    return true;
  }

  async complete(_scope: string, _key: string, _result: Record<string, unknown>): Promise<void> {
    return undefined;
  }

  async fail(_scope: string, _key: string, _error: unknown): Promise<void> {
    return undefined;
  }

  async get(_scope: string, _key: string): Promise<IdempotencyRecord | undefined> {
    return undefined;
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }
}
