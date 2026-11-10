import 'reflect-metadata';

import {
  Body,
  Controller,
  Headers,
  Injectable,
  Logger,
  Post,
  UseGuards,
  type CanActivate,
  type INestApplication,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lastValueFrom, of } from 'rxjs';
import {
  ChannelRegistry,
  INBOUND_DEPS,
  InboundBusyError,
  InboundGrpc,
  InboundInterceptor,
  InboundRest,
  IntegrationModule,
  MemoryIdempotencyStore,
  OutboundHttpError,
  OutboundRestGateway,
  ServiceActivator,
  type CareEvent,
  type CareMetricsPort,
  type InboundInterceptorDeps,
  type IntegrationModuleOptions,
} from '../../src/index';
import { manualCareClock, type ManualCareClock } from '../../src/testing/index';

/**
 * Scenario "burst-overload": a WhatsApp Business webhook hub and a card-payments authorizer take
 * an inbound burst of 200 concurrent calls over loopback HTTP (real Nest apps, real sockets, the
 * global fetch) and over the gRPC inbound pipeline, then a payments chain of three Estela services
 * meets a dead bank during the burst. Care time runs on `manualCareClock`, so every turn, lane
 * and waitlist bound is decided by the test, never by wall time.
 *
 * gRPC: `@grpc/grpc-js` is not a dependency of this repo (and package.json stays unchanged), so the
 * gRPC calls go through the module's own `InboundInterceptor` and `GrpcInboundStrategy` with an
 * RPC execution context carrying a grpc-js-shaped `Metadata` (`toJSON()`), which is exactly what
 * Nest hands the interceptor under the gRPC transport.
 */

jest.setTimeout(30_000);

const BURST = 200;

// ---------- Realistic payloads ----------

function whatsappDelivery(n: number): { wamid: string; body: unknown } {
  const wamid = `wamid.HBgLNTAyNTU1MDEyMzQVAgASGBQzQUI${String(n).padStart(5, '0')}`;
  return {
    wamid,
    body: {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550783881',
                  phone_number_id: '106540352242922',
                },
                contacts: [{ profile: { name: 'Ana López' }, wa_id: '50255501234' }],
                messages: [
                  {
                    from: '50255501234',
                    id: wamid,
                    timestamp: String(1_762_780_000 + n),
                    type: 'text',
                    text: { body: `Hola, quiero confirmar mi cita #${n}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  };
}

function cardAuthorization(n: number): Record<string, unknown> {
  return {
    merchantId: 'mch_7Q2LKX',
    orderRef: `ORD-2026-11-${String(n).padStart(6, '0')}`,
    amount: { value: 12_550 + n, currency: 'GTQ' },
    card: { token: `tok_visa_${n.toString(36)}`, last4: '4242', network: 'visa' },
    capture: false,
  };
}

// ---------- Helpers ----------

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Resolves when `predicate` holds, polling on the event loop; fails after `limitMs`. */
async function until(predicate: () => boolean, what: string, limitMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > limitMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface Settled {
  status: number;
  retryAfter: string | null;
  body: Record<string, unknown>;
}

async function settle(response: Promise<Response>): Promise<Settled> {
  const res = await response;
  const text = await res.text();
  return {
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>,
  };
}

/** Records the care metrics the engine reports. */
function metricsRecorder(): CareMetricsPort & { turnedAway(reason: string): number } {
  const counters: { name: string; labels: Record<string, string>; value: number }[] = [];
  return {
    counter: (name, labels, value = 1) => counters.push({ name, labels, value }),
    histogram: () => undefined,
    gauge: () => undefined,
    turnedAway: (reason) =>
      counters
        .filter((c) => c.name === 'estela_care_turned_away_total' && c.labels.reason === reason)
        .reduce((sum, c) => sum + c.value, 0),
  };
}

function timeoutHandles(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

interface Upstream {
  base: string;
  seen: IncomingMessage['headers'][];
  close(): Promise<void>;
}

/** The acquiring bank, down: every call answers 503 without Retry-After. */
async function startDeadBank(): Promise<Upstream> {
  const seen: IncomingMessage['headers'][] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'issuer_unavailable' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Handler runs per endpoint: a shed request never reaches the handler (RS-37). */
const handled = { webhook: 0, grpc: 0, authorize: 0 };

// ---------- WhatsApp webhook hub (pace) ----------

@Controller('whatsapp')
class WhatsappWebhookController {
  @Post('webhook')
  @InboundRest({
    channel: 'wa.webhook',
    requestReply: true,
    idempotency: {},
    care: { pace: { perSecond: 10, burst: 20 } },
  })
  receive(@Body() body: unknown): unknown {
    handled.webhook += 1;
    return body;
  }
}

@Controller('whatsapp-unguarded')
class UnguardedWebhookController {
  @Post('webhook')
  @InboundRest({ channel: 'wa.webhook', requestReply: true, idempotency: {} })
  receive(@Body() body: unknown): unknown {
    return body;
  }
}

@Injectable()
class WhatsappInboxActivator {
  delivered: string[] = [];

  @ServiceActivator('wa.webhook')
  store(payload: { entry: { changes: { value: { messages: { id: string }[] } }[] }[] }): unknown {
    const id = payload.entry[0]?.changes[0]?.value.messages[0]?.id ?? 'unknown';
    this.delivered.push(id);
    return { stored: id };
  }
}

// ---------- WhatsApp hub over gRPC (pace) ----------

class WhatsappGrpcController {
  @InboundGrpc({
    channel: 'wa.grpc',
    requestReply: true,
    care: { pace: { perSecond: 10, burst: 20 } },
  })
  deliver(data: unknown): unknown {
    handled.grpc += 1;
    return data;
  }

  @InboundGrpc({ channel: 'wa.grpc.relay', requestReply: true })
  relay(data: unknown): unknown {
    return data;
  }
}

@Injectable()
class WhatsappGrpcActivator {
  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator('wa.grpc')
  deliver(payload: unknown): unknown {
    return { queued: payload };
  }

  @ServiceActivator('wa.grpc.relay')
  async relay(payload: unknown): Promise<unknown> {
    return this.outbound.request('meta-graph', { payload });
  }
}

// ---------- Card authorizer (lanes) ----------

let arrivals = 0;

/** Counts every request that reaches the endpoint (guards run before inbound care). */
@Injectable()
class ArrivalGuard implements CanActivate {
  canActivate(): boolean {
    arrivals += 1;
    return true;
  }
}

@Controller('payments')
@UseGuards(ArrivalGuard)
class AuthorizeController {
  @Post('authorize')
  @InboundRest({
    channel: 'payments.authorize',
    requestReply: true,
    idempotency: {},
    care: { lanes: { count: 8, waitlist: 4, waitlistMs: 250 } },
  })
  authorize(@Body() body: unknown): unknown {
    handled.authorize += 1;
    return body;
  }
}

/** Holds each authorization until the test lets the issuer answer. */
@Injectable()
class IssuerActivator {
  inFlight = 0;
  maxInFlight = 0;
  started = 0;
  readonly gates: Deferred[] = [];

  @ServiceActivator('payments.authorize')
  async authorize(payload: { orderRef: string }): Promise<unknown> {
    this.started += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const gate = deferred();
    this.gates.push(gate);
    try {
      await gate.promise;
      return { orderRef: payload.orderRef, approved: true, authCode: 'A1B2C3' };
    } finally {
      this.inFlight -= 1;
    }
  }
}

// ---------- Payments chain: core -> ledger -> bank ----------

const chainSeen: { port: number; triesLeft: string | undefined }[] = [];

@Controller('charges')
class ChargeController {
  @Post()
  @InboundRest({ channel: 'charge.in', requestReply: true })
  charge(
    @Body() body: unknown,
    @Headers('x-tries-left') triesLeft: string | undefined,
    @Headers('host') host: string,
  ): unknown {
    chainSeen.push({ port: Number(host.split(':')[1]), triesLeft });
    return body;
  }
}

/** Forwards each charge to the `next` binding: one hop to the next layer. */
@Injectable()
class ChargeRelayActivator {
  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator('charge.in')
  async relay(payload: unknown): Promise<unknown> {
    return this.outbound.request('next', { payload });
  }
}

/** POST bodies are not tried again by the REST classifier without `idempotent` (RS-09). */
const tries3 = { tries: { max: 3, idempotent: true, spacing: 1 } } as const;

// ---------- App boot ----------

async function startApp(
  options: Partial<IntegrationModuleOptions>,
  controllers: unknown[],
  providers: unknown[],
): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels: [], logging: { banner: false }, ...options })],
    controllers: controllers as never[],
    providers: providers as never[],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

/** A grpc-js-shaped `Metadata`: Nest hands it to the interceptor as the RPC context. */
function grpcMetadata(entries: Record<string, string>): { toJSON(): Record<string, string[]> } {
  return {
    toJSON: () => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])),
  };
}

/** One unary gRPC call through the module's inbound pipeline; resolves to the reply or the error. */
async function grpcCall(
  interceptor: InboundInterceptor,
  method: 'deliver' | 'relay',
  data: unknown,
  metadata: Record<string, string> = {},
): Promise<{ ok: true; reply: unknown } | { ok: false; error: unknown }> {
  const controller = new WhatsappGrpcController();
  const handler = WhatsappGrpcController.prototype[method];
  const context = new ExecutionContextHost(
    [data, grpcMetadata(metadata), {}],
    WhatsappGrpcController,
    handler,
  );
  context.setType('rpc');
  try {
    const stream = await interceptor.intercept(context, {
      handle: () => of(handler.call(controller, data)),
    });
    return { ok: true, reply: await lastValueFrom(stream) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** What an app's RPC exception filter sends for a turned-away call (README "Inbound care"). */
function toGrpcStatus(error: unknown): { code: number; details: string } | undefined {
  if (!(error instanceof InboundBusyError)) return undefined;
  return { code: error.grpcCode, details: `RESOURCE_EXHAUSTED: ${error.reason}` };
}

// ---------- Scenario ----------

describe('scenario burst-overload', () => {
  const apps: INestApplication[] = [];
  let clock: ManualCareClock;
  let events: CareEvent[];

  beforeEach(() => {
    clock = manualCareClock();
    events = [];
    arrivals = 0;
    chainSeen.length = 0;
    handled.webhook = 0;
    handled.grpc = 0;
    handled.authorize = 0;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    jest.restoreAllMocks();
  });

  const care = (metrics?: CareMetricsPort) => ({
    clock,
    events: { channel: false as const, onEvent: (event: CareEvent) => events.push(event) },
    ...(metrics === undefined ? {} : { metrics }),
  });

  describe('WhatsApp webhook hub, pace { perSecond: 10, burst: 20 }', () => {
    async function startHub(metrics?: CareMetricsPort) {
      const store = new MemoryIdempotencyStore();
      const { app, url } = await startApp(
        {
          channels: [{ name: 'wa.webhook', type: 'direct' }],
          care: care(metrics),
          idempotency: { store },
        },
        [WhatsappWebhookController],
        [WhatsappInboxActivator],
      );
      apps.push(app);
      return { app, url: `${url}/whatsapp/webhook`, store };
    }

    it('RS-37 RS-22: of 200 concurrent deliveries exactly the burst passes; the rest get 429 + Retry-After before any idempotency claim', async () => {
      const metrics = metricsRecorder();
      const { app, url, store } = await startHub(metrics);
      const deliveries = Array.from({ length: BURST }, (_, n) => whatsappDelivery(n));
      const results = await Promise.all(
        deliveries.map(({ wamid, body }) =>
          settle(post(url, body, { 'idempotency-key': wamid })).then((r) => ({ wamid, ...r })),
        ),
      );

      const accepted = results.filter((r) => r.status === 201);
      const shed = results.filter((r) => r.status === 429);
      expect(accepted).toHaveLength(20);
      expect(shed).toHaveLength(BURST - 20);
      // One turn every 100 ms: Retry-After is the next turn, rounded up to whole seconds.
      for (const r of shed) {
        expect(r.retryAfter).toBe('1');
        expect(r.body).toMatchObject({ code: 'INBOUND_BUSY', reason: 'over-pace' });
      }
      for (const r of accepted) expect(r.retryAfter).toBeNull();

      // Shed before pipes, the handler and the claim: no trace of a shed delivery anywhere.
      expect(handled.webhook).toBe(20);
      const delivered = [...app.get(WhatsappInboxActivator).delivered];
      const acceptedIds = accepted.map((r) => r.wamid);
      delivered.sort();
      acceptedIds.sort();
      expect(delivered).toEqual(acceptedIds);
      for (const r of shed) expect(await store.get('inbound:wa.webhook', r.wamid)).toBeUndefined();
      for (const r of accepted) {
        expect((await store.get('inbound:wa.webhook', r.wamid))?.status).toBe('completed');
      }
      expect(events.filter((e) => e.type === 'pace.over')).toHaveLength(BURST - 20);
      expect(metrics.turnedAway('over-pace')).toBe(BURST - 20);
    });

    it('RS-22: a sender that honours Retry-After gets refilled turns, one per 100 ms, and no more', async () => {
      const { app, url } = await startHub();
      const first = await Promise.all(
        Array.from({ length: BURST }, (_, n) => whatsappDelivery(n)).map(({ wamid, body }) =>
          settle(post(url, body, { 'idempotency-key': wamid })).then((r) => ({
            ...r,
            wamid,
            delivery: body,
          })),
        ),
      );
      const shed = first.filter((r) => r.status === 429);
      expect(shed).toHaveLength(180);

      // Meta redelivers after Retry-After (1 s): exactly perSecond * 1 s turns came back.
      await clock.advance(1_000);
      const redelivered = await Promise.all(
        shed.map((r) => settle(post(url, r.delivery, { 'idempotency-key': r.wamid }))),
      );
      expect(redelivered.filter((r) => r.status === 201)).toHaveLength(10);
      expect(redelivered.filter((r) => r.status === 429)).toHaveLength(170);
      expect(app.get(WhatsappInboxActivator).delivered).toHaveLength(30);

      // 99 ms later the bucket is still empty; at 100 ms exactly one more turn exists.
      await clock.advance(99);
      expect(
        (await settle(post(url, shed[0]!.delivery, { 'idempotency-key': 'late-1' }))).status,
      ).toBe(429);
      await clock.advance(1);
      expect(
        (await settle(post(url, shed[0]!.delivery, { 'idempotency-key': 'late-2' }))).status,
      ).toBe(201);
      expect(
        (await settle(post(url, shed[0]!.delivery, { 'idempotency-key': 'late-3' }))).status,
      ).toBe(429);
    });

    it('RS-70 (control): the same webhook without any care configuration takes all 200, as in 0.9.0', async () => {
      const store = new MemoryIdempotencyStore();
      const { app, url } = await startApp(
        { channels: [{ name: 'wa.webhook', type: 'direct' }], idempotency: { store } },
        [UnguardedWebhookController],
        [WhatsappInboxActivator],
      );
      apps.push(app);
      const results = await Promise.all(
        Array.from({ length: BURST }, (_, n) => whatsappDelivery(n)).map(({ wamid, body }) =>
          settle(post(`${url}/whatsapp-unguarded/webhook`, body, { 'idempotency-key': wamid })),
        ),
      );
      expect(results.every((r) => r.status === 201 && r.retryAfter === null)).toBe(true);
      expect(app.get(WhatsappInboxActivator).delivered).toHaveLength(BURST);
      expect(results[0]?.body).toMatchObject({ status: 'ok' });
    });
  });

  describe('WhatsApp hub over gRPC', () => {
    async function startGrpcHub(bank?: Upstream) {
      const { app } = await startApp(
        {
          channels: [
            { name: 'wa.grpc', type: 'direct' },
            { name: 'wa.grpc.relay', type: 'direct' },
          ],
          // The relay spaces its tries on wall time; the pace burst runs on the manual clock.
          care: bank === undefined ? care() : { events: { channel: false } },
          outbound: {
            rest: {
              bindings:
                bank === undefined ? [] : [{ name: 'meta-graph', url: bank.base, care: tries3 }],
            },
          },
        },
        [],
        [WhatsappGrpcActivator],
      );
      apps.push(app);
      return new InboundInterceptor(app.get<InboundInterceptorDeps>(INBOUND_DEPS));
    }

    it('RS-37 RS-22: 200 concurrent gRPC calls: the burst passes, the rest fail RESOURCE_EXHAUSTED before the handler', async () => {
      const interceptor = await startGrpcHub();
      const outcomes = await Promise.all(
        Array.from({ length: BURST }, (_, n) =>
          grpcCall(interceptor, 'deliver', whatsappDelivery(n).body),
        ),
      );
      const ok = outcomes.filter((o) => o.ok);
      const failed = outcomes.flatMap((o) => (o.ok ? [] : [o.error]));
      expect(ok).toHaveLength(20);
      expect(failed).toHaveLength(BURST - 20);
      for (const error of failed) {
        expect(error).toBeInstanceOf(InboundBusyError);
        expect((error as InboundBusyError).reason).toBe('over-pace');
        expect((error as InboundBusyError).readyInMs).toBe(100);
        expect(toGrpcStatus(error)).toEqual({ code: 8, details: 'RESOURCE_EXHAUSTED: over-pace' });
      }
      expect(handled.grpc).toBe(20);
      expect(events.filter((e) => e.type === 'pace.over')).toHaveLength(BURST - 20);
    });

    it('RS-29 RS-30: x-tries-left 0 in gRPC metadata stops the extra tries of the outbound call behind it', async () => {
      const bank = await startDeadBank();
      try {
        const interceptor = await startGrpcHub(bank);
        const capped = await grpcCall(interceptor, 'relay', whatsappDelivery(1).body, {
          'x-tries-left': '0',
        });
        expect(capped.ok).toBe(false);
        expect(bank.seen).toHaveLength(1);
        expect(bank.seen[0]?.['x-tries-left']).toBe('0');

        bank.seen.length = 0;
        const free = await grpcCall(interceptor, 'relay', whatsappDelivery(2).body);
        expect(free.ok).toBe(false);
        expect(bank.seen).toHaveLength(3);
      } finally {
        await bank.close();
      }
    });
  });

  describe('card authorizer, lanes { count: 8, waitlist: 4, waitlistMs: 250 }', () => {
    it('RS-21 RS-37: 200 concurrent authorizations: 8 run, 4 wait, 188 get 429 at once; slots live until the reply; the waitlist bound holds; nothing leaks', async () => {
      const metrics = metricsRecorder();
      const store = new MemoryIdempotencyStore();
      const { app, url } = await startApp(
        {
          channels: [{ name: 'payments.authorize', type: 'direct' }],
          care: care(metrics),
          idempotency: { store },
        },
        [AuthorizeController],
        [IssuerActivator, ArrivalGuard],
      );
      apps.push(app);
      const issuer = app.get(IssuerActivator);
      const registry = app.get(ChannelRegistry);
      const channelsBefore = registry.list().length;
      const timersBefore = timeoutHandles();
      const endpoint = `${url}/payments/authorize`;

      const settled: (Settled & { ref: string })[] = [];
      const pending = Array.from({ length: BURST }, (_, n) => {
        const body = cardAuthorization(n);
        const ref = body.orderRef as string;
        return settle(post(endpoint, body, { 'idempotency-key': ref })).then((r) => {
          settled.push({ ref, ...r });
        });
      });

      // Every request is in; the shed ones are answered while the 8 lanes are still busy.
      await until(() => arrivals === BURST, 'all arrivals');
      await until(() => settled.length === BURST - 12, '188 sheds');
      await clock.flush();
      expect(settled).toHaveLength(BURST - 12);
      expect(settled.every((r) => r.status === 429)).toBe(true);
      for (const r of settled) {
        expect(r.body).toMatchObject({ code: 'INBOUND_BUSY', reason: 'lanes-full' });
        // A lane has no known free time: no Retry-After is invented.
        expect(r.retryAfter).toBeNull();
        expect(await store.get('inbound:payments.authorize', r.ref)).toBeUndefined();
      }
      expect(issuer.started).toBe(8);
      expect(issuer.inFlight).toBe(8);
      expect(handled.authorize).toBe(8);

      // The waitlist bound: at 249 ms the 4 waiters still wait.
      await clock.advance(249);
      expect(settled).toHaveLength(BURST - 12);
      expect(issuer.started).toBe(8);

      // Two issuer answers complete two replies: the slots pass to the two oldest waiters.
      issuer.gates[0]!.resolve();
      issuer.gates[1]!.resolve();
      await until(() => issuer.started === 10, 'two waiters admitted');
      await until(() => settled.length === BURST - 10, 'two approvals');
      expect(settled.slice(-2).every((r) => r.status === 201)).toBe(true);
      expect(issuer.maxInFlight).toBe(8);

      // At 250 ms the two remaining waiters are turned away; the lanes stay full meanwhile.
      await clock.advance(1);
      await until(() => settled.length === BURST - 8, 'waitlist expiry');
      const expired = settled.slice(-2);
      for (const r of expired) {
        expect(r.status).toBe(429);
        expect(r.body).toMatchObject({ code: 'INBOUND_BUSY', reason: 'lanes-full' });
      }
      expect(issuer.started).toBe(10);
      expect(clock.pendingTimers).toBe(0);

      // Every issuer answer arrives: all 8 remaining replies complete.
      for (const gate of issuer.gates) gate.resolve();
      await Promise.all(pending);
      expect(settled.filter((r) => r.status === 201)).toHaveLength(10);
      expect(settled.filter((r) => r.status === 429)).toHaveLength(190);
      expect(issuer.inFlight).toBe(0);
      expect(issuer.maxInFlight).toBe(8);
      expect(events.filter((e) => e.type === 'lanes.full')).toHaveLength(190);
      expect(metrics.turnedAway('lanes-full')).toBe(190);

      // No growth after the burst: reply channels unregistered, no reply or waitlist timer left.
      expect(registry.list()).toHaveLength(channelsBefore);
      expect(clock.pendingTimers).toBe(0);
      await until(() => timeoutHandles() <= timersBefore + 2, 'reply timers cleared', 2_000);

      // Every lane came back: a second wave of 12 runs 8 and queues 4 again, sheds none.
      issuer.gates.length = 0;
      const second = Array.from({ length: 12 }, (_, n) =>
        settle(post(endpoint, cardAuthorization(1_000 + n))),
      );
      await until(() => issuer.started === 18, 'second wave lanes');
      await clock.flush();
      expect(issuer.inFlight).toBe(8);
      for (let i = 0; i < 4; i += 1) {
        const gate = issuer.gates[i]!;
        gate.resolve();
      }
      await until(() => issuer.started === 22, 'second wave waiters');
      for (const gate of issuer.gates) gate.resolve();
      expect((await Promise.all(second)).every((r) => r.status === 201)).toBe(true);
      expect(issuer.maxInFlight).toBe(8);
    });
  });

  describe('payments chain during a bank outage: core -> ledger -> bank', () => {
    async function startChain(withCare: boolean) {
      const bank = await startDeadBank();
      const opts = withCare ? { care: { events: { channel: false as const } } } : {};
      const ledger = await startApp(
        {
          channels: [{ name: 'charge.in', type: 'direct' }],
          ...opts,
          outbound: { rest: { bindings: [{ name: 'next', url: bank.base, care: tries3 }] } },
        },
        [ChargeController],
        [ChargeRelayActivator],
      );
      apps.push(ledger.app);
      const core = await startApp(
        {
          channels: [{ name: 'charge.in', type: 'direct' }],
          ...opts,
          outbound: {
            rest: { bindings: [{ name: 'next', url: `${ledger.url}/charges`, care: tries3 }] },
          },
        },
        [ChargeController],
        [ChargeRelayActivator],
      );
      apps.push(core.app);
      const edge = await startApp(
        {
          care: { events: { channel: false } },
          outbound: {
            rest: { bindings: [{ name: 'core', url: `${core.url}/charges`, care: tries3 }] },
          },
        },
        [],
        [],
      );
      apps.push(edge.app);
      const portOf = (u: string) => Number(new URL(u).port);
      return {
        bank,
        edge,
        core: `${core.url}/charges`,
        corePort: portOf(core.url),
        ledgerPort: portOf(ledger.url),
      };
    }

    it('RS-30: three hops, each with tries.max 3: the dead bank sees 3 calls, not 27, and every hop sends x-tries-left 0', async () => {
      const chain = await startChain(true);
      try {
        const error: unknown = await chain.edge.app
          .get(OutboundRestGateway)
          .request('core', { payload: cardAuthorization(1) })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OutboundHttpError);
        expect((error as OutboundHttpError).attempts).toBe(3);
        const atCore = chainSeen.filter((s) => s.port === chain.corePort);
        const atLedger = chainSeen.filter((s) => s.port === chain.ledgerPort);
        expect(atCore).toHaveLength(3);
        expect(atLedger).toHaveLength(3);
        expect(chain.bank.seen).toHaveLength(3);
        for (const hop of [...atCore, ...atLedger]) expect(hop.triesLeft).toBe('0');
        for (const headers of chain.bank.seen) expect(headers['x-tries-left']).toBe('0');
      } finally {
        await chain.bank.close();
      }
    });

    it('RS-29 RS-31: a 200-charge burst from a caller that already spent its tries (x-tries-left 0) reaches the bank 200 times, not 1800', async () => {
      const chain = await startChain(true);
      try {
        const results = await Promise.all(
          Array.from({ length: BURST }, (_, n) =>
            settle(post(chain.core, cardAuthorization(n), { 'x-tries-left': '0' })),
          ),
        );
        expect(results.every((r) => r.status === 500)).toBe(true);
        expect(chainSeen.filter((s) => s.port === chain.ledgerPort)).toHaveLength(BURST);
        expect(chain.bank.seen).toHaveLength(BURST);

        // A caller with one try left lets the core spend exactly one extra try, never 2.
        chainSeen.length = 0;
        chain.bank.seen.length = 0;
        const one = await settle(
          post(chain.core, cardAuthorization(9_999), { 'x-tries-left': '1' }),
        );
        expect(one.status).toBe(500);
        expect(chainSeen.filter((s) => s.port === chain.ledgerPort)).toHaveLength(2);
        expect(chain.bank.seen).toHaveLength(2);

        // The header only lowers tries: a caller claiming 20 gets tries.max (3), not more.
        chainSeen.length = 0;
        chain.bank.seen.length = 0;
        await settle(post(chain.core, cardAuthorization(10_000), { 'x-tries-left': '20' }));
        expect(chain.bank.seen).toHaveLength(3);
      } finally {
        await chain.bank.close();
      }
    });

    it('RS-30 (control): without forRoot({ care }) on core and ledger the dead bank receives 27 calls', async () => {
      const chain = await startChain(false);
      try {
        await expect(
          chain.edge.app
            .get(OutboundRestGateway)
            .request('core', { payload: cardAuthorization(1) }),
        ).rejects.toBeInstanceOf(OutboundHttpError);
        expect(chain.bank.seen).toHaveLength(27);
      } finally {
        await chain.bank.close();
      }
    });
  });
});
