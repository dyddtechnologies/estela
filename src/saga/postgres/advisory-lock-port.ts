import { SagaUsageError } from '../concurrency-errors';
import { isLockTimeoutMs, mergeLockRequests, type LockPort, type LockRequest } from '../lock-port';
import { rowsOf, UnexpectedQueryResultError, type SqlQuery, type SqlQueryOf } from './sql';

/**
 * Transaction-scoped Postgres advisory locks on one bigint per (namespace, key): the first 64 bits
 * of SHA-256 over `length(namespace) || ':' || namespace || key` (see ADVISORY_LOCK_KEY_SQL). The
 * length prefix makes the encoding injective, and a cryptographic hash means a caller who chooses
 * part of a key cannot build a key that collides with someone else's (32-bit `hashtext` could be
 * brute-forced offline in minutes). Only the `_xact_` functions are used, so every lock is released
 * by COMMIT or ROLLBACK and nothing leaks into a pooled session. Every value is a bound parameter;
 * no user data is ever interpolated. Needs Postgres 11+ (`sha256`).
 */
export interface PostgresLockPortOptions<Tx> {
  query: SqlQueryOf<Tx>;
  /** Applied to requests without their own timeoutMs. Undefined: the session lock_timeout. */
  defaultTimeoutMs?: number;
  /**
   * Default false: acquiring in a REPEATABLE READ transaction throws SagaUsageError. Its snapshot
   * is taken by the first statement (the ledger claim, or the lock port's own query), BEFORE the
   * lock wait, so a step that reads after the lock is granted still sees the pre-wait data: the
   * lock serializes execution but not visibility, and a read-then-insert invariant breaks silently.
   * Set true only when the steps never rely on the lock for what they read. READ COMMITTED takes a
   * snapshot per statement and is safe; SERIALIZABLE turns the same race into 40001, which is safe
   * with `retry({ on: ['serialization'] })`.
   */
  allowSnapshotIsolation?: boolean;
}

function keyExpression(namespace: string, key: string): string {
  return `('x' || left(encode(sha256(convert_to(length(${namespace}) || ':' || ${namespace} || ${key}, 'UTF8')), 'hex'), 16))::bit(64)::int8`;
}

/**
 * The int8 advisory-lock key of ($1 namespace, $2 key), as a SQL expression. Code outside Estela
 * that must take the same lock binds both as parameters:
 * `SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY_SQL})` with `[namespace, key]`.
 */
export const ADVISORY_LOCK_KEY_SQL = keyExpression('$1::text', '$2::text');
// The key is returned as text so every driver reads it the same way (pg would give a string,
// Prisma a bigint, and a JS number cannot hold every int8).
const HASH_SQL =
  `SELECT l.i::int AS i, ${keyExpression('l.n', 'l.k')}::text AS h, ` +
  "current_setting('transaction_isolation') AS iso " +
  'FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS l(n, k, i)';
const SNAPSHOT_ISOLATION = 'repeatable read';
const READ_TIMEOUT_SQL = "SELECT current_setting('lock_timeout') AS prev";
// set_config(..., true) is the parameterized form of SET LOCAL, which cannot take bind params.
const SET_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true) AS lock_timeout";
// The lock function sits in FROM so no void column is returned (Prisma rejects void columns).
const LOCK_EXCLUSIVE_SQL = 'SELECT 1 AS ok FROM pg_advisory_xact_lock($1::int8)';
const LOCK_SHARED_SQL = 'SELECT 1 AS ok FROM pg_advisory_xact_lock_shared($1::int8)';

const INT8_MIN = -(2n ** 63n);
const INT8_MAX = 2n ** 63n - 1n;
const DECIMAL = /^-?\d{1,19}$/;

interface PhysicalLock {
  /** Signed int8, as the decimal string bound to the lock statement. */
  key: string;
  order: bigint;
  request: LockRequest;
}

function ordinalOf(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new UnexpectedQueryResultError(value);
  }
  return n;
}

/** Reads the int8 key from text (the query casts it), a bigint or a safe integer. */
function int8Of(value: unknown): bigint {
  let n: bigint | undefined;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && DECIMAL.test(value)) n = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  if (n === undefined || n < INT8_MIN || n > INT8_MAX) throw new UnexpectedQueryResultError(value);
  return n;
}

function withDefaultTimeout(request: LockRequest, defaultTimeoutMs?: number): LockRequest {
  if (request.timeoutMs !== undefined || defaultTimeoutMs === undefined) return request;
  return { ...request, timeoutMs: defaultTimeoutMs };
}

function compareKeys(a: PhysicalLock, b: PhysicalLock): number {
  if (a.order < b.order) return -1;
  return a.order > b.order ? 1 : 0;
}

/** Sorts by the signed int8 key and merges physical collisions: exclusive and min timeout win. */
function canonicalPhysical(locks: PhysicalLock[]): PhysicalLock[] {
  const sorted = [...locks].sort(compareKeys);
  const merged: PhysicalLock[] = [];
  for (const lock of sorted) {
    const last = merged[merged.length - 1];
    if (last?.order === lock.order) {
      last.request = mergeLockRequests(last.request, lock.request);
    } else {
      merged.push({ ...lock });
    }
  }
  return merged;
}

function assertIsolation(iso: unknown, allowSnapshotIsolation: boolean): void {
  if (typeof iso !== 'string') throw new UnexpectedQueryResultError(iso);
  if (iso === SNAPSHOT_ISOLATION && !allowSnapshotIsolation) {
    throw new SagaUsageError(
      'advisory locks in a REPEATABLE READ transaction do not protect reads: its snapshot predates the lock wait. Use READ COMMITTED, SERIALIZABLE with retry on serialization, or allowSnapshotIsolation: true when steps never read what the lock protects',
    );
  }
}

async function physicalLocks(
  query: SqlQuery,
  requests: readonly LockRequest[],
  allowSnapshotIsolation: boolean,
): Promise<PhysicalLock[]> {
  const rows = rowsOf(
    await query(HASH_SQL, [requests.map((r) => r.namespace), requests.map((r) => r.key)]),
  );
  if (rows.length !== requests.length) throw new UnexpectedQueryResultError(rows);
  assertIsolation(rows[0]?.iso, allowSnapshotIsolation);
  const locks = rows.map((row) => {
    const request = requests[ordinalOf(row.i) - 1];
    if (request === undefined) throw new UnexpectedQueryResultError(row);
    const order = int8Of(row.h);
    return { key: order.toString(), order, request };
  });
  return canonicalPhysical(locks);
}

function timeoutSetting(ms: number): string {
  return `${ms}ms`;
}

async function readTimeout(query: SqlQuery): Promise<string> {
  const prev = rowsOf(await query(READ_TIMEOUT_SQL, []))[0]?.prev;
  if (typeof prev !== 'string') throw new UnexpectedQueryResultError(prev);
  return prev;
}

async function lockAll(query: SqlQuery, locks: readonly PhysicalLock[]): Promise<void> {
  const needsTimeout = locks.some((lock) => lock.request.timeoutMs !== undefined);
  const previous = needsTimeout ? await readTimeout(query) : undefined;
  let current = previous;
  for (const { key, request } of locks) {
    if (previous !== undefined) {
      const wanted = request.timeoutMs === undefined ? previous : timeoutSetting(request.timeoutMs);
      if (wanted !== current) {
        await query(SET_TIMEOUT_SQL, [wanted]);
        current = wanted;
      }
    }
    await query(request.mode === 'shared' ? LOCK_SHARED_SQL : LOCK_EXCLUSIVE_SQL, [key]);
  }
  // Restore so the lock timeout never leaks into the step's own row locks. Not in a finally: a
  // failed lock aborts the transaction, and its rollback already discards the local setting.
  if (previous !== undefined && current !== previous) {
    await query(SET_TIMEOUT_SQL, [previous]);
  }
}

export function postgresAdvisoryLockPort<Tx>(options: PostgresLockPortOptions<Tx>): LockPort<Tx> {
  if (options.defaultTimeoutMs !== undefined && !isLockTimeoutMs(options.defaultTimeoutMs)) {
    throw new TypeError('defaultTimeoutMs must be an integer 1..2147483647');
  }
  return {
    acquire: async (tx, locks) => {
      if (locks.length === 0) return;
      const requests = locks.map((r) => withDefaultTimeout(r, options.defaultTimeoutMs));
      for (const request of requests) {
        if (request.timeoutMs !== undefined && !isLockTimeoutMs(request.timeoutMs)) {
          throw new TypeError(
            `lock ${request.namespace} timeoutMs must be an integer 1..2147483647, got ${String(request.timeoutMs)}`,
          );
        }
      }
      const query = options.query(tx);
      const allow = options.allowSnapshotIsolation === true;
      await lockAll(query, await physicalLocks(query, requests, allow));
    },
  };
}
