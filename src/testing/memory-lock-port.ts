import { LockTimeoutError } from '../saga/concurrency-errors';
import type { LockMode, LockPort, LockRequest, LockScope } from '../saga/lock-port';

interface Waiter {
  mode: LockMode;
  grant: () => void;
}

interface LockEntry {
  holders: LockMode[];
  queue: Waiter[];
}

/**
 * In-process lock port for unit tests. In-process only, NOT cross-process, no deadlock detection:
 * production code uses a database port (postgresAdvisoryLockPort). FIFO readers-writer lock per
 * (namespace, key), so a waiting writer is never starved by later readers; timeoutMs throws
 * LockTimeoutError; locks are released through LockScope when the unit of work settles.
 */
export class MemoryLockPort<Tx = unknown> implements LockPort<Tx> {
  private readonly entries = new Map<string, LockEntry>();
  private readonly log: (readonly LockRequest[])[] = [];

  constructor(private readonly options: { defaultTimeoutMs?: number } = {}) {}

  /** Every acquire call, in order, with the requests exactly as the runner passed them. */
  get acquisitions(): readonly (readonly LockRequest[])[] {
    return this.log;
  }

  /** Modes currently held on (namespace, key). */
  held(namespace: string, key: string): LockMode[] {
    return [...(this.entries.get(this.identity(namespace, key))?.holders ?? [])];
  }

  async acquire(_tx: Tx, locks: readonly LockRequest[], scope: LockScope): Promise<void> {
    this.log.push(Object.freeze([...locks]));
    for (const lock of locks) {
      const release = await this.lockOne(lock);
      scope.onRelease(release);
    }
  }

  private identity(namespace: string, key: string): string {
    return JSON.stringify([namespace, key]);
  }

  private lockOne(lock: LockRequest): Promise<() => void> {
    const id = this.identity(lock.namespace, lock.key);
    const entry = this.entries.get(id) ?? { holders: [], queue: [] };
    this.entries.set(id, entry);
    const release = this.releaser(id, entry, lock.mode);
    if (entry.queue.length === 0 && this.compatible(entry, lock.mode)) {
      entry.holders.push(lock.mode);
      return Promise.resolve(release);
    }
    const timeoutMs = lock.timeoutMs ?? this.options.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const pending: { timer?: NodeJS.Timeout } = {};
      const waiter: Waiter = {
        mode: lock.mode,
        grant: () => {
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          resolve(release);
        },
      };
      entry.queue.push(waiter);
      if (timeoutMs === undefined) return;
      pending.timer = setTimeout(() => {
        entry.queue.splice(entry.queue.indexOf(waiter), 1);
        this.pump(entry);
        if (entry.holders.length === 0 && entry.queue.length === 0) this.entries.delete(id);
        reject(
          new LockTimeoutError(
            `lock-timeout: ${lock.namespace}/${lock.key} not granted within ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
    });
  }

  private compatible(entry: LockEntry, mode: LockMode): boolean {
    if (mode === 'exclusive') return entry.holders.length === 0;
    return !entry.holders.includes('exclusive');
  }

  private releaser(id: string, entry: LockEntry, mode: LockMode): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.holders.splice(entry.holders.indexOf(mode), 1);
      this.pump(entry);
      if (entry.holders.length === 0 && entry.queue.length === 0) this.entries.delete(id);
    };
  }

  /** Grants waiters from the head of the queue while they are compatible (FIFO). */
  private pump(entry: LockEntry): void {
    let head = entry.queue[0];
    while (head !== undefined && this.compatible(entry, head.mode)) {
      entry.queue.shift();
      entry.holders.push(head.mode);
      head.grant();
      head = entry.queue[0];
    }
  }
}
