import type { DatabaseErrorKind } from '../concurrency-errors';

/**
 * Exact SQLSTATE matches only. Deliberately NOT classified: 57014 (statement_timeout, may be a
 * slow query rather than contention) and 08xxx / 57P01 (connection lost, admin shutdown: the
 * commit outcome is unknown, so a retry could re-apply work that actually committed).
 */
const KINDS: ReadonlyMap<string, DatabaseErrorKind> = new Map<string, DatabaseErrorKind>([
  ['55P03', 'lock-timeout'],
  ['40P01', 'deadlock'],
  ['40001', 'serialization'],
]);

/**
 * Prisma's ORM-level P2034 ("write conflict or a deadlock") carries no SQLSTATE. Under the
 * Postgres default READ COMMITTED only a deadlock can produce it, so it maps to 'deadlock'; under
 * REPEATABLE READ or SERIALIZABLE it may be a serialization failure, so a Prisma retry policy
 * should list both kinds.
 */
const PRISMA_KINDS: ReadonlyMap<string, DatabaseErrorKind> = new Map<string, DatabaseErrorKind>([
  ['P2034', 'deadlock'],
]);

const MAX_CAUSE_DEPTH = 5;

function kindOfCode(code: unknown): DatabaseErrorKind | undefined {
  return typeof code === 'string' ? KINDS.get(code) : undefined;
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

/** pg `code`, then TypeORM `driverError.code`, then Prisma raw-query `meta.code`, then the
 *  Prisma ORM code itself. */
function kindOf(error: unknown): DatabaseErrorKind | undefined {
  const code = field(error, 'code');
  return (
    kindOfCode(code) ??
    kindOfCode(field(field(error, 'driverError'), 'code')) ??
    kindOfCode(field(field(error, 'meta'), 'code')) ??
    (typeof code === 'string' ? PRISMA_KINDS.get(code) : undefined)
  );
}

/** Maps a Postgres driver error to a concurrency kind, walking `cause` up to 5 levels deep. */
export function classifyPostgresError(error: unknown): DatabaseErrorKind | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return undefined;
    const kind = kindOf(current);
    if (kind !== undefined) return kind;
    current = field(current, 'cause');
  }
  return undefined;
}
