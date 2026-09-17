import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { Injectable, Module } from '@nestjs/common';
import { INTEGRATION_OPTIONS, IntegrationModule } from './integration.module';
import { ServiceActivator } from './decorators';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { ChannelRegistry } from './channel-registry';
import { ChannelGraph } from './graph/channel-graph';
import { ChannelGraphController } from './graph/channel-graph.controller';
import type { ResolvedIntegrationOptions } from './integration.module';

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
