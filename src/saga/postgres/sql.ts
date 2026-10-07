/**
 * The only thing the Postgres adapters need from the app: a function that runs one parameterized
 * statement inside the transaction handle `Tx`. TypeORM, pg and Prisma all fit, so Estela needs no
 * `pg` dependency:
 *
 *   TypeORM: (m: EntityManager) => (sql, params) => m.query(sql, [...params])
 *   pg:      (c: PoolClient)    => (sql, params) => c.query(sql, [...params])
 *   Prisma:  (tx)               => (sql, params) => tx.$queryRawUnsafe(sql, ...params)
 */
export type SqlQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>;
export type SqlQueryOf<Tx> = (tx: Tx) => SqlQuery;

/** The query function returned something that is neither a row array nor `{ rows }`. */
export class UnexpectedQueryResultError extends Error {
  constructor(readonly received: unknown) {
    super(
      `UNEXPECTED_QUERY_RESULT: the query function must resolve to a row array (TypeORM, Prisma) or { rows } (pg), got ${received === null ? 'null' : typeof received}`,
    );
    this.name = 'UnexpectedQueryResultError';
  }
}

function isRowArray(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null);
}

/** Accepts a row array (TypeORM query(), Prisma $queryRawUnsafe) or { rows } (pg).
 *  Anything else: UnexpectedQueryResultError. Never reads rowCount. */
export function rowsOf(raw: unknown): readonly Record<string, unknown>[] {
  if (isRowArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null && 'rows' in raw) {
    const rows: unknown = raw.rows;
    if (isRowArray(rows)) return rows;
  }
  throw new UnexpectedQueryResultError(raw);
}

const IDENTIFIER = /^[A-Za-z_]\w{0,62}$/;

/** Validates a SQL identifier against a strict pattern, then double-quotes it. Anything else
 *  (quotes, spaces, semicolons, more than 63 chars, a leading digit) throws TypeError. */
export function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    throw new TypeError(
      `invalid SQL identifier ${JSON.stringify(name)}: expected ${IDENTIFIER.source}`,
    );
  }
  return `"${name}"`;
}
