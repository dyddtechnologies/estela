import type { Unsubscribe } from '../channel';
import { ChannelError } from '../channel';
import type { IntegrationMessage } from '../message';

export class OneShotTimeoutError extends ChannelError {
  constructor(name: string, timeoutMs: number) {
    super(`espera one-shot en '${name}' excedió ${timeoutMs}ms`);
    this.name = 'OneShotTimeoutError';
  }
}

export class OneShotCancelledError extends ChannelError {
  constructor(name: string) {
    super(`one-shot wait on '${name}' was cancelled`);
    this.name = 'OneShotCancelledError';
  }
}

export interface OneShotChannel {
  subscribe(handler: (msg: IntegrationMessage) => void): Unsubscribe;
}

export interface OneShotOptions {
  timeoutMs: number;
  name: string;
  timeoutError?: () => Error;
}

/** Pending one-shot wait whose timer and subscription can be released early. */
export interface FirstMessageWait {
  readonly promise: Promise<IntegrationMessage>;
  /**
   * Releases the timer and the subscription. If the wait is still pending it is
   * rejected with `OneShotCancelledError`, so an abandoned wait (e.g. the request
   * send failed) never keeps a live timer.
   */
  cancel(): void;
}

/**
 * Opens a race-free one-shot wait (plan sec.8.5 rule 6). The first settlement
 * wins (message, timeout or cancel) and always clears the timer and
 * unsubscribes from the channel.
 *
 * The returned promise is pre-marked as handled: the timeout can fire while the
 * caller is still awaiting its request send, before it awaits `promise`. Callers
 * that do await it still observe the rejection.
 */
export function openFirstMessageWait(
  channel: OneShotChannel,
  options: OneShotOptions,
): FirstMessageWait {
  let settle: ((outcome: { msg: IntegrationMessage } | { error: Error }) => void) | undefined;
  const promise = new Promise<IntegrationMessage>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      settle?.({
        error: options.timeoutError?.() ?? new OneShotTimeoutError(options.name, options.timeoutMs),
      });
    }, options.timeoutMs);
    // Like the previous AbortSignal.timeout, a pending wait must not keep the process alive.
    timer.unref?.();
    const unsub = channel.subscribe((msg) => settle?.({ msg }));
    settle = (outcome): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsub();
      if ('msg' in outcome) resolve(outcome.msg);
      else reject(outcome.error);
    };
  });
  promise.catch(() => undefined);
  return {
    promise,
    cancel: (): void => settle?.({ error: new OneShotCancelledError(options.name) }),
  };
}

/** Awaits the first message of the channel or rejects on timeout. */
export function awaitFirstMessage(
  channel: OneShotChannel,
  options: OneShotOptions,
): Promise<IntegrationMessage> {
  return openFirstMessageWait(channel, options).promise;
}
