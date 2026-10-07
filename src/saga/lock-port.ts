/**
 * Port to the application's lock manager. Locks belong to the unit of work that declares them:
 * the runner acquires every lock of a transaction segment at its start, in one canonical order,
 * and the database releases them on commit or rollback. Taking all locks of every saga in the same
 * global order is what keeps two sagas from deadlocking on each other's locks.
 */
export type LockMode = 'shared' | 'exclusive';

export interface LockRequest {
  readonly namespace: string;
  readonly key: string;
  readonly mode: LockMode;
  /** Integer ms, 1..2147483647. Undefined: the port default. */
  readonly timeoutMs?: number;
}

export interface LockScope {
  /** In-process ports register their release here; the runner calls it after transactions.run
   *  settles (commit or rollback). Database ports ignore it: their locks are tx-scoped. */
  onRelease(fn: () => void): void;
}

export interface LockPort<Tx = unknown> {
  /** Acquires every request, transaction-scoped (never session-scoped), in the order given.
   *  Requests arrive deduplicated and sorted by canonicalLocks(). A port whose physical lock
   *  identity differs from (namespace, key), e.g. hashing, MUST re-sort by physical identity and
   *  merge physical collisions with the same rules (mergeLockRequests). */
  acquire(tx: Tx, locks: readonly LockRequest[], scope: LockScope): Promise<void>;
}

/** Largest value accepted for a lock timeout: setTimeout and Postgres both stop at int32. */
export const MAX_LOCK_TIMEOUT_MS = 2_147_483_647;

/** True for an integer number of milliseconds in 1..2147483647. */
export function isLockTimeoutMs(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_LOCK_TIMEOUT_MS;
}

/** Ordinal comparison by UTF-16 code units: deterministic, unlike localeCompare. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Merges two requests for the same lock: exclusive wins, the smallest defined timeout wins. */
export function mergeLockRequests(a: LockRequest, b: LockRequest): LockRequest {
  const mode: LockMode = a.mode === 'exclusive' || b.mode === 'exclusive' ? 'exclusive' : 'shared';
  const timeouts = [a.timeoutMs, b.timeoutMs].filter((t): t is number => t !== undefined);
  const base = { namespace: a.namespace, key: a.key, mode };
  return timeouts.length === 0 ? base : { ...base, timeoutMs: Math.min(...timeouts) };
}

/** Pure: dedupe by (namespace, key), exclusive wins, smallest timeoutMs wins; then sort by
 *  namespace, then key, in UTF-16 code-unit order (a < b), NEVER localeCompare. */
export function canonicalLocks(requests: readonly LockRequest[]): LockRequest[] {
  const byIdentity = new Map<string, LockRequest>();
  for (const request of requests) {
    const identity = JSON.stringify([request.namespace, request.key]);
    const existing = byIdentity.get(identity);
    byIdentity.set(
      identity,
      existing === undefined ? request : mergeLockRequests(existing, request),
    );
  }
  return [...byIdentity.values()].sort(
    (a, b) => compareCodeUnits(a.namespace, b.namespace) || compareCodeUnits(a.key, b.key),
  );
}
