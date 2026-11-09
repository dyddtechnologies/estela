import type { ResilienceStatePort } from '../resilience/resilience.types';

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * In-memory `ResilienceStatePort` with fault injection (RS-47): `down()` makes every call throw,
 * `slow(ms)` delays answers on real timers (pair it with a short `stateTimeoutMs`), `hang()`
 * never answers, and `failNext(n)` fails the next n calls. Time comes from `now`.
 */
export class MemoryResilienceStatePort implements ResilienceStatePort {
  readonly calls: string[] = [];
  private readonly buckets = new Map<string, Bucket>();
  private readonly markers = new Map<string, number>();
  private readonly leases = new Map<string, number>();
  private isDown = false;
  private hanging = false;
  private delayMs = 0;
  private failures = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  down(): this {
    this.isDown = true;
    return this;
  }

  up(): this {
    this.isDown = false;
    this.hanging = false;
    this.delayMs = 0;
    return this;
  }

  slow(ms: number): this {
    this.delayMs = ms;
    return this;
  }

  hang(): this {
    this.hanging = true;
    return this;
  }

  failNext(n: number): this {
    this.failures = n;
    return this;
  }

  /** Raw marker value (tests assert which state keys were written). */
  markerKeys(): string[] {
    return [...this.markers.keys()];
  }

  async takeToken(
    key: string,
    limitPerSec: number,
    burst: number,
  ): Promise<{ granted: boolean; retryAfterMs: number }> {
    await this.gate(`takeToken ${key}`);
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) * limitPerSec) / 1000);
    bucket.at = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { granted: true, retryAfterMs: 0 };
    }
    return { granted: false, retryAfterMs: Math.ceil(((1 - bucket.tokens) * 1000) / limitPerSec) };
  }

  async markOpen(key: string, untilMs: number): Promise<void> {
    await this.gate(`markOpen ${key}`);
    this.markers.set(key, untilMs);
  }

  async openUntil(key: string): Promise<number | undefined> {
    await this.gate(`openUntil ${key}`);
    const until = this.markers.get(key);
    if (until !== undefined && until <= this.now()) {
      this.markers.delete(key);
      return undefined;
    }
    return until;
  }

  async tryProbeLease(key: string, leaseMs: number): Promise<boolean> {
    await this.gate(`tryProbeLease ${key}`);
    const held = this.leases.get(key);
    if (held !== undefined && held > this.now()) return false;
    this.leases.set(key, this.now() + leaseMs);
    return true;
  }

  async clearOpen(key: string): Promise<void> {
    await this.gate(`clearOpen ${key}`);
    this.markers.delete(key);
  }

  private async gate(call: string): Promise<void> {
    this.calls.push(call);
    if (this.hanging) await new Promise<never>(() => undefined);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.isDown) throw new Error('state port down');
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('state port failure');
    }
  }
}
