import 'reflect-metadata';

import {
  Body,
  Catch,
  Controller,
  HttpException,
  Injectable,
  Logger,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lastValueFrom, of } from 'rxjs';
import {
  ChannelRegistry,
  IdempotencyInProgressError,
  INBOUND_DEPS,
  InboundGrpc,
  InboundInterceptor,
  InboundRest,
  IntegrationFlow,
  IntegrationModule,
  MemoryIdempotencyLedger,
  MemoryIdempotencyStore,
  HopLogger,
  OutboundHttpError,
  OutboundRestGateway,
  Pack,
  PrivacyEngine,
  Remember,
  SagaRunner,
  ServiceActivator,
  TrailOutput,
  bindRestOut,
  createMessage,
  saga,
  type FingerprintSecret,
  type FlowDefinition,
  type InboundInterceptorDeps,
  type IntegrationMessage,
  type IntegrationModuleOptions,
  type MessageHeadersInit,
  type SealKey,
  type TransactionPort,
} from '../../src/index';
import {
  captureTrail,
  expectNoLeak,
  leakForms,
  manualCareClock,
  type TrailCapture,
  type TrailWrite,
} from '../../src/testing';

/**
 * Scenario "canary-leak-hunt": a clinic billing hub that receives payments over REST and gRPC,
 * runs them through flows that use every DSL method, calls a payment provider and a CRM over
 * outbound REST (with care: valve and plan B), a legacy webhook through `bindRestOut`, and books
 * refunds with a saga. Unique canary values (a JWT, a bearer token, an AWS key id, a PEM block, a
 * password in URL userinfo, an `api_key` query parameter, a card, an email and an E.164 phone) are
 * planted in payloads, headers, URLs, thrown error messages, error properties, causes and nested
 * arrays. Every trail output is captured (logger, error channel, events channel, wire tap, stores,
 * ledgers) together with the graph JSON and the error messages callers read where the spec makes
 * them part of the contract; none may hold a canary in any encoded form.
 *
 * Real Nest app on a loopback socket and a real loopback upstream; care time runs on
 * `manualCareClock`. The only real waits are bounded polls for socket round trips.
 */

jest.setTimeout(30_000);

// ---------- Canaries (deterministic, fake, unique) ----------

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwYXRpZW50LTc3MTAiLCJzY29wZSI6ImJpbGxpbmcifQ.Q2FuYXJ5U2lnbmF0dXJlLTc3MTAtbGVhaw';
const BEARER_TOKEN = 'tok_live_9fQ2CanaryBearer8841';
const AWS_KEY_ID = 'AKIAZ7CANARY4LEAK9QX';
const PEM_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7CanaryPemBody0001';
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;
const USERINFO_SECRET = 'Pw-Canary-Userinfo-4417';
const QUERY_API_KEY = 'ak_canary_query_55190';
const CARD = '4539578763621486';
const EMAIL = 'maria.canary.lopez@clinica-example.com';
const PHONE = '+50241234567';
const IDEM_KEY = 'pay-Canary-Idem-0001';

const CANARIES = [
  JWT,
  BEARER_TOKEN,
  AWS_KEY_ID,
  PEM_BODY,
  USERINFO_SECRET,
  QUERY_API_KEY,
  CARD,
  EMAIL,
  PHONE,
  IDEM_KEY,
] as const;

/** The `secrets@1` canaries: the only ones the baseline (no privacy option) must hide (D3). */
const SECRET_CANARIES = [JWT, BEARER_TOKEN, AWS_KEY_ID, PEM_BODY, USERINFO_SECRET, QUERY_API_KEY];

const callbackUrl = (host: string): string =>
  `https://hooks-svc:${USERINFO_SECRET}@${host}/v1/paid?api_key=${QUERY_API_KEY}`;

// ---------- Realistic payloads and errors ----------

interface BillingRequest {
  invoiceId: string;
  patient: { name: string; email: string; phone: string };
  payment: { method: 'card'; cardNumber: string; expiry: string };
  integration: {
    callbackUrl: string;
    partnerAuth: string;
    session: string;
    awsAccessKeyId: string;
    signingKey: string;
  };
  lines: { sku: string; amountCents: number; notes: string[] }[][];
  fail?: boolean;
}

function billingRequest(invoiceId = 'INV-2026-004417'): BillingRequest {
  return {
    invoiceId,
    patient: { name: 'Maria Lopez', email: EMAIL, phone: PHONE },
    payment: { method: 'card', cardNumber: CARD, expiry: '11/29' },
    integration: {
      callbackUrl: callbackUrl('hooks.clinica-example.com'),
      partnerAuth: `Bearer ${BEARER_TOKEN}`,
      session: JWT,
      awsAccessKeyId: AWS_KEY_ID,
      signingKey: PEM,
    },
    lines: [
      [
        {
          sku: 'CONSULT-01',
          amountCents: 45_000,
          notes: [`card on file ${CARD}`, `reach the patient at ${PHONE} or ${EMAIL}`],
        },
      ],
    ],
  };
}

/** Custom message headers an app puts on a message (copied by `createMessage`). */
function plantedHeaders(idempotencyKey: string): MessageHeadersInit {
  return {
    idempotencyKey,
    authorization: `Bearer ${JWT}`,
    'x-api-key': AWS_KEY_ID,
    'x-partner-callback': callbackUrl('partner.example'),
    'x-customer-contact': `${EMAIL} ${PHONE}`,
  };
}

/** A partner failure: canaries in the message, the cause, own properties and nested arrays. */
class PartnerRejectedError extends Error {
  readonly status = 502;
  readonly request: BillingRequest;
  readonly attempts: unknown[][];
  readonly upstream: string;

  constructor() {
    super(
      `partner rejected Authorization: Bearer ${BEARER_TOKEN} for ${EMAIL} (${PHONE}), ` +
        `card ${CARD}, key ${AWS_KEY_ID}`,
      {
        cause: new Error(`upstream said token=${JWT} at ${callbackUrl('partner.example')}\n${PEM}`),
      },
    );
    this.name = 'PartnerRejectedError';
    this.request = billingRequest('INV-ERR-0001');
    this.attempts = [[{ session: JWT }, { signingKey: PEM }], [`retry for ${EMAIL}`]];
    this.upstream = callbackUrl('partner.example');
  }
}

/** A non-Error value thrown by app code (S4 `{ value }` envelopes, SD-04). */
function thrownObject(): Record<string, unknown> {
  return {
    code: 'E_PARTNER_SCHEMA',
    detail: `schema check failed for ${EMAIL}`,
    rows: [[{ cardNumber: CARD }, { contact: PHONE }], [{ auth: `Bearer ${BEARER_TOKEN}` }]],
  };
}

// ---------- Loopback upstream: payment provider and CRM ----------

interface SeenRequest {
  path: string;
  headers: IncomingHttpHeaders;
}

interface Upstream {
  base: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

/** `/v1/charges` declines with 402 and leaks canaries back; `/crm/*` is in maintenance (503). */
async function startUpstream(): Promise<Upstream> {
  const state: Upstream = { base: '', seen: [], close: () => Promise.resolve() };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      state.seen.push({ path, headers: req.headers });
      if (path.startsWith('/crm/')) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'maintenance', escalate: EMAIL }));
        return;
      }
      res.writeHead(402, {
        'content-type': 'application/json',
        'set-cookie': `psp_session=${JWT}; HttpOnly; Secure`,
        'x-debug-echo': `Bearer ${BEARER_TOKEN}`,
      });
      res.end(
        JSON.stringify({
          error: 'card_declined',
          card: CARD,
          customer: { email: EMAIL, phone: PHONE },
          debug: [
            [{ awsAccessKeyId: AWS_KEY_ID }, { privateKey: PEM }],
            [callbackUrl('psp.example')],
          ],
        }),
      );
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

// ---------- Leak assertions ----------

const sha = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);

/** Fails when a canary, in any `LeakForm`, is in `text`; never prints the canary. */
function expectClean(label: string, text: string, canaries: readonly string[] = CANARIES): void {
  for (const canary of canaries) {
    for (const [form, needle] of leakForms(canary)) {
      if (needle.length >= 4 && text.includes(needle)) {
        throw new Error(`canary sha256:${sha(canary)} leaked to ${label} in form ${form}`);
      }
    }
  }
}

/** The writes recorded after `mark`, as a capture `expectNoLeak` accepts. */
function since(capture: TrailCapture, mark: number): TrailCapture {
  return {
    writes: capture.writes.slice(mark),
    logger: capture.logger,
    keepOriginals: capture.keepOriginals,
    store: (inner) => capture.store(inner),
    ledger: (inner) => capture.ledger(inner),
    channel: (registry, name) => capture.channel(registry, name),
  };
}

const outputsOf = (writes: readonly TrailWrite[]): string[] =>
  [...new Set(writes.map((write) => write.output))].sort();

/** Bounded poll for socket round trips and fire-and-forget sinks. */
async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the capture stops growing (no write for 30 ms), bounded like `until`. */
async function settle(
  trail: { readonly writes: readonly unknown[] },
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = -1;
  let quietTicks = 0;
  while (quietTicks < 6) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the trail to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
    quietTicks = trail.writes.length === seen ? quietTicks + 1 : 0;
    seen = trail.writes.length;
  }
}

// ---------- Providers: fingerprint secret and seal keys (test material, not real secrets) ----------

const FINGERPRINT: FingerprintSecret = { id: 'leak1', secret: new Uint8Array(32).fill(42) };
const SEAL_KEY: SealKey = { id: 'seal1', key: new Uint8Array(32).fill(7) };
const sealKeys = {
  current: (): Promise<SealKey> => Promise.resolve(SEAL_KEY),
  byId: (id: string): Promise<SealKey | undefined> =>
    Promise.resolve(id === SEAL_KEY.id ? SEAL_KEY : undefined),
};

// ---------- App: controllers, activators, flows ----------

@Controller('billing')
class BillingController {
  @Post('charge')
  @InboundRest({
    channel: 'billing.in',
    requestReply: true,
    timeoutMs: 3_000,
    idempotency: { onDuplicate: 'replay', remember: Remember.Sealed },
  })
  charge(@Body() body: BillingRequest): BillingRequest {
    return body;
  }

  @Post('refund')
  @InboundRest({
    channel: 'refund.in',
    requestReply: true,
    timeoutMs: 3_000,
    idempotency: { onFailure: 'store', remember: Remember.AsShown },
  })
  refund(@Body() body: BillingRequest): BillingRequest {
    return body;
  }
}

/** gRPC inbound: driven through the module interceptor (no `@grpc/grpc-js` dependency). */
class BillingGrpcController {
  @InboundGrpc({
    channel: 'billing.grpc',
    requestReply: true,
    idempotency: { onFailure: 'store', remember: Remember.AsShown },
  })
  charge(data: BillingRequest): BillingRequest {
    return data;
  }
}

@Injectable()
class HubActivators {
  @ServiceActivator('vault.lookup')
  vault(): unknown {
    return { token: JWT, cardOnFile: { pan: CARD }, signingKey: PEM };
  }

  @ServiceActivator('partner.sink')
  partner(): never {
    throw new PartnerRejectedError();
  }

  @ServiceActivator('partner.sink.awaited')
  partnerAwaited(): never {
    throw new PartnerRejectedError();
  }

  @ServiceActivator('billing.grpc')
  grpcCharge(payload: BillingRequest): unknown {
    if (payload.fail === true) throw new PartnerRejectedError();
    return { approved: true, receipt: { token: JWT, cardNumber: CARD, contact: EMAIL } };
  }
}

/** README guidance (spec 1.3): an app filter logs `errorForTrail(error)`, never the raw error. */
@Catch()
class TrailExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('TrailExceptionFilter');

  constructor(private readonly privacy: PrivacyEngine) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    if (status >= 500) {
      this.logger.error(this.privacy.errorForTrail(error, { output: TrailOutput.Log }));
    }
    host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(status)
      .json({ statusCode: status });
  }
}

const BillingFlow: FlowDefinition = {
  name: 'billing',
  build: () =>
    IntegrationFlow.from('billing.in')
      .filter((payload) => typeof (payload as BillingRequest).invoiceId === 'string', {
        id: 'valid',
      })
      .transform((payload) => ({ ...(payload as object), receivedAt: '2026-11-11T10:00:00Z' }), {
        id: 'stamp',
      })
      .handle((payload) => payload, { id: 'price' })
      .jump('vault.lookup', { id: 'vault' })
      .wireTap('audit', { id: 'audit' })
      .reply({ payload: 'jumpMerge' }),
};

const RefundFlow: FlowDefinition = {
  name: 'refund',
  build: () =>
    IntegrationFlow.from('refund.in').handle(
      () => {
        throw new PartnerRejectedError();
      },
      { id: 'refund' },
    ),
};

/** One flow per DSL method, each failing (or forgetting) at that method. */
const DSL_FLOWS: Record<string, (flow: IntegrationFlow) => IntegrationFlow> = {
  'dsl.filter': (flow) =>
    flow.filter(
      () => {
        throw new PartnerRejectedError();
      },
      { id: 'screen' },
    ),
  'dsl.transform': (flow) =>
    flow.transform(
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- app code may throw a plain object
        throw thrownObject();
      },
      { id: 'shape' },
    ),
  'dsl.handle': (flow) =>
    flow.handle(
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- app code may throw a string
        throw `partner said token=${JWT} for ${EMAIL} via ${callbackUrl('partner.example')}`;
      },
      { id: 'enrich' },
    ),
  'dsl.to': (flow) => flow.to('partner.sink', { id: 'send' }),
  'dsl.publish': (flow) => flow.publish('partner.sink', { id: 'publish' }),
  'dsl.route': (flow) => flow.route(() => 'partner.sink', { id: 'route' }),
  'dsl.fanout': (flow) =>
    flow.fanoutTo([{ channel: 'partner.sink', wait: false }, { channel: 'partner.sink.awaited' }], {
      id: 'spread',
    }),
  'dsl.jumpTo': (flow) => flow.jumpTo([{ channel: 'partner.sink' }], { id: 'lookup' }),
  'dsl.jump-forget': (flow) => flow.jump('partner.sink', { wait: false, id: 'forget' }),
};

/** Work a test plugs into an edge flow; the flow carries its result or its error to the trail. */
const hooks = {
  run: (): unknown => Promise.reject(new Error('no edge work plugged in')),
};

/** Edge flows: the outbound REST binding channel, the legacy `restOut` and work the test plugs in. */
const EDGE_FLOWS: Record<string, (flow: IntegrationFlow) => IntegrationFlow> = {
  'edge.psp': (flow) => flow.to('psp.out', { id: 'charge' }),
  'edge.legacy': (flow) => flow.to('legacy.out', { id: 'legacy' }),
  'edge.hook': (flow) =>
    flow.wireTap('audit', { id: 'audit' }).handle(() => hooks.run(), { id: 'work' }),
};

const flowsOf = (table: Record<string, (flow: IntegrationFlow) => IntegrationFlow>) =>
  Object.entries(table).map(([name, build]): FlowDefinition => ({
    name,
    build: () => build(IntegrationFlow.from(`${name}.in`)),
  }));

const FLOW_CHANNELS = [...Object.keys(DSL_FLOWS), ...Object.keys(EDGE_FLOWS)].map((name) => ({
  name: `${name}.in`,
  type: 'direct' as const,
}));

const CRM_PLAN_B = { queued: true, escalateTo: EMAIL, cardOnFile: CARD };
const LEDGER_USERINFO_WITH_AT = 'Lg@Pw-Canary-At-6630';
const LEDGER_USERINFO_TAIL = 'Pw-Canary-At-6630';

function hubOptions(upstream: Upstream, capture: TrailCapture, store: MemoryIdempotencyStore) {
  const options: IntegrationModuleOptions = {
    channels: [
      { name: 'billing.in', type: 'direct' },
      { name: 'refund.in', type: 'direct' },
      { name: 'billing.grpc', type: 'direct' },
      { name: 'vault.lookup', type: 'direct' },
      { name: 'partner.sink', type: 'direct' },
      { name: 'partner.sink.awaited', type: 'direct' },
      { name: 'psp.out', type: 'direct' },
      { name: 'legacy.out', type: 'direct' },
      { name: 'ledger.out', type: 'direct' },
      { name: 'audit', type: 'pubsub' },
      ...FLOW_CHANNELS,
    ],
    idempotency: { store: capture.store(store) },
    logging: { hops: true, level: 'debug', banner: false },
    care: {
      clock: manualCareClock(),
      // An app that labels the valve key with an account credential: still trail text (SD-62).
      keyLabel: (key) => key,
    },
    outbound: {
      rest: {
        bindings: [
          {
            name: 'psp',
            channel: 'psp.out',
            url: `${upstream.base}/v1/charges?api_key=${QUERY_API_KEY}`,
            headers: { authorization: `Bearer ${BEARER_TOKEN}` },
            response: 'body',
          },
          {
            name: 'crm',
            url: `${upstream.base}/crm/contacts?api_key=${QUERY_API_KEY}`,
            response: 'body',
            care: {
              tries: false,
              valve: {
                minCalls: 2,
                failPercent: 50,
                shutMs: 60_000,
                key: () => `acct:${AWS_KEY_ID}`,
              },
              planB: { value: () => CRM_PLAN_B, on: ['transient', 'valve-shut'] },
            },
          },
          {
            // Never reachable: a password holding a raw '@' (WHATWG URL accepts it).
            name: 'ledger',
            channel: 'ledger.out',
            url: `https://ledger-svc:${LEDGER_USERINFO_WITH_AT}@ledger.clinica-example.com/v2/entries?api_key=${QUERY_API_KEY}`,
          },
        ],
      },
    },
    privacy: {
      packs: [Pack.SecretsV1, Pack.PersonalV1],
      fingerprintSecret: { current: () => FINGERPRINT },
      sealKeys,
    },
  };
  return options;
}

/** A grpc-js-shaped `Metadata`: Nest hands it to the interceptor as the RPC context. */
function grpcMetadata(entries: Record<string, string>): { toJSON(): Record<string, string[]> } {
  return {
    toJSON: () => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])),
  };
}

async function grpcCall(
  interceptor: InboundInterceptor,
  data: BillingRequest,
  metadata: Record<string, string>,
): Promise<{ ok: true; reply: unknown } | { ok: false; error: unknown }> {
  const controller = new BillingGrpcController();
  const handler = BillingGrpcController.prototype.charge;
  const context = new ExecutionContextHost(
    [data, grpcMetadata(metadata), {}],
    BillingGrpcController,
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

// ---------- Scenario ----------

describe('scenario canary-leak-hunt (SPI-433)', () => {
  let upstream: Upstream;
  let app: INestApplication;
  let url: string;
  let registry: ChannelRegistry;
  let engine: PrivacyEngine;
  const capture = captureTrail();
  const store = new MemoryIdempotencyStore();
  const auditCopies: IntegrationMessage[] = [];

  const send = async (channel: string, payload: unknown, key: string): Promise<unknown> => {
    try {
      await registry.sendMessage(channel, createMessage(payload, plantedHeaders(key)));
      return undefined;
    } catch (error) {
      return error;
    }
  };

  beforeAll(async () => {
    upstream = await startUpstream();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(hubOptions(upstream, capture, store), [
          BillingFlow,
          RefundFlow,
          ...flowsOf(DSL_FLOWS),
          ...flowsOf(EDGE_FLOWS),
        ]),
      ],
      controllers: [BillingController],
      providers: [HubActivators],
    }).compile();
    app = moduleRef.createNestApplication({ logger: capture.logger });
    Logger.overrideLogger(capture.logger);
    app.useGlobalFilters(new TrailExceptionFilter(app.get(PrivacyEngine)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    registry = app.get(ChannelRegistry);
    engine = app.get(PrivacyEngine);
    capture.channel(registry, 'error.channel');
    capture.channel(registry, 'audit');
    capture.channel(registry, 'estela.care.events');
    registry.get('audit').subscribe((msg) => {
      auditCopies.push(msg);
    });
    bindRestOut(registry, 'legacy.out', {
      url: `http://legacy-svc:${USERINFO_SECRET}@127.0.0.1:9/hooks/paid?token=${QUERY_API_KEY}`,
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      fetchFn: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') }),
    });
  });

  afterAll(async () => {
    await app?.close();
    await upstream?.close();
  });

  const post = async (path: string, body: unknown, key: string) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${JWT}`,
        'x-api-key': AWS_KEY_ID,
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it('SD-27 SD-02 SD-09 SD-28 SD-53: REST checkout with canaries in body and headers: replies are intact, records, hop lines and tap copies hold none', async () => {
    const mark = capture.writes.length;
    const first = await post('/billing/charge', billingRequest(), IDEM_KEY);
    expect(first.status).toBe(201);
    // SD-02: the caller receives the real data, the jump reply included.
    const reply = JSON.stringify(first.body);
    for (const value of [EMAIL, CARD, JWT, PEM_BODY.slice(0, 20)]) expect(reply).toContain(value);

    const replay = await post('/billing/charge', billingRequest(), IDEM_KEY);
    expect((replay.body as { result: unknown }).result).toEqual(
      (first.body as { result: unknown }).result,
    );
    await until('the audit tap copy', () => auditCopies.length >= 1);
    await settle(capture);

    // SD-28 (amended by SD-52): under explicit privacy the tap gets a hidden copy, not the live one.
    const tap = auditCopies[0]!;
    const tapText = JSON.stringify(tap);
    expect(tapText).toContain('[HIDDEN:');
    expect(tapText).toContain('fp:leak1:');
    expect(tapText).toContain('***1486');
    expect(tap.headers.jumpReplies).toBeDefined();
    // SD-10: trace fields stay intact in the copy.
    expect(tap.headers.traceId).toEqual(expect.any(String));

    const writes = since(capture, mark);
    expect(outputsOf(writes.writes)).toEqual(expect.arrayContaining(['log', 'store', 'wiretap']));
    expect(writes.writes.some((w) => w.where.startsWith('store.complete'))).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-45 SD-11 SD-04 SD-02: a failure at every flow DSL method reaches error.channel, its log line and the flow failure record with no canary, while the caller gets the original error', async () => {
    const mark = capture.writes.length;
    const outcomes: Record<string, unknown> = {};
    for (const name of Object.keys(DSL_FLOWS)) {
      outcomes[name] = await send(`${name}.in`, billingRequest(), `${IDEM_KEY}-${name}`);
    }
    await settle(capture);

    // SD-02: the caller catches the very value that was thrown, canaries included.
    expect(outcomes['dsl.filter']).toBeInstanceOf(PartnerRejectedError);
    expect((outcomes['dsl.filter'] as Error).message).toContain(CARD);
    expect(outcomes['dsl.transform']).toEqual(thrownObject());
    expect(outcomes['dsl.handle']).toEqual(expect.stringContaining(JWT));
    for (const name of ['dsl.to', 'dsl.publish', 'dsl.route', 'dsl.fanout', 'dsl.jumpTo']) {
      expect(outcomes[name]).toBeInstanceOf(PartnerRejectedError);
    }
    // A forgotten jump never fails the flow (invariant 3); its envelope still goes to the trail.
    expect(outcomes['dsl.jump-forget']).toBeUndefined();

    const writes = since(capture, mark);
    const envelopes = writes.writes.filter((w) => w.output === TrailOutput.ErrorEnvelope);
    const flowEnvelopes = envelopes.filter((w) => w.text.includes('"flow":"dsl.'));
    expect(flowEnvelopes.length).toBeGreaterThanOrEqual(8);
    expect(envelopes.some((w) => w.text.includes('fireAndForget'))).toBe(true);
    const errorLines = writes.writes.filter((w) => w.text.startsWith('error.channel:'));
    expect(errorLines.length).toBeGreaterThanOrEqual(envelopes.length);
    expect(writes.writes.some((w) => w.where === 'store.fail flow:dsl.filter')).toBe(true);
    // The protection did run: hidden tokens are in the lines, not empty envelopes.
    expect(errorLines.some((w) => w.text.includes('[HIDDEN:secrets.'))).toBe(true);
    expect(errorLines.some((w) => w.text.includes('fp:leak1:'))).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-04 SD-05: outbound REST and restOut failures: url query, userinfo, response headers and body reach no sink, and the message the caller reads names no canary', async () => {
    const mark = capture.writes.length;
    const psp = await send('edge.psp.in', billingRequest(), `${IDEM_KEY}-psp`);
    const legacy = await send('edge.legacy.in', billingRequest(), `${IDEM_KEY}-legacy`);
    await settle(capture);

    expect(psp).toBeInstanceOf(OutboundHttpError);
    const pspError = psp as OutboundHttpError;
    expect(pspError.status).toBe(402);
    // Spec 1.3: the thrown error keeps url, headers and body for app code ...
    expect(pspError.url).toContain(QUERY_API_KEY);
    expect(JSON.stringify(pspError.body)).toContain(CARD);
    // ... but its message never carries the url query (outbound.errors.ts contract).
    expectClean('OutboundHttpError.message', pspError.message);
    // SD-05: the restOut message names scheme, host and path only.
    expect(legacy).toBeInstanceOf(Error);
    expect((legacy as Error).message).toContain('http://127.0.0.1:9/hooks/paid');
    expectClean('restOut error message', (legacy as Error).message);

    const writes = since(capture, mark);
    const pspLine = writes.writes.find(
      (w) => w.text.startsWith('error.channel:') && w.text.includes('OutboundHttpError'),
    );
    expect(pspLine?.text).toContain('402');
    expect(pspLine?.text).toContain(`${upstream.base}/v1/charges`);
    expect(writes.writes.some((w) => w.text.includes('outbound:rest POST'))).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-05 SD-04: a userinfo password holding a raw "@" is dropped whole from outbound messages, hop lines and the error line', async () => {
    const mark = capture.writes.length;
    const gateway = app.get(OutboundRestGateway);
    hooks.run = () => gateway.request('ledger', { payload: { entry: 'INV-2026-004417' } });
    const caught = await send('edge.hook.in', { entry: 'INV-2026-004417' }, `${IDEM_KEY}-ledger`);
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('ledger.clinica-example.com/v2/entries');
    expectClean('outbound error message', message, [...CANARIES, LEDGER_USERINFO_TAIL]);
    await settle(capture);
    const lines = since(capture, mark).writes.filter((w) => w.text.startsWith('error.channel:'));
    expect(lines.some((w) => w.text.includes('ledger.clinica-example.com/v2/entries'))).toBe(true);
    expectNoLeak(since(capture, mark), [...CANARIES, LEDGER_USERINFO_TAIL]);
  });

  it('SD-27 SD-02: inbound gRPC with canaries in data and metadata: the reply is intact, records and failure envelopes hold none', async () => {
    const interceptor = new InboundInterceptor(app.get<InboundInterceptorDeps>(INBOUND_DEPS));
    const mark = capture.writes.length;
    const metadata = (key: string) => ({
      authorization: `Bearer ${JWT}`,
      'x-api-key': AWS_KEY_ID,
      'idempotency-key': key,
    });
    const ok = await grpcCall(interceptor, billingRequest(), metadata(`${IDEM_KEY}-grpc`));
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok.ok ? ok.reply : undefined)).toContain(JWT);
    const failed = await grpcCall(
      interceptor,
      { ...billingRequest(), fail: true },
      metadata(`${IDEM_KEY}-grpc-fail`),
    );
    expect(failed.ok).toBe(false);
    await settle(capture);

    const writes = since(capture, mark);
    expect(writes.writes.some((w) => w.where.startsWith('store.complete'))).toBe(true);
    expect(writes.writes.some((w) => w.output === TrailOutput.ErrorEnvelope)).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-27 SD-11 SD-43 SD-33: saga steps: afterCommit, hook, compensation and fallback error lines, ledger rows and the in-progress duplicate hold no canary', async () => {
    const mark = capture.writes.length;
    const ledger = capture.ledger(new MemoryIdempotencyLedger<null>());
    const transactions: TransactionPort<null> = { run: (work) => work(null) };
    const traced = new SagaRunner<null>({
      transactions,
      ledger,
      logger: new HopLogger('debug', engine),
      privacy: { engine, remember: Remember.AsShown },
      onAfterCommitError: () => {
        throw new Error(`hook could not notify ${EMAIL} with token=${JWT}`);
      },
    });
    // No hop logger: the fallback line (S2) of the runner applies the same engine.
    const quiet = new SagaRunner<null>({
      transactions,
      ledger,
      privacy: { engine, remember: Remember.AsShown },
    });

    interface RefundCtx {
      key: string;
      failPartner?: boolean;
      gate?: Promise<void>;
      atGate?: () => void;
    }
    const refund = saga<RefundCtx, null, unknown>('refund')
      .idempotent((ctx) => ctx.key)
      .transaction('book', (_ctx, _tx, unit) => {
        unit.afterCommit(() => {
          throw new PartnerRejectedError();
        });
      })
      .outbound(
        'notify-partner',
        async (ctx) => {
          ctx.atGate?.();
          await ctx.gate;
          if (ctx.failPartner === true) throw new PartnerRejectedError();
        },
        {
          compensate: () => {
            throw new Error(`compensation failed for card ${CARD}, key ${AWS_KEY_ID}`);
          },
        },
      )
      .reply(() => ({
        refundId: 'RF-2026-0091',
        patient: { email: EMAIL, phone: PHONE },
        cardNumber: CARD,
        receipt: { token: JWT },
      }));

    const first = await traced.run(refund, { key: `${IDEM_KEY}-saga` });
    // SD-02: the first caller gets the real reply.
    expect(JSON.stringify(first)).toContain(CARD);
    await traced.run(refund, { key: `${IDEM_KEY}-saga` });
    // The partner fails, then its compensation fails too: the caller gets the compensation error.
    await expect(
      quiet.run(refund, { key: `${IDEM_KEY}-saga-fail`, failPartner: true }),
    ).rejects.toThrow(CARD);

    // SD-43: an in-progress duplicate keeps the key out of `message`, and a flow that carries it
    // to error.channel fingerprints the `key` property.
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let holding = false;
    const firstRun = traced.run(refund, {
      key: `${IDEM_KEY}-busy`,
      gate,
      atGate: () => {
        holding = true;
      },
    });
    await until('the first run to hold the claim', () => holding);
    hooks.run = () => traced.run(refund, { key: `${IDEM_KEY}-busy` });
    const duplicate = await send('edge.hook.in', { refundId: 'RF-2026-0092' }, 'saga-flow-0001');
    open();
    await firstRun;
    await settle(capture);
    expect(duplicate).toBeInstanceOf(IdempotencyInProgressError);
    expect((duplicate as IdempotencyInProgressError).key).toBe(`${IDEM_KEY}-busy`);
    expectClean('IdempotencyInProgressError.message', (duplicate as Error).message);

    const writes = since(capture, mark);
    expect(writes.writes.filter((w) => w.output === TrailOutput.Ledger).length).toBeGreaterThan(0);
    const sagaLines = writes.writes.filter((w) => w.text.includes('saga:refund'));
    // S1: the afterCommit and hook error lines fired, with hidden values in them.
    const errorLines = sagaLines.filter((w) => w.text.includes(' ERROR '));
    expect(errorLines.some((w) => w.text.includes('after-commit:'))).toBe(true);
    expect(errorLines.some((w) => w.text.includes(':hook'))).toBe(true);
    expect(errorLines.some((w) => w.text.includes('[HIDDEN:'))).toBe(true);
    expect(writes.writes.some((w) => w.text.includes('IdempotencyInProgressError'))).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-62 SD-02: care valve and plan B on the CRM: events, logs and stores hold no canary; the plan B value reaches only the caller', async () => {
    const gateway = app.get(OutboundRestGateway);
    const mark = capture.writes.length;
    const answers: unknown[] = [];
    for (let call = 0; call < 3; call++) {
      answers.push(await gateway.request('crm', { payload: billingRequest(`INV-CRM-${call}`) }));
    }
    await settle(capture);
    // Plan B answers the caller with its real value every time (busy upstream, then shut valve).
    expect(answers).toEqual([CRM_PLAN_B, CRM_PLAN_B, CRM_PLAN_B]);

    const writes = since(capture, mark);
    const events = writes.writes.filter((w) => w.where === 'channel estela.care.events');
    const types = events.map(
      (w) => (JSON.parse(w.text) as { payload: { type: string } }).payload.type,
    );
    expect(types).toEqual(expect.arrayContaining(['valve.shut', 'plan-b.used']));
    // The app's key label is trail text: it is in the events, hidden.
    expect(events.some((w) => w.text.includes('acct:[HIDDEN:secrets.aws-key-id]'))).toBe(true);
    expectNoLeak(writes, CANARIES);
  });

  it('SD-59: GET /integration/graph and its mermaid view, after all the traffic, hold no canary', async () => {
    const graph = await fetch(`${url}/integration/graph`);
    expect(graph.status).toBe(200);
    const json = await graph.text();
    expect(json).toContain('ledger.clinica-example.com/v2/entries');
    expectClean('graph JSON', json, [...CANARIES, LEDGER_USERINFO_TAIL]);
    const mermaid = await (await fetch(`${url}/integration/graph/mermaid`)).text();
    expect(mermaid).toContain('outbound');
    expectClean('graph mermaid', mermaid, [...CANARIES, LEDGER_USERINFO_TAIL]);
  });

  it('SD-21 SD-22 SD-02: walk limits: deep nesting, a huge string with a JWT across the cut, cycles, getters, toJSON, binary and the node limit never crash a sink and never leak', async () => {
    const mark = capture.writes.length;
    // A 2 KiB JWT that starts 1 KiB before the 64 KiB scan window ends (SD-21 acceptance).
    const longJwt = `eyJhbGciOiJIUzI1NiJ9.eyJ${'Q2FuYXJ5TG9uZ0pXVA'.repeat(110)}.c2lnLWNhbmFyeS1sb25n`;
    const filler = 'lorem ipsum '
      .repeat(Math.ceil((64 * 1024 - 1024) / 12))
      .slice(0, 64 * 1024 - 1024);
    const huge = `${filler}${longJwt} trailing text ${'z'.repeat(4 * 1024)}`;
    let deep: Record<string, unknown> = { signingKey: PEM, note: `call ${PHONE}` };
    for (let level = 0; level < 40; level++) deep = { level: deep };
    const cyclic: Record<string, unknown> = { contact: EMAIL };
    cyclic.self = cyclic;
    const hostile: Record<string, unknown> = {
      invoiceId: 'INV-WALK-0001',
      huge,
      deep,
      cyclic,
      blob: Buffer.from(`session=${JWT}`),
      when: new Date('2026-11-11T10:00:00Z'),
      many: Array.from({ length: 12_000 }, (_, i) => (i === 11_500 ? `card ${CARD}` : `row-${i}`)),
      lookup: new Map([['primary', { token: JWT }]]),
      tags: new Set([`owner ${EMAIL}`]),
      toJSON: () => {
        throw new Error(`toJSON exploded with ${AWS_KEY_ID}`);
      },
    };
    Object.defineProperty(hostile, 'secretGetter', {
      enumerable: true,
      get: () => {
        throw new Error(`getter exploded with ${JWT}`);
      },
    });
    const error = new PartnerRejectedError();
    Object.assign(error, { huge, deep, cyclic, blob: Buffer.from(PEM) });
    Object.defineProperty(error, 'lazy', {
      enumerable: true,
      get: () => {
        throw new Error(`lazy getter with ${CARD}`);
      },
    });

    const tapsBefore = auditCopies.length;
    // The walker is the same for every sink: drive it through the injectable engine (SD-39), then
    // through the tap, envelope, log and record writers of the running module.
    const forLog = engine.forLog(hostile);
    const forError = engine.errorForTrail(error, { output: TrailOutput.Log });
    expectClean('PrivacyEngine.forLog', JSON.stringify(forLog), CANARIES);
    expectClean('PrivacyEngine.errorForTrail', JSON.stringify(forError), CANARIES);
    const logText = JSON.stringify(forLog);
    for (const placeholder of [
      '[Circular]',
      '[TRUNCATED]',
      '[Getter]',
      '[Binary len=',
      '[truncated ',
    ]) {
      expect(logText).toContain(placeholder);
    }
    expect(logText).toContain('2026-11-11T10:00:00.000Z');
    // SD-21: no 9-char slice of the JWT that straddled the cut survives.
    for (let at = 0; at + 9 <= longJwt.length; at += 37) {
      expect(logText).not.toContain(longJwt.slice(at, at + 9));
    }

    hooks.run = () => {
      throw error;
    };
    const result = await send('edge.hook.in', hostile, `${IDEM_KEY}-walk`);
    expect(result).toBe(error);
    await until('the hostile tap copy', () => auditCopies.length > tapsBefore);
    await settle(capture);
    // SD-02: the live error and payload are untouched.
    expect(error.message).toContain(CARD);
    expect(hostile.huge).toBe(huge);

    const writes = since(capture, mark);
    expect(writes.writes.some((w) => w.text.startsWith('error.channel:'))).toBe(true);
    expectNoLeak(writes, [...CANARIES, longJwt]);
  });

  it('SD-27 SD-38: the whole run: every captured trail write, in every encoded form, holds no canary', () => {
    expect(outputsOf(capture.writes)).toEqual([
      'error-envelope',
      'ledger',
      'log',
      'store',
      'wiretap',
    ]);
    expectNoLeak(capture, CANARIES);
    expect(engine.stats().hideFailed).toBe(0);
  });
});

describe('scenario canary-leak-hunt: no privacy option (SPI-433 section 2)', () => {
  let upstream: Upstream;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    upstream = await startUpstream();
  });

  afterAll(async () => {
    await app?.close();
    await upstream.close();
  });

  it('SD-01 SD-04 SD-05: the baseline keeps every secrets@1 canary out of log lines, while records and tap copies stay as in 0.9.0', async () => {
    const capture = captureTrail();
    const store = new MemoryIdempotencyStore();
    const options = hubOptions(upstream, capture, store);
    delete options.privacy;
    delete options.care;
    options.outbound = {
      rest: { bindings: options.outbound!.rest!.bindings!.filter((b) => b.name === 'psp') },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(options, [
          BillingFlow,
          ...flowsOf(DSL_FLOWS),
          ...flowsOf(EDGE_FLOWS),
        ]),
      ],
      providers: [HubActivators],
    }).compile();
    app = moduleRef.createNestApplication({ logger: capture.logger });
    Logger.overrideLogger(capture.logger);
    await app.init();
    const registry = app.get(ChannelRegistry);
    capture.channel(registry, 'error.channel');
    const taps: IntegrationMessage[] = [];
    registry.get('audit').subscribe((msg) => {
      taps.push(msg);
    });
    bindRestOut(registry, 'legacy.out', {
      url: `http://legacy-svc:${USERINFO_SECRET}@127.0.0.1:9/hooks/paid?token=${QUERY_API_KEY}`,
      fetchFn: () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') }),
    });

    const failures = [...Object.keys(DSL_FLOWS), 'edge.psp', 'edge.legacy'];
    for (const name of failures) {
      await registry
        .sendMessage(
          `${name}.in`,
          createMessage(billingRequest(), plantedHeaders(`${IDEM_KEY}-${name}`)),
        )
        .catch(() => undefined);
    }
    const payload = billingRequest();
    await registry.sendMessage('billing.in', createMessage(payload, plantedHeaders(IDEM_KEY)));
    await settle(capture);

    // 0.9.0: no explicit privacy reaches the tap, so it gets the live payload, not a hidden copy.
    expect((taps[0]?.payload as BillingRequest).payment.cardNumber).toBe(
      payload.payment.cardNumber,
    );
    expect((taps[0]?.payload as BillingRequest).integration).toBe(payload.integration);
    const logs = capture.writes.filter((w) => w.output === TrailOutput.Log);
    expect(logs.filter((w) => w.text.startsWith('error.channel:')).length).toBeGreaterThanOrEqual(
      10,
    );
    // The baseline hides secrets in log lines; personal data is not in the baseline (D3).
    const logsOnly: TrailCapture = { ...since(capture, 0), writes: logs };
    expectNoLeak(logsOnly, SECRET_CANARIES);
    expect(logs.some((w) => w.text.includes('[HIDDEN:secrets.'))).toBe(true);
  });
});
