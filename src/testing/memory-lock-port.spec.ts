import { LockTimeoutError } from '../saga/concurrency-errors';
import type { LockMode, LockRequest } from '../saga/lock-port';
import { saga } from '../saga/saga';
import { SagaRunner } from '../saga/saga-runner';
import { FakeDb } from '../saga/saga-test-kit';
import { MemoryLockPort } from './memory-lock-port';

/** Acquires one lock and returns its release (what the runner does through LockScope). */
async function take(
  port: MemoryLockPort,
  mode: LockMode,
  extra: Partial<LockRequest> = {},
): Promise<() => void> {
  const releases: (() => void)[] = [];
  await port.acquire(null, [{ namespace: 'n', key: 'k', mode, ...extra }], {
    onRelease: (fn) => releases.push(fn),
  });
  return () => releases.forEach((release) => release());
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('MemoryLockPort (U12)', () => {
  it('runs shared with shared concurrently while exclusive blocks', async () => {
    const port = new MemoryLockPort();
    const r1 = await take(port, 'shared');
    const r2 = await take(port, 'shared');
    expect(port.held('n', 'k')).toEqual(['shared', 'shared']);
    let granted = false;
    const writer = take(port, 'exclusive').then((release) => {
      granted = true;
      return release;
    });
    await tick();
    expect(granted).toBe(false);
    r1();
    await tick();
    expect(granted).toBe(false);
    r2();
    (await writer)();
    expect(granted).toBe(true);
    expect(port.held('n', 'k')).toEqual([]);
  });

  it('grants in FIFO order, so a waiting writer is not starved by later readers', async () => {
    const port = new MemoryLockPort();
    const order: string[] = [];
    const reader = await take(port, 'shared');
    const writer = take(port, 'exclusive').then((release) => {
      order.push('writer');
      return release;
    });
    const lateReader = take(port, 'shared').then((release) => {
      order.push('late reader');
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    reader();
    (await writer)();
    (await lateReader)();
    expect(order).toEqual(['writer', 'late reader']);
  });

  it('throws LockTimeoutError after timeoutMs and lets the next waiter through', async () => {
    const port = new MemoryLockPort({ defaultTimeoutMs: 1_000 });
    const holder = await take(port, 'shared');
    const started = Date.now();
    await expect(take(port, 'exclusive', { timeoutMs: 30 })).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    const reader = await take(port, 'shared');
    holder();
    reader();
    expect(port.held('n', 'k')).toEqual([]);
  });

  it('is released by the runner on commit and on rollback', async () => {
    const db = new FakeDb();
    const port = new MemoryLockPort<string[]>();
    const seen: LockMode[][] = [];
    const build = (fail: boolean) =>
      saga<{ id: string }, string[], null>('release')
        .lock('n', () => 'k', 'exclusive')
        .transaction('a', () => {
          seen.push(port.held('n', 'k'));
          if (fail) throw new Error('rollback');
        })
        .reply(() => null);
    const runner = new SagaRunner<string[]>({ transactions: db.port, locks: port });
    await runner.run(build(false), { id: 'a' });
    expect(port.held('n', 'k')).toEqual([]);
    await expect(runner.run(build(true), { id: 'b' })).rejects.toThrow('rollback');
    expect(port.held('n', 'k')).toEqual([]);
    expect(seen).toEqual([['exclusive'], ['exclusive']]);
  });

  it('releases the locks already taken when a later one times out', async () => {
    const port = new MemoryLockPort();
    const blocker = await take(port, 'exclusive');
    const releases: (() => void)[] = [];
    await expect(
      port.acquire(
        null,
        [
          { namespace: 'm', key: 'first', mode: 'exclusive' },
          { namespace: 'n', key: 'k', mode: 'exclusive', timeoutMs: 10 },
        ],
        { onRelease: (fn) => releases.push(fn) },
      ),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(port.held('m', 'first')).toEqual(['exclusive']);
    releases.forEach((release) => release());
    releases.forEach((release) => release());
    expect(port.held('m', 'first')).toEqual([]);
    blocker();
    expect(port.acquisitions).toHaveLength(2);
  });
});
