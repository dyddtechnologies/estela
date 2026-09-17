/** Port de almacenamiento (spec sec.10) — implementable con Redis (contract only). */
export interface IdempotencyRecord {
  status: 'in-flight' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface IdempotencyStore {
  /** false si existe y no expiro (spec sec.10). */
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  purgeExpired(): Promise<number>;
}

/** Key de almacenamiento canonica (spec sec.10): `${scope}::${key}`. */
export function idempotencyStorageKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}
