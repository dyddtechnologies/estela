import { ChannelError, type ChannelKind, type MessageChannel } from './channel';
import { DirectChannel } from './channels/direct.channel';
import { FanoutChannel } from './channels/fanout.channel';
import { PubSubChannel } from './channels/pubsub.channel';
import { QueueChannel } from './channels/queue.channel';
import type { ChannelDeps } from './channels/channel-deps';

/** Declaracion de channel en `forRoot` (spec sec.5). */
export interface ChannelSpec {
  name: string;
  type: ChannelKind;
  capacity?: number;
  bindings?: readonly string[];
}

/** Factory Method por kind (plan sec.6 OCP / ADR-010). */
export interface ChannelFactory {
  readonly kind: ChannelKind;
  create(spec: ChannelSpec, deps: ChannelDeps): MessageChannel;
}

/** Abstract Factory extensible por map: new kinds sin tocar el registry. */
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
