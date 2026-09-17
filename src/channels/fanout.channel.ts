import {
  assertNoFanoutCycle,
  ChannelError,
  ChannelNotFoundError,
  type ChannelKind,
  type ChannelResolver,
  type IntegrationMessage,
  type MessageChannel,
  type MessageHandlerFn,
  type SubscribeOptions,
  type Unsubscribe,
} from '../channel';
import { nextHop } from '../message';
import type { ChannelDeps } from './channel-deps';

export interface FanoutChannelOptions {
  bindings?: readonly string[];
}

interface LocalSubscriber {
  id: number;
  handler: MessageHandlerFn;
}

/**
 * Composite (GoF): copia a bindings (otros canales, awaited) + subscribers
 * locales; sin filtro (spec §5, §17.3). Contexto reconstruido por destino;
 * cycle guard por binding (plan §8.6, ADR-019).
 */
export class FanoutChannel implements MessageChannel {
  readonly kind: ChannelKind = 'fanout';
  private readonly bindingsList: readonly string[];
  private readonly resolver: ChannelResolver;
  private readonly locals: LocalSubscriber[] = [];
  private nextId = 1;

  constructor(
    readonly name: string,
    private readonly deps: ChannelDeps,
    options?: FanoutChannelOptions,
  ) {
    if (deps.resolver === undefined) {
      throw new ChannelError(`fanout '${name}' requiere ChannelResolver en deps`);
    }
    this.resolver = deps.resolver;
    this.bindingsList = options?.bindings ?? [];
  }

  /** Bindings declarados — alimenta el grafo (plan §9.9). */
  get bindings(): readonly string[] {
    return this.bindingsList;
  }

  subscribe(handler: MessageHandlerFn, _options?: SubscribeOptions): Unsubscribe {
    const id = this.nextId;
    this.nextId += 1;
    this.locals.push({ id, handler });
    return () => {
      const index = this.locals.findIndex((local) => local.id === id);
      if (index >= 0) this.locals.splice(index, 1);
    };
  }

  async send(msg: IntegrationMessage): Promise<void> {
    const bindingSends: Promise<void>[] = this.bindingsList.map((binding) =>
      this.sendToBinding(msg, binding),
    );
    await Promise.all([...bindingSends, this.dispatchLocals(msg)]);
  }

  private async sendToBinding(msg: IntegrationMessage, binding: string): Promise<void> {
    assertNoFanoutCycle(msg, binding);
    const target = this.resolver.get(binding);
    if (target === undefined) throw new ChannelNotFoundError(binding);
    const hop = nextHop(
      msg,
      { channel: binding, component: `fanout:${this.name}` },
      { reply: 'none' },
    );
    await target.send(hop);
  }

  private async dispatchLocals(msg: IntegrationMessage): Promise<void> {
    const results = await Promise.allSettled(
      this.locals.map((local) =>
        this.deps.trace.runWithMessage(msg, async () => local.handler(msg)),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') this.deps.onError?.(result.reason, msg);
    }
  }
}
