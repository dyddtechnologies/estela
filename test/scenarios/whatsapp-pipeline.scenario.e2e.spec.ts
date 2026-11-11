import 'reflect-metadata';

import { Inject, Injectable, Logger, type INestApplication } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lastValueFrom, of } from 'rxjs';
import {
  CareControl,
  ChannelRegistry,
  INBOUND_DEPS,
  InboundBusyError,
  InboundGrpc,
  InboundInterceptor,
  IntegrationFlow,
  IntegrationModule,
  MemoryIdempotencyStore,
  OnQuota,
  OutboundHttpError,
  Pack,
  PlanBMode,
  Remember,
  ServiceActivator,
  Show,
  TrailOutput,
  type CareClassifierFn,
  type CareContext,
  type CareEvent,
  type CareProfile,
  type CareStatePort,
  type FingerprintSecretProvider,
  type FlowDefinition,
  type InboundInterceptorDeps,
  type IntegrationMessage,
  type PrivacyModuleOptions,
  type SealKey,
  type SealKeyProvider,
} from '../../src/index';
import {
  MemoryCareState,
  captureTrail,
  expectNoLeak,
  manualCareClock,
  type ManualCareClock,
  type TrailCapture,
} from '../../src/testing';

/**
 * Scenario "whatsapp-pipeline": a WhatsApp message that ms-whatsapp submits over gRPC is answered
 * by an AI agent and the reply goes back through ms-whatsapp.
 *
 *   wa.inbound (gRPC submit) -> flow wa-inbound: filter (an empty message is answered at once)
 *     -> headers businessNumber -> handle loadConversation
 *     -> jumpTo routing.resolve (ms-campaigns, care 'routing') -> route wa.turn | wa.handoff
 *   wa.turn -> flow wa-turn: jumpTo ai.turn (outbound REST binding to the LLM, care 'llm-turn')
 *     -> wireTap wa.audit -> transform toOutboundMessage -> to wa.send (activator, care 'wa-send',
 *     plan B leaves the reply on the wa.reply.parked queue and answers 'parked')
 *
 * Real Nest apps, a real loopback HTTP server playing the LLM provider, and every care timer on
 * `manualCareClock`; the only real waits are bounded polls while a loopback request runs.
 *
 * gRPC: `@grpc/grpc-js` is not a dependency (package.json stays unchanged), so a submit goes
 * through the module's own `InboundInterceptor` with an RPC execution context carrying a
 * grpc-js-shaped `Metadata`, which is what Nest hands the interceptor under the gRPC transport.
 *
 * Tenant and sender keys travel as message headers: `carryHeaders` copies the `x-organization-id`
 * metadata into `organizationId`, a `headers` step adds `businessNumber` from the submit, and the
 * `valve.key` / `pace.key` functions read both from the headers, never from the payload.
 *
 * Privacy (SPI-433): the trail shows the customer number as a keyed fingerprint, the business
 * number by its last 4 digits and the message text by its length, on every trail output. Inbound
 * shapes (`from` = customer) take the `wa-inbound` profile on the endpoint and both flows; the
 * outbound shape (`to` = customer) takes `wa-outbound` on the send step and its activator. Records
 * are sealed, so a duplicate submit still replays the real reply.
 */

jest.setTimeout(30_000);

// ---------- Realistic payloads ----------

const ORG_FARMACRO = 'org_7f3a9c21-farmacro-gt';
const ORG_CLINICA = 'org_b81e04d7-clinica-sur';
const BUSINESS_NUMBER = '+50224618427';
const CUSTOMER_NUMBER = '+50255501234';
const CUSTOMER_TEXT = 'Hola, ¿tienen disponible amoxicilina de 500 mg en la sucursal de zona 10?';
const LLM_TEXT =
  'Sí, en zona 10 tenemos amoxicilina de 500 mg. ¿Quiere que se la apartemos para hoy?';
const HOLDING_TEXT = 'Recibimos tu mensaje, te respondemos en un momento.';
const GEMINI_KEY = 'AIzaSyD-test-only-0000000000000000000';
const KEY_SECRET = 'whatsapp-pipeline-scenario-hmac-secret-32b+';

/** ms-whatsapp `SubmitInbound` request: a Twilio WhatsApp message, already tenant-resolved. */
interface SubmitInbound {
  messageSid: string;
  accountSid: string;
  organizationId: string;
  businessNumber: string;
  from: string;
  to: string;
  body: string;
  profileName: string;
  numMedia: number;
  receivedAt: string;
}

let sidSeq = 0;
/** A Twilio message SID: `SM` + 32 hex characters. */
function nextSid(): string {
  sidSeq += 1;
  return `SM${sidSeq.toString(16).padStart(8, '0')}c4f2a1e9b07d36f5a8e2c19d`;
}

function submit(overrides: Partial<SubmitInbound> = {}): SubmitInbound {
  return {
    messageSid: nextSid(),
    accountSid: 'AC_test_farmacro_account',
    organizationId: ORG_FARMACRO,
    businessNumber: BUSINESS_NUMBER,
    from: `whatsapp:${CUSTOMER_NUMBER}`,
    to: `whatsapp:${BUSINESS_NUMBER}`,
    body: CUSTOMER_TEXT,
    profileName: 'Ana López',
    numMedia: 0,
    receivedAt: '2026-11-10T15:04:05.000Z',
    ...overrides,
  };
}

interface Turn {
  role: 'user' | 'model';
  text: string;
}

/** What `loadConversation` adds to the submit. */
interface ConversationTurn extends SubmitInbound {
  conversation: { id: string; history: Turn[] };
}

/** ms-campaigns `ResolveAgent` answer, or the routing plan B. */
interface Routing {
  agentId: string | null;
  flowId?: string;
  reason?: string;
}

/** The LLM step's answer: the provider's text, or the plan B holding text. */
interface LlmReply {
  text: string;
}

/** ms-whatsapp `message.send` request. */
interface OutboundWhatsApp {
  organizationId: string;
  businessNumber: string;
  conversationId: string;
  inReplyTo: string;
  from: string;
  to: string;
  body: string;
}

// ---------- Test doubles of the other services (shared by every pod of a test) ----------

/** ms-campaigns: agent routing with a controllable failure mode. */
const campaigns = {
  mode: 'ok' as 'ok' | 'down' | 'hang',
  calls: 0,
  resolve(request: SubmitInbound): Promise<Routing> {
    campaigns.calls += 1;
    if (campaigns.mode === 'hang') return new Promise<Routing>(() => undefined);
    if (campaigns.mode === 'down') {
      return Promise.reject(grpcUnavailable('ms-campaigns'));
    }
    return Promise.resolve({
      agentId: request.organizationId === ORG_FARMACRO ? 'agt_sofia_farmacro' : 'agt_lucia_sur',
      flowId: 'flw_pharmacy_v3',
    });
  },
};

/**
 * What a grpc-js client raises for UNAVAILABLE (a `ServiceError`). The default in-process classifier
 * calls it transient; no custom `classify` and no `transient` flag are needed.
 */
function grpcUnavailable(service: string): Error {
  return Object.assign(new Error(`14 UNAVAILABLE: ${service}`), {
    code: 14,
    details: service,
    metadata: { get: () => [] },
  });
}

interface SendRecord {
  pod: string;
  at: number;
  request: OutboundWhatsApp;
  idempotencyKey: string | undefined;
}

/** ms-whatsapp `message.send`, with injectable gRPC UNAVAILABLE failures. */
const whatsapp = {
  failNext: 0,
  attempts: [] as SendRecord[],
  sent: [] as SendRecord[],
};

const parked: { pod: string; request: OutboundWhatsApp; headers: IntegrationMessage['headers'] }[] =
  [];
const handoffs: { pod: string; request: ConversationTurn; routing: Routing }[] = [];
const audited: IntegrationMessage[] = [];
const dropped: IntegrationMessage[] = [];

/** The conversation store `loadConversation` reads (Postgres in ms-ai-core). */
const conversations = new Map<string, Turn[]>([
  [
    `${ORG_FARMACRO}:${CUSTOMER_NUMBER}`,
    [
      { role: 'user', text: 'Buenas tardes' },
      { role: 'model', text: '¡Hola Ana! Soy Sofía de Farmacro. ¿En qué le ayudo?' },
    ],
  ],
]);

function resetDoubles(): void {
  campaigns.mode = 'ok';
  campaigns.calls = 0;
  whatsapp.failNext = 0;
  whatsapp.attempts.length = 0;
  whatsapp.sent.length = 0;
  parked.length = 0;
  handoffs.length = 0;
  audited.length = 0;
  dropped.length = 0;
}

// ---------- The LLM provider (loopback HTTP, Gemini-shaped) ----------

interface ScriptedAnswer {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const geminiOk = (text = LLM_TEXT): ScriptedAnswer => ({
  status: 200,
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    modelVersion: 'gemini-2.5-flash',
  },
});

const slowDown = (seconds: number): ScriptedAnswer => ({
  status: 429,
  headers: { 'retry-after': String(seconds) },
  body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', reason: 'rate' } },
});

const quotaUsedUp: ScriptedAnswer = {
  status: 429,
  body: {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      reason: 'quota',
      message: 'Quota exceeded for quota metric generate_content_requests_per_day.',
    },
  },
};

interface LlmRequest {
  headers: IncomingHttpHeaders;
  body: { contents: { role: string; parts: { text: string }[] }[] };
}

interface LlmProvider {
  url: string;
  seen: LlmRequest[];
  /** Answers served in order; once empty the provider answers 200 with LLM_TEXT. */
  script: ScriptedAnswer[];
  /** While true, requests are held unanswered until `release()`. */
  hold: boolean;
  held: (() => void)[];
  release(): void;
  close(): Promise<void>;
}

async function startLlmProvider(): Promise<LlmProvider> {
  const provider: LlmProvider = {
    url: '',
    seen: [],
    script: [],
    hold: false,
    held: [],
    release: () => {
      provider.hold = false;
      for (const answer of provider.held.splice(0)) answer();
    },
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      provider.seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as LlmRequest['body'],
      });
      const next = provider.script.shift() ?? geminiOk();
      const answer = (): void => {
        res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
        res.end(JSON.stringify(next.body));
      };
      if (provider.hold) provider.held.push(answer);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  provider.url = `http://127.0.0.1:${port}/v1beta/models/gemini-2.5-flash:generateContent`;
  provider.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return provider;
}

// ---------- Care: the module's profiles ----------

const LLM_BINDING = 'ai.turn';
const ROUTING_BINDING = 'flow:wa-inbound#routing:routing.resolve';
const SEND_BINDING = 'activator:WhatsAppSendActivator.send';

/** App rule (RS-16): only the app knows that this provider body means "credits used up". */
const providerQuota: CareClassifierFn = (error) => {
  if (!(error instanceof OutboundHttpError) || error.status !== 429) return undefined;
  const body = error.body as { error?: { status?: string; reason?: string } } | null;
  return body?.error?.status === 'RESOURCE_EXHAUSTED' && body.error.reason === 'quota'
    ? 'quota'
    : undefined;
};

/** Care keys read the headers the inbound endpoint and the flow set, never the payload. */
function headerOf(ctx: CareContext, name: string): string {
  const value = ctx.message?.headers[name];
  if (typeof value !== 'string') throw new Error(`care key header ${name} is missing`);
  return value;
}

const organizationOf = (ctx: CareContext): string => headerOf(ctx, 'organizationId');

const businessNumberOf = (ctx: CareContext): string => headerOf(ctx, 'businessNumber');

function profiles(state: CareStatePort): Record<string, CareProfile> {
  return {
    routing: {
      patience: { eachTryMs: 300, totalMs: 800 },
      tries: { max: 2, idempotent: true },
      planB: { value: (): Routing => ({ agentId: null, reason: 'routing-unavailable' }) },
    },
    'llm-turn': {
      classify: providerQuota,
      patience: { eachTryMs: 8_000, totalMs: 20_000 },
      tries: { max: 2, on: ['transient', 'busy'], heedServerWait: true },
      valve: {
        failPercent: 50,
        minCalls: 5,
        shutMs: 60_000,
        onQuota: OnQuota.ShutUntilResumed,
        state,
        key: organizationOf,
      },
      lanes: { count: 20, waitlist: 50, waitlistMs: 2_000 },
      planB: {
        value: (): LlmReply => ({ text: HOLDING_TEXT }),
        on: ['transient', 'busy', 'valve-shut', 'quota', 'out-of-time'],
      },
    },
    'wa-send': {
      patience: { eachTryMs: 3_000, totalMs: 10_000 },
      tries: { max: 3, requireIdempotencyKey: true, spacing: { firstMs: 300, growth: 2 } },
      pace: { perSecond: 20, burst: 40, state, replicas: 2, key: businessNumberOf },
      planB: {
        channel: 'wa.reply.parked',
        mode: PlanBMode.Leave,
        value: (_error, ctx) => ({
          status: 'parked',
          inReplyTo: (ctx.message?.payload as OutboundWhatsApp).inReplyTo,
        }),
      },
    },
  };
}

const hmac = (key: string): string => createHmac('sha256', KEY_SECRET).update(key).digest('hex');

// ---------- Privacy: what the trail shows of a WhatsApp message ----------

/** Fixture key material, derived from fixed labels: the run is deterministic. */
const derive = (label: string): Buffer =>
  createHash('sha256').update(`whatsapp-pipeline scenario ${label}`).digest();
const fingerprintSecret: FingerprintSecretProvider = {
  current: () => Promise.resolve({ id: 'wa-fp-1', secret: derive('fingerprint') }),
};
const sealKey: SealKey = { id: 'kms-wa-1', key: derive('seal') };
const sealKeys: SealKeyProvider = {
  current: () => Promise.resolve(sealKey),
  byId: (id) => Promise.resolve(id === sealKey.id ? sealKey : undefined),
};

const customer = (path: string) => ({ path, name: 'wa.customer', show: Show.Fingerprint }) as const;
const business = (path: string) => ({ path, name: 'wa.business', show: Show.Ends }) as const;
const textLength = (path: string) => ({ path, name: 'wa.body', show: Show.Length }) as const;

const privacy: PrivacyModuleOptions = {
  packs: [Pack.SecretsV1],
  fingerprintSecret,
  sealKeys,
  // Sealed records replay the real reply to a duplicate submit and re-send it on a duplicate send.
  remember: Remember.Sealed,
  profiles: {
    'wa-inbound': {
      fields: [
        customer('**.from'),
        business('**.to'),
        business('**.businessNumber'),
        textLength('**.body'),
        textLength('**.conversation.history[*].text'),
        { path: '**.profileName', name: 'wa.name' },
      ],
      // The sender header the `headers` step adds and the pace key reads.
      headers: ['businessNumber'],
    },
    'wa-outbound': {
      fields: [
        customer('**.to'),
        business('**.from'),
        business('**.businessNumber'),
        textLength('**.body'),
      ],
      headers: ['businessNumber'],
    },
  },
};

// ---------- Endpoint and activators ----------

const POD = 'WHATSAPP_PIPELINE_POD';

/** ms-whatsapp -> Estela: unary `SubmitInbound`, deduplicated on the Twilio message SID. */
@Injectable()
class WhatsAppInboundGrpc {
  @InboundGrpc({
    channel: 'wa.inbound',
    requestReply: true,
    reply: 'raw',
    carryHeaders: { 'x-organization-id': 'organizationId' },
    idempotency: {
      clientKey: (ctx) => (ctx.payload as SubmitInbound).messageSid,
      onDuplicate: 'replay',
    },
    care: { lanes: { count: 50 }, pace: { perSecond: 100, burst: 200 } },
    privacy: 'wa-inbound',
  })
  submit(request: SubmitInbound): SubmitInbound {
    return request;
  }
}

@Injectable()
class RoutingActivator {
  @ServiceActivator('routing.resolve')
  resolve(payload: ConversationTurn): Promise<Routing> {
    return campaigns.resolve(payload);
  }
}

@Injectable()
class WhatsAppSendActivator {
  constructor(
    @Inject(POD) private readonly pod: string,
    @Inject('CARE_CLOCK') private readonly clock: ManualCareClock,
  ) {}

  @ServiceActivator('wa.send', { care: 'wa-send', privacy: 'wa-outbound' })
  send(request: OutboundWhatsApp, msg: IntegrationMessage): Promise<unknown> {
    const record: SendRecord = {
      pod: this.pod,
      at: this.clock.monotonic(),
      request,
      idempotencyKey: msg.headers.idempotencyKey,
    };
    whatsapp.attempts.push(record);
    if (whatsapp.failNext > 0) {
      whatsapp.failNext -= 1;
      return Promise.reject(grpcUnavailable('ms-whatsapp'));
    }
    whatsapp.sent.push(record);
    return Promise.resolve({
      status: 'queued',
      providerMessageId: `SMout${String(whatsapp.sent.length).padStart(4, '0')}`,
      inReplyTo: request.inReplyTo,
    });
  }
}

@Injectable()
class HandoffActivator {
  constructor(@Inject(POD) private readonly pod: string) {}

  @ServiceActivator('wa.handoff')
  handOff(request: ConversationTurn, msg: IntegrationMessage): unknown {
    const routing = msg.headers.jumpReplies?.['routing.resolve'] as Routing;
    handoffs.push({ pod: this.pod, request, routing });
    return { status: 'handed-off', inReplyTo: request.messageSid, reason: routing.reason };
  }
}

/**
 * The parking lot: plan B leaves unsent replies on the wa.reply.parked queue and nobody waits on
 * them. Each leave has a key of its own (D42), so the same reply left again after a failed drain
 * reaches this activator too; `leftFromKey` is the key the drain sends it on with.
 */
@Injectable()
class ParkingActivator {
  constructor(@Inject(POD) private readonly pod: string) {}

  @ServiceActivator('wa.reply.parked', { privacy: 'wa-outbound' })
  park(request: OutboundWhatsApp, msg: IntegrationMessage): void {
    parked.push({ pod: this.pod, request, headers: msg.headers });
  }
}

/** Returns a value on purpose: a wireTap copy carries no reply routing, so it answers nobody. */
@Injectable()
class AuditActivator {
  @ServiceActivator('wa.audit')
  record(_payload: unknown, msg: IntegrationMessage): unknown {
    audited.push(msg);
    return { audited: true, auditId: `aud_${String(audited.length)}` };
  }
}

// ---------- Flows ----------

/** The answer ms-whatsapp gets at once for a message with no text (a sticker, a read receipt). */
function ignoredReply(payload: unknown, msg: IntegrationMessage): unknown {
  dropped.push(msg);
  return { status: 'ignored', inReplyTo: (payload as SubmitInbound).messageSid, reason: 'empty' };
}

/** The business number the `wa-send` pace key reads. */
function senderHeaders(payload: unknown): { businessNumber: string } {
  return { businessNumber: (payload as SubmitInbound).businessNumber };
}

function loadConversation(payload: unknown): ConversationTurn {
  const inbound = payload as SubmitInbound;
  const customer = inbound.from.replace(/^whatsapp:/, '');
  const key = `${inbound.organizationId}:${customer}`;
  return {
    ...inbound,
    conversation: {
      id: `conv_${hmac(key).slice(0, 16)}`,
      history: conversations.get(key) ?? [],
    },
  };
}

function toOutboundMessage(payload: unknown, msg: IntegrationMessage): OutboundWhatsApp {
  const turn = payload as ConversationTurn;
  const reply = msg.headers.jumpReplies?.[LLM_BINDING] as LlmReply;
  return {
    organizationId: turn.organizationId,
    businessNumber: turn.businessNumber,
    conversationId: turn.conversation.id,
    inReplyTo: turn.messageSid,
    from: turn.to,
    to: turn.from,
    body: reply.text,
  };
}

const waInbound: FlowDefinition = {
  name: 'wa-inbound',
  build: () =>
    IntegrationFlow.from('wa.inbound', { privacy: 'wa-inbound' })
      .filter((payload) => (payload as SubmitInbound).body.trim().length > 0, {
        id: 'skip-empty',
        whenDropped: { reply: ignoredReply },
      })
      .headers(senderHeaders, { id: 'sender' })
      .handle(loadConversation, { id: 'load-conversation' })
      .jumpTo(['routing.resolve'], { id: 'routing', care: 'routing' })
      .route(
        (_payload, msg) =>
          (msg.headers.jumpReplies?.['routing.resolve'] as Routing).agentId === null
            ? 'wa.handoff'
            : 'wa.turn',
        { id: 'dispatch' },
      ),
};

const waTurn: FlowDefinition = {
  name: 'wa-turn',
  build: () =>
    IntegrationFlow.from('wa.turn', { privacy: 'wa-inbound' })
      // The jump waits longer than the LLM's whole patience (20 s), so care decides the outcome.
      .jumpTo([{ channel: LLM_BINDING, timeoutMs: 21_000 }], { id: 'llm' })
      .wireTap('wa.audit', { id: 'audit' })
      .transform(toOutboundMessage, { id: 'to-outbound' })
      .to('wa.send', { id: 'send', privacy: 'wa-outbound' }),
};

// ---------- Boot and gRPC driver ----------

/** A grpc-js-shaped `Metadata`: Nest hands it to the interceptor as the RPC context. */
function grpcMetadata(entries: Record<string, string>): { toJSON(): Record<string, string[]> } {
  return {
    toJSON: () => Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, [v]])),
  };
}

type GrpcOutcome = { ok: true; reply: unknown } | { ok: false; error: unknown };

interface Pod {
  name: string;
  app: INestApplication;
  url: string;
  events: CareEvent[];
  control: CareControl;
  registry: ChannelRegistry;
  submit(request: SubmitInbound): Promise<GrpcOutcome>;
}

/** Bounded poll while a loopback request or a dispatch runs; fails with `what`. */
async function until(what: string, condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('scenario whatsapp-pipeline: WhatsApp inbound message to AI reply (SPI-445)', () => {
  let provider: LlmProvider;
  const pods: Pod[] = [];
  let clock: ManualCareClock;
  let state: MemoryCareState;
  let store: MemoryIdempotencyStore;
  let trail: TrailCapture;

  beforeAll(async () => {
    provider = await startLlmProvider();
  });

  afterAll(async () => {
    await provider.close();
  });

  beforeEach(() => {
    clock = manualCareClock();
    state = new MemoryCareState(() => clock.wall());
    store = new MemoryIdempotencyStore();
    trail = captureTrail();
    provider.seen.length = 0;
    provider.script.length = 0;
    provider.hold = false;
    provider.held.length = 0;
    resetDoubles();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    provider.release();
    for (const pod of pods.splice(0)) await pod.app.close();
    jest.restoreAllMocks();
  });

  /** One Estela pod; pods of a test share the clock, the care state and the idempotency store. */
  async function startPod(name = 'pod-a'): Promise<Pod> {
    const events: CareEvent[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            logging: { banner: false },
            idempotency: { store: trail.store(store) },
            privacy,
            channels: [
              { name: 'wa.inbound', type: 'direct' },
              { name: 'routing.resolve', type: 'direct' },
              { name: 'wa.turn', type: 'direct' },
              { name: LLM_BINDING, type: 'direct' },
              { name: 'wa.send', type: 'direct' },
              { name: 'wa.reply.parked', type: 'queue' },
              { name: 'wa.handoff', type: 'direct' },
              { name: 'wa.audit', type: 'direct' },
            ],
            care: {
              clock,
              // Full spread draws its top value: every gap is the configured one.
              random: (maxExclusive) => maxExclusive - 1,
              profiles: profiles(state),
              keyHasher: hmac,
              keyLabel: (key) => hmac(key).slice(0, 12),
              events: { onEvent: (event) => events.push(event) },
            },
            outbound: {
              rest: {
                bindings: [
                  {
                    name: LLM_BINDING,
                    channel: LLM_BINDING,
                    url: provider.url,
                    method: 'POST',
                    headers: { 'x-goog-api-key': GEMINI_KEY },
                    target: (ctx) => {
                      const turn = ctx.payload as ConversationTurn;
                      return {
                        body: {
                          contents: [
                            ...turn.conversation.history.map((t) => ({
                              role: t.role,
                              parts: [{ text: t.text }],
                            })),
                            { role: 'user', parts: [{ text: turn.body }] },
                          ],
                          generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
                        },
                      };
                    },
                    response: (ctx): LlmReply => {
                      const body = ctx.response.body as {
                        candidates: { content: { parts: { text: string }[] } }[];
                      };
                      return { text: body.candidates[0]!.content.parts[0]!.text };
                    },
                    care: 'llm-turn',
                  },
                ],
              },
            },
          },
          [waInbound, waTurn],
        ),
      ],
      providers: [
        { provide: POD, useValue: name },
        { provide: 'CARE_CLOCK', useValue: clock },
        WhatsAppInboundGrpc,
        RoutingActivator,
        WhatsAppSendActivator,
        HandoffActivator,
        ParkingActivator,
        AuditActivator,
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    trail.channel(app.get(ChannelRegistry), 'error.channel');
    trail.channel(app.get(ChannelRegistry), 'estela.care.events');
    const interceptor = new InboundInterceptor(app.get<InboundInterceptorDeps>(INBOUND_DEPS));
    const endpoint = app.get(WhatsAppInboundGrpc);
    const pod: Pod = {
      name,
      app,
      url: await app.getUrl(),
      events,
      control: app.get(CareControl),
      registry: app.get(ChannelRegistry),
      submit: async (request) => {
        const handler = WhatsAppInboundGrpc.prototype.submit;
        const context = new ExecutionContextHost(
          [
            request,
            grpcMetadata({
              'x-trace-id': randomUUID(),
              'x-organization-id': request.organizationId,
              'user-agent': 'grpc-go/1.68.1 ms-whatsapp',
            }),
            {},
          ],
          WhatsAppInboundGrpc,
          handler,
        );
        context.setType('rpc');
        try {
          const stream = await interceptor.intercept(context, {
            handle: () => of(handler.call(endpoint, request)),
          });
          return { ok: true, reply: await lastValueFrom(stream) };
        } catch (error) {
          return { ok: false, error };
        }
      },
    };
    pods.push(pod);
    return pod;
  }

  const sentBodies = (): string[] => whatsapp.sent.map((s) => s.request.body);
  /** A drain worker re-sends a parked reply with the key it was left from and its tenant headers. */
  const drainHeaders = (entry: (typeof parked)[number]) => ({
    idempotencyKey: String(entry.headers.leftFromKey),
    organizationId: entry.headers.organizationId,
    businessNumber: entry.headers.businessNumber,
  });
  const inboundRecord = async (sid: string) => store.get('inbound:wa.inbound', sid);

  it('RS-53 RS-58 RS-09: one inbound message gets exactly one send with the LLM text, one audit copy and one key end to end', async () => {
    const pod = await startPod();
    const request = submit();

    const outcome = await pod.submit(request);

    expect(outcome).toEqual({
      ok: true,
      reply: { status: 'queued', providerMessageId: 'SMout0001', inReplyTo: request.messageSid },
    });
    expect(provider.seen).toHaveLength(1);
    const llmCall = provider.seen[0]!;
    expect(llmCall.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(llmCall.headers['idempotency-key']).toBe(request.messageSid);
    expect(llmCall.body.contents.map((c) => c.parts[0]!.text)).toEqual([
      'Buenas tardes',
      '¡Hola Ana! Soy Sofía de Farmacro. ¿En qué le ayudo?',
      CUSTOMER_TEXT,
    ]);
    expect(whatsapp.sent).toHaveLength(1);
    expect(whatsapp.sent[0]).toMatchObject({
      pod: 'pod-a',
      idempotencyKey: request.messageSid,
      request: {
        organizationId: ORG_FARMACRO,
        businessNumber: BUSINESS_NUMBER,
        inReplyTo: request.messageSid,
        from: `whatsapp:${BUSINESS_NUMBER}`,
        to: `whatsapp:${CUSTOMER_NUMBER}`,
        body: LLM_TEXT,
      },
    });
    expect(campaigns.calls).toBe(1);
    expect(handoffs).toHaveLength(0);
    expect(parked).toHaveLength(0);
    await until('the audit copy', () => audited.length === 1);
    expect(audited[0]?.headers.jumpReplies?.[LLM_BINDING]).toEqual({ text: LLM_TEXT });
    expect(audited[0]?.headers).not.toHaveProperty('triesLeft');
    // The audit activator returns a value, yet the tap copy has no reply routing: the caller got
    // exactly one reply, the real send result, and the audit value went nowhere.
    expect(audited[0]?.headers).not.toHaveProperty('replyChannel');
    expect(audited[0]?.headers).not.toHaveProperty('x-integration-jump-reply');
    expect(outcome).not.toEqual(expect.objectContaining({ reply: { audited: true } }));
    // Tenant and sender travel as headers end to end; the tap copy hides the sender header.
    expect(audited[0]?.headers).toMatchObject({
      organizationId: ORG_FARMACRO,
      businessNumber: '[HIDDEN:header]',
    });
    expect((await inboundRecord(request.messageSid))?.status).toBe('completed');
    expect(pod.events.filter((e) => e.type === 'plan-b.used')).toHaveLength(0);
    expect(clock.monotonic()).toBe(0);
  });

  it('RS-27 RS-09: a duplicate webhook delivery with the same messageSid is a no-op: no second LLM call, no second send', async () => {
    const pod = await startPod();
    const request = submit();

    const first = await pod.submit(request);
    const second = await pod.submit({ ...request });

    expect(second).toEqual(first);
    expect(provider.seen).toHaveLength(1);
    expect(whatsapp.attempts).toHaveLength(1);
    expect(sentBodies()).toEqual([LLM_TEXT]);
    expect(campaigns.calls).toBe(1);
    await until('the audit copy', () => audited.length === 1);
    // A different message from the same customer is not a duplicate.
    await pod.submit(submit({ body: '¿Y el precio?' }));
    expect(provider.seen).toHaveLength(2);
    expect(whatsapp.sent).toHaveLength(2);
  });

  it('RS-07 RS-62 RS-25: routing slow or down ends within the 800 ms patience in plan B and a handoff; the LLM is never called', async () => {
    const pod = await startPod();

    // Slow: ms-campaigns never answers. Try 1 is cut at 300 ms, the gap is 200 ms, try 2 is cut
    // at 800 ms, which is also patience.totalMs.
    campaigns.mode = 'hang';
    const slow = submit();
    let slowOutcome: GrpcOutcome | undefined;
    void pod.submit(slow).then((outcome) => {
      slowOutcome = outcome;
    });
    await until('the first routing call', () => campaigns.calls === 1);
    await clock.advance(799);
    expect(slowOutcome).toBeUndefined();
    expect(handoffs).toHaveLength(0);
    await clock.advance(1);
    await until('the slow handoff', () => slowOutcome !== undefined);
    expect(clock.monotonic()).toBe(800);
    expect(slowOutcome).toEqual({
      ok: true,
      reply: { status: 'handed-off', inReplyTo: slow.messageSid, reason: 'routing-unavailable' },
    });
    const routingEvents = pod.events.filter((e) => e.binding === ROUTING_BINDING);
    expect(routingEvents.filter((e) => e.type === 'try.again')).toHaveLength(1);
    expect(routingEvents.find((e) => e.type === 'plan-b.used')).toBeDefined();

    // Down: ms-campaigns fails at once with UNAVAILABLE; tries at 0 and 200 ms, then plan B.
    campaigns.mode = 'down';
    campaigns.calls = 0;
    const down = submit({ body: 'Necesito hablar con alguien' });
    const started = clock.monotonic();
    const downOutcome = pod.submit(down);
    await until('the first failing routing call', () => campaigns.calls === 1);
    await clock.advance(200);
    expect(await downOutcome).toMatchObject({ ok: true, reply: { status: 'handed-off' } });
    expect(campaigns.calls).toBe(2);
    expect(clock.monotonic() - started).toBe(200);

    expect(handoffs.map((h) => [h.request.messageSid, h.routing])).toEqual([
      [slow.messageSid, { agentId: null, reason: 'routing-unavailable' }],
      [down.messageSid, { agentId: null, reason: 'routing-unavailable' }],
    ]);
    expect(provider.seen).toHaveLength(0);
    expect(whatsapp.attempts).toHaveLength(0);
    // The handoff was built on plan B: it is not stored, a redelivery runs again.
    expect((await inboundRecord(slow.messageSid))?.status).not.toBe('completed');
    expect((await inboundRecord(down.messageSid))?.status).not.toBe('completed');
  });

  it('RS-11: an LLM 429 with Retry-After: 1 gets one extra try exactly 1000 ms later on the care clock, then one send', async () => {
    const pod = await startPod();
    provider.script.push(slowDown(1));
    const request = submit();

    const outcome = pod.submit(request);
    await until('the try.again of the 429', () =>
      pod.events.some((e) => e.type === 'try.again' && e.binding === LLM_BINDING),
    );
    expect(provider.seen).toHaveLength(1);
    await clock.advance(999);
    // A real window long enough for a loopback request: an early try would have arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(provider.seen).toHaveLength(1);
    await clock.advance(1);
    expect(await outcome).toMatchObject({ ok: true, reply: { status: 'queued' } });

    expect(provider.seen).toHaveLength(2);
    expect(provider.seen.map((r) => r.headers['idempotency-key'])).toEqual([
      request.messageSid,
      request.messageSid,
    ]);
    expect(pod.events.find((e) => e.type === 'try.again' && e.binding === LLM_BINDING)).toEqual(
      expect.objectContaining({
        edge: 'outbound-rest',
        class: 'busy',
        tryNumber: 1,
        delayMs: 1_000,
      }),
    );
    expect(sentBodies()).toEqual([LLM_TEXT]);
    // 429 asks to slow down; it does not count against the organization's valve (RS-17).
    expect(pod.control.valveState(LLM_BINDING, ORG_FARMACRO)).toEqual({ state: 'flowing' });
  });

  it('RS-16 RS-20 RS-49 RS-27: LLM quota shuts the valve of that organization only, until resumed; plan B answers and is never stored', async () => {
    const pod = await startPod();
    provider.script.push(quotaUsedUp);
    const first = submit();

    // 1. Quota: no extra try, the Farmacro valve shuts by quota, the customer gets the holding text.
    expect(await pod.submit(first)).toMatchObject({ ok: true, reply: { status: 'queued' } });
    expect(provider.seen).toHaveLength(1);
    expect(sentBodies()).toEqual([HOLDING_TEXT]);
    expect(pod.control.valveState(LLM_BINDING, ORG_FARMACRO)).toEqual({
      state: 'shut',
      forcedBy: 'quota',
    });
    expect(pod.events.filter((e) => e.type === 'quota.used-up')).toHaveLength(1);
    expect((await inboundRecord(first.messageSid))?.status).not.toBe('completed');

    // 2. Another Farmacro message, a day later on the care clock: still shut, no provider call.
    await clock.advance(24 * 60 * 60 * 1_000);
    const second = submit({ body: '¿Siguen ahí?' });
    expect(await pod.submit(second)).toMatchObject({ ok: true, reply: { status: 'queued' } });
    expect(provider.seen).toHaveLength(1);
    expect(sentBodies()).toEqual([HOLDING_TEXT, HOLDING_TEXT]);
    expect(pod.events.filter((e) => e.type === 'valve.probing')).toHaveLength(0);

    // 3. Another organization on the same binding still reaches the provider.
    const other = submit({
      organizationId: ORG_CLINICA,
      businessNumber: '+50223851190',
      to: 'whatsapp:+50223851190',
      body: '¿A qué hora abren mañana?',
    });
    expect(await pod.submit(other)).toMatchObject({ ok: true, reply: { status: 'queued' } });
    expect(provider.seen).toHaveLength(2);
    expect(sentBodies()).toEqual([HOLDING_TEXT, HOLDING_TEXT, LLM_TEXT]);
    expect(pod.control.valveState(LLM_BINDING, ORG_CLINICA)).toEqual({ state: 'flowing' });

    // 4. The operator lifts the quota: the next Farmacro message reaches the provider.
    await pod.control.resume(LLM_BINDING, ORG_FARMACRO);
    expect(pod.control.valveState(LLM_BINDING, ORG_FARMACRO)).toEqual({ state: 'flowing' });
    const third = submit({ body: 'Quiero apartar dos cajas' });
    expect(await pod.submit(third)).toMatchObject({ ok: true, reply: { status: 'queued' } });
    expect(provider.seen).toHaveLength(3);
    expect(sentBodies().at(-1)).toBe(LLM_TEXT);

    // 5. Plan B was not stored: the redelivered first message runs again and gets a real answer.
    expect(await pod.submit({ ...first })).toMatchObject({ ok: true, reply: { status: 'queued' } });
    expect(provider.seen).toHaveLength(4);
    const replies = whatsapp.sent.filter((s) => s.request.inReplyTo === first.messageSid);
    expect(replies.map((s) => s.request.body)).toEqual([HOLDING_TEXT, LLM_TEXT]);
    expect((await inboundRecord(first.messageSid))?.status).toBe('completed');

    const leaked = JSON.stringify(pod.events);
    for (const value of [ORG_FARMACRO, ORG_CLINICA, CUSTOMER_NUMBER, first.messageSid]) {
      expect(leaked).not.toContain(value);
    }
  });

  it('RS-48 RS-25 RS-27: wa.send fails three times on the 300/600 ms gaps, then plan B parks the reply; nothing is lost', async () => {
    const pod = await startPod();
    whatsapp.failNext = 3;
    const request = submit();

    const outcome = pod.submit(request);
    await until('the first send try', () => whatsapp.attempts.length === 1);
    await clock.advance(299);
    expect(whatsapp.attempts).toHaveLength(1);
    await clock.advance(1);
    await until('the second send try', () => whatsapp.attempts.length === 2);
    await clock.advance(600);
    expect(await outcome).toEqual({
      ok: true,
      reply: { status: 'parked', inReplyTo: request.messageSid },
    });
    await until('the parked reply', () => parked.length === 1);

    expect(whatsapp.attempts.map((a) => a.at)).toEqual([0, 300, 900]);
    expect(whatsapp.attempts.every((a) => a.idempotencyKey === request.messageSid)).toBe(true);
    expect(whatsapp.sent).toHaveLength(0);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.request).toMatchObject({
      inReplyTo: request.messageSid,
      to: `whatsapp:${CUSTOMER_NUMBER}`,
      body: LLM_TEXT,
    });
    // Plan B left the reply on the queue without waiting: the parked copy cannot answer anyone.
    expect(parked[0]?.headers).not.toHaveProperty('replyChannel');
    expect(parked[0]?.headers).toMatchObject({
      leftFromKey: request.messageSid,
      organizationId: ORG_FARMACRO,
      businessNumber: BUSINESS_NUMBER,
    });
    expect(
      String(parked[0]?.headers.idempotencyKey).startsWith(`${request.messageSid}:left:`),
    ).toBe(true);
    expect(
      pod.events.filter((e) => e.binding === SEND_BINDING && e.type === 'plan-b.used'),
    ).toHaveLength(1);
    expect(provider.seen).toHaveLength(1);
    expect(pod.events.filter((e) => e.binding === SEND_BINDING && e.type === 'try.again')).toEqual([
      expect.objectContaining({ class: 'transient', tryNumber: 1, delayMs: 300 }),
      expect.objectContaining({ class: 'transient', tryNumber: 2, delayMs: 600 }),
    ]);
    expect((await inboundRecord(request.messageSid))?.status).not.toBe('completed');

    // The first drain finds ms-whatsapp still down: plan B leaves the same reply a second time,
    // and the parking activator takes it (D42: each leave has a key of its own).
    whatsapp.failNext = 3;
    const failedDrain = pod.registry.send('wa.send', parked[0]!.request, drainHeaders(parked[0]!));
    await until('the first drain try', () => whatsapp.attempts.length === 4);
    await clock.advance(300);
    await until('the second drain try', () => whatsapp.attempts.length === 5);
    await clock.advance(600);
    await failedDrain;
    await until('the reply parked again', () => parked.length === 2);
    expect(whatsapp.attempts.slice(3).every((a) => a.idempotencyKey === request.messageSid)).toBe(
      true,
    );
    expect(parked[1]?.request).toEqual(parked[0]?.request);
    expect(parked[1]?.headers.leftFromKey).toBe(request.messageSid);
    expect(parked[1]?.headers.idempotencyKey).not.toBe(parked[0]?.headers.idempotencyKey);

    // ms-whatsapp is back: draining the parked reply sends it once, with the key it was left from.
    await pod.registry.send('wa.send', parked[1]!.request, drainHeaders(parked[1]!));
    expect(whatsapp.sent.map((s) => [s.request.inReplyTo, s.request.body])).toEqual([
      [request.messageSid, LLM_TEXT],
    ]);
    expect(whatsapp.sent[0]?.idempotencyKey).toBe(request.messageSid);
  });

  it('RS-22 RS-23 RS-37 RS-21: a 120-message burst on two pods: inbound sheds before any claim, and sends keep 20/s + burst 40 across both pods', async () => {
    const podA = await startPod('pod-a');
    const podB = await startPod('pod-b');
    provider.hold = true;
    const requests = Array.from({ length: 120 }, (_, n) =>
      submit({ body: `Pedido #${4_810 + n}: ¿me confirman la entrega de hoy?` }),
    );

    const pending = requests.map((request, n) =>
      (n % 2 === 0 ? podA : podB).submit(request).then((outcome) => ({ request, outcome })),
    );
    // Inbound lanes 50 per pod: 50 + 50 in flight; LLM lanes 20 per pod reach the provider.
    await until('40 LLM calls in flight', () => provider.held.length === 40);
    await clock.flush();
    expect(provider.seen).toHaveLength(40);
    provider.release();
    const results = await Promise.all(pending);

    const refused = results.filter((r) => !r.outcome.ok);
    expect(refused).toHaveLength(20);
    for (const { request, outcome } of refused) {
      const error = (outcome as { error: unknown }).error;
      expect(error).toBeInstanceOf(InboundBusyError);
      expect((error as InboundBusyError).reason).toBe('lanes-full');
      expect((error as InboundBusyError).grpcCode).toBe(8);
      // Refused before the claim: no idempotency record, so the redelivery is a fresh run.
      expect(await inboundRecord(request.messageSid)).toBeUndefined();
    }
    const admitted = results.filter((r) => r.outcome.ok).map((r) => r.request.messageSid);
    expect(admitted).toHaveLength(100);
    expect(provider.seen).toHaveLength(100);

    // At t = 0 the shared bucket holds 40 turns for both pods together; the rest are parked.
    expect(whatsapp.sent).toHaveLength(40);
    expect(new Set(whatsapp.sent.map((s) => s.pod))).toEqual(new Set(['pod-a', 'pod-b']));
    await until('60 parked replies', () => parked.length === 60);
    expect(
      [...podA.events, ...podB.events].filter(
        (e) => e.type === 'pace.over' && e.binding === SEND_BINDING,
      ),
    ).toHaveLength(60);

    // A drain worker on each pod re-sends the parked replies once per second of care time.
    for (const second of [1, 2, 3]) {
      await clock.advance(1_000);
      const batch = parked.splice(0);
      await Promise.all(
        batch.map((entry, n) =>
          (n % 2 === 0 ? podA : podB).registry.send('wa.send', entry.request, drainHeaders(entry)),
        ),
      );
      expect(whatsapp.sent.filter((s) => s.at === second * 1_000)).toHaveLength(20);
    }
    expect(parked).toHaveLength(0);
    const perWindow = [0, 1_000, 2_000, 3_000].map(
      (at) => whatsapp.sent.filter((s) => s.at === at).length,
    );
    expect(perWindow).toEqual([40, 20, 20, 20]);
    // Every admitted message was sent exactly once; no refused one was.
    const sentFor = whatsapp.sent.map((s) => s.request.inReplyTo).sort();
    expect(sentFor).toEqual([...admitted].sort());
  });

  it('SPI-448: an empty inbound message is answered at once with the ack; no routing, no LLM call, no send', async () => {
    const pod = await startPod();
    const request = submit({ body: '   ', numMedia: 0 });

    const outcome = await pod.submit(request);

    expect(outcome).toEqual({
      ok: true,
      reply: { status: 'ignored', inReplyTo: request.messageSid, reason: 'empty' },
    });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.headers).toMatchObject({ organizationId: ORG_FARMACRO });
    expect(clock.monotonic()).toBe(0);
    expect(campaigns.calls).toBe(0);
    expect(provider.seen).toHaveLength(0);
    expect(whatsapp.attempts).toHaveLength(0);
    expect(parked).toHaveLength(0);
    expect(handoffs).toHaveLength(0);
    // A redelivery of the same empty message replays the ack and still calls nothing.
    expect(await pod.submit({ ...request })).toEqual(outcome);
    expect(provider.seen).toHaveLength(0);
    expect(whatsapp.attempts).toHaveLength(0);
  });

  it('RS-42 RS-66: GET /integration/graph shows the care summaries of these steps and no payload value', async () => {
    const pod = await startPod();
    // Traffic first: the graph must not pick up anything a message carried.
    const request = submit();
    expect(await pod.submit(request)).toMatchObject({ ok: true });

    const response = await fetch(`${pod.url}/integration/graph`);
    expect(response.status).toBe(200);
    const text = await response.text();
    const graph = JSON.parse(text) as {
      flows: { name: string; steps: Record<string, unknown>[] }[];
      nodes: {
        channel: string;
        activators?: string[];
        inbounds: Record<string, unknown>[];
        outbounds: Record<string, unknown>[];
      }[];
      module?: { careProfiles?: string[]; privacyProfiles?: string[] };
    };
    const steps = (flow: string) => graph.flows.find((f) => f.name === flow)?.steps;
    // The graph names the privacy profiles that reach each step, never a rule (SD-59).
    const inbound = ['secrets@1', 'wa-inbound'];
    expect(steps('wa-inbound')).toEqual([
      { kind: 'filter', id: 'skip-empty', whenDropped: 'reply', privacy: inbound },
      { kind: 'headers', id: 'sender', computed: true, privacy: inbound },
      { kind: 'handle', id: 'load-conversation', privacy: inbound },
      {
        kind: 'jump',
        id: 'routing',
        dests: [
          {
            channel: 'routing.resolve',
            care: 'patience 300ms · total 800ms · tries x2 · plan-b',
            repeatableBy: 'declared',
            privacy: inbound,
          },
        ],
        privacy: inbound,
      },
      { kind: 'route', id: 'dispatch', privacy: inbound },
    ]);
    expect(steps('wa-turn')).toEqual([
      {
        kind: 'jump',
        id: 'llm',
        dests: [{ channel: LLM_BINDING, timeoutMs: 21_000, privacy: inbound }],
        privacy: inbound,
      },
      { kind: 'wireTap', id: 'audit', channel: 'wa.audit', privacy: inbound },
      { kind: 'transform', id: 'to-outbound', privacy: inbound },
      { kind: 'to', id: 'send', channel: 'wa.send', privacy: [...inbound, 'wa-outbound'] },
    ]);
    const node = (channel: string) => graph.nodes.find((n) => n.channel === channel);
    expect(node(LLM_BINDING)?.outbounds).toEqual([
      {
        transport: 'rest',
        target: 'dynamic',
        care: 'patience 8s · total 20s · tries x2 · valve · lanes · plan-b',
      },
    ]);
    expect(node('wa.send')?.activators).toEqual([
      'WhatsAppSendActivator.send [patience 3s · total 10s · tries x3 · pace · plan-b leave]',
    ]);
    expect(node('wa.inbound')?.inbounds).toEqual([
      expect.objectContaining({
        transport: 'grpc',
        requestReply: true,
        care: 'lanes · pace',
        carries: ['organizationId'],
        privacy: inbound,
      }),
    ]);
    expect(graph.module?.careProfiles).toEqual(['llm-turn', 'routing', 'wa-send']);
    expect(graph.module?.privacyProfiles).toEqual(['wa-inbound', 'wa-outbound']);
    for (const value of [
      CUSTOMER_NUMBER,
      '50255501234',
      BUSINESS_NUMBER,
      CUSTOMER_TEXT,
      LLM_TEXT,
      request.messageSid,
      ORG_FARMACRO,
      GEMINI_KEY,
    ]) {
      expect(text).not.toContain(value);
    }
  });
  it('SD-25 SD-14 SD-27: every trail output shows the customer number as a fingerprint, the business number by its last 4 and the text by its length', async () => {
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown, ...rest: unknown[]): void => {
          trail.logger[level]?.(message, ...rest);
        });
    }
    const pod = await startPod();
    const request = submit();
    expect(await pod.submit(request)).toMatchObject({ ok: true });
    // A second customer message whose send fails once: tries, care events and error lines.
    whatsapp.failNext = 1;
    const outcome = pod.submit(submit({ body: '¿Y el precio?' }));
    await until('the first send try', () => whatsapp.attempts.length === 2);
    await clock.advance(300);
    expect(await outcome).toMatchObject({ ok: true });
    await until('both audit copies', () => audited.length === 2);

    // The tap copy, as the audit activator receives it.
    const tapped = audited[0]!.payload as ConversationTurn;
    const token = tapped.from;
    expect(token).toMatch(/^fp:wa-fp-1:[0-9a-f]{16}$/);
    expect((audited[1]!.payload as ConversationTurn).from).toBe(token);
    expect(tapped.to).toBe('***8427');
    expect(tapped.businessNumber).toBe('***8427');
    expect(tapped.body).toBe(`[HIDDEN:wa.body len=${CUSTOMER_TEXT.length}]`);
    expect(tapped.profileName).toBe('[HIDDEN:wa.name]');
    expect(tapped.conversation.history.map((turn) => turn.text)).toEqual([
      '[HIDDEN:wa.body len=13]',
      expect.stringMatching(/^\[HIDDEN:wa\.body len=\d+\]$/),
    ]);
    expect(audited[0]!.headers.businessNumber).toBe('[HIDDEN:header]');

    // Every trail output: records, envelopes, care events, log lines and the tap copies.
    const taps = audited.map((msg) => ({
      output: TrailOutput.WireTap,
      where: 'channel wa.audit',
      text: JSON.stringify(msg),
    }));
    const everything = { ...trail, writes: [...trail.writes, ...taps] };
    const outputs = new Set(everything.writes.map((write) => write.output));
    expect([...outputs].sort()).toEqual(['log', 'store', 'wiretap']);
    expect(trail.writes.some((write) => write.where === 'channel estela.care.events')).toBe(true);
    for (const write of everything.writes) {
      for (const [, body] of write.text.matchAll(/"body":"([^"]*)"/g)) {
        expect(body).toMatch(/^\[HIDDEN:wa\.body len=\d+\]$/);
      }
    }
    expectNoLeak(everything, [
      CUSTOMER_NUMBER,
      '50255501234',
      BUSINESS_NUMBER,
      '50224618427',
      CUSTOMER_TEXT,
      'Ana López',
    ]);
    // The business path got every value as ms-whatsapp sent it (SD-02).
    expect(whatsapp.sent[0]?.request).toMatchObject({
      from: `whatsapp:${BUSINESS_NUMBER}`,
      to: `whatsapp:${CUSTOMER_NUMBER}`,
      businessNumber: BUSINESS_NUMBER,
    });
    expect(provider.seen[0]?.body.contents.at(-1)?.parts[0]?.text).toBe(CUSTOMER_TEXT);
  });
});
