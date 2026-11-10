import 'reflect-metadata';

import { Body, Controller, Injectable, Logger, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CareControl,
  InboundRest,
  IntegrationModule,
  MemoryIdempotencyStore,
  OutboundHttpError,
  OutboundRestGateway,
  ServiceActivator,
  type CareClassifierFn,
  type CareEvent,
  type CareMetricsPort,
  type CareRef,
} from '../../src/index';
import { collectCareEvents, manualCareClock, type ManualCareClock } from '../../src/testing';

/**
 * Scenario "llm-quota": one WhatsApp conversation turn answered by an LLM provider.
 *
 * Real Nest app on a loopback socket (inbound webhook -> direct channel -> activator -> outbound
 * REST binding) and a real loopback HTTP server that plays the LLM provider. Every care timer
 * runs on `manualCareClock`, so gaps, deadlines and "never comes back by itself" are asserted
 * by moving time explicitly; the only real waits are bounded polls on socket I/O.
 *
 * The provider first answers 429 with `Retry-After: 2` (slow down), then 429 with an
 * `insufficient_quota` body (credits used up). The app classifier maps the second one to the
 * generic `'quota'` class; the binding's profile shuts the valve until an operator resumes it.
 */

// ---------- Realistic payloads ----------

const CUSTOMER_PHONE = '50255501234';
const CUSTOMER_TEXT = 'Hi, can I move my appointment to Tuesday at 10?';
const WAMID = 'wamid.HBgLNTAyNTU1MDEyMzQVAgASGBQzQUY0RDQ3NkQ0MzVGQzU3MjQ5RgA=';
const PROVIDER_KEY = 'Bearer llm-org-key-7f3a';
const HOLDING_TEXT = 'Thanks for your message. An advisor will get back to you shortly.';
const LLM_TEXT = 'Done: your appointment is now on Tuesday at 10:00.';

interface WhatsAppInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text';
  text: { body: string };
}

interface WhatsAppWebhook {
  object: 'whatsapp_business_account';
  entry: {
    id: string;
    changes: {
      field: 'messages';
      value: {
        messaging_product: 'whatsapp';
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts: { profile: { name: string }; wa_id: string }[];
        messages: WhatsAppInboundMessage[];
      };
    }[];
  }[];
}

function webhook(wamid = WAMID): WhatsAppWebhook {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
              contacts: [{ profile: { name: 'Ana' }, wa_id: CUSTOMER_PHONE }],
              messages: [
                {
                  from: CUSTOMER_PHONE,
                  id: wamid,
                  timestamp: '1731230400',
                  type: 'text',
                  text: { body: CUSTOMER_TEXT },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function inboundMessage(body: WhatsAppWebhook): WhatsAppInboundMessage | undefined {
  return body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
}

/** The provider's answer body as the binding returns it (`response: 'body'`). */
interface LlmAnswer {
  output: string;
  degraded?: boolean;
}

// ---------- The LLM provider (loopback HTTP) ----------

interface ScriptedAnswer {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

const slowDown = (seconds: number): ScriptedAnswer => ({
  status: 429,
  headers: { 'retry-after': String(seconds) },
  body: { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Slow down' } },
});

const quotaUsedUp: ScriptedAnswer = {
  status: 429,
  body: {
    error: {
      type: 'insufficient_quota',
      code: 'insufficient_quota',
      message: 'You exceeded your current quota, please check your plan and billing details.',
    },
  },
};

interface LlmProvider {
  url: string;
  /** Headers of every request received, in order. */
  seen: IncomingMessage['headers'][];
  /** Answers served in order; once empty the provider answers 200 with LLM_TEXT. */
  script: ScriptedAnswer[];
  close(): Promise<void>;
}

async function startLlmProvider(): Promise<LlmProvider> {
  const seen: IncomingMessage['headers'][] = [];
  const script: ScriptedAnswer[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers);
      const next = script.shift() ?? { status: 200, body: { output: LLM_TEXT } };
      res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
      res.end(JSON.stringify(next.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`,
    seen,
    script,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- App: webhook -> wa.turn -> assistant activator -> assistant.llm ----------

const TURN_CHANNEL = 'wa.turn';
const LLM_BINDING = 'assistant.llm';

@Controller('webhooks')
class WhatsAppWebhookController {
  @Post('whatsapp')
  @InboundRest({
    channel: TURN_CHANNEL,
    requestReply: true,
    idempotency: {
      // Meta redelivers a webhook with the same message id: that id is the idempotency key.
      clientKey: (ctx) => inboundMessage(ctx.payload as WhatsAppWebhook)?.id,
      onDuplicate: 'replay',
    },
  })
  receive(@Body() body: WhatsAppWebhook): WhatsAppWebhook {
    return body;
  }
}

@Injectable()
class AssistantTurnActivator {
  runs = 0;

  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator(TURN_CHANNEL)
  async reply(payload: WhatsAppWebhook): Promise<unknown> {
    this.runs += 1;
    const message = inboundMessage(payload)!;
    const answer = await this.outbound.request<LlmAnswer>(
      LLM_BINDING,
      {
        payload: {
          model: 'chat-large',
          conversation: `wa:${message.from}`,
          input: [{ role: 'user', content: message.text.body }],
        },
      },
      { idempotencyKey: `turn:${message.id}` },
    );
    return {
      messaging_product: 'whatsapp',
      to: message.from,
      type: 'text',
      text: { body: answer.output },
      degraded: answer.degraded === true,
    };
  }
}

/** App rule (RS-16): only the app knows that this provider's 429 + `insufficient_quota` is quota. */
const providerQuota: CareClassifierFn = (error) =>
  error instanceof OutboundHttpError &&
  error.status === 429 &&
  (error.body as { error?: { code?: string } } | null)?.error?.code === 'insufficient_quota'
    ? 'quota'
    : undefined;

/** The Estela-own parameter set of an LLM turn, referenced by name from the binding (RS-53). */
const LLM_TURN_PROFILE = {
  classify: providerQuota,
  patience: { totalMs: 10_000 },
  tries: { max: 3, spacing: { firstMs: 200, growth: 2, spread: 'none' as const } },
  valve: { minCalls: 10, shutMs: 30_000, quotaShutMs: 'until-resumed' as const },
  planB: {
    value: (): LlmAnswer => ({ output: HOLDING_TEXT, degraded: true }),
    on: [
      'transient',
      'busy',
      'quota',
      'valve-shut',
      'lanes-full',
      'over-pace',
      'out-of-time',
    ] as const,
  },
};

interface MetricPoint {
  kind: 'counter' | 'histogram' | 'gauge';
  name: string;
  labels: Record<string, string>;
  value: number;
}

class RecordingMetrics implements CareMetricsPort {
  readonly points: MetricPoint[] = [];
  counter(name: string, labels: Record<string, string>, value = 1): void {
    this.points.push({ kind: 'counter', name, labels, value });
  }
  histogram(name: string, labels: Record<string, string>, value: number): void {
    this.points.push({ kind: 'histogram', name, labels, value });
  }
  gauge(name: string, labels: Record<string, string>, value: number): void {
    this.points.push({ kind: 'gauge', name, labels, value });
  }
  sum(name: string, match: Record<string, string> = {}): number {
    return this.points
      .filter((p) => p.name === name && Object.entries(match).every(([k, v]) => p.labels[k] === v))
      .reduce((total, p) => total + p.value, 0);
  }
  lastGauge(name: string): number | undefined {
    return this.points.filter((p) => p.kind === 'gauge' && p.name === name).at(-1)?.value;
  }
}

/** Bounded poll for socket I/O: real time only advances while the loopback request runs. */
async function until(what: string, condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface Scenario {
  app: INestApplication;
  url: string;
  clock: ManualCareClock;
  store: MemoryIdempotencyStore;
  metrics: RecordingMetrics;
  events: CareEvent[];
  types(): string[];
  control: CareControl;
  activator: AssistantTurnActivator;
  deliver(wamid?: string): Promise<Response>;
}

interface TurnReplyEnvelope {
  status: string;
  result: { to: string; type: string; text: { body: string }; degraded: boolean };
}

describe('scenario llm-quota: WhatsApp turn against an LLM provider that runs out of quota', () => {
  let provider: LlmProvider;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    provider = await startLlmProvider();
  });

  afterAll(async () => {
    await provider.close();
  });

  beforeEach(() => {
    provider.seen.length = 0;
    provider.script.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    jest.restoreAllMocks();
  });

  async function boot(bindingCare: CareRef = 'llm-turn'): Promise<Scenario> {
    const clock = manualCareClock();
    const store = new MemoryIdempotencyStore();
    const metrics = new RecordingMetrics();
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({
          channels: [{ name: TURN_CHANNEL, type: 'direct' }],
          logging: { banner: false },
          idempotency: { store },
          care: { profiles: { 'llm-turn': LLM_TURN_PROFILE }, metrics, clock },
          outbound: {
            rest: {
              bindings: [
                {
                  name: LLM_BINDING,
                  url: provider.url,
                  method: 'POST',
                  headers: { authorization: PROVIDER_KEY },
                  response: 'body',
                  care: bindingCare,
                },
              ],
            },
          },
        }),
      ],
      controllers: [WhatsAppWebhookController],
      providers: [AssistantTurnActivator],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const url = `${await app.getUrl()}/webhooks/whatsapp`;
    const collected = collectCareEvents(app);
    return {
      app,
      url,
      clock,
      store,
      metrics,
      events: collected.events,
      types: collected.types,
      control: app.get(CareControl),
      activator: app.get(AssistantTurnActivator),
      deliver: (wamid = WAMID) =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(webhook(wamid)),
        }),
    };
  }

  /**
   * First delivery of the webhook: 429 slow-down, the gap on the care clock, then the quota
   * answer. Returns the webhook response and the clock position of each provider request.
   */
  async function slowDownThenQuota(s: Scenario) {
    provider.script.push(slowDown(2), quotaUsedUp);
    const pending = s.deliver();
    await until('the 429 slow-down and its try.again event', () => s.types().includes('try.again'));
    const firstTryAt = s.clock.monotonic();
    expect(provider.seen).toHaveLength(1);
    await s.clock.advance(1_999);
    // A real window long enough for a loopback request: an early try would have arrived by now.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stillOneAt1999 = provider.seen.length;
    await s.clock.advance(1);
    await until('the second try to reach the provider', () => provider.seen.length === 2);
    const secondTryAt = s.clock.monotonic();
    const response = await pending;
    return { response, firstTryAt, secondTryAt, stillOneAt1999 };
  }

  it('RS-11 RS-07: a 429 with Retry-After: 2 waits exactly 2000 ms on the care clock, inside patience.totalMs', async () => {
    const s = await boot();
    const { stillOneAt1999, firstTryAt, secondTryAt } = await slowDownThenQuota(s);
    // max(spacing 200, Retry-After 2000) = 2000: not one ms earlier, and well inside totalMs.
    expect(stillOneAt1999).toBe(1);
    expect(secondTryAt - firstTryAt).toBe(2_000);
    const tryAgain = s.events.filter((event) => event.type === 'try.again');
    expect(tryAgain).toEqual([
      expect.objectContaining({
        edge: 'outbound-rest',
        binding: LLM_BINDING,
        class: 'busy',
        tryNumber: 1,
        delayMs: 2_000,
      }),
    ]);
  });

  it('RS-09: both tries carry the same idempotency key and the same provider credential (no key rotation)', async () => {
    const s = await boot();
    await slowDownThenQuota(s);
    expect(provider.seen).toHaveLength(2);
    expect(new Set(provider.seen.map((headers) => headers['idempotency-key']))).toEqual(
      new Set([`turn:${WAMID}`]),
    );
    expect(new Set(provider.seen.map((headers) => headers.authorization))).toEqual(
      new Set([PROVIDER_KEY]),
    );
  });

  it('RS-16 RS-25: the quota answer is final, shuts the valve by quota, and plan B answers the webhook', async () => {
    const s = await boot();
    const { response } = await slowDownThenQuota(s);
    expect(response.status).toBe(201);
    const envelope = (await response.json()) as TurnReplyEnvelope;
    expect(envelope).toMatchObject({
      status: 'ok',
      result: { to: CUSTOMER_PHONE, type: 'text', text: { body: HOLDING_TEXT }, degraded: true },
    });
    // No third try: tries.max is 3, but quota is never tried again.
    expect(provider.seen).toHaveLength(2);
    expect(s.control.valveState(LLM_BINDING)).toEqual({ state: 'shut', forcedBy: 'quota' });
    await until('plan-b.used on the events channel', () => s.types().includes('plan-b.used'));
    expect(s.types().filter((type) => type === 'quota.used-up')).toHaveLength(1);
    expect(s.types().filter((type) => type === 'valve.forced-shut')).toHaveLength(1);
    expect(s.types()).not.toContain('valve.shut');
    expect(s.events.find((event) => event.type === 'plan-b.used')).toMatchObject({
      binding: LLM_BINDING,
      class: 'quota',
    });
  });

  it('RS-27: the degraded reply is not stored; the duplicate webhook runs again and plan B answers it with no provider call', async () => {
    const s = await boot();
    await (await slowDownThenQuota(s)).response.json();
    expect((await s.store.get(`inbound:${TURN_CHANNEL}`, WAMID))?.status).not.toBe('completed');
    expect((await s.store.get('activator:AssistantTurnActivator.reply', WAMID))?.status).not.toBe(
      'completed',
    );

    const duplicate = await s.deliver();
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({
      result: { text: { body: HOLDING_TEXT }, degraded: true },
    });
    expect(s.activator.runs).toBe(2);
    // The valve is shut by quota: 0 provider calls, and plan B runs under the 'quota' trigger.
    expect(provider.seen).toHaveLength(2);
    await until(
      'the second plan-b.used',
      () => s.events.filter((event) => event.type === 'plan-b.used').length === 2,
    );
    expect(s.events.filter((event) => event.type === 'plan-b.used').at(-1)).toMatchObject({
      class: 'quota',
    });
    expect((await s.store.get(`inbound:${TURN_CHANNEL}`, WAMID))?.status).not.toBe('completed');
  });

  it('RS-16: until-resumed never lets a probe through, even 24 h later on the care clock', async () => {
    const s = await boot();
    await (await slowDownThenQuota(s)).response.json();
    await s.clock.advance(24 * 60 * 60 * 1_000);
    expect(s.control.valveState(LLM_BINDING)).toEqual({ state: 'shut', forcedBy: 'quota' });

    const next = await s.deliver('wamid.HBgLNTAyNTU1MDEyMzQVAgASGBQ0QkE5MEQ2RkU3QUFCMUY1QjAyNgA=');
    expect(await next.json()).toMatchObject({ result: { degraded: true } });
    expect(provider.seen).toHaveLength(2);
    await s.clock.flush();
    expect(s.types()).not.toContain('valve.probing');
    expect(s.types()).not.toContain('valve.flowing');
  });

  it('RS-49 RS-27: after CareControl.resume the duplicate delivery runs again, reaches the provider and its real answer is stored', async () => {
    const s = await boot();
    await (await slowDownThenQuota(s)).response.json();

    await s.control.resume(LLM_BINDING);
    expect(s.control.valveState(LLM_BINDING)).toEqual({ state: 'flowing' });
    await until('valve.flowing', () => s.types().includes('valve.flowing'));
    expect(s.types().filter((type) => type === 'valve.flowing')).toHaveLength(1);

    const afterReset = await s.deliver();
    expect(afterReset.status).toBe(201);
    expect(await afterReset.json()).toMatchObject({
      result: { to: CUSTOMER_PHONE, text: { body: LLM_TEXT }, degraded: false },
    });
    expect(s.activator.runs).toBe(2);
    expect(provider.seen).toHaveLength(3);
    expect(provider.seen[2]?.['idempotency-key']).toBe(`turn:${WAMID}`);
    expect((await s.store.get(`inbound:${TURN_CHANNEL}`, WAMID))?.status).toBe('completed');

    // Control: the real answer, unlike plan B, is replayed for a further redelivery.
    const replayed = await s.deliver();
    expect(await replayed.json()).toMatchObject({ result: { text: { body: LLM_TEXT } } });
    expect(s.activator.runs).toBe(2);
    expect(provider.seen).toHaveLength(3);
  });

  it('RS-41 RS-17: metrics count the busy and quota tries, the plan B outcome and the shut valve', async () => {
    const s = await boot();
    await (await slowDownThenQuota(s)).response.json();
    const labels = { edge: 'outbound-rest', binding: LLM_BINDING };
    expect(s.metrics.sum('estela_care_tries_total', { ...labels, class: 'busy' })).toBe(1);
    expect(s.metrics.sum('estela_care_tries_total', { ...labels, class: 'quota' })).toBe(1);
    expect(s.metrics.sum('estela_care_extra_tries_total', labels)).toBe(1);
    expect(s.metrics.sum('estela_care_calls_total', { ...labels, outcome: 'plan-b' })).toBe(1);
    expect(s.metrics.sum('estela_care_calls_total', { ...labels, outcome: 'success' })).toBe(0);
    expect(s.metrics.lastGauge('estela_care_valves_shut')).toBe(1);

    await s.deliver().then((response) => response.json());
    expect(
      s.metrics.sum('estela_care_turned_away_total', { ...labels, reason: 'valve-shut' }),
    ).toBe(1);
    expect(s.metrics.sum('estela_care_calls_total', { ...labels, outcome: 'plan-b' })).toBe(2);

    await s.control.resume(LLM_BINDING);
    expect(s.metrics.lastGauge('estela_care_valves_shut')).toBe(0);

    const allowed = new Set(['edge', 'binding', 'outcome', 'class', 'reason']);
    for (const point of s.metrics.points) {
      for (const key of Object.keys(point.labels)) expect(allowed.has(key)).toBe(true);
    }
  });

  it('RS-43 RS-44: events, metrics and logs never carry the phone number, the message id, the text or the credential', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const s = await boot();
    await (await slowDownThenQuota(s)).response.json();
    // The forced shut is logged at warn (RS-45), so the log sink below is not empty.
    expect(warn.mock.calls.some(([line]) => String(line).includes('valve.forced-shut'))).toBe(true);
    await until('plan-b.used', () => s.types().includes('plan-b.used'));
    const sinks = JSON.stringify({
      events: s.events,
      metrics: s.metrics.points,
      logs: warn.mock.calls,
    });
    for (const secret of [
      CUSTOMER_PHONE,
      WAMID,
      CUSTOMER_TEXT,
      PROVIDER_KEY,
      'insufficient_quota',
    ]) {
      expect(sinks).not.toContain(secret);
    }
  });

  it('RS-11 RS-07: a Retry-After longer than what is left of patience.totalMs ends the turn at once with plan B', async () => {
    // The server wait itself is acceptable (maxServerWaitMs 60 s) but does not fit in totalMs 10 s.
    const s = await boot({ use: 'llm-turn', tries: { maxServerWaitMs: 60_000 } });
    provider.script.push(slowDown(30));
    const response = await s.deliver();
    expect(await response.json()).toMatchObject({
      result: { text: { body: HOLDING_TEXT }, degraded: true },
    });
    expect(provider.seen).toHaveLength(1);
    expect(s.clock.monotonic()).toBe(0);
    await until('patience.ran-out and plan-b.used', () => s.types().includes('plan-b.used'));
    expect(s.types()).toContain('patience.ran-out');
    expect(s.types()).not.toContain('try.again');
    expect(s.events.find((event) => event.type === 'plan-b.used')).toMatchObject({
      reason: 'out-of-time',
    });
    // 429 means "slow down", not "broken": the valve neither counts nor shuts on it (RS-17).
    expect(s.control.valveState(LLM_BINDING)).toEqual({ state: 'flowing' });
    expect((await s.store.get(`inbound:${TURN_CHANNEL}`, WAMID))?.status).not.toBe('completed');
  });
});
