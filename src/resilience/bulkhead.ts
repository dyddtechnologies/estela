import type { BulkheadPlan } from './resilience.plan';
import type { ResilienceClock, ResilienceTimer } from './resilience.types';

export type BulkheadDenial = { reason: 'full' } | { reason: 'queue-timeout'; byDeadline: boolean };

interface Waiter {
  grant(): void;
  timer?: ResilienceTimer;
}

/**
 * At most `maxConcurrent` calls in flight, `maxQueue` more waiting in FIFO order (RS-21).
 * `acquire` resolves with the release function or with the denial; the caller releases in
 * `finally` (invariant I6).
 */
export class Bulkhead {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(
    private readonly plan: BulkheadPlan,
    private readonly clock: ResilienceClock,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  acquire(deadlineAt: number): Promise<(() => void) | BulkheadDenial> {
    if (this.active < this.plan.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.plan.maxQueue) return Promise.resolve({ reason: 'full' });
    const remaining = deadlineAt - this.clock.monotonic();
    const limit = Math.min(this.plan.queueTimeoutMs ?? Infinity, remaining);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          waiter.timer?.cancel();
          resolve(this.releaser());
        },
      };
      if (Number.isFinite(limit)) {
        const byDeadline = remaining <= (this.plan.queueTimeoutMs ?? Infinity);
        waiter.timer = this.clock.setTimer(Math.max(0, limit), () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          resolve({ reason: 'queue-timeout', byDeadline });
        });
      }
      this.queue.push(waiter);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      // The slot passes to the next waiter without dropping the count.
      if (next !== undefined) next.grant();
      else this.active -= 1;
    };
  }
}
