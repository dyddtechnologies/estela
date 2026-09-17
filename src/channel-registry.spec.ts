import {
  ChannelError,
  ChannelNotFoundError,
  type ChannelKind,
  type MessageChannel,
} from './channel';
import { ChannelFactoryRegistry, type ChannelFactory, type ChannelSpec } from './channel-factory';
import type { ChannelDeps } from './channels/channel-deps';
import { DirectChannel } from './channels/direct.channel';
import { FanoutChannel } from './channels/fanout.channel';
import { PubSubChannel } from './channels/pubsub.channel';
import { QueueChannel } from './channels/queue.channel';
import { createMessage } from './message';
import { TraceContext } from './trace/trace-context';
import { ChannelRegistry } from './channel-registry';

const makeDeps = (): ChannelDeps => ({ trace: new TraceContext() });

describe('ChannelFactoryRegistry (ADR-010 — OCP)', () => {
  it('crea los 4 kinds embebidos', () => {
    const factories = new ChannelFactoryRegistry();
    const deps = makeDeps();
    expect(factories.create({ name: 'd', type: 'direct' }, deps)).toBeInstanceOf(DirectChannel);
    expect(factories.create({ name: 'q', type: 'queue', capacity: 5 }, deps)).toBeInstanceOf(
      QueueChannel,
    );
    expect(factories.create({ name: 'p', type: 'pubsub' }, deps)).toBeInstanceOf(PubSubChannel);
    expect(
      factories.create(
        { name: 'f', type: 'fanout', bindings: ['d'] },
        { ...deps, resolver: { get: () => undefined } },
      ),
    ).toBeInstanceOf(FanoutChannel);
  });

  it('kind desconocido → ChannelError; nuevo kind se registra sin tocar el core', () => {
    const factories = new ChannelFactoryRegistry();
    const kafkaKind = 'kafka' as unknown as ChannelKind;
    expect(() => factories.create({ name: 'x', type: kafkaKind }, makeDeps())).toThrow(
      ChannelError,
    );
    const custom: ChannelFactory = {
      kind: kafkaKind,
      create: (spec: ChannelSpec, deps: ChannelDeps) => new DirectChannel(spec.name, deps),
    };
    factories.register(custom);
    expect(factories.create({ name: 'k1', type: kafkaKind }, makeDeps())).toBeInstanceOf(
      DirectChannel,
    );
  });
});

describe('ChannelRegistry (spec §5)', () => {
  it('lifecycle: create/get/tryGet/unregister/list; duplicado lanza', () => {
    const registry = new ChannelRegistry(makeDeps());
    registry.create({ name: 'orders.place', type: 'direct' });
    expect(registry.tryGet('orders.place')).toBeInstanceOf(DirectChannel);
    expect(registry.get('orders.place').name).toBe('orders.place');
    expect(registry.tryGet('nope')).toBeUndefined();
    expect(() => registry.get('nope')).toThrow(ChannelNotFoundError);
    expect(() => registry.create({ name: 'orders.place', type: 'direct' })).toThrow(ChannelError);
    expect(registry.list()).toHaveLength(1);
    registry.unregister('orders.place');
    expect(registry.list()).toHaveLength(0);
  });

  it('send(): crea mensaje, registra hop del canal y conserva traceId', async () => {
    const registry = new ChannelRegistry(makeDeps());
    const channel = registry.create({ name: 'orders.persist', type: 'direct' });
    const seen: { hop: string | undefined; traceId: string }[] = [];
    channel.subscribe(async (msg) => {
      const last = msg.headers.history[msg.headers.history.length - 1];
      seen.push({ hop: last?.channel, traceId: msg.headers.traceId });
    });
    await registry.send('orders.persist', { orderId: 'o-1' }, { traceId: 't-9' });
    expect(seen).toEqual([{ hop: 'orders.persist', traceId: 't-9' }]);
  });

  it('sendMessage(): misma id + hop anexado; canal desconocido → ChannelNotFoundError', async () => {
    const registry = new ChannelRegistry(makeDeps());
    const channel = registry.create({ name: 'audit', type: 'direct' });
    const ids: string[] = [];
    const hops: number[] = [];
    channel.subscribe(async (msg) => {
      ids.push(msg.headers.id);
      hops.push(msg.headers.history.length);
    });
    const msg = createMessage('p', { history: [{ channel: 'origen', at: 0 }] });
    await registry.sendMessage('audit', msg);
    expect(ids).toEqual([msg.headers.id]);
    expect(hops).toEqual([2]);
    await expect(registry.send('fantasma', 'p')).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('fanout(): registry como resolver — un send entrega a ambos bindings', async () => {
    const registry = new ChannelRegistry(makeDeps());
    const local: string[] = [];
    const subscribe = (name: string): MessageChannel => {
      const channel = registry.create({ name, type: 'direct' });
      channel.subscribe(async (msg) => {
        local.push(`${name}:${String(msg.payload)}`);
      });
      return channel;
    };
    subscribe('inventory.reserve');
    subscribe('billing.charge');
    registry.fanout('ops.fanout', ['inventory.reserve', 'billing.charge']);
    await registry.send('ops.fanout', 'cmd');
    expect(local.slice().sort((a, b) => a.localeCompare(b))).toEqual([
      'billing.charge:cmd',
      'inventory.reserve:cmd',
    ]);
  });

  it('aislamiento de errores del canal llega por deps.onError', async () => {
    const errors: unknown[] = [];
    const deps: ChannelDeps = { trace: new TraceContext() };
    const registry = new ChannelRegistry(deps);
    deps.onError = (error) => {
      errors.push(error);
    };
    const channel = registry.create({ name: 'domain.events', type: 'pubsub' });
    channel.subscribe(async () => {
      throw new Error('roto');
    });
    await registry.send('domain.events', 'evt');
    expect(errors).toHaveLength(1);
  });
});
