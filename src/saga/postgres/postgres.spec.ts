import { SagaUsageError } from '../concurrency-errors';
import { TransitionOutcomeUnknownError } from '../transition';
import { ADVISORY_LOCK_KEY_SQL, postgresAdvisoryLockPort } from './advisory-lock-port';
import { classifyPostgresError } from './error-classifier';
import { quoteIdentifier, rowsOf, UnexpectedQueryResultError, type SqlQuery } from './sql';
import { postgresTransitionPort } from './transition-port';

interface Call {
  sql: string;
  params: readonly unknown[];
}

/** Recording fake SqlQuery: answers the hash query with fixed int8 keys, lock statements with the
 *  transaction probe (`open` inside a transaction block) and everything else with `next`. */
function fakeSql(
  hashes: Record<string, string | bigint | number>,
  shape: 'pg' | 'array' = 'pg',
  iso = 'read committed',
  probe: string | null = 'open',
) {
  const calls: Call[] = [];
  let next: Record<string, unknown>[] = [];
  const wrap = (rows: Record<string, unknown>[]) => (shape === 'pg' ? { rows } : rows);
  const query: SqlQuery = (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('sha256')) {
      const [namespaces, keys] = params as [string[], string[]];
      return Promise.resolve(
        wrap(
          namespaces.map((n, i) => ({
            i: i + 1,
            h: hashes[`${n}/${keys[i]}`] ?? '0',
            iso,
            probe: 'open',
          })),
        ),
      );
    }
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve(wrap([{ probe }]));
    if (sql.includes('current_setting')) return Promise.resolve(wrap([{ prev: '0' }]));
    return Promise.resolve(wrap(next));
  };
  return {
    calls,
    query,
    answer: (rows: Record<string, unknown>[]) => {
      next = rows;
    },
  };
}

const scope = { onRelease: () => undefined };

describe('postgresAdvisoryLockPort (U14)', () => {
  it('locks in physical int8 order with bound params and restores lock_timeout', async () => {
    const fake = fakeSql({
      'a/1': '9223372036854775807',
      'a/2': '-9223372036854775808',
      'b/1': '4611686018427387904',
    });
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
    await port.acquire(
      null,
      [
        { namespace: 'a', key: '1', mode: 'shared' },
        { namespace: 'a', key: '2', mode: 'exclusive', timeoutMs: 200 },
        { namespace: 'b', key: '1', mode: 'shared' },
      ],
      scope,
    );
    expect(fake.calls).toEqual([
      {
        sql: "SELECT l.i::int AS i, ('x' || left(encode(sha256(convert_to(length(l.n) || ':' || l.n || l.k, 'UTF8')), 'hex'), 16))::bit(64)::int8::text AS h, current_setting('transaction_isolation') AS iso, set_config('estela.unit_of_work', 'open', true) AS probe FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS l(n, k, i)",
        params: [
          ['a', 'a', 'b'],
          ['1', '2', '1'],
        ],
      },
      { sql: "SELECT current_setting('lock_timeout') AS prev", params: [] },
      {
        sql: "SELECT set_config('lock_timeout', $1, true) AS lock_timeout",
        params: ['200ms'],
      },
      {
        sql: "SELECT current_setting('estela.unit_of_work', true) AS probe FROM pg_advisory_xact_lock($1::int8)",
        params: ['-9223372036854775808'],
      },
      { sql: "SELECT set_config('lock_timeout', $1, true) AS lock_timeout", params: ['0'] },
      {
        sql: "SELECT current_setting('estela.unit_of_work', true) AS probe FROM pg_advisory_xact_lock_shared($1::int8)",
        params: ['4611686018427387904'],
      },
      {
        sql: "SELECT current_setting('estela.unit_of_work', true) AS probe FROM pg_advisory_xact_lock_shared($1::int8)",
        params: ['9223372036854775807'],
      },
    ]);
  });

  it('uses only transaction-scoped lock functions: no session lock, no unlock path (D32)', async () => {
    const fake = fakeSql({ 'a/1': '1', 'a/2': '2' });
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query, defaultTimeoutMs: 50 });
    await port.acquire(
      null,
      [
        { namespace: 'a', key: '1', mode: 'shared' },
        { namespace: 'a', key: '2', mode: 'exclusive' },
      ],
      scope,
    );
    const lockStatements = fake.calls.map((c) => c.sql).filter((s) => s.includes('pg_advisory'));
    expect(lockStatements).toHaveLength(2);
    for (const sql of lockStatements) expect(sql).toMatch(/pg_advisory_xact_lock(_shared)?\(/);
    for (const { sql } of fake.calls) {
      expect(sql).not.toMatch(/pg_advisory_lock(_shared)?\(/);
      expect(sql).not.toContain('pg_advisory_unlock');
    }
  });

  it.each([
    ['NULL (never set in this session)', null],
    ['the reset value of a placeholder defined earlier', ''],
  ])(
    'rejects a TransactionPort that runs in autocommit mode: the probe comes back as %s',
    async (_label, probe) => {
      const fake = fakeSql({ 'a/x': '1', 'a/y': '2' }, 'pg', 'read committed', probe);
      const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
      const request = [
        { namespace: 'a', key: 'x', mode: 'exclusive' as const },
        { namespace: 'a', key: 'y', mode: 'exclusive' as const },
      ];
      await expect(port.acquire(null, request, scope)).rejects.toBeInstanceOf(SagaUsageError);
      await expect(port.acquire(null, request, scope)).rejects.toThrow('autocommit');
      // It stops at the first lock statement: the one lock it did take is already gone.
      expect(fake.calls.filter((c) => c.sql.includes('pg_advisory'))).toHaveLength(2);
    },
  );

  it('reports an unreadable probe value instead of guessing', async () => {
    const fake = fakeSql({ 'a/x': '1' }, 'array', 'read committed', 'something-else');
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
    await expect(
      port.acquire(null, [{ namespace: 'a', key: 'x', mode: 'shared' }], scope),
    ).rejects.toBeInstanceOf(UnexpectedQueryResultError);
  });

  it('merges physical collisions: exclusive and the smallest timeout win', async () => {
    const fake = fakeSql({ 'a/x': 12n, 'b/y': '12' }, 'array');
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query, defaultTimeoutMs: 90 });
    await port.acquire(
      null,
      [
        { namespace: 'a', key: 'x', mode: 'shared' },
        { namespace: 'b', key: 'y', mode: 'exclusive', timeoutMs: 300 },
      ],
      scope,
    );
    const statements = fake.calls.map((c) => [c.sql.split(' FROM ')[1] ?? c.sql, c.params]);
    expect(statements.slice(2)).toEqual([
      ["SELECT set_config('lock_timeout', $1, true) AS lock_timeout", ['90ms']],
      ['pg_advisory_xact_lock($1::int8)', ['12']],
      ["SELECT set_config('lock_timeout', $1, true) AS lock_timeout", ['0']],
    ]);
  });

  it('issues no timeout statements when no lock has a timeout, and nothing for no locks', async () => {
    const fake = fakeSql({ 'a/x': '1' });
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
    await port.acquire(null, [], scope);
    expect(fake.calls).toEqual([]);
    await port.acquire(null, [{ namespace: 'a', key: 'x', mode: 'exclusive' }], scope);
    expect(fake.calls.map((c) => c.sql.split(' FROM ')[1]?.split(' ')[0])).toEqual([
      'unnest($1::text[],',
      'pg_advisory_xact_lock($1::int8)',
    ]);
  });

  it.each([0, 1.5, -1, 2 ** 31, Number.NaN])(
    'rejects timeoutMs=%p before any query',
    async (timeoutMs) => {
      const fake = fakeSql({});
      const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
      await expect(
        port.acquire(null, [{ namespace: 'a', key: 'x', mode: 'shared', timeoutMs }], scope),
      ).rejects.toBeInstanceOf(TypeError);
      expect(fake.calls).toEqual([]);
      expect(() =>
        postgresAdvisoryLockPort<null>({ query: () => fake.query, defaultTimeoutMs: timeoutMs }),
      ).toThrow(TypeError);
    },
  );

  it('rejects a REPEATABLE READ transaction before taking any lock, unless allowed', async () => {
    const request = [{ namespace: 'user', key: 'u', mode: 'exclusive' as const }];
    const fake = fakeSql({ 'user/u': '1' }, 'pg', 'repeatable read');
    const port = postgresAdvisoryLockPort<null>({ query: () => fake.query });
    await expect(port.acquire(null, request, scope)).rejects.toBeInstanceOf(SagaUsageError);
    await expect(port.acquire(null, request, scope)).rejects.toThrow('REPEATABLE READ');
    expect(fake.calls.filter((c) => c.sql.includes('pg_advisory'))).toEqual([]);
    const allowed = postgresAdvisoryLockPort<null>({
      query: () => fake.query,
      allowSnapshotIsolation: true,
    });
    await allowed.acquire(null, request, scope);
    expect(fake.calls.filter((c) => c.sql.includes('pg_advisory'))).toHaveLength(1);
    for (const iso of ['serializable', 'read committed']) {
      const other = fakeSql({ 'user/u': '1' }, 'array', iso);
      await postgresAdvisoryLockPort<null>({ query: () => other.query }).acquire(
        null,
        request,
        scope,
      );
      expect(other.calls.filter((c) => c.sql.includes('pg_advisory'))).toHaveLength(1);
    }
  });

  it.each([
    ['not a number', 'x'],
    ['above int8', '9223372036854775808'],
    ['below int8', '-9223372036854775809'],
    ['an unsafe JS number', 2 ** 60],
    ['a fraction', '1.5'],
  ])('rejects a hash result it cannot read (%s)', async (_label, h) => {
    const port = postgresAdvisoryLockPort<null>({
      query: () => () =>
        Promise.resolve({ rows: [{ i: 1, h, iso: 'read committed', probe: 'open' }] }),
    });
    await expect(
      port.acquire(null, [{ namespace: 'a', key: 'x', mode: 'shared' }], scope),
    ).rejects.toBeInstanceOf(UnexpectedQueryResultError);
  });

  it('exports the key expression with namespace and key as bound parameters', () => {
    expect(ADVISORY_LOCK_KEY_SQL).toBe(
      "('x' || left(encode(sha256(convert_to(length($1::text) || ':' || $1::text || $2::text, 'UTF8')), 'hex'), 16))::bit(64)::int8",
    );
  });

  it('rejects a short hash result', async () => {
    const short = postgresAdvisoryLockPort<null>({ query: () => () => Promise.resolve([]) });
    await expect(
      short.acquire(null, [{ namespace: 'a', key: 'x', mode: 'shared' }], scope),
    ).rejects.toBeInstanceOf(UnexpectedQueryResultError);
  });
});

describe('postgresTransitionPort (U14)', () => {
  it('builds a parameterized, quoted, SELECT-shaped CAS statement', async () => {
    const fake = fakeSql({});
    const port = postgresTransitionPort<null>({
      query: () => fake.query,
      schema: 'bpm',
      table: 'instances',
      stateColumn: 'status',
      versionColumn: 'rev',
      touchColumn: 'updated_at',
    });
    fake.answer([{ affected: 1, version: '8' }]);
    await expect(
      port.compareAndSet(null, {
        machine: 'm',
        id: 42,
        from: ['PENDING'],
        to: 'RUNNING',
        expectedVersion: 7,
      }),
    ).resolves.toEqual({ affected: 1, version: 8 });
    expect(fake.calls[0]).toEqual({
      sql: 'WITH changed AS (UPDATE "bpm"."instances" SET "status" = $1, "rev" = "rev" + 1, "updated_at" = now() WHERE "id" = $2 AND "status"::text = ANY($3::text[]) AND "rev" = $4 RETURNING "rev") SELECT count(*)::int AS affected, max("rev") AS version FROM changed',
      params: ['RUNNING', 42, ['PENDING'], 7],
    });
    fake.answer([{ affected: 0, version: null }]);
    await expect(
      port.compareAndSet(null, { machine: 'm', id: 42, from: ['PENDING'], to: 'RUNNING' }),
    ).resolves.toEqual({ affected: 0 });
    expect(fake.calls[1]?.sql).not.toContain('$4');
  });

  it('builds the minimal statement without version or touch columns', async () => {
    const fake = fakeSql({}, 'array');
    const port = postgresTransitionPort<null>({ query: () => fake.query, table: 'jobs' });
    fake.answer([{ affected: 1 }]);
    await port.compareAndSet(null, { machine: 'm', id: 'j', from: ['A', 'B'], to: 'C' });
    expect(fake.calls[0]?.sql).toBe(
      'WITH changed AS (UPDATE "jobs" SET "state" = $1 WHERE "id" = $2 AND "state"::text = ANY($3::text[]) RETURNING 1 AS one) SELECT count(*)::int AS affected FROM changed',
    );
    await expect(
      port.compareAndSet(null, { machine: 'm', id: 'j', from: ['A'], to: 'C', expectedVersion: 1 }),
    ).rejects.toThrow('versionColumn');
  });

  it('casts the bound id and state to the given column types for typed-parameter drivers (Prisma)', async () => {
    const fake = fakeSql({}, 'array');
    const port = postgresTransitionPort<null>({
      query: () => fake.query,
      schema: 'app',
      table: 'instances',
      stateColumn: 'status',
      idType: 'uuid',
      stateType: 'app.status_enum',
    });
    fake.answer([{ affected: 1 }]);
    await port.compareAndSet(null, { machine: 'm', id: 'u-1', from: ['A'], to: 'B' });
    expect(fake.calls[0]?.sql).toBe(
      'WITH changed AS (UPDATE "app"."instances" SET "status" = $1::text::"app"."status_enum" WHERE "id" = $2::text::"uuid" AND "status"::text = ANY($3::text[]) RETURNING 1 AS one) SELECT count(*)::int AS affected FROM changed',
    );
    expect(fake.calls[0]?.params).toEqual(['B', 'u-1', ['A']]);
  });

  it.each(['uuid; drop table x', 'a.b.c', 'a..b', 'x"', ''])(
    'rejects the column type %j at construction',
    (type) => {
      const query = () => () => Promise.resolve([]);
      expect(() => postgresTransitionPort<null>({ query, table: 't', idType: type })).toThrow(
        TypeError,
      );
      expect(() => postgresTransitionPort<null>({ query, table: 't', stateType: type })).toThrow(
        TypeError,
      );
    },
  );

  it('reads an int8 version returned as a bigint (Prisma) and never drops an unreadable one', async () => {
    const fake = fakeSql({}, 'array');
    const port = postgresTransitionPort<null>({
      query: () => fake.query,
      table: 'jobs',
      versionColumn: 'version',
    });
    const command = { machine: 'm', id: 1, from: ['A'], to: 'B' };
    fake.answer([{ affected: 1, version: BigInt(8) }]);
    await expect(port.compareAndSet(null, command)).resolves.toEqual({ affected: 1, version: 8 });
    fake.answer([{ affected: 1, version: '9' }]);
    await expect(port.compareAndSet(null, command)).resolves.toEqual({ affected: 1, version: 9 });
    for (const version of [BigInt(2) ** BigInt(60), '9007199254740993', null, 'x', 1.5]) {
      fake.answer([{ affected: 1, version }]);
      await expect(port.compareAndSet(null, command)).rejects.toBeInstanceOf(
        UnexpectedQueryResultError,
      );
    }
    fake.answer([{ affected: 0, version: null }]);
    await expect(port.compareAndSet(null, command)).resolves.toEqual({ affected: 0 });
  });

  it.each([[[{ affected: '1' }]], [[{}]], [[]], [[{ affected: 1.5 }]]])(
    'reports an unreadable count %j as TransitionOutcomeUnknownError',
    async (rows) => {
      const port = postgresTransitionPort<null>({
        query: () => () => Promise.resolve(rows),
        table: 'jobs',
      });
      await expect(
        port.compareAndSet(null, { machine: 'm', id: 1, from: ['A'], to: 'B' }),
      ).rejects.toBeInstanceOf(TransitionOutcomeUnknownError);
    },
  );

  it.each(['a; drop table x', '"x"', 'a'.repeat(64), '1abc', 'a b', 'a.b', '', 'é'])(
    'rejects the identifier %j at construction',
    (name) => {
      const query = () => () => Promise.resolve([]);
      expect(() => postgresTransitionPort<null>({ query, table: name })).toThrow(TypeError);
      expect(() => postgresTransitionPort<null>({ query, table: 't', schema: name })).toThrow(
        TypeError,
      );
      expect(() =>
        postgresTransitionPort<null>({ query, table: 't', versionColumn: name }),
      ).toThrow(TypeError);
    },
  );
});

describe('sql helpers (U14)', () => {
  it('quotes a valid identifier up to 63 chars', () => {
    expect(quoteIdentifier('_a1')).toBe('"_a1"');
    expect(quoteIdentifier('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
  });

  it('reads a row array or { rows } and rejects anything else', () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf({ rows: [{ a: 1 }], rowCount: 9 })).toEqual([{ a: 1 }]);
    for (const raw of [undefined, null, 1, 'x', { rowCount: 1 }, [[{ a: 1 }], 1], { rows: 'x' }]) {
      expect(() => rowsOf(raw)).toThrow(UnexpectedQueryResultError);
    }
  });
});

describe('classifyPostgresError (U14)', () => {
  const nest = (error: unknown, depth: number): unknown => {
    let current = error;
    for (let i = 0; i < depth; i += 1) current = new Error('wrapper', { cause: current });
    return current;
  };

  it('reads pg, TypeORM, Prisma and nested shapes', () => {
    expect(classifyPostgresError({ code: '55P03' })).toBe('lock-timeout');
    expect(classifyPostgresError({ driverError: { code: '40P01' } })).toBe('deadlock');
    expect(classifyPostgresError({ code: 'P2010', meta: { code: '40001' } })).toBe('serialization');
    expect(classifyPostgresError(nest({ code: '40P01' }, 5))).toBe('deadlock');
    expect(classifyPostgresError(nest({ code: '40P01' }, 6))).toBeUndefined();
  });

  it("maps Prisma's ORM-level P2034 (write conflict or deadlock), which carries no SQLSTATE", () => {
    const prisma = Object.assign(new Error('Transaction failed due to a write conflict'), {
      code: 'P2034',
      clientVersion: '5.0.0',
    });
    expect(classifyPostgresError(prisma)).toBe('deadlock');
    expect(classifyPostgresError(new Error('wrapped', { cause: prisma }))).toBe('deadlock');
    expect(classifyPostgresError({ code: 'P2002' })).toBeUndefined();
    expect(classifyPostgresError({ driverError: { code: 'P2034' } })).toBeUndefined();
  });

  it('never classifies connection loss, statement timeout or non-errors', () => {
    for (const code of ['08006', '57014', '57P01', '23505', 40001]) {
      expect(classifyPostgresError({ code })).toBeUndefined();
    }
    expect(classifyPostgresError(undefined)).toBeUndefined();
    expect(classifyPostgresError('40P01')).toBeUndefined();
  });
});
