import type { ChannelDeps } from '../channels/channel-deps';
import type { PubSubChannel } from '../channels/pubsub.channel';
import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';
import { JumpTimeoutError } from './flow-step';
import { FlowExecutor } from './flow-executor';
import { IntegrationFlow } from './integration-flow';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface World {
  registry: ChannelRegistry;
  errors: Record<string, unknown>[];
  bind: (name: string, flow: IntegrationFlow) => FlowExecutor;
  collect: (channel: string) => { received: unknown[] };
}

const makeWorld = (): World => {
  const deps: ChannelDeps = { trace: new TraceContext() };
  const registry = new ChannelRegistry(deps);
  registry.create({ name: 'error.channel', type: 'pubsub' });
  const errors: Record<string, unknown>[] = [];
  const errorChannel = registry.get('error.channel') as PubSubChannel;
  errorChannel.subscribe(async (msg) => {
    errors.push(msg.payload as Record<string, unknown>);
  });
  return {
    registry,
    errors,
    bind: (name, flow) => {
      const built = flow.build();
      if (registry.tryGet(built.source) === undefined) {
        registry.create({ name: built.source, type: 'direct' });
      }
      const executor = new FlowExecutor(name, built, {
        registry,
        trace: registry.trace,
        errorChannel: 'error.channel',
      });
      executor.attachTo(registry);
      return executor;
    },
    collect: (channel) => {
      const received: unknown[] = [];
      registry.create({ name: channel, type: 'direct' }).subscribe(async (msg) => {
        received.push(msg.payload);
      });
      return { received };
    },
  };
};

describe('FlowExecutor + DSL (spec §6, tests mínimos 1–6)', () => {
  it('test 1: filter descarta qty 0 y no llama activators', async () => {
    const world = makeWorld();
    const out = world.collect('out');
    world.bind(
      'place-order',
      IntegrationFlow.from('orders.place')
        .filter((payload) => (payload as { qty: number }).qty > 0)
        .to('out'),
    );
    await world.registry.send('orders.place', { qty: 0, sku: 'A' });
    expect(out.received).toEqual([]);
    await world.registry.send('orders.place', { qty: 2, sku: 'A' });
    expect(out.received).toEqual([{ qty: 2, sku: 'A' }]);
  });

  it('test 2: transform cambia payload y conserva traceId', async () => {
    const world = makeWorld();
    const out = world.collect('out');
    world.bind(
      'place-order',
      IntegrationFlow.from('orders.place')
        .transform((payload) => {
          const cmd = payload as { qty: number; sku: string };
          return { orderId: 'o-1', ...cmd, total: cmd.qty * 10 };
        })
        .to('out'),
    );
    await world.registry.send('orders.place', { qty: 2, sku: 'A' }, { traceId: 't-fixed' });
    expect(out.received).toEqual([{ orderId: 'o-1', qty: 2, sku: 'A', total: 20 }]);
    expect(world.registry.trace.current()).toBeUndefined();
  });

  it('test 3: wireTap no bloquea aunque el canal audit lance (§17.6)', async () => {
    const world = makeWorld();
    const out = world.collect('out');
    world.registry.create({ name: 'orders.audit', type: 'direct' }).subscribe(async () => {
      throw new Error('audit roto');
    });
    world.bind(
      'place-order',
      IntegrationFlow.from('orders.place').wireTap('orders.audit').to('out'),
    );
    await world.registry.send('orders.place', { qty: 1 });
    await delay(20);
    expect(out.received).toEqual([{ qty: 1 }]);
  });

  it('test 4: fanout wait:true espera; wait:false no retrasa (§17.3/17.4)', async () => {
    const world = makeWorld();
    const out = world.collect('out');
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let releaseB!: () => void;
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let aDone = false;
    let bDone = false;
    world.registry.create({ name: 'a', type: 'direct' }).subscribe(async () => {
      await gateA;
      aDone = true;
    });
    world.registry.create({ name: 'b', type: 'direct' }).subscribe(async () => {
      await gateB;
      bDone = true;
    });
    world.bind(
      'fan',
      IntegrationFlow.from('in')
        .fanoutTo([{ channel: 'a' }, { channel: 'b', wait: false }])
        .to('out'),
    );
    const done = world.registry.send('in', 'p');
    await delay(25);
    expect(aDone).toBe(false);
    expect(bDone).toBe(false);
    releaseA();
    await done;
    expect(aDone).toBe(true);
    expect(bDone).toBe(false);
    expect(out.received).toEqual(['p']);
    releaseB();
    await delay(20);
    expect(bDone).toBe(true);
  });

  it('test 5: jump wait:true llena jumpReplies; timeout falla el flow y va a error.channel', async () => {
    const world = makeWorld();
    const inboundReply = world.registry.create({ name: 'reply.http-1', type: 'direct' });
    const replies: unknown[] = [];
    inboundReply.subscribe(async (msg) => {
      replies.push(msg.payload);
    });
    world.registry.create({ name: 'inventory.reserve', type: 'direct' }).subscribe(async (msg) => {
      await world.registry.send(msg.headers.replyChannel!, 'reserved');
    });
    world.bind(
      'place-order',
      IntegrationFlow.from('orders.place')
        .jumpTo([{ channel: 'inventory.reserve', timeoutMs: 500 }])
        .reply({ payload: 'jumpMerge' })
        .to('out'),
    );
    world.collect('out');
    await world.registry.send('orders.place', { orderId: 'o-9' }, { replyChannel: 'reply.http-1' });
    expect(replies).toEqual([{ orderId: 'o-9', jumpReplies: { 'inventory.reserve': 'reserved' } }]);

    world.registry.create({ name: 'silent', type: 'direct' }).subscribe(async () => undefined);
    world.bind(
      'timeout-flow',
      IntegrationFlow.from('in2')
        .jumpTo([{ channel: 'silent', timeoutMs: 40 }])
        .to('out'),
    );
    await expect(world.registry.send('in2', 'x')).rejects.toBeInstanceOf(JumpTimeoutError);
    await delay(10);
    expect(world.errors).toHaveLength(1);
    expect(world.errors[0]?.flow).toBe('timeout-flow');
  });

  it('test 6: jump conserva el replyChannel del inbound (plan §8.1) — reply cierra al inbound', async () => {
    const world = makeWorld();
    const inboundReply = world.registry.create({ name: 'reply.http-2', type: 'direct' });
    const inboundPayloads: unknown[] = [];
    inboundReply.subscribe(async (msg) => {
      inboundPayloads.push(msg.payload);
    });
    let ephemeralSeen = false;
    world.registry.create({ name: 'billing.charge', type: 'direct' }).subscribe(async (msg) => {
      const rc = msg.headers.replyChannel;
      ephemeralSeen = typeof rc === 'string' && rc.startsWith('reply.') && rc !== 'reply.http-2';
      await world.registry.send(rc!, 'charged');
    });
    world.bind(
      'place-order',
      IntegrationFlow.from('orders.place')
        .jump('billing.charge', { timeoutMs: 300 })
        .reply()
        .to('out'),
    );
    world.collect('out');
    await world.registry.send('orders.place', 'cmd', { replyChannel: 'reply.http-2' });
    expect(ephemeralSeen).toBe(true);
    expect(inboundPayloads).toEqual(['cmd']);
  });

  it('route termina el pipeline y reparte; to+reply: reply después de to NO corre', async () => {
    const world = makeWorld();
    const local = world.collect('orders.local');
    const us = world.collect('orders.us');
    const intl = world.collect('orders.intl');
    const inboundReply = world.registry.create({ name: 'reply.route', type: 'direct' });
    const routeReplies: unknown[] = [];
    inboundReply.subscribe(async (msg) => {
      routeReplies.push(msg.payload);
    });
    const country = (payload: unknown): string => {
      const c = (payload as { country?: string }).country;
      if (c === 'GT') return 'orders.local';
      if (c === 'US') return 'orders.us';
      return 'orders.intl';
    };
    world.bind('route-flow', IntegrationFlow.from('orders.persist').route(country));
    await world.registry.send('orders.persist', { country: 'GT' });
    await world.registry.send('orders.persist', { country: 'US' });
    await world.registry.send('orders.persist', { country: 'FR' });
    expect(local.received).toEqual([{ country: 'GT' }]);
    expect(us.received).toEqual([{ country: 'US' }]);
    expect(intl.received).toEqual([{ country: 'FR' }]);

    world.bind('to-then-reply', IntegrationFlow.from('in3').to('out3').reply());
    world.collect('out3');
    await world.registry.send('in3', 'p', { replyChannel: 'reply.route' });
    await delay(20);
    expect(routeReplies).toEqual([]);
  });

  it('inspect() expone source y steps sin funciones; publish no corta', async () => {
    const flow = IntegrationFlow.from('orders.place')
      .filter(() => true)
      .publish('domain.events', 'order.placed')
      .to('out');
    const view = flow.inspect();
    expect(view.source).toBe('orders.place');
    expect(view.steps.map((s) => s.kind)).toEqual(['filter', 'publish', 'to']);
    expect(JSON.stringify(view)).not.toContain('=>');

    const world = makeWorld();
    const events: { payload: unknown; rk: unknown }[] = [];
    const domainEvents = world.registry.create({ name: 'domain.events', type: 'pubsub' });
    domainEvents.subscribe(async (msg) => {
      events.push({ payload: msg.payload, rk: msg.headers.routingKey });
    });
    const out = world.collect('out');
    world.bind('pub-flow', flow);
    await world.registry.send('orders.place', 'cmd');
    expect(events).toEqual([{ payload: 'cmd', rk: 'order.placed' }]);
    expect(out.received).toEqual(['cmd']);
  });
});
