import type { LanesPlan } from './resilience.plan';
import type { CareClock, CareTimer } from './resilience.types';

export type BulkheadDenial =
  { reason: 'full' } | { reason: 'waitlist-expired'; byDeadline: boolean };

interface Waiter {
  grant(): void;
  timer?: CareTimer;
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
    private readonly plan: LanesPlan,
    private readonly clock: CareClock,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  acquire(deadlineAt: number): Promise<(() => void) | BulkheadDenial> {
    if (this.active < this.plan.count) {
      this.active += 1;
      return Promise.resolve(this.releaser());
    }
    if (this.queue.length >= this.plan.waitlist) return Promise.resolve({ reason: 'full' });
    const remaining = deadlineAt - this.clock.monotonic();
    const limit = Math.min(this.plan.waitlistMs ?? Infinity, remaining);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: () => {
          waiter.timer?.cancel();
          resolve(this.releaser());
        },
      };
      if (Number.isFinite(limit)) {
        const byDeadline = remaining <= (this.plan.waitlistMs ?? Infinity);
        waiter.timer = this.clock.setTimer(Math.max(0, limit), () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          resolve({ reason: 'waitlist-expired', byDeadline });
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
