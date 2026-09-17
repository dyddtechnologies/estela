import type { Unsubscribe } from '../channel';
import { ChannelError } from '../channel';
import type { IntegrationMessage } from '../message';

export class OneShotTimeoutError extends ChannelError {
  constructor(name: string, timeoutMs: number) {
    super(`espera one-shot en '${name}' excedió ${timeoutMs}ms`);
    this.name = 'OneShotTimeoutError';
  }
}

export interface OneShotChannel {
  subscribe(handler: (msg: IntegrationMessage) => void): Unsubscribe;
}

/**
 * Awaits one-shot race-free (plan sec.8.5 rule 6): `AbortSignal.timeout` — sin
 * timers manuales ni races. El channel se unsubscribes always.
 */
export function awaitFirstMessage(
  channel: OneShotChannel,
  options: { timeoutMs: number; name: string; timeoutError?: () => Error },
): Promise<IntegrationMessage> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  return new Promise<IntegrationMessage>((resolve, reject) => {
    const onAbort = (): void => {
      reject(options.timeoutError?.() ?? new OneShotTimeoutError(options.name, options.timeoutMs));
    };
    const unsub = channel.subscribe((msg) => {
      signal.removeEventListener('abort', onAbort);
      resolve(msg);
    });
    signal.addEventListener(
      'abort',
      () => {
        onAbort();
        unsub();
      },
      { once: true },
    );
  });
}
