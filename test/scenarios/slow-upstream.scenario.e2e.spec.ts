import 'reflect-metadata';

import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ChannelRegistry,
  CareControl,
  IntegrationFlow,
  IntegrationModule,
  JumpTimeoutError,
  OutOfTimeError,
  OutboundRestGateway,
  OutboundTimeoutError,
  ReplyGateway,
  type CareEvent,
  type CareLogger,
  type FlowDefinition,
  type IntegrationMessage,
  type OutboundRestBinding,
} from '../../src/index';
import { manualCareClock, type ManualCareClock } from '../../src/testing';

/**
 * Scenario "slow-upstream": a WhatsApp checkout whose card acquirer slows down.
 *
 * A real Nest app (testing module) calls a real loopback HTTP acquirer over the global fetch.
 * The acquirer never answers on its own: every request is held until the test answers it, so
 * a "latency spike" is a request the test has not answered yet. Care time runs on
 * `manualCareClock`, so every deadline fires exactly when the test moves the clock. Real time
 * is used only to wait, with a hard bound, for socket events the clock cannot drive.
 *
 * Requirement IDs refer to docs/ESTELA_RESILIENCE_SPEC.md.
 */

// ---------- A held, slow upstream ----------

interface HeldRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  /** True once the client closed the socket before any answer (an aborted fetch). */
  abandoned: boolean;
  answer(status: number, body: unknown): void;
}

interface SlowAcquirer {
  base: string;
  requests: HeldRequest[];
  /** Answers every held request, and every later one at once, so no socket outlives a test. */
  releaseAll(): void;
  /** Forgets the requests seen and holds new ones again. */
  reset(): void;
  close(): Promise<void>;
}

async function startSlowAcquirer(): Promise<SlowAcquirer> {
  const requests: HeldRequest[] = [];
  let released = false;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const held: HeldRequest = {
        path: (req.url ?? '').split('?')[0] ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') as unknown,
        abandoned: false,
        answer: (status, body) => {
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
      };
      res.on('close', () => {
        if (!res.writableEnded) held.abandoned = true;
      });
      requests.push(held);
      if (released) held.answer(503, { error: 'test teardown' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    releaseAll: () => {
      released = true;
      for (const held of requests) held.answer(503, { error: 'test teardown' });
    },
    reset: () => {
      released = false;
      requests.length = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Bounded real-time wait for something the manual clock cannot drive (socket I/O). */
async function until(what: string, check: () => boolean, boundMs = 2_000): Promise<void> {
  const giveUpAt = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`gave up after ${boundMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Real-time window in which `check` must stay true (used for "nothing else happens"). */
async function stays(what: string, check: () => boolean, windowMs = 100): Promise<void> {
  const endAt = Date.now() + windowMs;
  while (Date.now() < endAt) {
    if (!check()) throw new Error(`expected ${what} to hold for ${windowMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Settles a promise into a value, so a rejection is asserted after the clock moved. */
function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

// ---------- Domain: a WhatsApp order turned into a card authorization ----------

const wamid = 'wamid.HBgLNTAyMDAwMDAwMDEVAgASGBQzQUVCNEM3RjE2QjM0NUU4QTk5NgA=';

/** Shape of a WhatsApp Cloud API `order` message, as the webhook delivers it. */
const whatsappOrder = {
  messaging_product: 'whatsapp',
  from: '50200000001',
  id: wamid,
  timestamp: '1762790400',
  type: 'order',
  order: {
    catalog_id: '1180000000000001',
    product_items: [
      { product_retailer_id: 'SKU-COFFEE-1KG', quantity: 2, item_price: 79.5, currency: 'GTQ' },
      { product_retailer_id: 'SKU-MUG-STEEL', quantity: 1, item_price: 30.5, currency: 'GTQ' },
    ],
  },
};

interface AuthorizationRequest {
  merchantReference: string;
  amount: { value: number; currency: string };
  channel: 'whatsapp';
  payer: { msisdn: string };
}

function toAuthorization(payload: unknown): AuthorizationRequest {
  const message = payload as typeof whatsappOrder;
  const cents = message.order.product_items.reduce(
    (sum, item) => sum + Math.round(item.item_price * 100) * item.quantity,
    0,
  );
  return {
    merchantReference: message.id,
    amount: { value: cents, currency: message.order.product_items[0]?.currency ?? 'GTQ' },
    channel: 'whatsapp',
    payer: { msisdn: message.from },
  };
}

const approved = (id: string) => ({
  authorizationId: id,
  status: 'approved',
  responseCode: '00',
  amount: { value: 18_950, currency: 'GTQ' },
});

// ---------- Module wiring ----------

const quiet: CareLogger = {
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** The flow functions reach the gateway through this holder, filled after the module compiles. */
const wiring: { gateway?: OutboundRestGateway | undefined } = {};

function authorizeWith(binding: string) {
  return async (payload: unknown): Promise<unknown> => {
    if (wiring.gateway === undefined) throw new Error('gateway not wired');
    return wiring.gateway.request(binding, { payload });
  };
}

/** Nested flow: one outbound REST call per hop, its response is the reply. */
function acquirerFlow(
  binding: string,
  handleCare?: { patience: { totalMs: number } },
): FlowDefinition {
  return {
    name: 'acquirer-authorize',
    build: () =>
      IntegrationFlow.from('acquirer.authorize')
        .handle(authorizeWith(binding), {
          id: 'call-acquirer',
          ...(handleCare === undefined ? {} : { care: handleCare }),
        })
        .reply(),
  };
}

/** Checkout flow: WhatsApp order -> authorization -> jump into the nested acquirer flow. */
const checkoutFlow: FlowDefinition = {
  name: 'wa-checkout',
  build: () =>
    IntegrationFlow.from('wa.checkout')
      .transform(toAuthorization, { id: 'to-authorization' })
      .jumpTo(
        [
          {
            channel: 'acquirer.authorize',
            care: {
              patience: { eachTryMs: 500, totalMs: 900 },
              tries: { max: 3, idempotent: true, spacing: 100 },
            },
          },
        ],
        { id: 'authorize' },
      )
      .reply({ payload: 'jumpMerge' }),
};

interface Harness {
  app: INestApplication;
  clock: ManualCareClock;
  gateway: OutboundRestGateway;
  replies: ReplyGateway;
  registry: ChannelRegistry;
  errors: IntegrationMessage[];
  events: CareEvent[];
}

/**
 * `authorize` is the kind of the nested flow's channel: `direct` runs the hop inside the jump's
 * send; `queue` stands for an acquirer worker that takes one authorization at a time.
 */
async function boot(
  bindings: OutboundRestBinding[],
  flows: FlowDefinition[] = [],
  authorize: 'direct' | 'queue' = 'direct',
): Promise<Harness> {
  const clock = manualCareClock();
  const events: CareEvent[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        {
          channels: [
            { name: 'wa.checkout', type: 'direct' },
            { name: 'acquirer.authorize', type: authorize },
          ],
          logging: { banner: false },
          care: {
            clock,
            events: { channel: false, onEvent: (event) => events.push(event) },
            logger: quiet,
          },
          outbound: { rest: { bindings } },
        },
        flows,
      ),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  const gateway = app.get(OutboundRestGateway);
  wiring.gateway = gateway;
  const registry = app.get(ChannelRegistry);
  const errors: IntegrationMessage[] = [];
  registry.get('error.channel').subscribe((msg) => {
    errors.push(msg);
  });
  return { app, clock, gateway, replies: app.get(ReplyGateway), registry, errors, events };
}

const replyChannels = (registry: ChannelRegistry): string[] =>
  registry
    .list()
    .map((channel) => channel.name)
    .filter((name) => name.startsWith('reply.'));

describe('scenario: slow upstream (card acquirer behind a WhatsApp checkout)', () => {
  let acquirer: SlowAcquirer;
  let harness: Harness | undefined;

  beforeAll(async () => {
    acquirer = await startSlowAcquirer();
  });

  afterAll(async () => {
    await acquirer.close();
  });

  beforeEach(() => {
    acquirer.reset();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    acquirer.releaseAll();
    if (harness !== undefined) {
      // Let any try still waiting on the clock end before the app closes.
      await harness.clock.advance(60_000);
      await harness.app.close();
      harness = undefined;
    }
    wiring.gateway = undefined;
    jest.restoreAllMocks();
  });

  const binding = (name: string, extra: Partial<OutboundRestBinding>): OutboundRestBinding => ({
    name,
    url: `${acquirer.base}/v1/authorizations`,
    method: 'POST',
    ...extra,
  });

  it('RS-06: a latency spike past eachTryMs aborts the in-flight request at the socket, and the next try is answered', async () => {
    harness = await boot([
      binding('acquirer', {
        care: {
          patience: { eachTryMs: 300 },
          tries: { max: 3, idempotent: true, spacing: 50 },
        },
      }),
    ]);
    const { clock, gateway } = harness;
    const authorization = toAuthorization(whatsappOrder);
    const call = settle(gateway.request('acquirer', { payload: authorization }));

    await until('try 1 to reach the acquirer', () => acquirer.requests.length === 1);
    await clock.advance(299);
    expect(acquirer.requests[0]?.abandoned).toBe(false);

    await clock.advance(1);
    await until('try 1 socket to be aborted', () => acquirer.requests[0]?.abandoned === true);

    // The spacing gap: no new try before it ends.
    await clock.advance(49);
    await stays('one request only during the gap', () => acquirer.requests.length === 1, 50);
    await clock.advance(1);
    await until('try 2 to reach the acquirer', () => acquirer.requests.length === 2);
    acquirer.requests[1]?.answer(201, approved('auth_0002'));

    const outcome = await call;
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toMatchObject({
      status: 201,
      body: { authorizationId: 'auth_0002', status: 'approved' },
    });
    // Every try sends the same authorization, never a partial or re-built body.
    expect(acquirer.requests.map((held) => held.body)).toEqual([authorization, authorization]);
    expect(acquirer.requests.map((held) => held.abandoned)).toEqual([true, false]);
  });

  it('RS-07: no try outlives the remaining totalMs, the call fails with OutOfTimeError at the deadline, and the cut try is not counted by the valve', async () => {
    harness = await boot([
      binding('acquirer', {
        care: {
          patience: { eachTryMs: 1_000, totalMs: 1_500 },
          tries: { max: 5, idempotent: true, spacing: 200 },
          valve: { failPercent: 50, minCalls: 2, shutMs: 60_000 },
        },
      }),
    ]);
    const { clock, gateway, app } = harness;
    const call = settle(gateway.request('acquirer', { payload: toAuthorization(whatsappOrder) }));

    await until('try 1 to reach the acquirer', () => acquirer.requests.length === 1);
    await clock.advance(1_000);
    await until('try 1 socket to be aborted', () => acquirer.requests[0]?.abandoned === true);
    await clock.advance(200);
    await until('try 2 to reach the acquirer at t=1200', () => acquirer.requests.length === 2);

    // Try 2 may only wait the 300 ms left, not its own 1000 ms.
    await clock.advance(299);
    expect(acquirer.requests[1]?.abandoned).toBe(false);
    await clock.advance(1);
    await until(
      'try 2 socket to be aborted at t=1500',
      () => acquirer.requests[1]?.abandoned === true,
    );

    const outcome = await call;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(OutOfTimeError);
    expect((error as OutOfTimeError).binding).toBe('acquirer');
    expect((error as OutOfTimeError).tries).toBe(2);
    const cause = (error as OutOfTimeError).cause;
    expect(cause).toBeInstanceOf(OutboundTimeoutError);
    expect((cause as OutboundTimeoutError).timeoutMs).toBe(300);

    // Nothing starts after the deadline, however long the clock runs.
    await clock.advance(10_000);
    await stays('two requests in total', () => acquirer.requests.length === 2);
    // Try 1 failed on its own (counted); try 2 was cut by the deadline (not counted): 1 of 1 < minCalls.
    expect(app.get(CareControl).valveState('acquirer')?.state ?? 'flowing').toBe('flowing');
  });

  it('RS-62: a jumpTo try that outlives eachTryMs is tried again on a fresh reply channel, and the late reply of the earlier try is dropped', async () => {
    harness = await boot(
      [binding('acquirer', { care: { patience: { eachTryMs: 5_000 } } })],
      [checkoutFlow, acquirerFlow('acquirer')],
    );
    const { clock, replies, registry, errors } = harness;
    const baseline = replyChannels(registry);
    const reply = settle(
      replies.sendAndReceive('wa.checkout', whatsappOrder, { correlationId: wamid }, 5_000),
    );

    await until(
      'hop 1 of the nested flow to reach the acquirer',
      () => acquirer.requests.length === 1,
    );
    await clock.advance(500);
    await clock.advance(100);
    await until(
      'hop 2 of the nested flow to reach the acquirer',
      () => acquirer.requests.length === 2,
    );
    acquirer.requests[1]?.answer(201, approved('auth_0002'));

    const outcome = await reply;
    expect(outcome.ok).toBe(true);
    const merged = (outcome as { value: { jumpReplies: Record<string, unknown> } }).value;
    expect(merged).toMatchObject({
      merchantReference: wamid,
      amount: { value: 18_950, currency: 'GTQ' },
      jumpReplies: {
        'acquirer.authorize': { status: 201, body: { authorizationId: 'auth_0002' } },
      },
    });

    // The first hop's request is still open (the deadline does not cross a channel hop, RS-69):
    // its answer arrives late and must not reach the caller or any registered reply channel.
    expect(acquirer.requests[0]?.abandoned).toBe(false);
    const errorsBefore = errors.length;
    acquirer.requests[0]?.answer(201, approved('auth_0001'));
    await until('the late hop to finish', () => errors.length > errorsBefore);
    expect(JSON.stringify(errors.slice(errorsBefore))).not.toContain('auth_0001');
    expect(merged.jumpReplies['acquirer.authorize']).toMatchObject({
      body: { authorizationId: 'auth_0002' },
    });
    expect(replyChannels(registry)).toEqual(baseline);
  });

  it('RS-07 + RS-62: when totalMs runs out across jump tries the flow fails at the deadline, the last try waits only what is left, and no third hop starts', async () => {
    harness = await boot(
      [binding('acquirer', { care: { patience: { eachTryMs: 5_000 } } })],
      [checkoutFlow, acquirerFlow('acquirer')],
    );
    const { clock, replies, registry, errors } = harness;
    const baseline = replyChannels(registry);
    const reply = settle(
      replies.sendAndReceive('wa.checkout', whatsappOrder, { correlationId: wamid }, 5_000),
    );

    await until('hop 1 to reach the acquirer', () => acquirer.requests.length === 1);
    await clock.advance(600);
    await until('hop 2 to reach the acquirer at t=600', () => acquirer.requests.length === 2);
    await clock.advance(299);
    await stays('the flow to still wait at t=899', () => errors.length === 0, 30);
    await clock.advance(1);

    const outcome = await reply;
    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(OutOfTimeError);
    expect((error as OutOfTimeError).edge).toBe('flow-jump');
    expect((error as OutOfTimeError).tries).toBe(2);
    // The second try waited the remaining 300 ms, not its 500 ms eachTryMs.
    const cause = (error as OutOfTimeError).cause;
    expect(cause).toBeInstanceOf(JumpTimeoutError);
    expect((cause as JumpTimeoutError).timeoutMs).toBe(300);
    // Invariant 3: the awaited failure also reaches error.channel.
    expect(errors.length).toBeGreaterThanOrEqual(1);

    await clock.advance(10_000);
    await stays('no third hop after the deadline', () => acquirer.requests.length === 2);
    expect(replyChannels(registry)).toEqual(baseline);
  });

  it('RS-62: toward a queued acquirer worker, each jump try is timed on the care clock only, and the stale hop answered late is dropped', async () => {
    harness = await boot(
      [binding('acquirer', { care: { patience: { eachTryMs: 5_000 } } })],
      [checkoutFlow, acquirerFlow('acquirer')],
      'queue',
    );
    const { clock, replies, registry, events } = harness;
    const baseline = replyChannels(registry);
    const tryAgain = () => events.filter((event) => event.type === 'try.again');
    const reply = settle(
      replies.sendAndReceive('wa.checkout', whatsappOrder, { correlationId: wamid }, 5_000),
    );

    await until('hop 1 to reach the acquirer', () => acquirer.requests.length === 1);
    // The hop is already queued and the reply not in: standing still in real time for longer
    // than the 500 ms eachTryMs must not end try 1 while the care clock does not move.
    await stays(
      'try 1 to keep waiting while the care clock stands still',
      () => tryAgain().length === 0,
      600,
    );
    await clock.advance(500);
    expect(tryAgain()).toHaveLength(1);

    // Try 2 queues its hop behind the slow one: the worker takes one authorization at a time.
    await clock.advance(100);
    await stays('hop 2 to wait behind hop 1', () => acquirer.requests.length === 1, 50);

    // The slow answer to hop 1 arrives late: its reply channel is gone, so it is dropped, and the
    // worker moves on to hop 2.
    acquirer.requests[0]?.answer(201, approved('auth_0001'));
    await until('hop 2 to reach the acquirer', () => acquirer.requests.length === 2);
    acquirer.requests[1]?.answer(201, approved('auth_0002'));

    const outcome = await reply;
    expect(outcome.ok).toBe(true);
    expect((outcome as { value: unknown }).value).toMatchObject({
      merchantReference: wamid,
      jumpReplies: {
        'acquirer.authorize': { status: 201, body: { authorizationId: 'auth_0002' } },
      },
    });
    expect(tryAgain()).toHaveLength(1);
    expect(replyChannels(registry)).toEqual(baseline);
  });

  it('RS-69: an outbound call made inside a handle step is capped by the step totalMs, and its socket is aborted at that deadline', async () => {
    harness = await boot(
      [
        binding('acquirer', {
          care: {
            patience: { eachTryMs: 2_000 },
            tries: { max: 3, idempotent: true, spacing: 600 },
          },
        }),
      ],
      [acquirerFlow('acquirer', { patience: { totalMs: 400 } })],
    );
    const { clock, replies } = harness;
    const reply = settle(
      replies.sendAndReceive('acquirer.authorize', toAuthorization(whatsappOrder), {}, 5_000),
    );

    await until('the call to reach the acquirer', () => acquirer.requests.length === 1);
    await clock.advance(399);
    expect(acquirer.requests[0]?.abandoned).toBe(false);
    await clock.advance(1);
    // Without the cap the request would stay open until the binding's own 2000 ms.
    await until(
      'the socket to be aborted at the step deadline',
      () => acquirer.requests[0]?.abandoned === true,
    );

    const outcome = await reply;
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: unknown }).error).toBeInstanceOf(OutOfTimeError);

    // The capped call starts no extra try past the step deadline.
    await clock.advance(10_000);
    await stays('one request in total', () => acquirer.requests.length === 1);
  });

  it('RS-69 (control): a binding with no care keeps its 0.9.0 timeoutMs inside a capped step', async () => {
    harness = await boot(
      [binding('acquirer-legacy', { timeoutMs: 30_000 })],
      [acquirerFlow('acquirer-legacy', { patience: { totalMs: 400 } })],
    );
    const { clock, replies } = harness;
    const reply = settle(
      replies.sendAndReceive('acquirer.authorize', toAuthorization(whatsappOrder), {}, 5_000),
    );

    await until('the call to reach the acquirer', () => acquirer.requests.length === 1);
    await clock.advance(400);
    const outcome = await reply;
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: unknown }).error).toBeInstanceOf(OutOfTimeError);
    // The step gave up, but the 0.9.0 call keeps its own timer: its socket stays open.
    await stays('the legacy request to stay open', () => acquirer.requests[0]?.abandoned === false);
  });
});
