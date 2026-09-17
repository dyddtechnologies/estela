import {
  ChannelError,
  ChannelNotFoundError,
  type ChannelResolver,
  type MessageChannel,
} from './channel';
import { ChannelFactoryRegistry, type ChannelSpec } from './channel-factory';
import type { ChannelDeps } from './channels/channel-deps';
import type { FanoutChannel } from './channels/fanout.channel';
import { MessageDispatcher } from './message-dispatcher';
import type { IntegrationMessage, MessageHeadersInit } from './message';
import type { TraceContext } from './trace/trace-context';

/**
 * Mediator (GoF): catálogo de canales + API pública de envío (spec §5).
 * `ChannelRegistry.send/sendMessage` delegan en `MessageDispatcher` (ADR-011).
 */
export class ChannelRegistry implements ChannelResolver {
  private readonly channels = new Map<string, MessageChannel>();
  readonly dispatcher: MessageDispatcher;

  constructor(
    private readonly deps: ChannelDeps,
    private readonly factories: ChannelFactoryRegistry = new ChannelFactoryRegistry(),
  ) {
    this.dispatcher = new MessageDispatcher((name) => this.tryGet(name), this.deps.trace);
  }

  get trace(): TraceContext {
    return this.deps.trace;
  }

  /** Crea vía factory y registra. `deps.resolver` apunta al registry (bindings). */
  create(spec: ChannelSpec): MessageChannel {
    const channel = this.factories.create(spec, { ...this.deps, resolver: this });
    return this.register(channel);
  }

  register(channel: MessageChannel): MessageChannel {
    if (this.channels.has(channel.name)) {
      throw new ChannelError(`canal duplicado: '${channel.name}'`);
    }
    this.channels.set(channel.name, channel);
    return channel;
  }

  get(name: string): MessageChannel {
    const channel = this.tryGet(name);
    if (channel === undefined) throw new ChannelNotFoundError(name);
    return channel;
  }

  tryGet(name: string): MessageChannel | undefined {
    return this.channels.get(name);
  }

  unregister(name: string): void {
    this.channels.delete(name);
  }

  /** Helper spec §5: crea o devuelve el fanout con los bindings dados. */
  fanout(name: string, bindings: readonly string[] = []): FanoutChannel {
    const existing = this.tryGet(name);
    if (existing !== undefined) return existing as FanoutChannel;
    return this.create({ name, type: 'fanout', bindings }) as FanoutChannel;
  }

  list(): readonly MessageChannel[] {
    return [...this.channels.values()];
  }

  // ---------- API pública de envío (spec §5) ----------

  send(channelName: string, payload: unknown, headers?: MessageHeadersInit): Promise<void> {
    return this.dispatcher.send(channelName, payload, headers);
  }

  sendMessage(channelName: string, msg: IntegrationMessage): Promise<void> {
    return this.dispatcher.sendMessage(channelName, msg);
  }
}
