import { LruMap } from './lru';
import type { PacePlan } from './resilience.plan';
import type { CareClock } from './resilience.types';
import type { StateSwitch } from './state-port';

/** Outcome of a take: granted after `waitMs` (0 = now), or denied. */
export type TakeOutcome =
  { granted: true } | { granted: false; readyInMs: number; byDeadline: boolean };

type Reservation = { granted: true; waitMs: number } | Extract<TakeOutcome, { granted: false }>;

class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Reserves one token: the wait before it is available, or the denial. */
  reserve(now: number, maxWaitMs: number, deadlineAt: number): Reservation {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { granted: true, waitMs: 0 };
    }
    const waitMs = ((1 - this.tokens) * 1000) / this.rate;
    if (waitMs > maxWaitMs)
      return { granted: false, readyInMs: Math.ceil(waitMs), byDeadline: false };
    if (now + waitMs >= deadlineAt) {
      return { granted: false, readyInMs: Math.ceil(waitMs), byDeadline: true };
    }
    this.tokens -= 1;
    return { granted: true, waitMs };
  }
}

/**
 * Token bucket per key (RS-22): local buckets on the monotonic clock in an LRU bounded by
 * `maxKeys`, or the shared bucket of a state port with a bounded degraded local bucket (RS-24).
 * Each attempt takes one token.
 */
export class RateLimiter {
  private readonly local = new LruMap<TokenBucket>();
  private readonly degraded = new LruMap<TokenBucket>();

  constructor(
    private readonly plan: PacePlan,
    private readonly clock: CareClock,
    private readonly shared?: { switch: StateSwitch; stateKey: (key: string) => string },
  ) {}

  get bucketCount(): number {
    return this.local.size;
  }

  async take(key: string, deadlineAt: number): Promise<TakeOutcome> {
    if (this.shared === undefined)
      return this.takeLocal(this.local, key, this.plan.perSecond, this.plan.burst, deadlineAt);
    const started = this.clock.monotonic();
    for (;;) {
      const port = this.plan.state;
      const stateKey = this.shared.stateKey(key);
      const answer = await this.shared.switch.call(
        () => port!.takeTurn(stateKey, this.plan.perSecond, this.plan.burst),
        deadlineAt,
      );
      if (answer === undefined) {
        return this.takeLocal(
          this.degraded,
          key,
          this.plan.soloPerSecond,
          this.plan.soloBurst,
          deadlineAt,
        );
      }
      if (answer.value.granted) return { granted: true };
      const waitMs = Math.max(1, answer.value.readyInMs);
      const now = this.clock.monotonic();
      if (now - started + waitMs > this.plan.waitMs) {
        return { granted: false, readyInMs: waitMs, byDeadline: false };
      }
      if (now + waitMs >= deadlineAt)
        return { granted: false, readyInMs: waitMs, byDeadline: true };
      await this.clock.sleep(waitMs);
    }
  }

  private async takeLocal(
    buckets: LruMap<TokenBucket>,
    key: string,
    rate: number,
    burst: number,
    deadlineAt: number,
  ): Promise<TakeOutcome> {
    const now = this.clock.monotonic();
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      if (buckets.size >= this.plan.maxKeys) buckets.evictOne(() => true);
      bucket = new TokenBucket(rate, burst, now);
      buckets.set(key, bucket);
    }
    const outcome = bucket.reserve(now, this.plan.waitMs, deadlineAt);
    if (!outcome.granted) return outcome;
    if (outcome.waitMs > 0) await this.clock.sleep(outcome.waitMs);
    return { granted: true };
  }
}
