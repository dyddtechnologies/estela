import { HopLogger } from '../trace/hop-logger';
import {
  IdempotencyInProgressError,
  MemoryIdempotencyLedger,
  type IdempotencyLedger,
  type LedgerClaim,
} from './idempotency-ledger';
import { saga } from './saga';
import { SagaRunner } from './saga-runner';
import type { TransactionPort } from './transaction-port';

/** Fake database: writes are staged per transaction and only become visible on commit. */
class FakeDb {
  committed: string[] = [];
  transactions = 0;
  active = false;
  readonly port: TransactionPort<string[]> = {
    run: async <T>(work: (tx: string[]) => Promise<T>): Promise<T> => {
      this.transactions += 1;
      const staged: string[] = [];
      this.active = true;
      try {
        const result = await work(staged);
        this.committed.push(...staged);
        return result;
      } finally {
        this.active = false;
      }
    },
  };
}

/** Ledger whose rows live in the same fake transaction as the saga's writes. */
class TxLedger implements IdempotencyLedger<string[]> {
  constructor(private readonly db: FakeDb) {}
  private rows(scope: string, key: string): string[] {
    return this.db.committed.filter((w) => w.startsWith(`ledger:${scope}:${key}:`));
  }
  claim(tx: string[], scope: string, key: string): Promise<LedgerClaim> {
    const rows = this.rows(scope, key);
    const released = rows.includes(`ledger:${scope}:${key}:released`);
    const done = rows.find((w) => w.includes(':done:'));
    if (rows.length > 0 && !released) {
      return Promise.resolve(
        done
          ? { status: 'replay', response: JSON.parse(done.split(':done:')[1]!) as unknown }
          : { status: 'in-progress' },
      );
    }
    if (released)
      this.db.committed = this.db.committed.filter((w) => !w.startsWith(`ledger:${scope}:${key}:`));
    tx.push(`ledger:${scope}:${key}:claimed`);
    return Promise.resolve({ status: 'new' });
  }
  record(tx: string[], scope: string, key: string, response: unknown): Promise<void> {
    tx.push(`ledger:${scope}:${key}:done:${JSON.stringify(response)}`);
    return Promise.resolve();
  }
  release(tx: string[], scope: string, key: string): Promise<void> {
    tx.push(`ledger:${scope}:${key}:released`);
    return Promise.resolve();
  }
}

interface Ctx {
  id: string;
  key?: string;
  trail: string[];
  failAt?: string;
}

const step = (name: string) => (ctx: Ctx, tx: string[]) => {
  if (ctx.failAt === name) throw new Error(`${name} failed`);
  ctx.trail.push(name);
  tx.push(`${ctx.id}:${name}`);
};

describe('saga runner', () => {
  it('runs consecutive transaction steps in ONE transaction and shares ctx', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], string[]>('inline')
      .transaction('claim', step('claim'))
      .transaction('merge', step('merge'))
      .transaction('complete', step('complete'))
      .reply((ctx) => ctx.trail);
    const reply = await new SagaRunner({ transactions: db.port }).run(definition, {
      id: 'a',
      trail: [],
    });
    expect(reply).toEqual(['claim', 'merge', 'complete']);
    expect(db.transactions).toBe(1);
    expect(db.committed).toEqual(['a:claim', 'a:merge', 'a:complete']);
  });

  it('rolls the whole unit of work back when one step fails', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], string[]>('inline')
      .transaction('claim', step('claim'))
      .transaction('merge', step('merge'))
      .reply((ctx) => ctx.trail);
    await expect(
      new SagaRunner({ transactions: db.port }).run(definition, {
        id: 'a',
        trail: [],
        failAt: 'merge',
      }),
    ).rejects.toThrow('merge failed');
    expect(db.committed).toEqual([]);
  });

  it('commits before an outbound step and runs it outside any transaction', async () => {
    const db = new FakeDb();
    const seen: boolean[] = [];
    const definition = saga<Ctx, string[], string[]>('outbound')
      .transaction('claim', step('claim'))
      .outbound('call', (ctx) => {
        seen.push(db.active);
        expect(db.committed).toEqual(['a:claim']);
        ctx.trail.push('call');
      })
      .transaction('complete', step('complete'))
      .reply((ctx) => ctx.trail);
    const reply = await new SagaRunner({ transactions: db.port }).run(definition, {
      id: 'a',
      trail: [],
    });
    expect(reply).toEqual(['claim', 'call', 'complete']);
    expect(seen).toEqual([false]);
    expect(db.transactions).toBe(2);
  });

  it('compensates in a new transaction when an outbound step fails, and stops', async () => {
    const db = new FakeDb();
    const definition = saga<Ctx, string[], string[]>('outbound')
      .transaction('claim', step('claim'))
      .outbound(
        'call',
        () => {
          throw new Error('upstream 500');
        },
        {
          compensate: (ctx, tx) => {
            tx.push(`${ctx.id}:release`);
          },
        },
      )
      .transaction('complete', step('complete'))
      .reply((ctx) => ctx.trail);
    await expect(
      new SagaRunner({ transactions: db.port }).run(definition, { id: 'a', trail: [] }),
    ).rejects.toThrow('upstream 500');
    expect(db.committed).toEqual(['a:claim', 'a:release']);
  });

  describe('idempotency', () => {
    const build = () =>
      saga<Ctx, string[], { trail: string[] }>('pay')
        .idempotent((ctx) => ctx.key)
        .transaction('claim', step('claim'))
        .transaction('complete', step('complete'))
        .reply((ctx) => ({ trail: [...ctx.trail] }));

    it('claims and records in the same unit of work, then replays the stored reply', async () => {
      const db = new FakeDb();
      const runner = new SagaRunner({ transactions: db.port, ledger: new TxLedger(db) });
      const first = await runner.run(build(), { id: 'a', key: 'k1', trail: [] });
      expect(db.transactions).toBe(1);
      const second = await runner.run(build(), { id: 'b', key: 'k1', trail: [] });
      expect(second).toEqual(first);
      expect(db.committed.filter((w) => w.startsWith('b:'))).toEqual([]);
    });

    it('rolls the claim back with the work, so a failed run can be retried', async () => {
      const db = new FakeDb();
      const runner = new SagaRunner({ transactions: db.port, ledger: new TxLedger(db) });
      await expect(
        runner.run(build(), { id: 'a', key: 'k1', trail: [], failAt: 'complete' }),
      ).rejects.toThrow();
      expect(db.committed).toEqual([]);
      await expect(runner.run(build(), { id: 'a', key: 'k1', trail: [] })).resolves.toEqual({
        trail: ['claim', 'complete'],
      });
    });

    it('answers in-progress while the first run is past its first unit of work', async () => {
      const db = new FakeDb();
      const ledger = new TxLedger(db);
      const runner = new SagaRunner({ transactions: db.port, ledger });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slow = saga<Ctx, string[], string>('pay')
        .idempotent((ctx) => ctx.key)
        .transaction('claim', step('claim'))
        .outbound('call', () => gate)
        .transaction('complete', step('complete'))
        .reply(() => 'done');
      const first = runner.run(slow, { id: 'a', key: 'k1', trail: [] });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(runner.run(slow, { id: 'b', key: 'k1', trail: [] })).rejects.toBeInstanceOf(
        IdempotencyInProgressError,
      );
      release();
      await expect(first).resolves.toBe('done');
      await expect(runner.run(slow, { id: 'c', key: 'k1', trail: [] })).resolves.toBe('done');
    });

    it('releases the key when an outbound step fails', async () => {
      const db = new FakeDb();
      const runner = new SagaRunner({ transactions: db.port, ledger: new TxLedger(db) });
      let fail = true;
      const flaky = saga<Ctx, string[], string>('pay')
        .idempotent((ctx) => ctx.key)
        .transaction('claim', step('claim'))
        .outbound('call', () => {
          if (fail) throw new Error('timeout');
        })
        .reply(() => 'ok');
      await expect(runner.run(flaky, { id: 'a', key: 'k1', trail: [] })).rejects.toThrow('timeout');
      fail = false;
      await expect(runner.run(flaky, { id: 'a', key: 'k1', trail: [] })).resolves.toBe('ok');
      expect(db.committed.some((w) => w.includes(':done:"ok"'))).toBe(true);
    });

    it('ignores the key without a ledger, and runs without a key', async () => {
      const db = new FakeDb();
      const runner = new SagaRunner({ transactions: db.port });
      await runner.run(build(), { id: 'a', key: 'k1', trail: [] });
      await runner.run(build(), { id: 'b', key: 'k1', trail: [] });
      expect(db.committed.filter((w) => w.startsWith('b:'))).toHaveLength(2);
      const withLedger = new SagaRunner<string[]>({
        transactions: db.port,
        ledger: new MemoryIdempotencyLedger<string[]>(),
      });
      await withLedger.run(build(), { id: 'c', trail: [] });
      await withLedger.run(build(), { id: 'd', trail: [] });
      expect(db.committed.filter((w) => w.startsWith('d:'))).toHaveLength(2);
    });

    it('claims before calling out when the saga opens with an outbound step', async () => {
      const db = new FakeDb();
      const runner = new SagaRunner({ transactions: db.port, ledger: new TxLedger(db) });
      let calls = 0;
      const outboundFirst = saga<Ctx, string[], number>('notify')
        .idempotent((ctx) => ctx.key)
        .outbound('send', () => {
          calls += 1;
        })
        .reply(() => 1);
      await runner.run(outboundFirst, { id: 'a', key: 'k9', trail: [] });
      await runner.run(outboundFirst, { id: 'a', key: 'k9', trail: [] });
      expect(calls).toBe(1);
    });
  });

  it('logs one flow line and one hop line per step', async () => {
    const db = new FakeDb();
    const logger = new HopLogger('log');
    const lines: string[] = [];
    jest
      .spyOn(logger as unknown as { emit: (line: string) => void }, 'emit')
      .mockImplementation((line) => {
        lines.push(line);
      });
    const definition = saga<Ctx, string[], null>('inline')
      .transaction('claim', step('claim'))
      .outbound('call', () => undefined)
      .reply(() => null);
    await new SagaRunner({ transactions: db.port, logger }).run(
      definition,
      { id: 'a', trail: [] },
      { correlationId: 'corr-1' },
    );
    expect(lines.map((l) => l.split(' [')[0])).toEqual([
      '▶ flow inline on saga:inline',
      '→ hop saga:inline transaction:claim',
      expect.stringMatching(/^← hop saga:inline transaction:claim ok \d+ms$/),
      '→ hop saga:inline outbound:call',
      expect.stringMatching(/^← hop saga:inline outbound:call ok \d+ms$/),
      expect.stringMatching(/^■ flow inline on saga:inline completed \d+ms$/),
    ]);
    expect(lines[0]).toContain('corr=corr-1');
  });

  it('refuses an empty saga', () => {
    expect(() => saga<Ctx>('empty').reply((ctx) => ctx)).toThrow('has no steps');
  });
});
