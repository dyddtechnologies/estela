import { performance } from 'node:perf_hooks';
import { ChannelError } from '../channel';
import type { ResilienceClock, ResilienceTimer } from './resilience.types';

/**
 * Per-attempt timeout of an in-process edge (activator, saga step, flow function). It is
 * `retryable`, so `defaultInProcessClassifier` treats it as transient.
 */
export class AttemptTimeoutError extends ChannelError {
  readonly retryable = true;

  constructor(
    readonly binding: string,
    readonly timeoutMs: number,
  ) {
    super(`attempt of '${binding}' timed out after ${timeoutMs}ms`);
  }
}

/** Default clock: `performance.now()` for decisions, `Date.now()` for events and markers. */
export const systemResilienceClock: ResilienceClock = {
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
  setTimer(ms, fn): ResilienceTimer {
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
  clock: ResilienceClock,
  timeoutMs: number,
  work: (signal: AbortSignal | undefined) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work(undefined);
  const controller = new AbortController();
  let timer: ResilienceTimer | undefined;
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
