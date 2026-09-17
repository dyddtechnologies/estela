import {
  NoSubscriberError,
  type ChannelKind,
  type IntegrationMessage,
  type MessageChannel,
  type MessageHandlerFn,
  type SubscribeOptions,
  type Unsubscribe,
} from '../channel';
import type { ChannelDeps } from './channel-deps';

/** 1 subscriber; `send` await el handler; sin subscriber -> throw (spec sec.5, sec.17.7). */
export class DirectChannel implements MessageChannel {
  readonly kind: ChannelKind = 'direct';
  private handler: MessageHandlerFn | undefined;

  constructor(
    readonly name: string,
    private readonly deps: ChannelDeps,
  ) {}

  subscribe(handler: MessageHandlerFn, _options?: SubscribeOptions): Unsubscribe {
    if (this.handler !== undefined) {
      this.deps.onWarn?.(`direct '${this.name}': re-subscripcion — el ultimo wins (spec sec.17.7)`);
    }
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = undefined;
    };
  }

  async send(msg: IntegrationMessage): Promise<void> {
    const handler = this.handler;
    if (handler === undefined) throw new NoSubscriberError(this.name);
    await this.deps.trace.runWithMessage(msg, () => handler(msg));
  }
}
