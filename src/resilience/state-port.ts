import type { ResilienceClock } from './resilience.types';

export type { ResilienceStatePort } from './resilience.types';

/** Sentinel of a state-port call that did not answer in time. */
const TIMED_OUT = Symbol('state-timeout');

export interface StateSwitchHooks {
  onDegraded(): void;
  onRecovered(): void;
}

/**
 * D-REDIS-DOWN switch of one binding (RS-24): a state-port call waits at most
 * `min(stateTimeoutMs, remaining deadline)`; a throw or a timeout moves the binding to degraded
 * local state (one event per transition), and the port is probed again at most once per
 * `stateProbeMs`. Each call is decided by exactly one source (I9).
 */
export class StateSwitch {
  private degraded = false;
  private nextProbeAt = 0;

  constructor(
    private readonly clock: ResilienceClock,
    private readonly timeoutMs: number,
    private readonly probeMs: number,
    private readonly hooks: StateSwitchHooks,
  ) {}

  get isDegraded(): boolean {
    return this.degraded;
  }

  /** The port's answer, or `undefined` when the call must use local state. */
  async call<T>(op: () => Promise<T>, deadlineAt: number): Promise<{ value: T } | undefined> {
    const now = this.clock.monotonic();
    if (this.degraded && now < this.nextProbeAt) return undefined;
    if (this.degraded) this.nextProbeAt = now + this.probeMs;
    const wait = Math.max(0, Math.min(this.timeoutMs, deadlineAt - now));
    let timer: { cancel(): void } | undefined;
    const expired = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = this.clock.setTimer(wait, () => resolve(TIMED_OUT));
    });
    try {
      const value = await Promise.race([op(), expired]);
      if (value === TIMED_OUT) return this.fail();
      if (this.degraded) {
        this.degraded = false;
        this.hooks.onRecovered();
      }
      return { value: value as T };
    } catch {
      return this.fail();
    } finally {
      timer?.cancel();
    }
  }

  private fail(): undefined {
    this.nextProbeAt = this.clock.monotonic() + this.probeMs;
    if (!this.degraded) {
      this.degraded = true;
      this.hooks.onDegraded();
    }
    return undefined;
  }
}
