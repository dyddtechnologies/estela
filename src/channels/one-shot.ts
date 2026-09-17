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
 * Espera one-shot race-free (plan §8.5 regla 6): `AbortSignal.timeout` — sin
 * timers manuales ni carreras. El canal se desuscribe siempre.
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
