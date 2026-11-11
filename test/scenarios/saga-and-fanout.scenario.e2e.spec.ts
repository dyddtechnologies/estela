import 'reflect-metadata';

import {
  Body,
  Controller,
  Inject,
  Injectable,
  Logger,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CARE_ENGINE,
  CareControl,
  ChannelRegistry,
  FlowDefinitionError,
  InboundRest,
  IntegrationFlow,
  IntegrationModule,
  OutboundHttpError,
  OutboundRestGateway,
  OutOfTimeError,
  SagaDefinitionError,
  SagaRunner,
  ServiceActivator,
  saga,
  type CareEngine,
  type CareModuleOptions,
  type CareRef,
  type FlowDefinition,
  type IntegrationMessage,
  type SagaDefinition,
  type TransactionPort,
} from '../../src/index';
import { collectCareEvents, manualCareClock, type ManualCareClock } from '../../src/testing';

/**
 * Scenario "saga-and-fanout": a checkout saga charging a flaky payment gateway, and a WhatsApp
 * inbound webhook fanned out to three internal destinations, one of them down. Real Nest apps on
 * loopback sockets, a real upstream HTTP server and the global fetch. Care time runs on
 * `manualCareClock`; the only real waits are bounded polls for socket round trips.
 */

// ---------- Upstream: payment gateway and CRM over loopback HTTP ----------

interface SeenRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Upstream {
  base: string;
  seen: SeenRequest[];
  /** Number of `/v1/charges` requests still answered with 503 before succeeding. */
  chargeFailuresLeft: number;
  close(): Promise<void>;
}

/**
 * `/v1/charges` answers 503 while `chargeFailuresLeft` > 0 (no Retry-After), then 201 with a
 * charge id. `/crm/*` always answers 503: the CRM is down for the whole scenario.
 */
async function startUpstream(): Promise<Upstream> {
  const state: Upstream = {
    base: '',
    seen: [],
    chargeFailuresLeft: 0,
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const raw = Buffer.concat(chunks).toString('utf8');
      state.seen.push({
        path,
        headers: req.headers,
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path.startsWith('/crm/')) {
        json(503, { error: 'crm_maintenance' });
        return;
      }
      if (state.chargeFailuresLeft > 0) {
        state.chargeFailuresLeft -= 1;
        json(503, { error: 'issuer_unavailable' });
        return;
      }
      json(201, { id: 'ch_3PfQ2nL9', status: 'succeeded' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

const requestsTo = (upstream: Upstream, prefix: string): SeenRequest[] =>
  upstream.seen.filter((request) => request.path.startsWith(prefix));

/** Bounded poll for socket round trips; fails with `label` instead of hanging. */
async function waitUntil(condition: () => boolean, label: string, timeoutMs = 3_000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------- Checkout saga: hold funds, charge the card, confirm ----------

interface CheckoutCtx {
  orderId: string;
  customerPhone: string;
  amountCents: number;
  currency: string;
  paymentKey: string;
  chargeId?: string;
  trail: string[];
}

interface Ledger {
  rows: string[];
  transactions: number;
}

/** In-memory database: a transaction stages writes and commits them only when the work resolves. */
function ledgerPort(ledger: Ledger): TransactionPort<string[]> {
  return {
    run: async <T>(work: (tx: string[]) => Promise<T>): Promise<T> => {
      ledger.transactions += 1;
      const staged: string[] = [];
      const result = await work(staged);
      ledger.rows.push(...staged);
      return result;
    },
    // Postgres SQLSTATE 40P01: the compensation's own retry policy reacts to it.
    classify: (error) =>
      (error as { code?: unknown } | undefined)?.code === '40P01' ? 'deadlock' : undefined,
  };
}

const deadlock = (): Error => Object.assign(new Error('deadlock detected'), { code: '40P01' });

@Injectable()
class CheckoutService {
  readonly ledger: Ledger = { rows: [], transactions: 0 };
  /** Compensation runs that throw a deadlock before one succeeds (Infinity: never succeeds). */
  releaseDeadlocks = 0;
  releaseRuns = 0;
  readonly runner: SagaRunner<string[]>;

  constructor(
    private readonly outbound: OutboundRestGateway,
    @Inject(CARE_ENGINE) engine: CareEngine,
  ) {
    this.runner = new SagaRunner<string[]>({
      transactions: ledgerPort(this.ledger),
      care: engine,
      sleep: () => Promise.resolve(),
    });
  }

  /** The checkout saga; the charge step's care comes from a module profile or inline. */
  definition(care: CareRef): SagaDefinition<CheckoutCtx, string[], { chargeId: string }> {
    return saga<CheckoutCtx, string[], { chargeId: string }>('checkout')
      .transaction('hold-funds', (ctx, tx) => {
        ctx.trail.push('hold');
        tx.push(`hold:${ctx.orderId}`);
      })
      .outbound(
        'charge',
        async (ctx) => {
          ctx.trail.push('charge');
          const response = await this.outbound.request<{ body: { id: string } }>(
            'psp.charges',
            {
              payload: {
                amount: ctx.amountCents,
                currency: ctx.currency,
                source: 'tok_visa_4242',
                metadata: { orderId: ctx.orderId, phone: ctx.customerPhone },
              },
            },
            { idempotencyKey: ctx.paymentKey },
          );
          ctx.chargeId = response.body.id;
        },
        {
          care,
          compensate: (ctx, tx) => {
            this.releaseRuns += 1;
            ctx.trail.push('release');
            if (this.releaseRuns <= this.releaseDeadlocks) throw deadlock();
            tx.push(`release:${ctx.orderId}`);
          },
        },
      )
      .transaction('confirm', (ctx, tx) => {
        ctx.trail.push('confirm');
        tx.push(`confirm:${ctx.orderId}`);
      })
      .retry({ on: ['deadlock'], attempts: 2, backoffMs: 0 })
      .reply((ctx) => ({ chargeId: ctx.chargeId ?? '' }));
  }
}

const checkoutCtx = (orderId: string): CheckoutCtx => ({
  orderId,
  customerPhone: '+50255501234',
  amountCents: 189_900,
  currency: 'GTQ',
  paymentKey: `pay_${orderId}_v1`,
  trail: [],
});

// ---------- WhatsApp inbound webhook fanned out to three destinations ----------

const CUSTOMER_PHONE = '+50255501234';
const CUSTOMER_TEXT = 'Hola, quiero cambiar mi cita del jueves a las 4pm';

const whatsappWebhook = (wamid: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: CUSTOMER_PHONE, profile: { name: 'Lucia Mendez' } }],
            messages: [
              { id: wamid, from: CUSTOMER_PHONE, type: 'text', text: { body: CUSTOMER_TEXT } },
            ],
          },
        },
      ],
    },
  ],
});

@Controller('webhooks')
class WhatsAppWebhookController {
  @Post('whatsapp')
  @InboundRest({ channel: 'wa.inbound', requestReply: true, idempotency: {} })
  receive(@Body() _body: unknown): void {
    // The flow answers the webhook with `.reply()`.
  }
}

@Injectable()
class AgentInboxActivator {
  readonly received: IntegrationMessage[] = [];

  @ServiceActivator('wa.agent-inbox')
  deliver(_payload: unknown, msg: IntegrationMessage): { queued: true } {
    this.received.push(msg);
    return { queued: true };
  }
}

@Injectable()
class AnalyticsActivator {
  readonly received: IntegrationMessage[] = [];

  @ServiceActivator('wa.analytics')
  ingest(_payload: unknown, msg: IntegrationMessage): void {
    this.received.push(msg);
  }
}

/** Relays each message to the CRM timeline API, which is down (503) for the whole scenario. */
@Injectable()
class CrmTimelineActivator {
  runs = 0;

  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator('wa.crm-timeline')
  async append(payload: unknown): Promise<unknown> {
    this.runs += 1;
    return this.outbound.request('crm.timeline', { payload });
  }
}

const CRM_BINDING = 'flow:wa-inbound#deliver:wa.crm-timeline';
const INBOX_BINDING = 'flow:wa-inbound#deliver:wa.agent-inbox';

/** The CRM target's own care: three tries under the message key, and a valve that shuts fast. */
const crmCare = {
  tries: { max: 3, spacing: 0 },
  valve: { minCalls: 3, failPercent: 50, shutMs: 60_000 },
} as const;

function whatsappFlow(crmWait: boolean): FlowDefinition {
  return {
    name: 'wa-inbound',
    build: () =>
      IntegrationFlow.from('wa.inbound')
        .wireTap('wa.audit')
        .fanoutTo(
          [
            'wa.agent-inbox',
            { channel: 'wa.analytics', care: false },
            { channel: 'wa.crm-timeline', wait: crmWait, care: crmCare },
          ],
          { id: 'deliver', care: { patience: { eachTryMs: 2_000 } } },
        )
        .transform(() => ({ received: true }))
        .reply(),
  };
}

// ---------- Module wiring ----------

interface Booted {
  app: INestApplication;
  url: string;
  clock: ManualCareClock;
}

function careOptions(clock: ManualCareClock): CareModuleOptions {
  return {
    clock,
    profiles: {
      'psp-charge': { tries: { max: 3, idempotent: true, spacing: 0 } },
      'psp-charge-sla': {
        extends: 'psp-charge',
        tries: { max: 5, idempotent: true, spacing: 600 },
        patience: { totalMs: 1_000 },
      },
      'psp-charge-unsafe': { tries: { max: 3, spacing: 0 } },
    },
  };
}

async function boot(upstream: Upstream, flows: FlowDefinition[] = []): Promise<Booted> {
  const clock = manualCareClock();
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        {
          logging: { banner: false },
          care: careOptions(clock),
          channels: [
            { name: 'wa.inbound', type: 'direct' },
            { name: 'wa.agent-inbox', type: 'direct' },
            { name: 'wa.analytics', type: 'direct' },
            { name: 'wa.crm-timeline', type: 'direct' },
            // Care on the tap channel: a wireTap must never pick it up (RS-58).
            {
              name: 'wa.audit',
              type: 'direct',
              care: { tries: { max: 3, idempotent: true, spacing: 0 } },
            },
          ],
          outbound: {
            rest: {
              bindings: [
                // A layer without extra tries: it forwards the tries left it gets (RS-30).
                {
                  name: 'psp.charges',
                  url: `${upstream.base}/v1/charges`,
                  care: { patience: { eachTryMs: 5_000 } },
                },
                { name: 'crm.timeline', url: `${upstream.base}/crm/v3/timeline` },
              ],
            },
          },
        },
        flows,
      ),
    ],
    controllers: [WhatsAppWebhookController],
    providers: [CheckoutService, AgentInboxActivator, AnalyticsActivator, CrmTimelineActivator],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl(), clock };
}

const postWebhook = (url: string, wamid: string) =>
  fetch(`${url}/webhooks/whatsapp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': wamid,
      'x-tries-left': '2',
    },
    body: JSON.stringify(whatsappWebhook(wamid)),
  });

// ---------- Scenario ----------

describe('scenario saga-and-fanout (SPI-445)', () => {
  let upstream: Upstream;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    upstream = await startUpstream();
  });

  afterAll(async () => {
    await upstream.close();
  });

  beforeEach(() => {
    upstream.seen.length = 0;
    upstream.chargeFailuresLeft = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    jest.restoreAllMocks();
  });

  async function start(flows: FlowDefinition[] = []): Promise<Booted> {
    const booted = await boot(upstream, flows);
    apps.push(booted.app);
    return booted;
  }

  describe('checkout saga against a flaky payment gateway', () => {
    it('RS-38 RS-09: a flaky charge succeeds on try 3 with the same idempotency key, without compensation', async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      upstream.chargeFailuresLeft = 2;
      const ctx = checkoutCtx('ord-7781');

      const reply = await checkout.runner.run(checkout.definition('psp-charge'), ctx);

      expect(reply).toEqual({ chargeId: 'ch_3PfQ2nL9' });
      const charges = requestsTo(upstream, '/v1/charges');
      expect(charges).toHaveLength(3);
      expect(charges.map((request) => request.headers['idempotency-key'])).toEqual([
        'pay_ord-7781_v1',
        'pay_ord-7781_v1',
        'pay_ord-7781_v1',
      ]);
      expect(ctx.trail).toEqual(['hold', 'charge', 'charge', 'charge', 'confirm']);
      expect(checkout.releaseRuns).toBe(0);
      expect(checkout.ledger.rows).toEqual(['hold:ord-7781', 'confirm:ord-7781']);
    });

    it('RS-30: the step that owns the extra tries sends x-tries-left 0 to the gateway', async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      upstream.chargeFailuresLeft = 1;
      await checkout.runner.run(checkout.definition('psp-charge'), checkoutCtx('ord-7782'));
      const charges = requestsTo(upstream, '/v1/charges');
      expect(charges).toHaveLength(2);
      expect(charges.every((request) => request.headers['x-tries-left'] === '0')).toBe(true);
    });

    it('RS-38: when every try fails, compensation runs once after the last try and the last error is rethrown', async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      upstream.chargeFailuresLeft = Number.POSITIVE_INFINITY;
      const ctx = checkoutCtx('ord-7790');

      const failure: unknown = await checkout.runner
        .run(checkout.definition('psp-charge'), ctx)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OutboundHttpError);
      expect((failure as OutboundHttpError).status).toBe(503);
      expect(requestsTo(upstream, '/v1/charges')).toHaveLength(3);
      expect(ctx.trail).toEqual(['hold', 'charge', 'charge', 'charge', 'release']);
      expect(checkout.releaseRuns).toBe(1);
      expect(checkout.ledger.rows).toEqual(['hold:ord-7790', 'release:ord-7790']);
    });

    it('RS-07 RS-38: patience.totalMs ends the tries before tries.max, then compensation runs once', async () => {
      const { app, clock } = await start();
      const checkout = app.get(CheckoutService);
      const events = collectCareEvents(app);
      upstream.chargeFailuresLeft = Number.POSITIVE_INFINITY;
      const ctx = checkoutCtx('ord-7791');

      const running = checkout.runner
        .run(checkout.definition('psp-charge-sla'), ctx)
        .catch((error: unknown) => error);
      await waitUntil(() => events.types().includes('try.again'), 'the first try.again');
      // The 600 ms gap after try 1 fits the 1 s deadline; the gap after try 2 does not.
      await clock.advance(600);
      const failure = await running;

      expect(failure).toBeInstanceOf(OutOfTimeError);
      expect((failure as OutOfTimeError).cause).toBeInstanceOf(OutboundHttpError);
      expect(requestsTo(upstream, '/v1/charges')).toHaveLength(2);
      expect(ctx.trail).toEqual(['hold', 'charge', 'charge', 'release']);
      expect(checkout.releaseRuns).toBe(1);
      const charge = events.events.filter((event) => event.binding === 'checkout:charge');
      expect(charge.map((event) => event.type)).toEqual(['try.again', 'patience.ran-out']);
      expect(JSON.stringify(events.events)).not.toContain('50255501234');
      events.unsubscribe();
    });

    it("RS-38: a compensation that deadlocks is re-run only by the saga's own retry policy", async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      upstream.chargeFailuresLeft = Number.POSITIVE_INFINITY;
      checkout.releaseDeadlocks = 1;
      const ctx = checkoutCtx('ord-7792');

      const failure: unknown = await checkout.runner
        .run(checkout.definition('psp-charge'), ctx)
        .catch((error: unknown) => error);

      // The step's three tries do not leak into the compensation, and its deadlock does not
      // replace the charge failure once the second attempt (its own policy) succeeds.
      expect(failure).toBeInstanceOf(OutboundHttpError);
      expect(requestsTo(upstream, '/v1/charges')).toHaveLength(3);
      expect(checkout.releaseRuns).toBe(2);
      expect(checkout.ledger.rows).toEqual(['hold:ord-7792', 'release:ord-7792']);
    });

    it('RS-38: a compensation that keeps deadlocking stops at its own attempts and surfaces its error', async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      upstream.chargeFailuresLeft = Number.POSITIVE_INFINITY;
      checkout.releaseDeadlocks = Number.POSITIVE_INFINITY;
      const ctx = checkoutCtx('ord-7793');

      const failure: unknown = await checkout.runner
        .run(checkout.definition('psp-charge'), ctx)
        .catch((error: unknown) => error);

      expect(failure).not.toBeInstanceOf(OutboundHttpError);
      expect(String((failure as Error).message)).toMatch(/deadlock/i);
      expect(checkout.releaseRuns).toBe(2);
      expect(requestsTo(upstream, '/v1/charges')).toHaveLength(3);
      expect(checkout.ledger.rows).toEqual(['hold:ord-7793']);
    });

    it('RS-38 RS-09: extra tries without an idempotency declaration are refused before any charge', async () => {
      const { app } = await start();
      const checkout = app.get(CheckoutService);
      expect(() => checkout.definition({ tries: { max: 3, spacing: 0 } })).toThrow(
        SagaDefinitionError,
      );
      const failure: unknown = await checkout.runner
        .run(checkout.definition('psp-charge-unsafe'), checkoutCtx('ord-7794'))
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SagaDefinitionError);
      expect((failure as Error).message).toContain('checkout:charge');
      expect(checkout.ledger.transactions).toBe(0);
      expect(requestsTo(upstream, '/v1/charges')).toHaveLength(0);
    });
  });

  describe('WhatsApp inbound fanned out to inbox, analytics and a CRM that is down', () => {
    it('RS-59 RS-60: the CRM target tries alone under the message key; inbox and analytics get one copy each', async () => {
      const { app, url } = await start([whatsappFlow(false)]);
      const inbox = app.get(AgentInboxActivator);
      const analytics = app.get(AnalyticsActivator);
      const crm = app.get(CrmTimelineActivator);
      const events = collectCareEvents(app);

      const response = await postWebhook(url, 'wamid.HBgLNTAyNTU1MDEyMzQVAgASGBQzQUE');
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ status: 'ok', result: { received: true } });
      await waitUntil(() => requestsTo(upstream, '/crm/').length === 3, 'three CRM tries');

      expect(inbox.received).toHaveLength(1);
      expect(analytics.received).toHaveLength(1);
      expect(crm.runs).toBe(3);
      expect(inbox.received[0]?.headers.idempotencyKey).toBe(
        'wamid.HBgLNTAyNTU1MDEyMzQVAgASGBQzQUE',
      );
      const crmTries = events.events.filter((event) => event.binding === CRM_BINDING);
      expect(crmTries.filter((event) => event.type === 'try.again')).toHaveLength(2);
      expect(crmTries.every((event) => event.channel === 'wa.crm-timeline')).toBe(true);
      expect(events.events.some((event) => event.binding === INBOX_BINDING)).toBe(false);
      const leaked = JSON.stringify(events.events);
      expect(leaked).not.toContain('50255501234');
      expect(leaked).not.toContain('cambiar mi cita');
      events.unsubscribe();
    });

    it('RS-18 RS-66: the CRM valve shuts for its own target only; the next message still reaches the inbox', async () => {
      const { app, url } = await start([whatsappFlow(false)]);
      const inbox = app.get(AgentInboxActivator);
      const control = app.get(CareControl);

      expect((await postWebhook(url, 'wamid.first')).status).toBe(201);
      await waitUntil(() => requestsTo(upstream, '/crm/').length === 3, 'three CRM tries');
      await waitUntil(
        () => control.valveState(CRM_BINDING)?.state === 'shut',
        'the CRM valve to shut',
      );

      expect((await postWebhook(url, 'wamid.second')).status).toBe(201);
      expect(inbox.received.map((msg) => msg.headers.idempotencyKey)).toEqual([
        'wamid.first',
        'wamid.second',
      ]);
      expect(requestsTo(upstream, '/crm/')).toHaveLength(3);
      expect(control.valveState(INBOX_BINDING)).toBeUndefined();
    });

    it('RS-59: an awaited CRM target that stays down fails the webhook, yet inbox and analytics are delivered exactly once', async () => {
      const { app, url } = await start([whatsappFlow(true)]);
      const inbox = app.get(AgentInboxActivator);
      const analytics = app.get(AnalyticsActivator);

      const response = await postWebhook(url, 'wamid.awaited');

      expect(response.status).toBe(500);
      expect(requestsTo(upstream, '/crm/')).toHaveLength(3);
      expect(inbox.received).toHaveLength(1);
      expect(analytics.received).toHaveLength(1);
    });

    it('RS-58: the wireTap audit copy is sent once, without triesLeft, ignoring the care of its channel', async () => {
      const { app, url } = await start([whatsappFlow(false)]);
      const registry = app.get(ChannelRegistry);
      const audited: IntegrationMessage[] = [];
      registry.get('wa.audit').subscribe((msg) => {
        audited.push(msg);
        return Promise.reject(Object.assign(new Error('audit sink busy'), { transient: true }));
      });

      const response = await postWebhook(url, 'wamid.audit');
      expect(response.status).toBe(201);
      await waitUntil(() => requestsTo(upstream, '/crm/').length === 3, 'three CRM tries');

      expect(audited).toHaveLength(1);
      expect(audited[0]?.headers).not.toHaveProperty('triesLeft');
      expect(audited[0]?.headers.idempotencyKey).toBe('wamid.audit');
      expect(app.get(AgentInboxActivator).received[0]?.headers).toHaveProperty('triesLeft');
    });

    it('RS-58: a wireTap given care fails the boot with WIRETAP_CARE', async () => {
      const tapped: FlowDefinition = {
        name: 'wa-tapped',
        build: () =>
          IntegrationFlow.from('wa.inbound').wireTap('wa.audit', {
            care: { tries: { max: 2 } },
          } as never),
      };
      const failure: unknown = await boot(upstream, [tapped]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FlowDefinitionError);
      expect((failure as FlowDefinitionError).codes).toContain('WIRETAP_CARE');
    });

    it('RS-42 RS-66: GET /integration/graph shows Estela-vocabulary annotations and no payload, threshold or textbook word', async () => {
      const { url } = await start([whatsappFlow(false)]);
      // Traffic first: the graph must not pick up anything a message carried.
      expect((await postWebhook(url, 'wamid.graph')).status).toBe(201);
      await waitUntil(() => requestsTo(upstream, '/crm/').length === 3, 'three CRM tries');

      const response = await fetch(`${url}/integration/graph`);
      expect(response.status).toBe(200);
      const text = await response.text();
      const graph = JSON.parse(text) as {
        flows: { name: string; steps: Record<string, unknown>[] }[];
        nodes: Record<string, unknown>[];
        module?: { careProfiles?: string[] };
      };
      const steps = graph.flows.find((flow) => flow.name === 'wa-inbound')?.steps;
      expect(steps).toEqual([
        { kind: 'wireTap', channel: 'wa.audit' },
        {
          kind: 'fanout',
          id: 'deliver',
          dests: [
            { channel: 'wa.agent-inbox', care: 'patience 2s', repeatableBy: 'none' },
            { channel: 'wa.analytics' },
            {
              channel: 'wa.crm-timeline',
              wait: false,
              care: 'patience 2s · tries x3 · valve',
              repeatableBy: 'key',
            },
          ],
        },
        { kind: 'transform' },
        { kind: 'reply', payload: 'current' },
      ]);
      expect(graph.module?.careProfiles).toEqual([
        'psp-charge',
        'psp-charge-sla',
        'psp-charge-unsafe',
      ]);
      for (const value of [CUSTOMER_PHONE, '50255501234', 'cambiar mi cita', 'wamid.graph']) {
        expect(text).not.toContain(value);
      }
      // Only timeouts and try counts are numbers; no thresholds, URLs or textbook names.
      for (const word of ['failPercent', 'minCalls', 'shutMs', '60s', upstream.base]) {
        expect(text).not.toContain(word);
      }
      for (const word of ['retry', 'circuit', 'breaker', 'bulkhead', 'fallback', 'rateLimit']) {
        expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      }
    });
  });
});
