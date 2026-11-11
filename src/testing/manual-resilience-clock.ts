import type { CareClock, CareTimer } from '../resilience/resilience.types';

interface PendingTimer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export interface ManualCareClock extends CareClock {
  /** Moves both clocks forward, firing due timers in order and letting promises settle. */
  advance(ms: number): Promise<void>;
  /** Lets pending promise chains settle without moving time. */
  flush(): Promise<void>;
  /** Number of timers not yet fired or cancelled. */
  readonly pendingTimers: number;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Deterministic clock for care tests (RS-47): no real timers, no jest fake timers. */
export function manualCareClock(
  start = { monotonic: 0, wall: 1_700_000_000_000 },
): ManualCareClock {
  let now = 0;
  let seq = 0;
  const timers: PendingTimer[] = [];
  const schedule = (ms: number, fn: () => void): CareTimer => {
    seq += 1;
    const timer: PendingTimer = { at: now + Math.max(0, ms), seq, fn, cancelled: false };
    timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await tick();
  };
  const nextDue = (until: number): PendingTimer | undefined => {
    let best: PendingTimer | undefined;
    for (const timer of timers) {
      if (timer.cancelled || timer.at > until) continue;
      if (
        best === undefined ||
        timer.at < best.at ||
        (timer.at === best.at && timer.seq < best.seq)
      )
        best = timer;
    }
    return best;
  };
  return {
    monotonic: () => start.monotonic + now,
    wall: () => start.wall + now,
    setTimer: schedule,
    sleep(ms, signal) {
      if (ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = schedule(ms, resolve);
        signal?.addEventListener('abort', () => {
          timer.cancel();
          resolve();
        });
      });
    },
    async advance(ms) {
      const until = now + ms;
      await flush();
      for (let timer = nextDue(until); timer !== undefined; timer = nextDue(until)) {
        now = timer.at;
        timer.cancelled = true;
        timer.fn();
        await flush();
      }
      now = until;
      await flush();
    },
    flush,
    get pendingTimers() {
      return timers.filter((timer) => !timer.cancelled).length;
    },
  };
}
