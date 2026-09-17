import type { FlowIdempotencyPort } from '../flow/flow-executor';
import type { IdempotencyRecord, IdempotencyStore } from './idempotency-store';
import { MemoryIdempotencyStore } from './memory-idempotency.store';
import { NoopIdempotencyStore } from './noop-idempotency.store';

export interface IdempotencyOptions {
  enabled?: boolean; // default true
  ttlMs?: number; // default 1h
  store?: IdempotencyStore; // default MemoryIdempotencyStore (spec §10)
}

/**
 * Política de idempotencia (SRP): scopes, enable/disable, TTL default.
 * NO almacena — delega en el `IdempotencyStore` (D, plan §6).
 * Sin `idempotencyKey` en el mensaje el executor ni siquiera llama aquí.
 */
export class IdempotencyService implements FlowIdempotencyPort {
  private readonly store: IdempotencyStore;

  constructor(private readonly options: IdempotencyOptions = {}) {
    this.store =
      options.enabled === false
        ? new NoopIdempotencyStore()
        : (options.store ?? new MemoryIdempotencyStore());
  }

  get ttlMs(): number {
    return this.options.ttlMs ?? 3_600_000;
  }

  async begin(scope: string, key: string, ttlMs?: number): Promise<boolean> {
    return this.store.begin(scope, key, ttlMs ?? this.ttlMs);
  }

  async complete(scope: string, key: string, result: Record<string, unknown>): Promise<void> {
    await this.store.complete(scope, key, result);
  }

  async fail(scope: string, key: string, error: unknown): Promise<void> {
    await this.store.fail(scope, key, error);
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    return this.store.get(scope, key);
  }

  async purgeExpired(): Promise<number> {
    return this.store.purgeExpired();
  }
}
