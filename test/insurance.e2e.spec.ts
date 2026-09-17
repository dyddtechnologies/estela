import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OrdersApplicationModule } from '../src/example/orders.application';
import {
  PolicyEventsCollector,
  PolicyPersistence,
  QuoteEventsCollector,
  QuotePersistence,
  QuotePriceActivator,
  QuoteRulesActivator,
} from '../src/example/insurance/insurance.activators';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('example insurance — e2e HTTP (README EIP shape)', () => {
  let app: INestApplication | undefined;
  let url: string;
  let rules: QuoteRulesActivator;
  let price: QuotePriceActivator;
  let persistence: QuotePersistence;
  let events: QuoteEventsCollector;
  let policies: PolicyPersistence;
  let policyEvents: PolicyEventsCollector;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [OrdersApplicationModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    rules = moduleRef.get(QuoteRulesActivator);
    price = moduleRef.get(QuotePriceActivator);
    persistence = moduleRef.get(QuotePersistence);
    events = moduleRef.get(QuoteEventsCollector);
    policies = moduleRef.get(PolicyPersistence);
    policyEvents = moduleRef.get(PolicyEventsCollector);
  }, 20_000);

  afterAll(async () => {
    if (app === undefined) return;
    await app.close();
  });

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('POST /insurance/quotes requestReply → {status:"ok"} con payload del flow', async () => {
    const response = await post('/insurance/quotes', {
      planId: 'plan-apap-1',
      numberId: '12345678',
      dob: '1990-01-01',
      country: 'GT',
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      status: string;
      result: { quoteId: string; premium: number; jumpReplies?: unknown };
      headers: Record<string, string>;
    };
    expect(body.status).toBe('ok');
    expect(body.result.quoteId).toBe('qte-plan-apap-1');
    expect(body.result.premium).toBe(250);
    expect(body.result.jumpReplies).toBeUndefined();
    expect(body.headers.traceId).toBeTruthy();
    await delay(50);
    expect(persistence.persisted).toHaveLength(1);
    expect(events.seen).toEqual([
      {
        routingKey: 'quote.created',
        payload: {
          quoteId: 'qte-plan-apap-1',
          planId: 'plan-apap-1',
          numberId: '12345678',
          dob: '1990-01-01',
          country: 'GT',
          premium: 250,
        },
      },
    ]);
  }, 20_000);

  it('replay con idempotency-key → duplicate con cachedResult', async () => {
    const first = await post(
      '/insurance/quotes',
      { planId: 'DUP', numberId: '1', country: 'US' },
      { 'idempotency-key': 'ins-e2e-1' },
    );
    expect(((await first.json()) as { status: string }).status).toBe('ok');
    const second = await post(
      '/insurance/quotes',
      { planId: 'DUP', numberId: '1', country: 'US' },
      { 'idempotency-key': 'ins-e2e-1' },
    );
    const body = (await second.json()) as {
      status: string;
      replayed: boolean;
      result: Record<string, unknown>;
    };
    expect(body.status).toBe('duplicate');
    expect(body.replayed).toBe(true);
    expect(body.result).toEqual({
      quoteId: 'qte-DUP',
      planId: 'DUP',
      numberId: '1',
      country: 'US',
      premium: 250,
    });
  }, 20_000);

  it('fanout: POST /insurance/quotes/fanout → accepted; bindings a rules Y price', async () => {
    const rulesBefore = rules.calls;
    const priceBefore = price.calls;
    const response = await post('/insurance/quotes/fanout', { planId: 'FAN' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('accepted');
    await delay(80);
    expect(rules.calls).toBe(rulesBefore + 1);
    expect(price.calls).toBe(priceBefore + 1);
  }, 20_000);

  it('POST /insurance/policies requestReply → policy emitida', async () => {
    const response = await post('/insurance/policies', { quoteId: 'qte-plan-apap-1' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      status: string;
      result: { policyId: string; status: string };
    };
    expect(body.status).toBe('ok');
    expect(body.result.policyId).toBe('pol-qte-plan-apap-1');
    expect(body.result.status).toBe('ISSUED');
    await delay(50);
    expect(policies.persisted).toHaveLength(1);
    expect(policyEvents.seen).toEqual([
      {
        routingKey: 'policy.created',
        payload: { policyId: 'pol-qte-plan-apap-1', quoteId: 'qte-plan-apap-1', status: 'ISSUED' },
      },
    ]);
  }, 20_000);
});
