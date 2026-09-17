import 'reflect-metadata';

import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator, PubSub } from '../decorators';
import { TraceContext } from '../trace/trace-context';
import type { ChannelDeps } from '../channels/channel-deps';
import { createMessage } from '../message';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { discoverActivators, subscribeActivators, type ActivatorDeps } from './activator-wrapper';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class InventoryActivator {
  calls = 0;
  lastMsg: unknown;

  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown, msg: unknown): string {
    this.calls += 1;
    this.lastMsg = msg;
    return `reserved:${JSON.stringify(payload)}`;
  }
}

class EventsActivator {
  seen: string[] = [];

  @PubSub('domain.events', { routingKey: 'order.*' })
  onEvent(payload: unknown): void {
    this.seen.push(String(payload));
  }
}

class BrokenActivator {
  @ServiceActivator('broken.channel')
  handle(): string {
    throw new Error('activator roto');
  }
}

describe('decoradores + activator wrapper (spec §7.1)', () => {
  const makeWorld = () => {
    const deps: ChannelDeps = { trace: new TraceContext() };
    const registry = new ChannelRegistry(deps);
    registry.create({ name: 'error.channel', type: 'pubsub' });
    registry.create({ name: 'inventory.reserve', type: 'direct' });
    registry.create({ name: 'broken.channel', type: 'direct' });
    registry.create({ name: 'domain.events', type: 'pubsub' });
    const errors: Array<Record<string, unknown>> = [];
    (registry.get('error.channel') as import('../channels/pubsub.channel').PubSubChannel).subscribe(
      async (msg) => {
        errors.push(msg.payload as Record<string, unknown>);
      },
    );
    const idempotency = new IdempotencyService({ store: new MemoryIdempotencyStore() });
    const activatorDeps: ActivatorDeps = { registry, trace: registry.trace, errorChannel: 'error.channel', idempotency };
    const collectReply = (name: string): unknown[] => {
      const bucket: unknown[] = [];
      registry.create({ name, type: 'direct' }).subscribe(async (msg) => {
        bucket.push(msg.payload);
      });
      return bucket;
    };
    return { registry, errors, activatorDeps, collectReply };
  };

  it('descubre bindings decorados con channel/kind/opciones', () => {
    const bindings = discoverActivators([new InventoryActivator(), new EventsActivator()]);
    const byChannel = new Map(bindings.map((b) => [b.metadata.channel, b]));
    expect(byChannel.get('inventory.reserve')?.metadata.kind).toBe('service-activator');
    expect(byChannel.get('domain.events')?.metadata.kind).toBe('pubsub');
    expect(byChannel.get('domain.events')?.metadata.routingKey).toBe('order.*');
  });

  it('wrapper: método recibe (payload,msg) con contexto ALS; auto-reply al replyChannel', async () => {
    const world = makeWorld();
    const instance = new InventoryActivator();
    const replies = world.collectReply('reply.http-1');
    let traceIdInside: string | undefined;
    const original = instance.reserve.bind(instance);
    instance.reserve = (payload: unknown, msg: unknown): string => {
      traceIdInside = world.activatorDeps.trace.current()?.traceId;
      return original(payload as never, msg as never);
    };
    subscribeActivators(discoverActivators([instance]), world.activatorDeps);
    await world.registry.send('inventory.reserve', { sku: 'A1' }, {
      replyChannel: 'reply.http-1',
      traceId: 't-act',
    });
    await delay(10);
    expect(replies).toEqual(['reserved:{"sku":"A1"}']);
    expect(traceIdInside).toBe('t-act');
  });

  it('sin replyChannel: return no explota ni envía nada', async () => {
    const world = makeWorld();
    const instance = new InventoryActivator();
    subscribeActivators(discoverActivators([instance]), world.activatorDeps);
    await world.registry.send('inventory.reserve', { sku: 'X' });
    expect(instance.calls).toBe(1);
  });

  it('duplicado: NO re-ejecuta el método y reenvía cachedResult al replyChannel', async () => {
    const world = makeWorld();
    const instance = new InventoryActivator();
    subscribeActivators(discoverActivators([instance]), world.activatorDeps);
    const replies = world.collectReply('reply.dup');
    await world.registry.send('inventory.reserve', { sku: 'A' }, {
      idempotencyKey: 'inv-1',
      replyChannel: 'reply.dup',
    });
    await world.registry.send('inventory.reserve', { sku: 'A' }, {
      idempotencyKey: 'inv-1',
      replyChannel: 'reply.dup',
    });
    await delay(10);
    expect(instance.calls).toBe(1);
    expect(replies).toEqual(['reserved:{"sku":"A"}', 'reserved:{"sku":"A"}']);
  });

  it('error del activator: envelope a error.channel + rethrow (awaited §8.2)', async () => {
    const world = makeWorld();
    subscribeActivators(discoverActivators([new BrokenActivator()]), world.activatorDeps);
    await expect(world.registry.send('broken.channel', 'p')).rejects.toThrow('activator roto');
    await delay(10);
    expect(world.errors).toHaveLength(1);
    expect(world.errors[0]?.activator).toBe('activator:BrokenActivator.handle');
    expect((world.errors[0]?.error as { name?: string }).name).toBe('Error');
  });

  it('PubSub routingKey filtra; mensajes no coincidentes no invocan', async () => {
    const world = makeWorld();
    const instance = new EventsActivator();
    subscribeActivators(discoverActivators([instance]), world.activatorDeps);
    await world.registry.send('domain.events', 'created', { routingKey: 'order.created' });
    await world.registry.send('domain.events', 'internal', { routingKey: 'system.tick' });
    await delay(10);
    expect(instance.seen).toEqual(['created']);
  });

  it('mensaje sin idempotencia: ejecuta siempre (wrapper sin key)', async () => {
    const world = makeWorld();
    const instance = new InventoryActivator();
    subscribeActivators(discoverActivators([instance]), world.activatorDeps);
    await world.registry.send('inventory.reserve', { n: 1 });
    await world.registry.send('inventory.reserve', { n: 2 });
    expect(instance.calls).toBe(2);
    expect(createMessage('sanity').headers.history).toEqual([]);
  });
});
