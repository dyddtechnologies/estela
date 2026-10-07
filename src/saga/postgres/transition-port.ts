import {
  TransitionOutcomeUnknownError,
  type CasCommand,
  type CasResult,
  type TransitionPort,
} from '../transition';
import { quoteIdentifier, rowsOf, UnexpectedQueryResultError, type SqlQueryOf } from './sql';

/**
 * Compare-and-set state transitions on one table. The statement is built once at construction:
 * identifiers are validated against a strict pattern and quoted, and every value is a bound
 * parameter. It is SELECT-shaped on purpose (an UPDATE inside a CTE, counted outside), so pg
 * returns `{ rows }` and TypeORM returns a row array: the row count never depends on a driver's
 * UPDATE result shape, which is how a lost update used to look like a success.
 */
export interface PostgresTransitionPortOptions<Tx> {
  query: SqlQueryOf<Tx>;
  table: string;
  schema?: string;
  /** Default 'id'. */
  idColumn?: string;
  /** Default 'state'. The guard compares state::text, so it works for any column type. */
  stateColumn?: string;
  /**
   * Postgres type of the id column, as `name` or `schema.name` (catalog names: `uuid`, `int8`).
   * Needed only with a driver that binds typed parameters (Prisma binds a JS string as text): the
   * id is then compared as `$2::text::<idType>`. pg and TypeORM bind untyped parameters, which
   * Postgres types from the column, so they need no cast.
   */
  idType?: string;
  /** Same as idType, for the state column (e.g. `my_schema.status_enum` with Prisma). */
  stateType?: string;
  /** Bumped by 1 on success and guarded by expectedVersion; off by default. */
  versionColumn?: string;
  /** Set to now() on success; off by default. */
  touchColumn?: string;
}

interface CasStatements {
  plain: string;
  versioned?: string;
}

/** `$n`, or `$n::text::"schema"."type"` when the column type was given; parts validated. */
function boundAs(param: string, type: string | undefined, option: string): string {
  if (type === undefined) return param;
  const parts = type.split('.');
  if (parts.length > 2) {
    throw new TypeError(`invalid ${option} ${JSON.stringify(type)}: expected name or schema.name`);
  }
  return `${param}::text::${parts.map(quoteIdentifier).join('.')}`;
}

function buildStatements<Tx>(options: PostgresTransitionPortOptions<Tx>): CasStatements {
  const table =
    options.schema === undefined
      ? quoteIdentifier(options.table)
      : `${quoteIdentifier(options.schema)}.${quoteIdentifier(options.table)}`;
  const id = quoteIdentifier(options.idColumn ?? 'id');
  const state = quoteIdentifier(options.stateColumn ?? 'state');
  const version =
    options.versionColumn === undefined ? undefined : quoteIdentifier(options.versionColumn);
  const to = boundAs('$1', options.stateType, 'stateType');
  const key = boundAs('$2', options.idType, 'idType');
  const sets = [`${state} = ${to}`];
  if (version !== undefined) sets.push(`${version} = ${version} + 1`);
  if (options.touchColumn !== undefined)
    sets.push(`${quoteIdentifier(options.touchColumn)} = now()`);
  const returning = version ?? '1 AS one';
  const select =
    version === undefined
      ? 'SELECT count(*)::int AS affected FROM changed'
      : `SELECT count(*)::int AS affected, max(${version}) AS version FROM changed`;
  const statement = (guard: string): string =>
    `WITH changed AS (UPDATE ${table} SET ${sets.join(', ')} WHERE ${id} = ${key} AND ${state}::text = ANY($3::text[])${guard} RETURNING ${returning}) ${select}`;
  const plain = statement('');
  return version === undefined
    ? { plain }
    : { plain, versioned: statement(` AND ${version} = $4`) };
}

/**
 * Reads the new version: a number (int4 through pg or TypeORM), a numeric string (int8 through
 * pg) or a bigint (int8 through Prisma). A version the caller asked for but that cannot be read
 * as a safe integer throws instead of being dropped, because dropping it would silently turn the
 * next `expectedVersion` guard off.
 */
function versionOf(value: unknown): number {
  let n: unknown = value;
  if (typeof value === 'string' && value !== '') n = Number(value);
  if (typeof value === 'bigint') n = Number(value);
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new UnexpectedQueryResultError(value);
  }
  return n;
}

export function postgresTransitionPort<Tx>(
  options: PostgresTransitionPortOptions<Tx>,
): TransitionPort<Tx> {
  const statements = buildStatements(options);
  return {
    compareAndSet: async (tx: Tx, command: CasCommand): Promise<CasResult> => {
      const params: unknown[] = [command.to, command.id, [...command.from]];
      let sql = statements.plain;
      if (command.expectedVersion !== undefined) {
        if (statements.versioned === undefined) {
          throw new TypeError('expectedVersion needs the versionColumn option');
        }
        sql = statements.versioned;
        params.push(command.expectedVersion);
      }
      const row = rowsOf(await options.query(tx)(sql, params))[0];
      const affected = row?.affected;
      if (typeof affected !== 'number' || !Number.isInteger(affected)) {
        throw new TransitionOutcomeUnknownError(affected, command);
      }
      const version =
        affected === 1 && statements.versioned !== undefined ? versionOf(row?.version) : undefined;
      return version === undefined ? { affected } : { affected, version };
    },
  };
}
