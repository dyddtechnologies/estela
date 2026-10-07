import { Logger } from '@nestjs/common';
import { MemoryLockPort } from '../testing/memory-lock-port';
import { MemoryTransitionPort } from '../testing/memory-transition-port';
import { testUnitOfWork } from '../testing/test-unit-of-work';
import { HopLogger } from '../trace/hop-logger';
import {
  ConcurrencyError,
  DeadlockError,
  LockTimeoutError,
  SagaDefinitionError,
  SagaUsageError,
  SerializationError,
  toConcurrencyError,
} from './concurrency-errors';
import { IdempotencyInProgressError, MemoryIdempotencyLedger } from './idempotency-ledger';
import { classifyPostgresError } from './postgres/error-classifier';
import type * as ConcurrencyErrors from './concurrency-errors';
import type { LockPort, LockRequest } from './lock-port';
import type { RetryPolicy } from './retry-policy';
import {
  saga,
  type OutboundOptions,
  type SagaDefinition,
  type TransactionStep,
  type UnitOfWork,
} from './saga';
import { SagaRunner, type SagaRunnerOptions } from './saga-runner';
import { FakeDb, pgError, TxLedger } from './saga-test-kit';
import { defineStateMachine, IllegalTransitionError } from './state-machine';
import type { TransactionPort } from './transaction-port';
import { StaleStateError, transition, TransitionOutcomeUnknownError } from './transition';

interface Ctx {
  id: string;
  key?: string;
  trail: string[];
  orderId?: string;
  userIds?: string[];
}

const noSleep = (): Promise<void> => Promise.resolve();
const zero = (): number => 0;

function runnerFor(db: FakeDb, extra: Partial<SagaRunnerOptions<string[]>> = {}) {
  return new SagaRunner<string[]>({
    transactions: db.port,
    sleep: noSleep,
    random: zero,
    ...extra,
  });
}

/** Records the hop lines a HopLogger would print, without the trace tag. */
function recordingLogger(): { logger: HopLogger; lines: string[]; errors: string[] } {
  const logger = new HopLogger('log');
  const lines: string[] = [];
  const errors: string[] = [];
  jest
    .spyOn(logger as unknown as { emit: (line: string) => void }, 'emit')
    .mockImplementation((line) => {
      lines.push(line.split(' [')[0] ?? line);
    });
  jest.spyOn(logger, 'hopError').mockImplementation((_c, target) => {
    errors.push(target);
  });
  return { logger, lines, errors };
}

/** A LockPort that records into a shared event log and delegates to MemoryLockPort. */
function recordingLocks(events: string[]): LockPort<string[]> & { inner: MemoryLockPort } {
  const inner = new MemoryLockPort<string[]>();
  return {
    inner,
    acquire: async (tx, locks, scope) => {
      const described = locks.map((l) => [l.namespace, l.key, l.mode].join('/')).join(',');
      events.push(`acquire:${described}`);
      await inner.acquire(tx, locks, scope);
    },
  };
}

const push =
  (events: string[], name: string): TransactionStep<Ctx, string[]> =>
  (ctx, tx) => {
    events.push(name);
    tx.push(`${ctx.id}:${name}`);
  };

describe('saga concurrency: builder and lock placement (U1)', () => {
  const noop = (): void => undefined;

  it('rejects a lock that is not followed by a transaction step in the same unit of work', () => {
    expect(() =>
      saga<Ctx>('s')
        .lock('x', (c) => c.id, 'exclusive')
        .outbound('o', noop),
    ).toThrow(SagaDefinitionError);
    expect(() =>
      saga<Ctx>('s')
        .transaction('a', noop)
        .lock('x', (c) => c.id, 'shared')
        .outbound('o', noop),
    ).toThrow(
      'lock "x" in saga "s" is not followed by a transaction step in the same unit of work',
    );
    expect(() =>
      saga<Ctx>('s')
        .transaction('a', noop)
        .lock('x', (c) => c.id, 'shared')
        .reply((c) => c),
    ).toThrow(SagaDefinitionError);
    expect(() =>
      saga<Ctx>('s')
        .lock('x', (c) => c.id, 'shared')
        .reply((c) => c),
    ).toThrow(SagaDefinitionError);
  });

  it('validates the lock declaration eagerly', () => {
    const b = () => saga<Ctx>('s');
    expect(() => b().lock('', (c) => c.id, 'shared')).toThrow(SagaDefinitionError);
    expect(() => b().lock('n'.repeat(201), (c) => c.id, 'shared')).toThrow(SagaDefinitionError);
    expect(() => b().lock('x', (c) => c.id, 'upgrade' as 'shared')).toThrow(SagaDefinitionError);
    for (const timeoutMs of [0, 1.5, -1, 2 ** 31, Number.NaN]) {
      expect(() => b().lock('x', (c) => c.id, 'shared', { timeoutMs })).toThrow(
        SagaDefinitionError,
      );
    }
    expect(() => b().lock('x', 'id' as unknown as () => string, 'shared')).toThrow(
      SagaDefinitionError,
    );
  });

  it('hoists a lock written between two transaction steps to the segment start', async () => {
    const db = new FakeDb();
    const events: string[] = [];
    const definition = saga<Ctx, string[], string[]>('hoist')
      .transaction('a', push(events, 'a'))
      .lock('x', (c) => c.id, 'exclusive')
      .transaction('b', push(events, 'b'))
      .reply((c) => c.trail);
    expect(definition.steps[1]).toMatchObject({ kind: 'transaction', name: 'b' });
    await runnerFor(db, { locks: recordingLocks(events) }).run(definition, { id: 'i', trail: [] });
    expect(events).toEqual(['acquire:x/i/exclusive', 'a', 'b']);
    expect(db.transactions).toBe(1);
  });

  it('binds a lock written after an outbound step to the next segment', async () => {
    const db = new FakeDb();
    const events: string[] = [];
    const definition = saga<Ctx, string[], null>('forward')
      .transaction('a', push(events, 'a'))
      .outbound('o', () => {
        events.push('o');
      })
      .lock('x', (c) => c.id, 'shared')
      .transaction('b', push(events, 'b'))
      .reply(() => null);
    expect(definition.steps[0]).not.toHaveProperty('locks');
    expect(definition.steps[2]).toMatchObject({ name: 'b', locks: [{ namespace: 'x' }] });
    await runnerFor(db, { locks: recordingLocks(events) }).run(definition, { id: 'i', trail: [] });
    expect(events).toEqual(['a', 'o', 'acquire:x/i/shared', 'b']);
  });

  it('validates the retry policy eagerly and allows it only once', () => {
    const b = () => saga<Ctx>('s').transaction('a', () => undefined);
    const ok = { on: ['deadlock'] as const, attempts: 3, backoffMs: 10 };
    for (const attempts of [0, 21, 1.5]) {
      expect(() => b().retry({ ...ok, attempts })).toThrow(SagaDefinitionError);
    }
    expect(() => b().retry({ ...ok, backoffMs: -1 })).toThrow(SagaDefinitionError);
    expect(() => b().retry({ ...ok, maxBackoffMs: 5 })).toThrow(SagaDefinitionError);
    expect(() => b().retry({ ...ok, on: [] })).toThrow(SagaDefinitionError);
    expect(() => b().retry({ ...ok, on: ['deadlock', 'deadlock'] })).toThrow(SagaDefinitionError);
    expect(() => b().retry({ ...ok, on: ['boom' as 'deadlock'] })).toThrow(SagaDefinitionError);
    expect(() => b().retry({ ...ok, jitter: 'wild' as 'full' })).toThrow(SagaDefinitionError);
    expect(() => b().retry(ok).retry(ok)).toThrow('already declares a retry policy');
    expect(() => b().retry({ ...ok, attempts: 20, maxBackoffMs: 10 })).not.toThrow();
  });

  it('freezes the definition, its steps, its locks and its retry policy', () => {
    const definition = saga<Ctx>('frozen')
      .lock('x', (c) => c.id, 'exclusive')
      .transaction('a', () => undefined)
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply((c) => c);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.steps)).toBe(true);
    expect(Object.isFrozen(definition.retry)).toBe(true);
    expect(Object.isFrozen(definition.retry?.on)).toBe(true);
    const first = definition.steps[0];
    expect(first?.kind === 'transaction' && Object.isFrozen(first.locks)).toBe(true);
    expect(first?.kind === 'transaction' && Object.isFrozen(first.locks?.[0])).toBe(true);
  });
});

describe('saga concurrency: runner and locks (U3)', () => {
  it('acquires once per segment, after the claim and before the first step; none on replay', async () => {
    const db = new FakeDb();
    const events: string[] = [];
    const ledger = new TxLedger(db);
    const claim = ledger.claim.bind(ledger);
    jest.spyOn(ledger, 'claim').mockImplementation((tx, scope, key) => {
      events.push('claim');
      return claim(tx, scope, key);
    });
    const definition = saga<Ctx, string[], string>('locked')
      .idempotent((c) => c.key)
      .lock('order', (c) => c.orderId, 'exclusive')
      .lock('user', (c) => c.userIds, 'shared')
      .transaction('a', push(events, 'a'))
      .transaction('b', push(events, 'b'))
      .outbound('o', () => {
        events.push('o');
      })
      .lock('order', (c) => c.orderId, 'shared')
      .transaction('c', push(events, 'c'))
      .reply(() => 'done');
    const runner = runnerFor(db, { ledger, locks: recordingLocks(events) });
    const ctx = { id: 'i', key: 'k', trail: [], orderId: 'o1', userIds: ['u2', 'u1', 'u2'] };
    await expect(runner.run(definition, ctx)).resolves.toBe('done');
    expect(events).toEqual([
      'claim',
      'acquire:order/o1/exclusive,user/u1/shared,user/u2/shared',
      'a',
      'b',
      'o',
      'acquire:order/o1/shared',
      'c',
    ]);
    events.length = 0;
    await expect(runner.run(definition, { ...ctx, id: 'j' })).resolves.toBe('done');
    expect(events).toEqual(['claim']);
  });

  it('collapses shared and exclusive on the same key into one exclusive request', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const definition = saga<Ctx, string[], null>('upgrade')
      .lock('flow', (c) => c.id, 'shared')
      .transaction('a', () => undefined)
      .lock('flow', (c) => c.id, 'exclusive', { timeoutMs: 50 })
      .transaction('b', () => undefined)
      .reply(() => null);
    await runnerFor(db, { locks }).run(definition, { id: 'f', trail: [] });
    expect(locks.acquisitions).toEqual([
      [{ namespace: 'flow', key: 'f', mode: 'exclusive', timeoutMs: 50 }],
    ]);
  });

  it('throws SagaUsageError before any transaction when the runner has no LockPort', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], null>('nolock')
      .lock('x', (c) => c.id, 'exclusive')
      .transaction('a', () => undefined)
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toBeInstanceOf(
      SagaUsageError,
    );
    expect(db.transactions).toBe(0);
  });

  it('rejects a missing or empty key unless the lock is optional, before any transaction', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const build = (optional: boolean, keyOf: (c: Ctx) => string | string[] | undefined) =>
      saga<Ctx, string[], null>('keys')
        .lock('x', keyOf, 'exclusive', { optional })
        .transaction('a', () => undefined)
        .reply(() => null);
    const runner = runnerFor(db, { locks });
    const ctx = { id: 'i', trail: [] };
    await expect(
      runner.run(
        build(false, () => undefined),
        ctx,
      ),
    ).rejects.toThrow(SagaUsageError);
    await expect(
      runner.run(
        build(false, () => []),
        ctx,
      ),
    ).rejects.toThrow('resolved no key');
    await expect(
      runner.run(
        build(true, () => ['']),
        ctx,
      ),
    ).rejects.toThrow('empty');
    expect(db.transactions).toBe(0);
    await runner.run(
      build(true, () => undefined),
      ctx,
    );
    expect(locks.acquisitions).toEqual([]);
    expect(db.transactions).toBe(1);
  });

  it('propagates a throwing keyOf without starting a transaction or retrying', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], null>('throws')
      .lock(
        'x',
        () => {
          throw pgError('40P01');
        },
        'exclusive',
      )
      .transaction('a', () => undefined)
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    await expect(
      runnerFor(db, { locks: new MemoryLockPort() }).run(definition, { id: 'i', trail: [] }),
    ).rejects.toThrow('pg error 40P01');
    expect(db.transactions).toBe(0);
  });

  it('logs lock acquisition as a locks:<n> hop', async () => {
    const db = new FakeDb();
    const { logger, lines } = recordingLogger();
    const definition = saga<Ctx, string[], null>('logged')
      .lock('x', (c) => [c.id, 'z'], 'exclusive')
      .transaction('a', () => undefined)
      .reply(() => null);
    await runnerFor(db, { locks: new MemoryLockPort(), logger }).run(definition, {
      id: 'i',
      trail: [],
    });
    expect(lines.map((l) => l.replace(/ \d+ms$/, ''))).toEqual([
      '▶ flow logged on saga:logged',
      '→ hop saga:logged locks:2',
      '← hop saga:logged locks:2 ok',
      '→ hop saga:logged transaction:a',
      '← hop saga:logged transaction:a ok',
      expect.stringMatching(/^■ flow logged on saga:logged completed/),
    ]);
  });
});

describe('saga concurrency: retry (U4)', () => {
  interface Deep {
    id: string;
    n: number;
    nested: { list: number[]; when: Date; tags: Set<string>; byId: Map<string, { v: number }> };
    extra?: number;
  }

  it('re-runs only the failed unit of work, with ctx restored deeply and its identity kept', async () => {
    const db = new FakeDb();
    const { logger, lines } = recordingLogger();
    const seen: Deep[] = [];
    const attempts: number[] = [];
    const firstUnit = jest.fn();
    const definition = saga<Deep, string[], number>('deep')
      .transaction('first', (ctx) => {
        firstUnit();
        ctx.n += 100;
      })
      .outbound('o', () => undefined)
      .transaction('mutate', (ctx, tx, unit) => {
        seen.push(ctx);
        attempts.push(unit.attempt);
        expect(ctx.n).toBe(100);
        expect(ctx.nested.list).toEqual([1]);
        expect(ctx.nested.tags.has('b')).toBe(false);
        expect(ctx.nested.byId.get('a')?.v).toBe(1);
        expect(ctx).not.toHaveProperty('extra');
        ctx.n += 1;
        ctx.nested.list.push(2);
        ctx.nested.tags.add('b');
        const byA = ctx.nested.byId.get('a');
        if (byA !== undefined) byA.v = 2;
        ctx.extra = 1;
        tx.push('mutated');
        if (unit.attempt === 1) throw pgError('40P01');
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 5 })
      .reply((ctx) => ctx.n);
    const ctx: Deep = {
      id: 'd',
      n: 0,
      nested: {
        list: [1],
        when: new Date(0),
        tags: new Set(['a']),
        byId: new Map([['a', { v: 1 }]]),
      },
    };
    await expect(runnerFor(db, { logger }).run(definition, ctx)).resolves.toBe(101);
    expect(attempts).toEqual([1, 2]);
    expect(seen[0]).toBe(ctx);
    expect(seen[1]).toBe(ctx);
    expect(firstUnit).toHaveBeenCalledTimes(1);
    expect(Object.prototype.toString.call(ctx.nested.when)).toBe('[object Date]');
    expect(db.committed).toEqual(['mutated']);
    expect(lines).toContainEqual('→ hop saga:deep retry:deadlock#2');
  });

  it.each([
    ['full', [0, 0, 0], [11, 21, 26]],
    ['equal', [5, 10, 12], [6, 11, 14]],
    ['none', [10, 20, 25], []],
  ] as const)(
    'follows the sleep and random seams with %s jitter',
    async (jitter, sleeps, maxes) => {
      const db = new FakeDb();
      const slept: number[] = [];
      const randomArgs: number[] = [];
      const definition = saga<Ctx, string[], null>('backoff')
        .transaction('a', (_c, _tx, unit) => {
          if (unit.attempt < 4) throw pgError('40001');
        })
        .retry({ on: ['serialization'], attempts: 4, backoffMs: 10, maxBackoffMs: 25, jitter })
        .reply(() => null);
      const runner = new SagaRunner<string[]>({
        transactions: db.port,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
        random: (max) => {
          randomArgs.push(max);
          return 0;
        },
      });
      await runner.run(definition, { id: 'i', trail: [] });
      expect(slept).toEqual(sleeps);
      expect(randomArgs).toEqual(maxes);
      expect(db.transactions).toBe(4);
    },
  );

  it('throws the typed error with attempts, cause, saga and unit when retries are exhausted', async () => {
    const db = new FakeDb();
    const cause = pgError('40P01');
    const definition = saga<Ctx, string[], null>('exhaust')
      .transaction('a', () => {
        throw cause;
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    const error = await runnerFor(db)
      .run(definition, { id: 'i', trail: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeadlockError);
    expect(error).toMatchObject({
      kind: 'deadlock',
      attempts: 3,
      saga: 'exhaust',
      unit: 'tx#0',
      cause,
    });
    expect(db.transactions).toBe(3);
  });

  it('keeps driver text out of the typed error message: it stays only in cause', async () => {
    const db = new FakeDb();
    const cause = Object.assign(
      new Error('could not obtain lock on row in relation "flow_instances"'),
      { code: '55P03' },
    );
    const definition = saga<Ctx, string[], null>('start')
      .transaction('a', () => {
        throw cause;
      })
      .reply(() => null);
    const error = await runnerFor(db)
      .run(definition, { id: 'i', trail: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect((error as Error).message).toBe(
      'lock-timeout in saga "start" unit tx#0 after 1 attempt(s)',
    );
    expect((error as Error).cause).toBe(cause);
    expect(() => toConcurrencyError('timeout' as never, cause, {})).toThrow(TypeError);
  });

  it.each([['lock_timeout'], ['timeout'], ['stale-state'], [42]])(
    'treats a classifier result %p that is not a database kind as unclassified',
    async (kind) => {
      const db = new FakeDb();
      const raw = new Error('busy');
      const definition = saga<Ctx, string[], null>('typo')
        .transaction('a', () => {
          throw raw;
        })
        .retry({ on: ['stale-state', 'lock-timeout'], attempts: 3, backoffMs: 0 })
        .reply(() => null);
      const runner = runnerFor(db, { classifyError: () => kind as never });
      await expect(runner.run(definition, { id: 'i', trail: [] })).rejects.toBe(raw);
      expect(db.transactions).toBe(1);
      const port = runnerFor(db, {
        transactions: { run: db.port.run, classify: () => kind as never },
      });
      await expect(port.run(definition, { id: 'i', trail: [] })).rejects.toBe(raw);
      expect(db.transactions).toBe(2);
    },
  );

  it('never retries or wraps logic errors, even when a classifier calls them serialization', async () => {
    const errors: Error[] = [
      new IllegalTransitionError('job', ['DONE'], 'RUNNING'),
      new TransitionOutcomeUnknownError(undefined),
      new SagaUsageError('misuse'),
    ];
    for (const thrown of errors) {
      const db = new FakeDb();
      const definition = saga<Ctx, string[], null>('logic')
        .transaction('a', () => {
          throw thrown;
        })
        .retry({ on: ['serialization'], attempts: 3, backoffMs: 0 })
        .reply(() => null);
      const runner = runnerFor(db, { classifyError: () => 'serialization' });
      await expect(runner.run(definition, { id: 'i', trail: [] })).rejects.toBe(thrown);
      expect(db.transactions).toBe(1);
    }
    const db = new FakeDb();
    db.committed.push('ledger:busy:k:claimed');
    const claimed = saga<Ctx, string[], null>('busy')
      .idempotent((c) => c.key)
      .transaction('a', () => undefined)
      .retry({ on: ['serialization'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    const runner = runnerFor(db, {
      ledger: new TxLedger(db),
      classifyError: () => 'serialization',
    });
    await expect(runner.run(claimed, { id: 'i', key: 'k', trail: [] })).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );
    expect(db.transactions).toBe(1);
  });

  it('wraps an unlisted kind without retrying, and lets an unclassified error through raw', async () => {
    const db = new FakeDb();
    const build = (error: Error) =>
      saga<Ctx, string[], null>('once')
        .transaction('a', () => {
          throw error;
        })
        .retry({ on: ['deadlock'], attempts: 5, backoffMs: 0 })
        .reply(() => null);
    const typed = await runnerFor(db)
      .run(build(pgError('55P03')), { id: 'i', trail: [] })
      .catch((e: unknown) => e);
    expect(typed).toBeInstanceOf(LockTimeoutError);
    expect(typed).toMatchObject({ attempts: 1 });
    expect(db.transactions).toBe(1);
    const raw = new Error('constraint violated');
    await expect(runnerFor(db).run(build(raw), { id: 'i', trail: [] })).rejects.toBe(raw);
    expect(db.transactions).toBe(2);
  });

  it('never retries an outbound step, even when its error is classified', async () => {
    const db = new FakeDb();
    const call = jest.fn(() => {
      throw pgError('40P01');
    });
    const definition = saga<Ctx, string[], null>('outbound')
      .transaction('a', () => undefined)
      .outbound('call', call)
      .retry({ on: ['deadlock'], attempts: 5, backoffMs: 0 })
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toMatchObject({
      code: '40P01',
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps 0.8.0 errors when no classifier is configured', async () => {
    const db = new FakeDb();
    const error = pgError('40P01');
    const definition = saga<Ctx, string[], null>('plain')
      .transaction('a', () => {
        throw error;
      })
      .reply(() => null);
    await expect(
      new SagaRunner({ transactions: db.bare }).run(definition, { id: 'i', trail: [] }),
    ).rejects.toBe(error);
  });

  it('lets classifyError override transactions.classify', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], null>('override')
      .transaction('a', () => {
        throw new Error('custom busy');
      })
      .reply(() => null);
    await expect(
      runnerFor(db, { classifyError: () => 'serialization' }).run(definition, {
        id: 'i',
        trail: [],
      }),
    ).rejects.toBeInstanceOf(SerializationError);
  });
});

describe('saga concurrency: ledger across retries (U5)', () => {
  const build = (fail: (unit: UnitOfWork) => void) =>
    saga<Ctx, string[], { id: string }>('pay')
      .idempotent((c) => c.key)
      .transaction('work', (ctx, tx, unit) => {
        tx.push(`${ctx.id}:work`);
        fail(unit);
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply((ctx) => ({ id: ctx.id }));

  it('reverts the claim with the rolled-back attempt and re-claims on the next one', async () => {
    const db = new FakeDb();
    const ledger = new TxLedger(db);
    const definition = build((unit) => {
      if (unit.attempt === 1) throw pgError('40P01');
    });
    await expect(
      runnerFor(db, { ledger }).run(definition, { id: 'a', key: 'k1', trail: [] }),
    ).resolves.toEqual({ id: 'a' });
    expect(ledger.claims).toBe(2);
    expect(db.committed.filter((w) => w === 'ledger:pay:k1:claimed')).toHaveLength(1);
    expect(db.committed.filter((w) => w.includes(':done:'))).toEqual([
      'ledger:pay:k1:done:{"id":"a"}',
    ]);
    expect(db.committed.filter((w) => w === 'a:work')).toHaveLength(1);
  });

  it('returns the replayed reply when a concurrent run completes between attempts', async () => {
    const db = new FakeDb();
    const ledger = new TxLedger(db);
    const other = new SagaRunner<string[]>({ transactions: db.port, ledger });
    const definition = build((unit) => {
      if (unit.attempt === 1) throw pgError('40P01');
    });
    const winner = saga<Ctx, string[], { id: string }>('pay')
      .idempotent((c) => c.key)
      .transaction('work', () => undefined)
      .reply(() => ({ id: 'winner' }));
    const runner = runnerFor(db, {
      ledger,
      sleep: async () => {
        await other.run(winner, { id: 'w', key: 'k1', trail: [] });
      },
    });
    await expect(runner.run(definition, { id: 'a', key: 'k1', trail: [] })).resolves.toEqual({
      id: 'winner',
    });
    expect(db.committed.filter((w) => w === 'a:work')).toEqual([]);
  });

  it('raises IdempotencyInProgressError, not retried, when a concurrent run is in progress', async () => {
    const db = new FakeDb();
    const definition = build((unit) => {
      if (unit.attempt === 1) throw pgError('40P01');
    });
    const runner = runnerFor(db, {
      ledger: new TxLedger(db),
      sleep: () => {
        db.committed.push('ledger:pay:k1:claimed');
        return Promise.resolve();
      },
    });
    await expect(runner.run(definition, { id: 'a', key: 'k1', trail: [] })).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );
    expect(db.transactions).toBe(2);
  });
});

describe('saga concurrency: a TransactionPort that re-invokes work', () => {
  /** Wraps FakeDb the way apps wrap dataSource.transaction: re-runs `work` on 40001, in a NEW
   *  transaction, inside one call to run(). */
  function selfRetryingPort(db: FakeDb, tries: number): TransactionPort<string[]> {
    return {
      run: async <T>(work: (tx: string[]) => Promise<T>): Promise<T> => {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return await db.port.run(work);
          } catch (error) {
            if (attempt >= tries || classifyPostgresError(error) !== 'serialization') throw error;
          }
        }
      },
      classify: classifyPostgresError,
    };
  }

  it('re-claims the key, re-acquires locks and drops the rolled-back callbacks on every call', async () => {
    const db = new FakeDb();
    const ledger = new TxLedger(db);
    const locks = new MemoryLockPort<string[]>({ defaultTimeoutMs: 20 });
    const after: string[] = [];
    let calls = 0;
    const definition = saga<Ctx, string[], { id: string }>('publish')
      .idempotent((c) => c.key)
      .lock('flow', (c) => c.id, 'exclusive')
      .transaction('work', (ctx, tx, unit) => {
        calls += 1;
        const call = calls;
        tx.push(`${ctx.id}:work${call}`);
        unit.afterCommit(() => {
          after.push(`call${call}`);
        });
        if (call === 1) throw pgError('40001');
      })
      .reply((ctx) => ({ id: ctx.id }));
    const runner = new SagaRunner<string[]>({
      transactions: selfRetryingPort(db, 2),
      ledger,
      locks,
    });
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).resolves.toEqual({
      id: 'a',
    });
    expect(calls).toBe(2);
    expect(ledger.claims).toBe(2);
    expect(db.committed).toEqual([
      'ledger:publish:k:claimed',
      'a:work2',
      'ledger:publish:k:done:{"id":"a"}',
    ]);
    expect(after).toEqual(['call2']);
    expect(locks.acquisitions).toHaveLength(2);
  });

  it('restores ctx before the re-invocation when the saga has a retry policy', async () => {
    const db = new FakeDb();
    let calls = 0;
    const seen: string[][] = [];
    const definition = saga<Ctx, string[], string[]>('restore')
      .transaction('work', (ctx) => {
        calls += 1;
        seen.push([...ctx.trail]);
        ctx.trail.push(`call${calls}`);
        if (calls === 1) throw pgError('40001');
      })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply((ctx) => ctx.trail);
    const runner = new SagaRunner<string[]>({ transactions: selfRetryingPort(db, 2) });
    await expect(runner.run(definition, { id: 'a', trail: [] })).resolves.toEqual(['call2']);
    expect(seen).toEqual([[], []]);
  });
});

describe('saga concurrency: commit-time failure (U6)', () => {
  it('retries a serialization failure at COMMIT and never runs the failed attempt callbacks', async () => {
    const db = new FakeDb();
    const called: number[] = [];
    db.failNext(pgError('40001'), 'commit');
    const definition = saga<Ctx, string[], null>('commit')
      .transaction('a', (_c, tx, unit) => {
        tx.push(`attempt${unit.attempt}`);
        unit.afterCommit(() => {
          called.push(unit.attempt);
        });
      })
      .retry({ on: ['serialization'], attempts: 2, backoffMs: 0 })
      .reply(() => null);
    await runnerFor(db).run(definition, { id: 'i', trail: [] });
    expect(called).toEqual([2]);
    expect(db.committed).toEqual(['attempt2']);
  });
});

describe('saga concurrency: afterCommit (U7)', () => {
  it('runs callbacks in order after commit, before the next segment and before run() resolves', async () => {
    const db = new FakeDb();
    const events: string[] = [];
    const definition = saga<Ctx, string[], string[]>('after')
      .transaction('a', (_c, _tx, unit) => {
        unit.afterCommit(() => {
          events.push(`A committed=${db.committed.join('|')}`);
        });
        unit.afterCommit(async () => {
          await Promise.resolve();
          events.push('B');
        });
        _tx.push('a');
        events.push('step a');
      })
      .outbound('o', () => {
        events.push('outbound');
      })
      .transaction('c', (_c, _tx, unit) => {
        unit.afterCommit(() => {
          events.push('C');
        });
        events.push('step c');
      })
      .reply(() => events);
    await runnerFor(db).run(definition, { id: 'i', trail: [] });
    expect(events).toEqual(['step a', 'A committed=a', 'B', 'outbound', 'step c', 'C']);
  });

  it('reports a failing callback, runs the next one and does not fail the saga', async () => {
    const db = new FakeDb();
    const { logger, errors, lines } = recordingLogger();
    const hook = jest.fn(() => {
      throw new Error('hook broke');
    });
    const ran: string[] = [];
    const definition = saga<Ctx, string[], string>('report')
      .transaction('a', (_c, _tx, unit) => {
        unit.afterCommit(() => {
          throw new Error('cache down');
        });
        unit.afterCommit(() => {
          ran.push('second');
        });
      })
      .reply(() => 'ok');
    await expect(
      runnerFor(db, { logger, onAfterCommitError: hook }).run(
        definition,
        { id: 'i', trail: [] },
        { correlationId: 'c-1' },
      ),
    ).resolves.toBe('ok');
    expect(ran).toEqual(['second']);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ message: 'cache down' }), {
      saga: 'report',
      unit: 'tx#0',
      index: 0,
      correlationId: 'c-1',
    });
    expect(errors).toEqual(['after-commit:tx#0#0', 'after-commit:tx#0#0:hook']);
    expect(lines).toContainEqual(
      expect.stringMatching(/^← hop saga:report after-commit:tx#0#0 FAIL/),
    );
  });

  it('falls back to a static Nest Logger when no hop logger is configured', async () => {
    const db = new FakeDb();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const definition = saga<Ctx, string[], null>('fallback')
      .transaction('a', (_c, _tx, unit) => {
        unit.afterCommit(() => {
          throw new Error('lost');
        });
      })
      .reply(() => null);
    await runnerFor(db).run(definition, { id: 'i', trail: [] });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('saga:fallback after-commit:tx#0#0 failed: lost'),
      expect.any(String),
    );
    error.mockRestore();
  });

  it('discards callbacks of a rolled-back unit and throws when called after the unit settled', async () => {
    const db = new FakeDb();
    const called = jest.fn();
    let captured: UnitOfWork | undefined;
    const definition = saga<Ctx, string[], null>('sealed')
      .transaction('a', (_c, _tx, unit) => {
        captured = unit;
        unit.afterCommit(called);
        throw new Error('rollback');
      })
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toThrow('rollback');
    expect(called).not.toHaveBeenCalled();
    expect(() => captured?.afterCommit(called)).toThrow(SagaUsageError);
  });

  it('still accepts 2-argument transaction steps (compile-time check)', async () => {
    const db = new FakeDb();
    const twoArgs: TransactionStep<Ctx, string[]> = (ctx, tx) => {
      tx.push(ctx.id);
    };
    const definition = saga<Ctx, string[], null>('two')
      .transaction('a', twoArgs)
      .reply(() => null);
    await runnerFor(db).run(definition, { id: 'i', trail: [] });
    expect(db.committed).toEqual(['i']);
  });
});

describe('saga concurrency: stored steps require unit (compile-time check)', () => {
  it('rejects a wrapper that drops unit, and a forwarding wrapper keeps afterCommit working', async () => {
    const audit: string[] = [];
    function dropsUnit<C, Tx>(o: OutboundOptions<C, Tx>): OutboundOptions<C, Tx> {
      return {
        compensate: async (ctx, tx) => {
          // @ts-expect-error a stored compensation needs `unit`; dropping it is a compile error
          await o.compensate?.(ctx, tx);
        },
      };
    }
    expect(dropsUnit).toBeInstanceOf(Function);
    function audited<C, Tx>(o: OutboundOptions<C, Tx>): OutboundOptions<C, Tx> {
      return {
        compensate: async (ctx, tx, unit) => {
          await o.compensate?.(ctx, tx, unit);
          audit.push('audited');
        },
      };
    }
    const db = new FakeDb();
    const definition = saga<Ctx, string[], null>('wrapped')
      .transaction('a', (ctx, tx) => {
        tx.push(ctx.id);
      })
      .outbound(
        'call',
        () => {
          throw new Error('upstream 500');
        },
        audited<Ctx, string[]>({
          compensate: (_ctx, tx, unit) => {
            tx.push('undo');
            unit.afterCommit(() => {
              audit.push('after-commit');
            });
          },
        }),
      )
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toThrow(
      'upstream 500',
    );
    expect(db.committed).toEqual(['i', 'undo']);
    expect(audit).toEqual(['audited', 'after-commit']);
  });
});

describe('saga concurrency: checkpoint (U8)', () => {
  class Entity {
    constructor(public v: number) {}
  }

  it('rejects a ctx that is not plain-cloneable, with the path, before any transaction', async () => {
    const db = new FakeDb();
    const build = () =>
      saga<Record<string, unknown>, string[], null>('clone')
        .transaction('a', () => undefined)
        .retry({ on: ['stale-state'], attempts: 2, backoffMs: 0 })
        .reply(() => null);
    await expect(runnerFor(db).run(build(), { deep: { entity: new Entity(1) } })).rejects.toThrow(
      'ctx is not cloneable at ctx.deep.entity; provide retry.checkpoint',
    );
    await expect(runnerFor(db).run(build(), { fn: () => 1 })).rejects.toThrow(SagaUsageError);
    expect(db.transactions).toBe(0);
  });

  it('rejects a frozen root with a mutable child instead of retrying on attempt-1 state', async () => {
    const db = new FakeDb();
    const seen: string[][] = [];
    const definition = saga<{ cmd: string; created: string[] }, string[], string[]>('frozen-root')
      .transaction('a', (c, tx, unit) => {
        c.created.push('a');
        seen.push([...c.created]);
        tx.push(...c.created);
        if (unit.attempt === 1) throw pgError('40P01');
      })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply((c) => c.created);
    const ctx = Object.freeze({ cmd: 'start', created: [] as string[] });
    await expect(runnerFor(db).run(definition, ctx)).rejects.toThrow(
      'ctx is frozen but ctx.created is mutable, so it cannot be restored in place; provide retry.checkpoint',
    );
    expect(seen).toEqual([]);
    expect(db.transactions).toBe(0);
  });

  it('accepts a deeply frozen root: nothing can change, so nothing is restored', async () => {
    const db = new FakeDb();
    const definition = saga<{ ids: readonly string[] }, string[], number>('deep-frozen')
      .transaction('a', (c, tx, unit) => {
        tx.push(...c.ids);
        if (unit.attempt === 1) throw pgError('40P01');
      })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply((c) => c.ids.length);
    const ctx = Object.freeze({ ids: Object.freeze(['x', 'y']) });
    await expect(runnerFor(db).run(definition, ctx)).resolves.toBe(2);
    expect(db.committed).toEqual(['x', 'y']);
  });

  it('rejects symbol-keyed and non-enumerable state that a clone would drop', async () => {
    const db = new FakeDb();
    const build = () =>
      saga<object, string[], null>('hidden')
        .transaction('a', () => undefined)
        .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
        .reply(() => null);
    const items = Symbol('items');
    await expect(runnerFor(db).run(build(), { [items]: [] })).rejects.toThrow(
      'ctx has a symbol-keyed property at ctx[Symbol(items)] that a clone would drop; provide retry.checkpoint',
    );
    const hidden = Object.defineProperty({}, 'created', { value: [], enumerable: false });
    await expect(runnerFor(db).run(build(), hidden)).rejects.toThrow(
      'ctx has a non-enumerable property at ctx.created that a clone would drop; provide retry.checkpoint',
    );
    await expect(runnerFor(db).run(build(), { nested: { [items]: [] } })).rejects.toThrow(
      SagaUsageError,
    );
    expect(db.transactions).toBe(0);
  });

  it('honours a custom checkpoint thunk and keeps ctx identity', async () => {
    const db = new FakeDb();
    const ctx = { entity: new Entity(1), id: 'x' };
    const seen: number[] = [];
    const definition = saga<typeof ctx, string[], number>('custom')
      .transaction('a', (c, _tx, unit) => {
        seen.push(c.entity.v);
        c.entity.v += 10;
        if (unit.attempt === 1) throw pgError('40P01');
      })
      .retry({
        on: ['deadlock'],
        attempts: 2,
        backoffMs: 0,
        checkpoint: (c) => {
          const v = c.entity.v;
          return () => {
            c.entity.v = v;
          };
        },
      })
      .reply((c) => c.entity.v);
    await expect(runnerFor(db).run(definition, ctx)).resolves.toBe(11);
    expect(seen).toEqual([1, 1]);
    expect(ctx.entity).toBeInstanceOf(Entity);
  });

  it('takes no clone without a retry policy', async () => {
    const db = new FakeDb();
    const clone = jest.spyOn(globalThis, 'structuredClone');
    const definition = saga<Ctx, string[], null>('noclone')
      .transaction('a', () => undefined)
      .reply(() => null);
    await runnerFor(db).run(definition, { id: 'i', trail: [] });
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
  });
});

describe('saga concurrency: compensation (U9)', () => {
  const failingCall = (ctx: Ctx): void => {
    ctx.orderId = 'mutated-by-outbound';
    throw new Error('upstream 500');
  };

  it('re-acquires the exact earlier lock requests by default, even after ctx changed', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const compensate = jest.fn();
    const definition = saga<Ctx, string[], null>('inherit')
      .lock('order', (c) => c.orderId, 'exclusive', { timeoutMs: 100 })
      .transaction('a', () => undefined)
      .outbound('call', failingCall, { compensate })
      .reply(() => null);
    await expect(
      runnerFor(db, { locks }).run(definition, { id: 'i', trail: [], orderId: 'o1' }),
    ).rejects.toThrow('upstream 500');
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(locks.acquisitions).toHaveLength(2);
    expect(locks.acquisitions[1]).toEqual(locks.acquisitions[0]);
    expect(locks.acquisitions[1]).toEqual([
      { namespace: 'order', key: 'o1', mode: 'exclusive', timeoutMs: 100 },
    ]);
  });

  it("takes no lock for the compensation with compensateLocks: 'none'", async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const definition = saga<Ctx, string[], null>('none')
      .lock('order', (c) => c.orderId, 'exclusive')
      .transaction('a', () => undefined)
      .outbound('call', failingCall, { compensate: () => undefined, compensateLocks: 'none' })
      .reply(() => null);
    await expect(
      runnerFor(db, { locks }).run(definition, { id: 'i', trail: [], orderId: 'o1' }),
    ).rejects.toThrow('upstream 500');
    expect(locks.acquisitions).toHaveLength(1);
  });

  it('retries the compensation unit and then rethrows the outbound error', async () => {
    const db = new FakeDb();
    const compensate = jest.fn((_c: Ctx, tx: string[], unit: UnitOfWork) => {
      if (unit.attempt === 1) throw pgError('40P01');
      tx.push('compensated');
    });
    const definition = saga<Ctx, string[], null>('comp')
      .transaction('a', () => undefined)
      .outbound('call', failingCall, { compensate })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toThrow(
      'upstream 500',
    );
    expect(compensate).toHaveBeenCalledTimes(2);
    expect(db.committed).toEqual(['compensated']);
  });

  it('retries the claim-only transaction and the record transaction around outbound steps', async () => {
    const db = new FakeDb();
    const call = jest.fn(() => {
      db.failNext(pgError('40P01'));
    });
    const definition = saga<Ctx, string[], string>('around')
      .idempotent((c) => c.key)
      .outbound('call', call)
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => 'ok');
    db.failNext(pgError('40P01'));
    await expect(
      runnerFor(db, { ledger: new TxLedger(db) }).run(definition, {
        id: 'i',
        key: 'k',
        trail: [],
      }),
    ).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
    expect(db.transactions).toBe(4);
    expect(db.committed).toEqual(['ledger:around:k:claimed', 'ledger:around:k:done:"ok"']);
  });
});

describe('saga concurrency: nested sagas and fail-fast checks (U10, U11)', () => {
  const inner = saga<Ctx, string[], string>('inner')
    .transaction('i', () => undefined)
    .reply(() => 'inner');
  const innerLocked = saga<Ctx, string[], string>('inner-locked')
    .lock('x', () => 'k', 'exclusive', { timeoutMs: 50 })
    .transaction('i', () => undefined)
    .reply(() => 'inner');

  it('rejects a nested run from a step when the outer unit holds locks', async () => {
    const db = new FakeDb();
    const runner = runnerFor(db, { locks: new MemoryLockPort() });
    const outer = saga<Ctx, string[], null>('outer')
      .lock('y', () => 'k', 'shared')
      .transaction('a', async (ctx) => {
        await runner.run(inner, ctx);
      })
      .reply(() => null);
    await expect(runner.run(outer, { id: 'i', trail: [] })).rejects.toThrow(
      'saga "inner" started inside a unit of work that holds locks or uses retry',
    );
  });

  it('allows a nested run when neither side uses locks or retry', async () => {
    const db = new FakeDb();
    const runner = runnerFor(db);
    const replies: string[] = [];
    const outer = saga<Ctx, string[], null>('outer')
      .transaction('a', async (ctx) => {
        replies.push(await runner.run(inner, ctx));
      })
      .reply(() => null);
    await runner.run(outer, { id: 'i', trail: [] });
    expect(replies).toEqual(['inner']);
  });

  it('allows a nested run, with locks, from inside an afterCommit callback', async () => {
    const db = new FakeDb();
    const runner = runnerFor(db, { locks: new MemoryLockPort() });
    const replies: string[] = [];
    const outer = saga<Ctx, string[], null>('outer')
      .lock('x', () => 'k', 'exclusive')
      .transaction('a', (ctx, _tx, unit) => {
        unit.afterCommit(async () => {
          replies.push(await runner.run(innerLocked, ctx));
        });
      })
      .reply(() => null);
    await runner.run(outer, { id: 'i', trail: [] });
    expect(replies).toEqual(['inner']);
  });

  it('requires a classifier for database kinds, but not for stale-state alone', async () => {
    const db = new FakeDb();
    const port = new MemoryTransitionPort<string[]>();
    const Machine = defineStateMachine('job', { PENDING: ['RUNNING'], RUNNING: [] });
    port.seed(1, 'PENDING');
    port.forceNext({ affected: 0 });
    const build = (on: ('deadlock' | 'stale-state')[]) =>
      saga<Ctx, string[], null>('cas')
        .transaction('start', async (_c, tx) => {
          await transition(Machine, port, tx, { id: 1, to: 'RUNNING' });
        })
        .retry({ on, attempts: 2, backoffMs: 0 })
        .reply(() => null);
    const bare = new SagaRunner<string[]>({ transactions: db.bare, sleep: noSleep });
    await expect(bare.run(build(['deadlock']), { id: 'i', trail: [] })).rejects.toThrow(
      'no classifier is configured',
    );
    expect(db.transactions).toBe(0);
    await bare.run(build(['stale-state']), { id: 'i', trail: [] });
    expect(db.transactions).toBe(2);
    expect(port.get(1)).toEqual({ state: 'RUNNING', version: 1 });
  });

  it('surfaces StaleStateError as is when stale-state is not retried', async () => {
    const db = new FakeDb();
    const port = new MemoryTransitionPort<string[]>();
    const Machine = defineStateMachine('job', { PENDING: ['RUNNING'], RUNNING: [] });
    port.seed(1, 'RUNNING');
    const definition = saga<Ctx, string[], null>('cas')
      .transaction('start', async (_c, tx) => {
        await transition(Machine, port, tx, { id: 1, to: 'RUNNING' });
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toBeInstanceOf(
      StaleStateError,
    );
    expect(db.transactions).toBe(1);
  });
});

describe('saga concurrency: lock order under contention', () => {
  it('runs {a,b} against {b,a} 100 times concurrently without a timeout', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const build = (keys: string[]) =>
      saga<Ctx, string[], null>('pair')
        .lock('k', () => keys, 'exclusive', { timeoutMs: 1_000 })
        .transaction('a', async () => {
          await new Promise((resolve) => setImmediate(resolve));
        })
        .reply(() => null);
    const runner = runnerFor(db, { locks });
    const runs = Array.from({ length: 100 }, (_, i) =>
      runner.run(build(i % 2 === 0 ? ['a', 'b'] : ['b', 'a']), { id: `${i}`, trail: [] }),
    );
    await expect(Promise.all(runs)).resolves.toHaveLength(100);
    const orders = new Set(
      locks.acquisitions.map((r: readonly LockRequest[]) => r.map((l) => l.key).join()),
    );
    expect([...orders]).toEqual(['a,b']);
    expect(locks.held('k', 'a')).toEqual([]);
  });
});

describe('saga concurrency: locks across retries (I5)', () => {
  it('re-acquires the same lock set on every attempt and releases the failed attempt first', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const seen: string[] = [];
    const definition = saga<Ctx, string[], null>('locked-retry')
      .lock('order', (c) => c.orderId, 'exclusive', { timeoutMs: 50 })
      .transaction('work', (ctx, _tx, unit) => {
        seen.push(`${unit.attempt}:${ctx.orderId ?? ''}:${locks.held('order', 'o1').join()}`);
        if (unit.attempt === 1) {
          ctx.orderId = 'o2';
          throw pgError('40P01');
        }
      })
      .retry({
        on: ['deadlock'],
        attempts: 2,
        backoffMs: 0,
        // Restores everything but orderId, so a runner that re-read keyOf would lock 'o2'.
        checkpoint: (c) => {
          const trail = [...c.trail];
          return () => {
            c.trail = trail;
          };
        },
      })
      .reply(() => null);
    await runnerFor(db, { locks }).run(definition, { id: 'i', trail: [], orderId: 'o1' });
    expect(seen).toEqual(['1:o1:exclusive', '2:o2:exclusive']);
    expect(locks.acquisitions).toHaveLength(2);
    expect(locks.acquisitions[1]).toEqual(locks.acquisitions[0]);
    expect(locks.acquisitions[0]).toEqual([
      { namespace: 'order', key: 'o1', mode: 'exclusive', timeoutMs: 50 },
    ]);
    expect(locks.held('order', 'o1')).toEqual([]);
  });

  it('retries a LockTimeoutError raised by the port and takes the same set again', async () => {
    const db = new FakeDb();
    const locks = new MemoryLockPort<string[]>();
    const outside: (() => void)[] = [];
    await locks.acquire([], [{ namespace: 'order', key: 'o1', mode: 'exclusive' }], {
      onRelease: (fn) => outside.push(fn),
    });
    const attempts: number[] = [];
    const definition = saga<Ctx, string[], null>('timeout-retry')
      .lock('order', (c) => c.orderId, 'exclusive', { timeoutMs: 10 })
      .transaction('work', (_c, _tx, unit) => {
        attempts.push(unit.attempt);
      })
      .retry({ on: ['lock-timeout'], attempts: 2, backoffMs: 0 })
      .reply(() => null);
    const runner = runnerFor(db, {
      locks,
      sleep: () => {
        for (const release of outside) release();
        return Promise.resolve();
      },
    });
    await runner.run(definition, { id: 'i', trail: [], orderId: 'o1' });
    expect(attempts).toEqual([2]);
    expect(locks.acquisitions.slice(1)).toEqual([
      [{ namespace: 'order', key: 'o1', mode: 'exclusive', timeoutMs: 10 }],
      [{ namespace: 'order', key: 'o1', mode: 'exclusive', timeoutMs: 10 }],
    ]);
    expect(locks.held('order', 'o1')).toEqual([]);
  });

  it('caps the lock requests of one unit before any transaction (maxLocksPerUnit)', async () => {
    const db = new FakeDb();
    const ids = Array.from({ length: 65 }, (_, i) => `item-${i}`);
    const definition = saga<Ctx, string[], null>('batch')
      .lock('item', (c) => c.userIds, 'exclusive')
      .transaction('a', () => undefined)
      .reply(() => null);
    const ctx = { id: 'i', trail: [], userIds: ids };
    await expect(
      runnerFor(db, { locks: new MemoryLockPort() }).run(definition, ctx),
    ).rejects.toThrow('resolved 65 locks for one unit of work; the limit is 64');
    expect(db.transactions).toBe(0);
    await runnerFor(db, { locks: new MemoryLockPort(), maxLocksPerUnit: 100 }).run(definition, ctx);
    expect(db.transactions).toBe(1);
    expect(() => runnerFor(db, { maxLocksPerUnit: 0 })).toThrow(TypeError);
  });
});

describe('saga concurrency: retry with a non-transactional ledger', () => {
  it('refuses MemoryIdempotencyLedger with a retry policy before any transaction', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], string>('mem')
      .idempotent((c) => c.key)
      .transaction('a', (_c, _tx, unit) => {
        if (unit.attempt === 1) throw pgError('40P01');
      })
      .transaction('b', () => undefined)
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => 'ok');
    const runner = runnerFor(db, { ledger: new MemoryIdempotencyLedger<string[]>() });
    await expect(runner.run(definition, { id: 'i', key: 'k', trail: [] })).rejects.toThrow(
      'ledger that is not transactional',
    );
    expect(db.transactions).toBe(0);
  });

  it('would otherwise replay a reply whose writes never committed (commit-time failure)', async () => {
    const db = new FakeDb();
    db.failNext(pgError('40P01'), 'commit');
    const definition = saga<Ctx, string[], string>('mem-commit')
      .idempotent((c) => c.key)
      .transaction('a', (_c, tx) => {
        tx.push('effect');
      })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => 'ok');
    const runner = runnerFor(db, { ledger: new MemoryIdempotencyLedger<string[]>() });
    await expect(runner.run(definition, { id: 'i', key: 'k', trail: [] })).rejects.toBeInstanceOf(
      SagaUsageError,
    );
    expect(db.committed).toEqual([]);
  });

  it('still accepts MemoryIdempotencyLedger without retry, or without an idempotency key', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    const plain = saga<Ctx, string[], string>('mem-plain')
      .idempotent((c) => c.key)
      .transaction('a', () => undefined)
      .reply(() => 'ok');
    const keyless = saga<Ctx, string[], string>('mem-keyless')
      .transaction('a', () => undefined)
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => 'ok');
    const runner = runnerFor(db, { ledger });
    await expect(runner.run(plain, { id: 'i', key: 'k', trail: [] })).resolves.toBe('ok');
    await expect(runner.run(keyless, { id: 'i', trail: [] })).resolves.toBe('ok');
  });
});

describe('saga concurrency: checkpoint failures after work committed', () => {
  class Entity {
    constructor(public v: number) {}
  }
  interface EntityCtx {
    key: string;
    e?: Entity;
    lastError?: unknown;
  }

  it('still compensates and releases the key when ctx became uncloneable', async () => {
    const db = new FakeDb();
    const { logger, errors } = recordingLogger();
    const compensate = jest.fn((_c: EntityCtx, tx: string[]) => {
      tx.push('compensated');
    });
    const definition = saga<EntityCtx, string[], null>('s2')
      .idempotent((c) => c.key)
      .transaction('load', (c, tx) => {
        tx.push('work');
        c.e = new Entity(1);
      })
      .outbound(
        'call',
        () => {
          throw new Error('upstream 500');
        },
        { compensate },
      )
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    const runner = runnerFor(db, { ledger: new TxLedger(db), logger });
    await expect(runner.run(definition, { key: 'y' })).rejects.toThrow('upstream 500');
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(db.committed).toEqual([
      'ledger:s2:y:claimed',
      'work',
      'compensated',
      'ledger:s2:y:released',
    ]);
    expect(errors).toEqual(['checkpoint:compensate#1']);
  });

  it('keeps the outbound error when the outbound stored an Error in ctx', async () => {
    const db = new FakeDb();
    const { logger, errors } = recordingLogger();
    const apiError = new Error('api down');
    const compensate = jest.fn();
    const definition = saga<EntityCtx, string[], null>('stores-error')
      .transaction('a', () => undefined)
      .outbound(
        'call',
        (c) => {
          c.lastError = apiError;
          throw apiError;
        },
        { compensate },
      )
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply(() => null);
    await expect(runnerFor(db, { logger }).run(definition, { key: 'k' })).rejects.toBe(apiError);
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(errors).toEqual(['checkpoint:compensate#1']);
  });

  it('still records the reply after a successful outbound, running the unit once', async () => {
    const db = new FakeDb();
    const { logger, errors } = recordingLogger();
    const definition = saga<EntityCtx, string[], string>('rec')
      .idempotent((c) => c.key)
      .transaction('load', (c) => {
        c.e = new Entity(2);
      })
      .outbound('call', () => undefined)
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => 'done');
    const runner = runnerFor(db, { ledger: new TxLedger(db), logger });
    await expect(runner.run(definition, { key: 'r' })).resolves.toBe('done');
    expect(db.committed).toEqual(['ledger:rec:r:claimed', 'ledger:rec:r:done:"done"']);
    expect(errors).toEqual(['checkpoint:record']);
  });

  it('runs a later unit without retry when it cannot be checkpointed', async () => {
    const db = new FakeDb();
    const definition = saga<EntityCtx, string[], null>('later')
      .transaction('load', (c) => {
        c.e = new Entity(3);
      })
      .outbound('call', () => undefined)
      .transaction('mark', () => {
        throw pgError('40P01');
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    const { logger } = recordingLogger();
    await expect(runnerFor(db, { logger }).run(definition, { key: 'l' })).rejects.toMatchObject({
      kind: 'deadlock',
      unit: 'tx#2',
      attempts: 1,
    });
    expect(db.transactions).toBe(2);
  });
});

describe('saga concurrency: nested-saga guard (D16)', () => {
  const inner = saga<Ctx, string[], string>('inner')
    .transaction('i', () => undefined)
    .reply(() => 'inner');
  const innerLocked = saga<Ctx, string[], string>('inner-locked')
    .lock('x', () => 'k', 'exclusive', { timeoutMs: 50 })
    .transaction('i', () => undefined)
    .reply(() => 'inner');
  const innerRetry = saga<Ctx, string[], string>('inner-retry')
    .transaction('i', () => undefined)
    .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
    .reply(() => 'inner');
  const message = 'started inside a unit of work that holds locks or uses retry';

  it('rejects a plain nested saga when the outer unit uses retry', async () => {
    const db = new FakeDb();
    const runner = runnerFor(db);
    const outer = saga<Ctx, string[], null>('outer-retry')
      .transaction('a', async (ctx) => {
        await runner.run(inner, ctx);
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
      .reply(() => null);
    await expect(runner.run(outer, { id: 'i', trail: [] })).rejects.toThrow(
      `saga "inner" ${message}`,
    );
  });

  it.each([
    ['locks', innerLocked],
    ['retry', innerRetry],
  ])(
    'rejects an inner saga with %s inside a lock-free, retry-free outer unit',
    async (_, nested) => {
      const db = new FakeDb();
      const runner = runnerFor(db, { locks: new MemoryLockPort() });
      const outer = saga<Ctx, string[], null>('outer-plain')
        .transaction('a', async (ctx) => {
          await runner.run(nested, ctx);
        })
        .reply(() => null);
      await expect(runner.run(outer, { id: 'i', trail: [] })).rejects.toThrow(message);
    },
  );
});

describe('saga concurrency: definitions built as plain objects', () => {
  const step = { kind: 'transaction' as const, name: 'a', run: () => undefined };

  it.each([
    ['attempts: Infinity', { on: ['deadlock'], attempts: Infinity, backoffMs: 0 }],
    ['on as a string', { on: 'deadlock', attempts: 3, backoffMs: 0 }],
    ['negative backoff', { on: ['deadlock'], attempts: 3, backoffMs: -5 }],
  ])('re-validates the retry policy at run() (%s)', async (_, retry) => {
    const db = new FakeDb();
    const definition = {
      name: 'literal',
      steps: [step],
      reply: () => null,
      retry: retry as unknown as RetryPolicy<Ctx>,
    } satisfies SagaDefinition<Ctx, string[], null>;
    await expect(runnerFor(db).run(definition, { id: 'i', trail: [] })).rejects.toBeInstanceOf(
      SagaDefinitionError,
    );
    expect(db.transactions).toBe(0);
  });

  it('re-validates lock declarations at run()', async () => {
    const db = new FakeDb();
    const definition: SagaDefinition<Ctx, string[], null> = {
      name: 'literal-lock',
      steps: [
        {
          ...step,
          locks: [
            { namespace: 'x', keyOf: () => 'k', mode: 'upgrade' as 'shared', optional: false },
          ],
        },
      ],
      reply: () => null,
    };
    await expect(
      runnerFor(db, { locks: new MemoryLockPort() }).run(definition, { id: 'i', trail: [] }),
    ).rejects.toBeInstanceOf(SagaDefinitionError);
    expect(db.transactions).toBe(0);
  });
});

describe('saga concurrency: calling a TransactionStep directly (compile-time check)', () => {
  it('requires unit at the call site; testUnitOfWork() supplies one', async () => {
    const markDone: TransactionStep<Ctx, string[]> = (ctx, tx, unit) => {
      tx.push(`${ctx.id}:done`);
      unit.afterCommit(() => {
        tx.push(`${ctx.id}:after`);
      });
    };
    const tx: string[] = [];
    // @ts-expect-error unit is required: a 2-argument call would throw inside unit.afterCommit
    expect(() => markDone({ id: 'x', trail: [] }, tx)).toThrow(TypeError);
    const unit = testUnitOfWork();
    await markDone({ id: 'a', trail: [] }, tx, unit);
    await unit.commit();
    const definition = saga<Ctx, string[], null>('reuse')
      .transaction('mark', markDone)
      .outbound('o', () => undefined, { compensate: markDone })
      .reply(() => null);
    const first = definition.steps[0];
    if (first?.kind !== 'transaction') throw new Error('expected a transaction step');
    // @ts-expect-error a stored step needs unit too
    expect(() => first.run({ id: 'y', trail: [] }, tx)).toThrow(TypeError);
    const other = testUnitOfWork();
    await first.run({ id: 'b', trail: [] }, tx, other);
    other.rollback();
    expect(tx).toEqual(['x:done', 'a:done', 'a:after', 'y:done', 'b:done']);
    expect(() => other.afterCommit(() => undefined)).toThrow('settled');
    await expect(other.commit()).rejects.toThrow('already settled');
  });

  it('still accepts a 2-argument implementation', () => {
    const twoArgs: TransactionStep<Ctx, string[]> = (ctx, tx) => {
      tx.push(ctx.id);
    };
    const tx: string[] = [];
    const call = (step: TransactionStep<Ctx, string[]>) =>
      step({ id: 'i', trail: [] }, tx, testUnitOfWork());
    void call(twoArgs);
    expect(tx).toEqual(['i']);
  });
});

describe('saga concurrency: ConcurrencyError identity across module copies', () => {
  /** A second, independent copy of the module, like the one the CJS testing entry bundles. */
  const foreignCopy = (): typeof ConcurrencyErrors => {
    let copy: typeof ConcurrencyErrors | undefined;
    jest.isolateModules(() => {
      copy = jest.requireActual<typeof ConcurrencyErrors>('./concurrency-errors');
    });
    if (copy === undefined) throw new Error('isolated module not loaded');
    return copy;
  };

  it('matches a copy of the class from another bundle by brand and kind', () => {
    const foreign = foreignCopy();
    expect(foreign.LockTimeoutError).not.toBe(LockTimeoutError);
    const error = new foreign.LockTimeoutError('busy');
    expect(error).toBeInstanceOf(LockTimeoutError);
    expect(error).toBeInstanceOf(ConcurrencyError);
    expect(error).not.toBeInstanceOf(DeadlockError);
    expect(new Error('plain')).not.toBeInstanceOf(ConcurrencyError);
    expect(new LockTimeoutError('local')).toBeInstanceOf(foreign.ConcurrencyError);
  });

  it('keeps the prototype check for a consumer subclass of an exported error', () => {
    class FlowStartLockTimeout extends LockTimeoutError {}
    class MyStale extends StaleStateError {}
    const foreign = foreignCopy();
    expect(new LockTimeoutError('other saga')).not.toBeInstanceOf(FlowStartLockTimeout);
    expect(new foreign.LockTimeoutError('memory port')).not.toBeInstanceOf(FlowStartLockTimeout);
    expect(new FlowStartLockTimeout('flow busy')).toBeInstanceOf(FlowStartLockTimeout);
    expect(new FlowStartLockTimeout('flow busy')).toBeInstanceOf(LockTimeoutError);
    expect(new FlowStartLockTimeout('flow busy')).toBeInstanceOf(foreign.LockTimeoutError);
    expect(new FlowStartLockTimeout('flow busy')).toBeInstanceOf(foreign.ConcurrencyError);
    const stale = new StaleStateError({ machine: 'm', id: 1, from: ['A'], to: 'B' });
    expect(stale).not.toBeInstanceOf(MyStale);
    expect(stale).toBeInstanceOf(StaleStateError);
  });

  it('retries on lock-timeout when the port throws a foreign LockTimeoutError', async () => {
    const Foreign = foreignCopy().LockTimeoutError;
    const db = new FakeDb();
    let calls = 0;
    const locks: LockPort<string[]> = {
      acquire: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Foreign('busy')) : Promise.resolve();
      },
    };
    const definition = saga<Ctx, string[], string>('foreign')
      .lock('x', () => 'k', 'exclusive')
      .transaction('a', () => undefined)
      .retry({ on: ['lock-timeout'], attempts: 2, backoffMs: 0 })
      .reply(() => 'ok');
    await expect(runnerFor(db, { locks }).run(definition, { id: 'i', trail: [] })).resolves.toBe(
      'ok',
    );
    expect(calls).toBe(2);
  });
});

describe('saga concurrency: lock scope (D32)', () => {
  it('acquires inside transactions.run, so database locks share the unit of work transaction', async () => {
    const db = new FakeDb();
    const inside: boolean[] = [];
    const locks: LockPort<string[]> = {
      acquire: () => {
        inside.push(db.active);
        return Promise.resolve();
      },
    };
    const definition = saga<Ctx, string[], string>('scoped')
      .lock('x', (c) => c.id, 'exclusive')
      .transaction('a', (_c, _tx, unit) => {
        unit.afterCommit(() => {
          inside.push(db.active);
        });
      })
      .reply(() => 'ok');
    await expect(runnerFor(db, { locks }).run(definition, { id: 'i', trail: [] })).resolves.toBe(
      'ok',
    );
    // [acquire, afterCommit]: the lock is taken with the transaction open and the callback runs
    // after it ended, when a transaction-scoped lock is already gone.
    expect(inside).toEqual([true, false]);
  });
});

describe('saga concurrency: non-transactional ledger after a partial failure (U30)', () => {
  const build = (fail: (ctx: Ctx) => void) =>
    saga<Ctx, string[], string>('mem-partial')
      .idempotent((c) => c.key)
      .transaction('work', (ctx, tx) => {
        tx.push(`${ctx.id}:work`);
        fail(ctx);
      })
      .reply((ctx) => `reply:${ctx.id}`);

  it('frees a pending claim when the unit that took it rolls back, so the client can retry', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    const runner = runnerFor(db, { ledger });
    const definition = build((ctx) => {
      if (ctx.id === 'a') throw new Error('step broke');
    });
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).rejects.toThrow(
      'step broke',
    );
    expect(ledger.statusOf('mem-partial', 'k')).toBeUndefined();
    await expect(runner.run(definition, { id: 'b', key: 'k', trail: [] })).resolves.toBe('reply:b');
    expect(ledger.statusOf('mem-partial', 'k')).toBe('applied');
    expect(db.committed).toEqual(['b:work']);
  });

  it('never replays a reply recorded by an attempt whose COMMIT failed', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    db.failNext(pgError('40001'), 'commit');
    const runner = runnerFor(db, { ledger });
    const definition = build(() => undefined);
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).rejects.toBeInstanceOf(
      SerializationError,
    );
    expect(ledger.statusOf('mem-partial', 'k')).toBeUndefined();
    await expect(runner.run(definition, { id: 'b', key: 'k', trail: [] })).resolves.toBe('reply:b');
    expect(db.committed).toEqual(['b:work']);
  });

  it('frees the claim-only unit of an outbound-first saga when its COMMIT fails', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    const calls: string[] = [];
    const definition = saga<Ctx, string[], number>('mem-outbound-first')
      .idempotent((c) => c.key)
      .outbound('send', (ctx) => {
        calls.push(ctx.id);
      })
      .reply(() => 1);
    db.failNext(pgError('40P01'), 'commit');
    const runner = runnerFor(db, { ledger });
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).rejects.toBeInstanceOf(
      DeadlockError,
    );
    expect(calls).toEqual([]);
    expect(ledger.statusOf('mem-outbound-first', 'k')).toBeUndefined();
    await expect(runner.run(definition, { id: 'b', key: 'k', trail: [] })).resolves.toBe(1);
    expect(calls).toEqual(['b']);
  });

  it('frees the claim of a rolled-back call when the TransactionPort re-invokes work', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    const port: TransactionPort<string[]> = {
      run: async <T>(work: (tx: string[]) => Promise<T>): Promise<T> => {
        try {
          return await db.port.run(work);
        } catch {
          return db.port.run(work);
        }
      },
      classify: classifyPostgresError,
    };
    let calls = 0;
    const definition = saga<Ctx, string[], string>('mem-reinvoke')
      .idempotent((c) => c.key)
      .transaction('work', (ctx, tx) => {
        calls += 1;
        tx.push(`${ctx.id}:work${calls}`);
        if (calls === 1) throw pgError('40001');
      })
      .reply((ctx) => ctx.id);
    const runner = new SagaRunner<string[]>({ transactions: port, ledger });
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).resolves.toBe('a');
    expect(calls).toBe(2);
    expect(db.committed).toEqual(['a:work2']);
    expect(ledger.statusOf('mem-reinvoke', 'k')).toBe('applied');
  });

  it('keeps the key claimed when a unit after a successful outbound fails (0.8.0 semantics, R10)', async () => {
    const db = new FakeDb();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    const definition = saga<Ctx, string[], string>('mem-after-outbound')
      .idempotent((c) => c.key)
      .transaction('a', () => undefined)
      .outbound('call', () => undefined)
      .transaction('b', () => {
        throw new Error('late failure');
      })
      .reply(() => 'ok');
    const runner = runnerFor(db, { ledger });
    await expect(runner.run(definition, { id: 'a', key: 'k', trail: [] })).rejects.toThrow(
      'late failure',
    );
    expect(ledger.statusOf('mem-after-outbound', 'k')).toBe('pending');
    await expect(runner.run(definition, { id: 'b', key: 'k', trail: [] })).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );
  });

  it('does not call release on a transactional ledger: its rollback already undid the claim', async () => {
    const db = new FakeDb();
    const ledger = new TxLedger(db);
    const release = jest.spyOn(ledger, 'release');
    const definition = build(() => {
      throw new Error('step broke');
    });
    await expect(
      runnerFor(db, { ledger }).run(definition, { id: 'a', key: 'k', trail: [] }),
    ).rejects.toThrow('step broke');
    expect(release).not.toHaveBeenCalled();
    expect(db.committed).toEqual([]);
  });

  it('reports a failing release at error level and keeps the original error', async () => {
    const db = new FakeDb();
    const { logger, errors } = recordingLogger();
    const ledger = new MemoryIdempotencyLedger<string[]>();
    jest.spyOn(ledger, 'release').mockRejectedValue(new Error('ledger down'));
    const definition = build(() => {
      throw new Error('step broke');
    });
    await expect(
      runnerFor(db, { ledger, logger }).run(definition, { id: 'a', key: 'k', trail: [] }),
    ).rejects.toThrow('step broke');
    expect(errors).toEqual(['ledger-release:tx#0']);
  });
});

describe('MemoryIdempotencyLedger entry states', () => {
  it('moves pending to applied, answers in-progress then replay, and release frees the key', async () => {
    const ledger = new MemoryIdempotencyLedger<null>();
    expect(ledger.statusOf('s', 'k')).toBeUndefined();
    await expect(ledger.claim(null, 's', 'k')).resolves.toEqual({ status: 'new' });
    expect(ledger.statusOf('s', 'k')).toBe('pending');
    await expect(ledger.claim(null, 's', 'k')).resolves.toEqual({ status: 'in-progress' });
    await ledger.record(null, 's', 'k', { ok: 1 });
    expect(ledger.statusOf('s', 'k')).toBe('applied');
    await expect(ledger.claim(null, 's', 'k')).resolves.toEqual({
      status: 'replay',
      response: { ok: 1 },
    });
    await ledger.release(null, 's', 'k');
    expect(ledger.statusOf('s', 'k')).toBeUndefined();
    await expect(ledger.claim(null, 's', 'k')).resolves.toEqual({ status: 'new' });
  });
});

describe('saga concurrency: the checkpoint survives failing effects (U31)', () => {
  interface Doc {
    id: string;
    n: number;
    tags: string[];
    nested: { a: number; list: number[] };
    extra?: string;
    gone?: string;
  }
  const pristine = (): Doc => ({
    id: 'd',
    n: 0,
    tags: [],
    nested: { a: 1, list: [1] },
    gone: 'yes',
  });
  const snapshot = (ctx: Doc): Doc => JSON.parse(JSON.stringify(ctx)) as Doc;

  it('restores ctx from the snapshot taken before attempt 1 after every failing attempt', async () => {
    const db = new FakeDb();
    const clone = jest.spyOn(globalThis, 'structuredClone');
    try {
      const seen: Doc[] = [];
      const committedAttempts: number[] = [];
      const definition = saga<Doc, string[], number>('effects')
        .transaction('mutate', (ctx, tx, unit) => {
          seen.push(snapshot(ctx));
          ctx.n += 10;
          ctx.tags.push(`t${unit.attempt}`);
          ctx.nested.a = unit.attempt;
          ctx.nested.list.push(unit.attempt);
          ctx.extra = 'x';
          delete ctx.gone;
          tx.push(`attempt${unit.attempt}`);
          unit.afterCommit(() => {
            committedAttempts.push(unit.attempt);
          });
          if (unit.attempt < 3) throw pgError('40P01');
        })
        .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0 })
        .reply((ctx) => ctx.n);
      const ctx = pristine();
      await expect(runnerFor(db).run(definition, ctx)).resolves.toBe(10);
      expect(seen).toEqual([pristine(), pristine(), pristine()]);
      expect(ctx).toEqual({
        id: 'd',
        n: 10,
        tags: ['t3'],
        nested: { a: 3, list: [1, 3] },
        extra: 'x',
      });
      expect(ctx).not.toHaveProperty('gone');
      expect(committedAttempts).toEqual([3]);
      expect(db.committed).toEqual(['attempt3']);
      // One snapshot before attempt 1, then one restore per failed attempt: never re-taken from
      // the state a failing attempt left behind.
      expect(clone).toHaveBeenCalledTimes(3);
    } finally {
      clone.mockRestore();
    }
  });

  it('restores ctx when the failure happens at COMMIT, after the step mutated it', async () => {
    const db = new FakeDb();
    db.failNext(pgError('40001'), 'commit');
    const seen: number[] = [];
    const definition = saga<Doc, string[], number[]>('commit-effects')
      .transaction('mutate', (ctx, tx, unit) => {
        seen.push(ctx.n);
        ctx.n += 1;
        ctx.nested.list.push(unit.attempt);
        tx.push(`a${unit.attempt}`);
      })
      .retry({ on: ['serialization'], attempts: 2, backoffMs: 0 })
      .reply((ctx) => ctx.nested.list);
    await expect(runnerFor(db).run(definition, pristine())).resolves.toEqual([1, 2]);
    expect(seen).toEqual([0, 0]);
    expect(db.committed).toEqual(['a2']);
  });

  it('takes a custom checkpoint once and restores it before each retry', async () => {
    const db = new FakeDb();
    const checkpoint = jest.fn((ctx: Doc) => {
      const n = ctx.n;
      return jest.fn(() => {
        ctx.n = n;
      });
    });
    const definition = saga<Doc, string[], number>('custom-effects')
      .transaction('mutate', (ctx, _tx, unit) => {
        ctx.n += 1;
        if (unit.attempt < 3) throw pgError('40P01');
      })
      .retry({ on: ['deadlock'], attempts: 3, backoffMs: 0, checkpoint })
      .reply((ctx) => ctx.n);
    await expect(runnerFor(db).run(definition, pristine())).resolves.toBe(1);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(checkpoint.mock.results[0]?.value).toHaveBeenCalledTimes(2);
  });
});
