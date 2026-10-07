/**
 * Saga concurrency against a real Postgres. SKIPPED unless ESTELA_PG_URL is set, so CI and
 * `npm run verify` stay database-free. Each run works in its own throwaway schema, dropped at the
 * end. Advisory locks live in one key space for the whole cluster, so every lock namespace is
 * prefixed with that schema and the waiter probe only counts this run's keys: several runs
 * (parallel worktrees or agents) can share one server. The pool stays small for the same reason.
 * Example:
 *   ESTELA_PG_URL=postgres://postgres:estela@localhost:55433/estela npx jest test/saga-postgres
 */
import { randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  ADVISORY_LOCK_KEY_SQL,
  classifyPostgresError,
  DeadlockError,
  defineStateMachine,
  LockTimeoutError,
  postgresAdvisoryLockPort,
  postgresTransitionPort,
  saga,
  SagaRunner,
  SagaUsageError,
  StaleStateError,
  transition,
  type SagaRunnerOptions,
  type SqlQueryOf,
  type TransactionPort,
} from '../src';

const url = process.env.ESTELA_PG_URL;
const d = url === undefined || url === '' ? describe.skip : describe;

jest.setTimeout(60_000);

const pgQuery: SqlQueryOf<PoolClient> = (c) => (sql, params) => c.query(sql, [...params]);
const arrayQuery: SqlQueryOf<PoolClient> = (c) => async (sql, params) =>
  (await c.query<Record<string, unknown>>(sql, [...params])).rows;

/** Binds every bare string parameter as text, the way Prisma's $queryRawUnsafe types a JS string,
 *  instead of leaving it untyped for Postgres to infer from the column (pg, TypeORM). */
const textTypedQuery: SqlQueryOf<PoolClient> = (c) => async (sql, params) => {
  const typed = sql.replace(/\$(\d+)(?!\d|::)/g, (bare, n: string) =>
    typeof params[Number(n) - 1] === 'string' ? `${bare}::text` : bare,
  );
  return (await c.query<Record<string, unknown>>(typed, [...params])).rows;
};

type Isolation = 'SERIALIZABLE' | 'REPEATABLE READ' | 'READ COMMITTED';

function poolPort(pool: Pool, isolation?: Isolation): TransactionPort<PoolClient> {
  return {
    run: async <T>(work: (tx: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query(
          isolation === undefined ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${isolation}`,
        );
        try {
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      } finally {
        client.release();
      }
    },
    classify: classifyPostgresError,
  };
}

/** A port pinned to one client, so the test can inspect that session after the transaction. */
function clientPort(client: PoolClient): TransactionPort<PoolClient> {
  return {
    run: async <T>(work: (tx: PoolClient) => Promise<T>): Promise<T> => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    },
    classify: classifyPostgresError,
  };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Resolves once `parties` callers arrived; rejects after timeoutMs so a test never hangs. */
function barrier(parties: number, timeoutMs = 5_000): () => Promise<void> {
  let arrived = 0;
  const all = gate();
  return () => {
    arrived += 1;
    if (arrived >= parties) all.open();
    return Promise.race([
      all.wait,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('barrier timeout')), timeoutMs).unref(),
      ),
    ]);
  };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Always lets a lock-holding saga finish, so a failed assertion never leaves a pooled client
 *  inside an open transaction (afterAll's pool.end() would then hang instead of reporting it). */
async function releaseHolder(release: { open: () => void }, holder: Promise<unknown>) {
  release.open();
  await holder.catch(() => undefined);
}

/** Resolves once some session waits on the advisory lock (namespace, key), not granted yet.
 *  Matches the single-int8 form the adapter takes (objsubid = 1: classid holds the high 32 bits,
 *  objid the low 32), so other runs' waiters never count. */
async function untilAdvisoryWaiter(
  pool: Pool,
  namespace: string,
  key: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks, (SELECT ${ADVISORY_LOCK_KEY_SQL} AS h) k WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND classid::int8 = ((k.h >> 32) & 4294967295) AND objid::int8 = (k.h & 4294967295)`,
      [namespace, key],
    );
    if ((waiting.rows[0]?.n ?? 0) > 0) return;
    await settle(10);
  }
  throw new Error('no session ever waited on an advisory lock');
}

async function advisoryLocks(c: PoolClient): Promise<{ mode: string }[]> {
  const result = await c.query<{ mode: string }>(
    "SELECT mode FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
  );
  return result.rows;
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

d('saga concurrency on real Postgres', () => {
  const schema = `estela_it_${randomBytes(6).toString('hex')}`;
  /** Lock namespace scoped to this run, so concurrent runs never share an advisory key. */
  const ns = (name: string): string => `${schema}:${name}`;
  let pool: Pool;
  let runner: SagaRunner<PoolClient>;
  const options = (extra: Partial<SagaRunnerOptions<PoolClient>> = {}) =>
    new SagaRunner<PoolClient>({
      transactions: poolPort(pool),
      locks: postgresAdvisoryLockPort({ query: pgQuery }),
      ...extra,
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 16 });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(`CREATE TYPE ${schema}.job_state AS ENUM ('PENDING', 'RUNNING', 'DONE')`);
    await pool.query(
      `CREATE TABLE ${schema}.jobs (id int PRIMARY KEY, status ${schema}.job_state NOT NULL, rev int NOT NULL DEFAULT 0, updated_at timestamptz)`,
    );
    await pool.query(`CREATE TABLE ${schema}.accounts (id int PRIMARY KEY, balance int NOT NULL)`);
    await pool.query(
      `CREATE TABLE ${schema}.doctors (id int PRIMARY KEY, on_call boolean NOT NULL)`,
    );
    await pool.query(`CREATE TABLE ${schema}.notes (id text PRIMARY KEY)`);
    await pool.query(
      `CREATE TABLE ${schema}.instances (id uuid PRIMARY KEY, status ${schema}.job_state NOT NULL)`,
    );
    await pool.query(
      `CREATE TABLE ${schema}.starts (id serial PRIMARY KEY, user_id text NOT NULL)`,
    );
    runner = options();
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await pool.end();
  });

  interface LockCtx {
    key: string;
    entered?: () => void;
    hold?: Promise<void>;
  }

  const exclusiveOn = (timeoutMs?: number) =>
    saga<LockCtx, PoolClient, string>('exclusive')
      .lock(ns('res'), (c) => c.key, 'exclusive', timeoutMs === undefined ? {} : { timeoutMs })
      .transaction('hold', async (c) => {
        c.entered?.();
        await c.hold;
      })
      .reply(() => 'done');

  it('P1: an exclusive lock serializes; lock_timeout gives LockTimeoutError, retry then succeeds', async () => {
    const entered = gate();
    const release = gate();
    const holder = runner.run(exclusiveOn(), {
      key: 'p1',
      entered: entered.open,
      hold: release.wait,
    });
    try {
      await entered.wait;

      const started = Date.now();
      const timedOut = await runner.run(exclusiveOn(200), { key: 'p1' }).catch((e: unknown) => e);
      expect(timedOut).toBeInstanceOf(LockTimeoutError);
      expect((timedOut as LockTimeoutError).cause).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(195);

      const attempts: number[] = [];
      const retrying = saga<LockCtx, PoolClient, string>('exclusive-retry')
        .lock(ns('res'), (c) => c.key, 'exclusive', { timeoutMs: 100 })
        .transaction('work', (_c, _tx, unit) => {
          attempts.push(unit.attempt);
        })
        .retry({ on: ['lock-timeout'], attempts: 20, backoffMs: 20, maxBackoffMs: 50 })
        .reply(() => 'retried');
      const contender = runner.run(retrying, { key: 'p1' });
      await settle(300);
      release.open();
      await expect(holder).resolves.toBe('done');
      await expect(contender).resolves.toBe('retried');
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toBeGreaterThan(1);
    } finally {
      await releaseHolder(release, holder);
    }
  });

  it('P2: shared locks overlap; shared against exclusive blocks', async () => {
    const meet = barrier(2);
    const both = saga<LockCtx, PoolClient, string>('shared')
      .lock(ns('res'), (c) => c.key, 'shared')
      .transaction('meet', () => meet())
      .reply(() => 'met');
    await expect(
      Promise.all([runner.run(both, { key: 'p2' }), runner.run(both, { key: 'p2' })]),
    ).resolves.toEqual(['met', 'met']);

    const entered = gate();
    const release = gate();
    const reader = saga<LockCtx, PoolClient, string>('reader')
      .lock(ns('res'), (c) => c.key, 'shared')
      .transaction('hold', async (c) => {
        c.entered?.();
        await c.hold;
      })
      .reply(() => 'read');
    const holding = runner.run(reader, { key: 'p2', entered: entered.open, hold: release.wait });
    try {
      await entered.wait;
      await expect(runner.run(exclusiveOn(200), { key: 'p2' })).rejects.toBeInstanceOf(
        LockTimeoutError,
      );
      release.open();
      await expect(holding).resolves.toBe('read');
    } finally {
      await releaseHolder(release, holding);
    }
  });

  it('P3, P4: locks are transaction-scoped and lock_timeout never leaks into the step', async () => {
    const client = await pool.connect();
    try {
      await client.query("SET lock_timeout = '3s'");
      const pinned = new SagaRunner<PoolClient>({
        transactions: clientPort(client),
        locks: postgresAdvisoryLockPort({ query: pgQuery }),
      });
      const inside: { locks: number; timeout: string }[] = [];
      const build = (fail: boolean) =>
        saga<LockCtx, PoolClient, null>('scoped')
          .lock(ns('res'), (c) => [c.key, `${c.key}-b`], 'exclusive', { timeoutMs: 500 })
          .transaction('inspect', async (_c, tx) => {
            const timeout = await tx.query<{ lock_timeout: string }>('SHOW lock_timeout');
            inside.push({
              locks: (await advisoryLocks(tx)).length,
              timeout: timeout.rows[0]?.lock_timeout ?? '',
            });
            if (fail) throw new Error('rollback');
          })
          .reply(() => null);
      await pinned.run(build(false), { key: 'p3' });
      expect(await advisoryLocks(client)).toEqual([]);
      await expect(pinned.run(build(true), { key: 'p3' })).rejects.toThrow('rollback');
      expect(await advisoryLocks(client)).toEqual([]);
      expect(inside).toEqual([
        { locks: 2, timeout: '3s' },
        { locks: 2, timeout: '3s' },
      ]);
    } finally {
      await client.query('RESET lock_timeout');
      client.release();
    }
  });

  it('P5: 64 sagas with random lock subsets in random order never deadlock', async () => {
    const random = seeded(42);
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5'];
    const runs = Array.from({ length: 64 }, (_, i) => {
      const picked = keys
        .filter(() => random() < 0.6)
        .sort(() => random() - 0.5)
        .map((key) => ({
          key,
          mode: random() < 0.5 ? ('shared' as const) : ('exclusive' as const),
        }));
      if (picked.length === 0) picked.push({ key: 'k1', mode: 'exclusive' });
      let builder = saga<{ i: number }, PoolClient, number>(`random-${i}`);
      for (const { key, mode } of picked) builder = builder.lock(ns('p5'), () => key, mode);
      const definition = builder
        .transaction('work', async (_c, tx) => {
          await tx.query('SELECT pg_sleep(0.005)');
        })
        .reply((c) => c.i);
      return runner.run(definition, { i });
    });
    const results = await Promise.allSettled(runs);
    const failures = results.filter((r) => r.status === 'rejected');
    expect(failures).toEqual([]);
  });

  it('P5 control: taking the same locks in declaration order does deadlock (40P01)', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [ns('ctl'), 'A']);
      await b.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [ns('ctl'), 'B']);
      const results = await Promise.allSettled([
        a.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [ns('ctl'), 'B']),
        b.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [ns('ctl'), 'A']),
      ]);
      const codes = results.map((r) =>
        r.status === 'rejected' ? classifyPostgresError(r.reason) : 'ok',
      );
      codes.sort();
      expect(codes).toEqual(['deadlock', 'ok']);
    } finally {
      await a.query('ROLLBACK');
      await b.query('ROLLBACK');
      a.release();
      b.release();
    }
  });

  it('P6: keys that collide under 32-bit hashtext are distinct locks', async () => {
    // hashtext is a 32-bit hash: a caller who picks part of a key can brute-force a collision
    // with someone else's key offline. The int8 SHA-256 identity must keep the two apart.
    const found = await pool.query<{ ks: string[] }>(
      "SELECT array_agg(k ORDER BY k) AS ks FROM (SELECT 'c' || g AS k FROM generate_series(1, 400000) g) s GROUP BY hashtext(k) HAVING count(*) = 2 ORDER BY min(k) LIMIT 1",
    );
    const [victim = '', attacker = ''] = found.rows[0]?.ks ?? [];
    expect(victim).not.toBe('');
    const collides = await pool.query<{ same: boolean }>(
      'SELECT hashtext($1) = hashtext($2) AS same',
      [victim, attacker],
    );
    expect(collides.rows[0]?.same).toBe(true);

    const holding = gate();
    const release = gate();
    const hold = saga<{ k: string }, PoolClient, null>('hold')
      .lock(ns('p6'), (c) => c.k, 'exclusive')
      .transaction('hold', async () => {
        holding.open();
        await release.wait;
      })
      .reply(() => null);
    const probe = saga<{ k: string }, PoolClient, string>('probe')
      .lock(ns('p6'), (c) => c.k, 'exclusive', { timeoutMs: 300 })
      .transaction('noop', () => undefined)
      .reply((c) => c.k);
    const holder = runner.run(hold, { k: victim });
    try {
      await holding.wait;
      await expect(runner.run(probe, { k: attacker })).resolves.toBe(attacker);
      await expect(runner.run(probe, { k: victim })).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      await releaseHolder(release, holder);
    }
  });

  it('P6b: shared and exclusive on the same key merge to one exclusive lock', async () => {
    const merged: { mode: string }[][] = [];
    const twice = saga<{ k: string }, PoolClient, null>('twice')
      .lock(ns('p6b'), (c) => c.k, 'shared')
      .lock(ns('p6b'), (c) => c.k, 'exclusive')
      .transaction('inspect', async (_c, tx) => {
        merged.push(await advisoryLocks(tx));
      })
      .reply(() => null);
    await runner.run(twice, { k: 'same' });
    expect(merged).toEqual([[{ mode: 'ExclusiveLock' }]]);
  });

  it('P7: namespaces and keys with quotes, $$, semicolons and unicode are bound parameters', async () => {
    const seen: number[] = [];
    const odd = saga<{ k: string }, PoolClient, null>('odd')
      .lock(ns("ns'; DROP TABLE x; --"), (c) => c.k, 'exclusive', { timeoutMs: 1_000 })
      .transaction('inspect', async (_c, tx) => {
        seen.push((await advisoryLocks(tx)).length);
      })
      .reply(() => null);
    await runner.run(odd, { k: "$$ ' ; \\ é中\u{1F600}" });
    expect(seen).toEqual([1]);
  });

  describe('P8: compare-and-set transitions', () => {
    const Job = defineStateMachine('job', {
      PENDING: ['RUNNING'],
      RUNNING: ['DONE'],
      DONE: [],
    });

    it('20 concurrent PENDING to RUNNING give exactly one winner and 19 StaleStateError', async () => {
      await pool.query(`INSERT INTO ${schema}.jobs (id, status) VALUES (1, 'PENDING')`);
      const port = postgresTransitionPort<PoolClient>({
        query: pgQuery,
        schema,
        table: 'jobs',
        stateColumn: 'status',
        versionColumn: 'rev',
        touchColumn: 'updated_at',
      });
      const start = saga<{ n: number }, PoolClient, number>('start-job')
        .transaction('cas', async (_c, tx) => {
          await transition(Job, port, tx, { id: 1, to: 'RUNNING', from: 'PENDING' });
          await tx.query('SELECT pg_sleep(0.05)');
        })
        .reply((c) => c.n);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, n) => runner.run(start, { n })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(19);
      for (const r of rejected) expect(r.reason).toBeInstanceOf(StaleStateError);
      const row = await pool.query<{ status: string; rev: number; updated_at: Date | null }>(
        `SELECT status, rev, updated_at FROM ${schema}.jobs WHERE id = 1`,
      );
      expect(row.rows[0]).toMatchObject({ status: 'RUNNING', rev: 1 });
      expect(row.rows[0]?.updated_at).not.toBeNull();

      const tx = await pool.connect();
      try {
        await expect(
          transition(Job, port, tx, { id: 1, to: 'DONE', expectedVersion: 0 }),
        ).rejects.toBeInstanceOf(StaleStateError);
        await expect(
          transition(Job, port, tx, { id: 1, to: 'DONE', expectedVersion: 1 }),
        ).resolves.toEqual({ id: 1, from: ['RUNNING'], to: 'DONE', version: 2 });
      } finally {
        tx.release();
      }
    });
  });

  it('P9: opposite-order row updates deadlock (40P01) and retry makes both commit', async () => {
    await pool.query(`INSERT INTO ${schema}.accounts VALUES (1, 0), (2, 0)`);
    const build = (first: number, second: number, retry: boolean, meet: () => Promise<void>) => {
      const builder = saga<{ n: number }, PoolClient, string>(`transfer-${first}`).transaction(
        'move',
        async (_c, tx, unit) => {
          await tx.query(`UPDATE ${schema}.accounts SET balance = balance + 1 WHERE id = $1`, [
            first,
          ]);
          if (unit.attempt === 1) await meet();
          await tx.query(`UPDATE ${schema}.accounts SET balance = balance - 1 WHERE id = $1`, [
            second,
          ]);
        },
      );
      return (
        retry ? builder.retry({ on: ['deadlock'], attempts: 3, backoffMs: 10 }) : builder
      ).reply(() => 'ok');
    };
    const meet1 = barrier(2);
    const plain = await Promise.allSettled([
      runner.run(build(1, 2, false, meet1), { n: 1 }),
      runner.run(build(2, 1, false, meet1), { n: 2 }),
    ]);
    const failed = plain.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toBeInstanceOf(DeadlockError);
    expect((failed[0]?.reason as DeadlockError).cause).toMatchObject({ code: '40P01' });

    const meet2 = barrier(2);
    await expect(
      Promise.all([
        runner.run(build(1, 2, true, meet2), { n: 1 }),
        runner.run(build(2, 1, true, meet2), { n: 2 }),
      ]),
    ).resolves.toEqual(['ok', 'ok']);
  });

  it('P10: serializable write skew raises 40001, is retried and converges', async () => {
    await pool.query(`INSERT INTO ${schema}.doctors VALUES (1, true), (2, true)`);
    const serializable = options({ transactions: poolPort(pool, 'SERIALIZABLE') });
    const meet = barrier(2);
    const attempts: number[] = [];
    const goOffCall = saga<{ id: number }, PoolClient, null>('off-call')
      .transaction('check', async (c, tx, unit) => {
        attempts.push(unit.attempt);
        const onCall = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${schema}.doctors WHERE on_call`,
        );
        if (unit.attempt === 1) await meet();
        if ((onCall.rows[0]?.n ?? 0) >= 2) {
          await tx.query(`UPDATE ${schema}.doctors SET on_call = false WHERE id = $1`, [c.id]);
        }
      })
      .retry({ on: ['serialization'], attempts: 4, backoffMs: 10 })
      .reply(() => null);
    await Promise.all([
      serializable.run(goOffCall, { id: 1 }),
      serializable.run(goOffCall, { id: 2 }),
    ]);
    const left = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${schema}.doctors WHERE on_call`,
    );
    expect(left.rows[0]?.n).toBe(1);
    expect(Math.max(...attempts)).toBeGreaterThan(1);
  });

  it('P11: afterCommit sees the committed row from another connection, never on rollback', async () => {
    const seen: number[] = [];
    const build = (fail: boolean) =>
      saga<{ id: string }, PoolClient, null>('notes')
        .transaction('insert', async (c, tx, unit) => {
          await tx.query(`INSERT INTO ${schema}.notes VALUES ($1)`, [c.id]);
          unit.afterCommit(async () => {
            const found = await pool.query(`SELECT 1 FROM ${schema}.notes WHERE id = $1`, [c.id]);
            seen.push(found.rowCount ?? 0);
          });
          if (fail) throw new Error('rollback');
        })
        .reply(() => null);
    await runner.run(build(false), { id: 'a' });
    await expect(runner.run(build(true), { id: 'b' })).rejects.toThrow('rollback');
    expect(seen).toEqual([1]);
  });

  it('P12: the adapters work with a row-array (TypeORM-style) query function', async () => {
    await pool.query(`INSERT INTO ${schema}.jobs (id, status) VALUES (12, 'PENDING')`);
    const Job = defineStateMachine('job', { PENDING: ['RUNNING'], RUNNING: [] });
    const port = postgresTransitionPort<PoolClient>({
      query: arrayQuery,
      schema,
      table: 'jobs',
      stateColumn: 'status',
      versionColumn: 'rev',
    });
    const arrays = options({
      locks: postgresAdvisoryLockPort({ query: arrayQuery, defaultTimeoutMs: 500 }),
    });
    const definition = saga<{ id: number }, PoolClient, number | undefined>('array-shaped')
      .lock(ns('job'), (c) => String(c.id), 'exclusive')
      .transaction('cas', async (c, tx) => {
        const outcome = await transition(Job, port, tx, { id: c.id, to: 'RUNNING' });
        c.id = outcome.version ?? -1;
      })
      .reply((c) => c.id);
    await expect(arrays.run(definition, { id: 12 })).resolves.toBe(1);
  });

  it('P15: with typed text parameters (Prisma), a uuid id and an enum state need idType/stateType', async () => {
    const id = '6f1c2a52-0b4e-4c55-9d43-2c1f0f7f3a10';
    await pool.query(`INSERT INTO ${schema}.instances (id, status) VALUES ($1, 'PENDING')`, [id]);
    const Instance = defineStateMachine('instance', { PENDING: ['RUNNING'], RUNNING: [] });
    const base = { query: textTypedQuery, schema, table: 'instances', stateColumn: 'status' };
    const client = await pool.connect();
    try {
      const untyped = postgresTransitionPort<PoolClient>(base);
      const failure: unknown = await transition(Instance, untyped, client, {
        id,
        to: 'RUNNING',
      }).catch((e: unknown) => e);
      expect(failure).toMatchObject({ code: expect.stringMatching(/^42(883|804)$/) as string });
      const typed = postgresTransitionPort<PoolClient>({
        ...base,
        idType: 'uuid',
        stateType: `${schema}.job_state`,
      });
      await expect(transition(Instance, typed, client, { id, to: 'RUNNING' })).resolves.toEqual({
        id,
        from: ['PENDING'],
        to: 'RUNNING',
      });
      await expect(
        transition(Instance, typed, client, { id, to: 'RUNNING', from: 'PENDING' }),
      ).rejects.toBeInstanceOf(StaleStateError);
    } finally {
      client.release();
    }
    const row = await pool.query<{ status: string }>(
      `SELECT status FROM ${schema}.instances WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]?.status).toBe('RUNNING');
  });

  it('P13: ms-bpm Start/Publish: per-user starts run in parallel, same user and Publish serialize', async () => {
    const STEP_MS = 300;
    interface FlowCtx {
      flowId: string;
      userId?: string;
      spans: [string, number, number][];
    }
    const start = saga<FlowCtx, PoolClient, null>('start')
      .lock(ns('flow'), (c) => c.flowId, 'shared')
      .lock(ns('flow-start'), (c) => `${c.flowId}:${c.userId ?? ''}`, 'exclusive')
      .transaction('start', async (c, tx) => {
        const begin = Date.now();
        await tx.query(`SELECT pg_sleep(${STEP_MS / 1000})`);
        c.spans.push([`start:${c.userId ?? ''}`, begin, Date.now()]);
      })
      .reply(() => null);
    const publish = saga<FlowCtx, PoolClient, null>('publish')
      .lock(ns('flow'), (c) => c.flowId, 'exclusive')
      .transaction('publish', async (c, tx) => {
        const begin = Date.now();
        await tx.query(`SELECT pg_sleep(${STEP_MS / 1000})`);
        c.spans.push(['publish', begin, Date.now()]);
      })
      .reply(() => null);
    const timed = async (work: () => Promise<unknown>) => {
      const begin = Date.now();
      await work();
      return Date.now() - begin;
    };
    const spans: [string, number, number][] = [];
    const single = await timed(() => runner.run(start, { flowId: 'f', userId: 'u0', spans }));
    const parallel = await timed(() =>
      Promise.all([
        runner.run(start, { flowId: 'f', userId: 'u1', spans }),
        runner.run(start, { flowId: 'f', userId: 'u2', spans }),
      ]),
    );
    expect(parallel).toBeLessThan(single * 1.5);
    const serial = await timed(() =>
      Promise.all([
        runner.run(start, { flowId: 'f', userId: 'u3', spans }),
        runner.run(start, { flowId: 'f', userId: 'u3', spans }),
      ]),
    );
    expect(serial).toBeGreaterThanOrEqual(STEP_MS * 2 - 20);

    const mixed: [string, number, number][] = [];
    await Promise.all([
      runner.run(start, { flowId: 'g', userId: 'a', spans: mixed }),
      runner.run(publish, { flowId: 'g', spans: mixed }),
      runner.run(start, { flowId: 'g', userId: 'b', spans: mixed }),
    ]);
    const pub = mixed.find(([name]) => name === 'publish');
    expect(pub).toBeDefined();
    for (const [name, begin, end] of mixed) {
      if (name === 'publish' || pub === undefined) continue;
      const overlaps = begin < pub[2] && pub[1] < end;
      expect(overlaps).toBe(false);
    }
  });
  describe('P14: advisory locks and the isolation level of the step reads', () => {
    interface StartCtx {
      user: string;
      entered?: () => void;
      hold?: Promise<void>;
    }
    /** ms-bpm "one Start per user": read-then-insert under an exclusive per-user lock. */
    const startOnce = saga<StartCtx, PoolClient, null>('start-once')
      .lock(ns('user'), (c) => c.user, 'exclusive', { timeoutMs: 5_000 })
      .transaction('start', async (c, tx) => {
        const found = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${schema}.starts WHERE user_id = $1`,
          [c.user],
        );
        if ((found.rows[0]?.n ?? 0) === 0) {
          await tx.query(`INSERT INTO ${schema}.starts (user_id) VALUES ($1)`, [c.user]);
        }
        c.entered?.();
        await c.hold;
      })
      // ctx holds a gate (functions, a promise) and steps never mutate it: nothing to restore.
      .retry({
        on: ['serialization'],
        attempts: 3,
        backoffMs: 10,
        checkpoint: () => () => undefined,
      })
      .reply(() => null);

    /** Run A holds the lock after inserting; run B takes its snapshot, then waits on the lock. */
    async function race(contender: SagaRunner<PoolClient>, user: string): Promise<number> {
      const entered = gate();
      const release = gate();
      const first = contender.run(startOnce, { user, entered: entered.open, hold: release.wait });
      try {
        await Promise.race([entered.wait, first]);
        const second = contender.run(startOnce, { user });
        await untilAdvisoryWaiter(pool, ns('user'), user);
        release.open();
        await Promise.all([first, second]);
      } finally {
        await releaseHolder(release, first);
      }
      const rows = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${schema}.starts WHERE user_id = $1`,
        [user],
      );
      return rows.rows[0]?.n ?? -1;
    }

    const runnerAt = (isolation: Isolation, allowSnapshotIsolation = false) =>
      options({
        transactions: poolPort(pool, isolation),
        locks: postgresAdvisoryLockPort({ query: pgQuery, allowSnapshotIsolation }),
      });

    it('rejects a REPEATABLE READ transaction with SagaUsageError before any lock or write', async () => {
      await expect(
        runnerAt('REPEATABLE READ').run(startOnce, { user: 'rr' }),
      ).rejects.toBeInstanceOf(SagaUsageError);
      const rows = await pool.query(`SELECT 1 FROM ${schema}.starts WHERE user_id = 'rr'`);
      expect(rows.rowCount).toBe(0);
    });

    it('control: under REPEATABLE READ the lock serializes but the stale snapshot inserts twice', async () => {
      await expect(race(runnerAt('REPEATABLE READ', true), 'rr-allowed')).resolves.toBe(2);
    });

    it('keeps one row per user under READ COMMITTED', async () => {
      await expect(race(runnerAt('READ COMMITTED'), 'rc')).resolves.toBe(1);
    });

    it('keeps one row per user under SERIALIZABLE with retry on serialization', async () => {
      await expect(race(runnerAt('SERIALIZABLE'), 'ser')).resolves.toBe(1);
    });
  });
});
