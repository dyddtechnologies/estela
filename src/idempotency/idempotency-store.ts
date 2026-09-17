/** Puerto de almacenamiento (spec §10) — implementable con Redis (contrato only). */
export interface IdempotencyRecord {
  status: 'in-flight' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: unknown;
}

export interface IdempotencyStore {
  /** false si existe y no expiró (spec §10). */
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  purgeExpired(): Promise<number>;
}

/** Clave de almacenamiento canónica (spec §10): `${scope}::${key}`. */
export function idempotencyStorageKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}
