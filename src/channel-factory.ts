import { ChannelError, type ChannelKind, type MessageChannel } from './channel';
import { DirectChannel } from './channels/direct.channel';
import { FanoutChannel } from './channels/fanout.channel';
import { PubSubChannel } from './channels/pubsub.channel';
import { QueueChannel } from './channels/queue.channel';
import type { ChannelDeps } from './channels/channel-deps';
import type { CareRef } from './resilience/resilience.types';

/** Channel declaration in `forRoot` (spec sec.5). */
export interface ChannelSpec {
  name: string;
  type: ChannelKind;
  capacity?: number;
  bindings?: readonly string[];
  /**
   * L2 care (RS-56): the default of flow send and jump steps whose destination is this channel
   * and of activators on it. Never applied to inbound endpoints, `wireTap` or `handle`.
   */
  care?: CareRef;
}

/** Factory Method per kind (plan sec.6 OCP / ADR-010). */
export interface ChannelFactory {
  readonly kind: ChannelKind;
  create(spec: ChannelSpec, deps: ChannelDeps): MessageChannel;
}

/** Abstract Factory extensible through a map: new kinds without touching the registry. */
export class ChannelFactoryRegistry {
  private readonly factories = new Map<ChannelKind, ChannelFactory>();

  constructor() {
    this.register({ kind: 'direct', create: (spec, deps) => new DirectChannel(spec.name, deps) });
    this.register({
      kind: 'queue',
      create: (spec, deps) => new QueueChannel(spec.name, deps, spec.capacity),
    });
    this.register({ kind: 'pubsub', create: (spec, deps) => new PubSubChannel(spec.name, deps) });
    this.register({
      kind: 'fanout',
      create: (spec, deps) => new FanoutChannel(spec.name, deps, { bindings: spec.bindings ?? [] }),
    });
  }

  register(factory: ChannelFactory): void {
    this.factories.set(factory.kind, factory);
  }

  create(spec: ChannelSpec, deps: ChannelDeps): MessageChannel {
    const factory = this.factories.get(spec.type);
    if (factory === undefined) {
      throw new ChannelError(`sin ChannelFactory para kind '${spec.type}'`);
    }
    return factory.create(spec, deps);
  }
}
