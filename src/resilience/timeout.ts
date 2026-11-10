import { performance } from 'node:perf_hooks';
import { ChannelError } from '../channel';
import type { CareClock, CareTimer } from './resilience.types';

/**
 * One in-process try (activator, saga step, flow function) ran past `eachTryMs`.
 * `defaultInProcessClassifier` treats it as transient.
 */
export class TryOverdueError extends ChannelError {
  readonly transient = true;

  constructor(
    readonly binding: string,
    readonly eachTryMs: number,
  ) {
    super(`try of '${binding}' ran past ${eachTryMs}ms`);
  }
}

/** Default clock: `performance.now()` for decisions, `Date.now()` for events and markers. */
export const systemCareClock: CareClock = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
  sleep(ms, signal) {
    return new Promise<void>((resolve) => {
      if (ms <= 0 || signal?.aborted === true) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
  setTimer(ms, fn): CareTimer {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** Marks the rejection produced by the engine's own per-attempt timer. */
export class AttemptTimeout extends Error {
  constructor(readonly error: Error) {
    super('attempt timeout');
  }
}

/**
 * Runs `work` with an AbortSignal that aborts after `timeoutMs`; the timer wins even when the
 * work ignores the signal (RS-06). `Infinity` or 0 runs without a signal and without a timer.
 * The returned promise rejects with `AttemptTimeout` wrapping `onTimeout()`.
 */
export async function withAttemptTimeout<T>(
  clock: CareClock,
  timeoutMs: number,
  work: (signal: AbortSignal | undefined) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work(undefined);
  const controller = new AbortController();
  let timer: CareTimer | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimer(timeoutMs, () => {
      reject(new AttemptTimeout(onTimeout()));
      controller.abort();
    });
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    timer?.cancel();
  }
}
