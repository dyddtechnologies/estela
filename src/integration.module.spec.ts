import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { Controller, Injectable, Logger, Module, Post } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { INTEGRATION_OPTIONS, IntegrationModule } from './integration.module';
import { ServiceActivator } from './decorators';
import { InboundGraphQL, InboundRest } from './inbound/inbound.decorators';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { ChannelRegistry } from './channel-registry';
import { ChannelGraph } from './graph/channel-graph';
import { ChannelGraphController } from './graph/channel-graph.controller';
import type { ResolvedIntegrationOptions } from './integration.module';
import type { IntegrationModuleOptions } from './integration.module';
import type { AmqpLikeChannel, AmqpMessage } from './adapters/amqp-like.channel';
import { MemoryIdempotencyStore } from './idempotency/memory-idempotency.store';
import type { IntegrationMessage } from './message';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
class InventoryActivator {
  calls = 0;

  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    this.calls += 1;
    return `reserved:${JSON.stringify(payload)}`;
  }
}

@Injectable()
class BillingActivator {
  @ServiceActivator('billing.charge')
  charge(): string {
    return 'charged';
  }
}

@Injectable()
class OrderPersistence {
  persisted: Record<string, unknown>[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  @ServiceActivator('orders.persist')
  async persist(payload: unknown): Promise<void> {
    this.persisted.push(payload as Record<string, unknown>);
    // sec.17.8: el activator de persist forward a 'orders.country' (rule direct 1-subscriber)
    await this.registry.send('orders.country', payload);
  }
}

/** Prueba de `global: true`: NO importa IntegrationModule. */
@Injectable()
class FeatureProbe {
  constructor(public readonly registry: ChannelRegistry) {}
}

@Module({ providers: [FeatureProbe] })
class FeatureModuleWithoutImport {}

const PlaceOrderFlow: FlowDefinition = {
  name: 'place-order',
  build: () =>
    IntegrationFlow.from('orders.place')
      .filter(
        (payload) =>
          (payload as { qty: number }).qty > 0 &&
          typeof (payload as { sku?: string }).sku === 'string',
      )
      .transform((payload) => {
        const cmd = payload as { qty: number; sku: string };
        return { orderId: `ord-${cmd.sku}`, ...cmd, total: cmd.qty * 10 };
      })
      .wireTap('orders.audit')
      .jumpTo([
        { channel: 'inventory.reserve', timeoutMs: 1000 },
        { channel: 'billing.charge', timeoutMs: 1000 },
      ])
      .publish('domain.events', 'order.placed')
      .reply()
      .to('orders.persist'),
};

const RouteByCountryFlow: FlowDefinition = {
  name: 'route-by-country',
  build: () =>
    IntegrationFlow.from('orders.country').route((payload) => {
      const country = (payload as { country?: string }).country;
      if (country === 'GT') return 'orders.local';
      if (country === 'US') return 'orders.us';
      return 'orders.intl';
    }),
};

describe('IntegrationModule.forRoot — bootstrap orders (topologia sec.17.8)', () => {
  let moduleRef: Awaited<ReturnType<typeof compileApp>> | undefined;

  const compileApp = async () => {
    const module = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: 'orders.place', type: 'direct' },
              { name: 'orders.persist', type: 'direct' },
              { name: 'orders.country', type: 'direct' },
              { name: 'orders.audit', type: 'queue', capacity: 100 },
              { name: 'inventory.reserve', type: 'direct' },
              { name: 'billing.charge', type: 'direct' },
              { name: 'domain.events', type: 'pubsub' },
              { name: 'orders.local', type: 'queue' },
              { name: 'orders.us', type: 'queue' },
              { name: 'orders.intl', type: 'queue' },
            ],
            idempotency: { enabled: true },
          },
          [PlaceOrderFlow, RouteByCountryFlow],
        ),
        FeatureModuleWithoutImport,
      ],
      providers: [InventoryActivator, BillingActivator, OrderPersistence],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    return { app, module };
  };

  beforeAll(async () => {
    moduleRef = await compileApp();
  });

  afterAll(async () => {
    if (moduleRef === undefined) return;
    const { app } = moduleRef;
    await app.close(); // dispara onApplicationShutdown -> drain de queues
  });

  it('bootstrap: error.channel auto-created; providers exportados resolubles', () => {
    const { module } = moduleRef!;
    const registry = module.get(ChannelRegistry);
    expect(registry.get('error.channel').kind).toBe('pubsub');
    expect(module.get(ChannelGraph)).toBeInstanceOf(ChannelGraph);
    expect(module.get(ChannelGraphController)).toBeInstanceOf(ChannelGraphController);
    const options = module.get<ResolvedIntegrationOptions>(INTEGRATION_OPTIONS);
    expect(options.errorChannel).toBe('error.channel');
    expect(options.flows).toHaveLength(2);
  });

  it('e2e: place-order -> persist -> country -> route local (GT)', async () => {
    const { module } = moduleRef!;
    const registry = module.get(ChannelRegistry);
    const persistence = module.get(OrderPersistence);
    const inventory = module.get(InventoryActivator);

    const local: unknown[] = [];
    registry.get('orders.local').subscribe(async (msg: { payload: unknown }) => {
      local.push(msg.payload);
    });

    await registry.send('orders.place', { qty: 2, sku: 'A', country: 'GT' });
    await delay(80);

    expect(inventory.calls).toBe(1);
    expect(persistence.persisted).toEqual([
      { orderId: 'ord-A', qty: 2, sku: 'A', total: 20, country: 'GT' },
    ]);
    expect(local).toEqual([{ orderId: 'ord-A', qty: 2, sku: 'A', total: 20, country: 'GT' }]);
  });

  it('graph refleja los dos flows + activators descubiertos', () => {
    const { module } = moduleRef!;
    const graph = module.get(ChannelGraph);
    const registry = module.get(ChannelRegistry);
    const snapshot = graph.snapshot(registry);
    expect(snapshot.flows.map((f: { name: string }) => f.name)).toEqual([
      'place-order',
      'route-by-country',
    ]);
    expect(snapshot.edges).toContainEqual({
      from: 'orders.place',
      to: 'orders.persist',
      via: 'to',
      flow: 'place-order',
    });
    expect(snapshot.edges).toContainEqual({
      from: 'inventory.reserve',
      to: 'activator:InventoryActivator.reserve',
      via: 'activator',
    });
    const controller = module.get(ChannelGraphController);
    expect(controller.mermaid()).toContain('flowchart LR');
  });

  it('module es global: FeatureModule SIN imports resuelve ChannelRegistry (spec sec.11)', () => {
    const { module } = moduleRef!;
    const probe = module.get(FeatureProbe);
    expect(probe.registry.get('error.channel').kind).toBe('pubsub');
  });
});

describe('IntegrationModule.forRoot: channel hooks, rabbit wiring and idempotency ttl', () => {
  const closers: (() => Promise<void>)[] = [];

  const boot = async (
    options: IntegrationModuleOptions,
    flows: readonly FlowDefinition[] = [],
    providers: (new (...args: never[]) => unknown)[] = [],
  ) => {
    const module = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot(options, flows)],
      providers,
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    closers.push(() => app.close());
    return { module, registry: module.get(ChannelRegistry) };
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    jest.restoreAllMocks();
  });

  it('a replaced direct subscriber is reported through the module logger', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { registry } = await boot({ channels: [{ name: 'solo', type: 'direct' }] });
    const solo = registry.get('solo');
    solo.subscribe(async () => undefined);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("direct 'solo'"));
    solo.subscribe(async () => undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("direct 'solo'"));
  });

  it('a failing pubsub subscriber is reported to the error channel with its causation', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { registry } = await boot({
      channels: [{ name: 'events', type: 'pubsub' }],
      errorChannel: 'errors.custom',
    });
    const failed: IntegrationMessage[] = [];
    const reported: IntegrationMessage[] = [];
    registry.get('events').subscribe(async (msg: IntegrationMessage) => {
      failed.push(msg);
      throw new Error('subscriber blew up');
    });
    registry.get('errors.custom').subscribe(async (msg: IntegrationMessage) => {
      reported.push(msg);
    });

    await registry.send('events', { n: 1 }, { traceId: 't-err', correlationId: 'c-err' });
    await delay(20);

    expect(failed).toHaveLength(1);
    expect(reported).toHaveLength(1);
    const cause = failed[0]!.headers;
    const envelope = reported[0]!;
    expect(envelope.payload).toMatchObject({
      error: { message: 'subscriber blew up' },
      causedBy: cause.id,
    });
    expect(envelope.headers.traceId).toBe('t-err');
    expect(envelope.headers.correlationId).toBe('c-err');
    expect(envelope.headers.causationId).toBe(cause.id);
  });

  it('an error report that cannot be delivered is swallowed, never an unhandled rejection', async () => {
    const { registry } = await boot({ channels: [{ name: 'events', type: 'pubsub' }] });
    registry.get('events').subscribe(async () => {
      throw new Error('subscriber blew up');
    });
    registry.unregister('error.channel');
    const sendMessage = jest.spyOn(registry, 'sendMessage');
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(registry.send('events', 'p')).resolves.toBeUndefined();
      await delay(20);
      expect(sendMessage).toHaveBeenCalledWith('error.channel', expect.anything());
      await expect(sendMessage.mock.results[0]?.value).rejects.toThrow('error.channel');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('rabbit mappings are bound at init; a poison message is nacked and logged', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const consumers = new Map<string, (msg: AmqpMessage | null) => void>();
    const amqp: AmqpLikeChannel = {
      assertQueue: jest.fn(async () => undefined),
      consume: jest.fn(async (queue: string, handler: (msg: AmqpMessage | null) => void) => {
        consumers.set(queue, handler);
        return {};
      }),
      ack: jest.fn(),
      nack: jest.fn(),
      sendToQueue: jest.fn(() => true),
    };
    const { registry } = await boot({
      channels: [{ name: 'orders.in', type: 'queue' }],
      rabbitChannel: amqp,
      rabbitMappings: [{ queue: 'orders.q', channel: 'orders.in' }],
    });
    expect(amqp.assertQueue).toHaveBeenCalledWith('orders.q', { durable: true });
    const received: unknown[] = [];
    registry.get('orders.in').subscribe(async (msg: IntegrationMessage) => {
      received.push(msg.payload);
    });

    const good: AmqpMessage = { content: Buffer.from(JSON.stringify({ orderId: 'o-1' })) };
    consumers.get('orders.q')?.(good);
    await delay(20);
    expect(received).toEqual([{ orderId: 'o-1' }]);
    expect(amqp.ack).toHaveBeenCalledWith(good);
    expect(amqp.nack).not.toHaveBeenCalled();

    const poison: AmqpMessage = { content: Buffer.from('{not json') };
    consumers.get('orders.q')?.(poison);
    await delay(20);
    expect(amqp.nack).toHaveBeenCalledWith(poison, false, false);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('SyntaxError'));
    expect(received).toHaveLength(1);
  });

  it('the module idempotency ttl reaches flow scopes and activator scopes', async () => {
    const store = new MemoryIdempotencyStore();
    const begin = jest.spyOn(store, 'begin');
    const TtlFlow: FlowDefinition = {
      name: 'ttl-flow',
      build: () => IntegrationFlow.from('ttl.in').to('billing.charge'),
    };
    const { registry } = await boot(
      {
        channels: [
          { name: 'ttl.in', type: 'direct' },
          { name: 'billing.charge', type: 'direct' },
        ],
        idempotency: { ttlMs: 1234, store },
      },
      [TtlFlow],
      [BillingActivator],
    );
    await registry.send('ttl.in', 'p', { idempotencyKey: 'ttl-1' });
    const scopes = begin.mock.calls.map(([scope]) => scope);
    expect(scopes).toHaveLength(2);
    expect(scopes).toContain('flow:ttl-flow');
    expect(begin.mock.calls.map(([, key, ttlMs]) => [key, ttlMs])).toEqual([
      ['ttl-1', 1234],
      ['ttl-1', 1234],
    ]);
  });
});

@Controller('V1/Workflows')
class WorkflowController {
  @Post(':id/Start')
  @InboundRest({ channel: 'wf.start', requestReply: true })
  start(): void {}
}

@Injectable()
class OrdersResolver {
  @InboundGraphQL({ channel: 'orders.place', operation: 'mutation' })
  placeOrder(): void {}
}

describe('IntegrationModule.forRoot: inbound endpoints in the boot log', () => {
  const closers: (() => Promise<void>)[] = [];
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const boot = async (options: IntegrationModuleOptions, withInbounds: boolean) => {
    const module = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot(options)],
      controllers: withInbounds ? [WorkflowController] : [],
      providers: withInbounds ? [OrdersResolver, BillingActivator] : [BillingActivator],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    closers.push(() => app.close());
    return module;
  };

  const channels: IntegrationModuleOptions['channels'] = [
    { name: 'wf.start', type: 'direct' },
    { name: 'orders.place', type: 'direct' },
    { name: 'billing.charge', type: 'direct' },
  ];

  const inboundLines = (): string[] =>
    log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('inbound '));

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    jest.restoreAllMocks();
  });

  it('logs one line per annotated controller and provider method and records the graph', async () => {
    const module = await boot({ channels }, true);
    expect(inboundLines()).toEqual([
      'inbound rest: POST /V1/Workflows/:id/Start -> wf.start (request-reply)',
      'inbound graphql: mutation placeOrder -> orders.place',
    ]);
    expect(log).toHaveBeenCalledWith('activator: BillingActivator.charge -> billing.charge');
    const snapshot = module.get(ChannelGraph).snapshot(module.get(ChannelRegistry));
    expect(snapshot.nodes.find((node) => node.channel === 'wf.start')?.inbounds).toEqual([
      { transport: 'rest', requestReply: true },
    ]);
    expect(snapshot.edges).toContainEqual({
      from: 'inbound:graphql',
      to: 'orders.place',
      via: 'inbound',
    });
  });

  it('logs no inbound line and no rabbit warning when the service declares neither', async () => {
    await boot({ channels }, false);
    expect(inboundLines()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about rabbit mappings that have no AMQP channel to bind to', async () => {
    await boot(
      { channels, rabbitMappings: [{ queue: 'orders.q', channel: 'orders.place' }] },
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      'AMQP_CHANNEL missing: 1 rabbit inbound mapping(s) declared but not bound (warn, no throw)',
    );
  });

  it('a failing discovery is swallowed: boot completes and activators still work', async () => {
    jest.spyOn(DiscoveryService.prototype, 'getControllers').mockImplementation(() => {
      throw new Error('discovery exploded');
    });
    const module = await boot({ channels }, true);
    expect(inboundLines()).toEqual([]);
    expect(warn).toHaveBeenCalledWith('inbound discovery skipped: Error: discovery exploded');
    expect(log).toHaveBeenCalledWith('activator: BillingActivator.charge -> billing.charge');
    expect(module.get(ChannelRegistry).get('wf.start').kind).toBe('direct');
  });
});
