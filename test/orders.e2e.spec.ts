import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  OrdersApplicationModule,
  InventoryActivator,
  BillingActivator,
  OrderPersistence,
  DomainEventsCollector,
} from '../src/example/orders.application';
import { setupIntegrationSwagger } from '../src/inbound/inbound.swagger';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('example orders — e2e HTTP (spec §13/§15)', () => {
  let app: INestApplication | undefined;
  let url: string;
  let inventory: InventoryActivator;
  let billing: BillingActivator;
  let persistence: OrderPersistence;
  let domain: DomainEventsCollector;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrdersApplicationModule],
    }).compile();
    app = moduleRef.createNestApplication();
    setupIntegrationSwagger(app, { title: 'orders-e2e' });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    inventory = moduleRef.get(InventoryActivator);
    billing = moduleRef.get(BillingActivator);
    persistence = moduleRef.get(OrderPersistence);
    domain = moduleRef.get(DomainEventsCollector);
  }, 20_000);

  afterAll(async () => {
    if (app === undefined) return;
    await app.close(); // drain de queues (plan sec.8.6)
  });

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('POST /orders requestReply → {status:"ok"} con payload del flow + reply al HTTP', async () => {
    const response = await post('/orders', { qty: 2, sku: 'A', country: 'GT' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      status: string;
      result: { orderId: string; total: number; jumpReplies: Record<string, unknown> };
      headers: Record<string, string>;
    };
    expect(body.status).toBe('ok');
    expect(body.result.orderId).toBe('ord-A');
    expect(body.result.total).toBe(20);
    // .reply() default 'current' -> payload SIN jumpReplies (spec sec.6.3); los
    // jumpReplies viven en headers y se exponen con reply({payload:'jumpMerge'})
    expect(body.result.jumpReplies).toBeUndefined();
    expect(body.headers.traceId).toBeTruthy();
    await delay(50);
    expect(persistence.persisted).toHaveLength(1);
    expect(domain.seen).toEqual([
      {
        routingKey: 'order.placed',
        payload: { orderId: 'ord-A', qty: 2, sku: 'A', country: 'GT', total: 20 },
      },
    ]);
  }, 20_000);

  it('replay con idempotency-key → duplicate con cachedResult', async () => {
    const first = await post(
      '/orders',
      { qty: 1, sku: 'DUP', country: 'US' },
      { 'idempotency-key': 'e2e-1' },
    );
    expect(((await first.json()) as { status: string }).status).toBe('ok');
    const second = await post(
      '/orders',
      { qty: 1, sku: 'DUP', country: 'US' },
      { 'idempotency-key': 'e2e-1' },
    );
    const body = (await second.json()) as {
      status: string;
      replayed: boolean;
      result: Record<string, unknown>;
    };
    expect(body.status).toBe('duplicate');
    expect(body.replayed).toBe(true);
    expect(body.result).toEqual({
      orderId: 'ord-DUP',
      qty: 1,
      sku: 'DUP',
      country: 'US',
      total: 10,
    });
  }, 20_000);

  it('fanout: POST /orders/fanout → accepted; bindings entregan a inventory Y billing', async () => {
    const inventoryCallsBefore = inventory.calls;
    const billingCallsBefore = billing.calls;
    const response = await post('/orders/fanout', { sku: 'FAN' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('accepted'); // no awaits handlers (spec sec.5 fanout via channel)
    await delay(80);
    expect(inventory.calls).toBe(inventoryCallsBefore + 1);
    expect(billing.calls).toBe(billingCallsBefore + 1);
  }, 20_000);

  it('GET /integration/graph y /mermaid y /docs viven', async () => {
    const graphResponse = await fetch(`${url}/integration/graph`);
    expect(graphResponse.status).toBe(200);
    const graph = (await graphResponse.json()) as {
      nodes: { channel: string; bindings: readonly string[] }[];
      flows: { name: string }[];
    };
    expect(graph.flows.map((f) => f.name).sort()).toEqual([
      'cancel-policy',
      'cancel-policy-errors',
      'create-policy',
      'create-quote',
      'place-order',
      'route-by-country',
      'route-quote-by-country',
    ]);
    const fanoutNode = graph.nodes.find((n) => n.channel === 'ops.fanout');
    expect(fanoutNode?.bindings).toEqual(['inventory.reserve', 'billing.charge']);

    const mermaidResponse = await fetch(`${url}/integration/graph/mermaid`);
    expect(mermaidResponse.status).toBe(200);
    expect(await mermaidResponse.text()).toContain('flowchart LR');

    const docsResponse = await fetch(`${url}/docs`);
    expect(docsResponse.status).toBe(200);
    expect((await docsResponse.text()).toLowerCase()).toContain('swagger');
  }, 20_000);
});
