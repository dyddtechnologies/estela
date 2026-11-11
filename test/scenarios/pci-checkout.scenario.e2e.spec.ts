import 'reflect-metadata';

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Body,
  Catch,
  Controller,
  HttpException,
  Injectable,
  Logger,
  Module,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ChannelRegistry,
  HopLogger,
  InboundRest,
  IntegrationFlow,
  IntegrationModule,
  MemoryIdempotencyLedger,
  OutboundHttpError,
  OutboundRestGateway,
  Pack,
  PRIVACY_FINDING_CODES,
  PrivacyConfigError,
  PrivacyEngine,
  Reach,
  Remember,
  SagaRunner,
  ServiceActivator,
  Show,
  TrailOutput,
  saga,
  type CareEvent,
  type FingerprintSecretProvider,
  type FlowDefinition,
  type IntegrationMessage,
  type OutboundRestError,
  type PrivacyModuleOptions,
  type SealKey,
  type SealKeyProvider,
} from '../../src/index';
import { captureTrail, expectNoLeak, MemoryIdempotencyStore } from '../../src/testing';

/**
 * Scenario "pci-checkout": a card checkout that charges through an outbound REST acquirer.
 *
 * A real Nest app listens on loopback and is called over HTTP. The flow prices the order, taps an
 * audit copy and hands the charge to a PSP activator, which calls a loopback acquirer through
 * `OutboundRestGateway` with care (tries, valve, plan B). The acquirer is scripted per order: it
 * fails, declines (echoing the card, as legacy acquirers do) or approves.
 *
 * The business path must see the real card; everything Estela writes about it (Nest logs, the
 * error channel, care events, the wire-tap copy, the graph endpoint, idempotency records, the saga
 * ledger and the trail copies of outbound errors) shows at most the last four digits, never CVV,
 * PIN block, track data or expiry. All card numbers are public test PANs.
 *
 * Requirement IDs refer to docs/ESTELA_SENSITIVE_DATA_SPEC.md.
 */

// ---------- Card data (public test PANs) ----------

const ONLINE_PAN = '4111111111111111';
const DECLINED_PAN = '5555555555554444';
const DECLINED_PAN_GROUPED = '5555 5555 5555 4444';
const KIOSK_PAN = '4000056655665556';
const OUTAGE_PAN = '4012888888881881';
const REFUND_PAN = '4532015112830366';
const EXPIRY = '12/29';
const CVV = '737';
const PIN_BLOCK = '04A1B2C3D4E5F607';
const TRACK2 = `;${DECLINED_PAN}=29121011000012345678?`;
/** Order ids are 16 digits with a Visa prefix that fail Luhn: they must never be touched. */
const ORDER_ONLINE = '4000202611090007';
const ORDER_DECLINED = '4920117311090005';
const ORDER_OUTAGE = ['4000202611090015', '4000202611090023', '4000202611090031'] as const;
const EMAIL = 'ana.lucia.mendez@example.com';
const ACQUIRER_API_KEY = 'acq-live-7f3c9a1e5b2d4086';
const IDEM_ONLINE = 'chk-2026-11-11-online-0001';
const IDEM_DECLINED = 'chk-2026-11-11-declined-0002';

const ALL_SECRETS = [
  ONLINE_PAN,
  DECLINED_PAN,
  DECLINED_PAN_GROUPED,
  KIOSK_PAN,
  OUTAGE_PAN,
  REFUND_PAN,
  PIN_BLOCK,
  TRACK2,
  EMAIL,
  ACQUIRER_API_KEY,
  IDEM_ONLINE,
  IDEM_DECLINED,
];

interface Card {
  pan: string;
  expiry: string;
  cvv?: string;
  pinBlock?: string;
  track2?: string;
}

interface CheckoutOrder {
  orderId: string;
  customer: { email: string };
  items: { sku: string; quantity: number; unitPrice: number }[];
  currency: string;
  card: Card;
}

const onlineOrder = (orderId: string, pan: string): CheckoutOrder => ({
  orderId,
  customer: { email: EMAIL },
  items: [
    { sku: 'SKU-COFFEE-1KG', quantity: 2, unitPrice: 79.5 },
    { sku: 'SKU-MUG-STEEL', quantity: 1, unitPrice: 30.5 },
  ],
  currency: 'GTQ',
  card: { pan, expiry: EXPIRY, cvv: CVV },
});

/** An unattended kiosk reads the stripe and the PIN pad: track data and a PIN block, no CVV. */
const kioskOrder = (orderId: string, pan: string, track2: string): CheckoutOrder => ({
  orderId,
  customer: { email: EMAIL },
  items: [{ sku: 'SKU-TICKET-ADULT', quantity: 3, unitPrice: 45 }],
  currency: 'GTQ',
  card: { pan, expiry: EXPIRY, pinBlock: PIN_BLOCK, track2 },
});

// ---------- A scripted loopback acquirer ----------

interface AcquirerRequest {
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: { orderId?: string; card?: Card; refundId?: string } & Record<string, unknown>;
}

interface Answer {
  status: number;
  body: unknown;
}

interface Acquirer {
  base: string;
  requests: AcquirerRequest[];
  /** Answers per order id, consumed in order; the last one repeats. */
  script: Map<string, Answer[]>;
  close(): Promise<void>;
}

const approvedCharge = (orderId: string, pan: string): Answer => ({
  status: 201,
  body: {
    chargeId: `ch_${orderId.slice(-4)}`,
    status: 'approved',
    authCode: '0A1B2C',
    orderId,
    card: { brand: pan.startsWith('4') ? 'visa' : 'mastercard', last4: pan.slice(-4) },
  },
});

async function startAcquirer(): Promise<Acquirer> {
  const requests: AcquirerRequest[] = [];
  const script = new Map<string, Answer[]>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const [path = '', query = ''] = (req.url ?? '').split('?');
      const body = JSON.parse(
        Buffer.concat(chunks).toString('utf8') || '{}',
      ) as AcquirerRequest['body'];
      requests.push({ path, query, headers: req.headers, body });
      const key = body.orderId ?? body.refundId ?? '';
      const answers = script.get(key) ?? [];
      const answer =
        answers.length > 1
          ? answers.shift()!
          : (answers[0] ?? approvedCharge(key, body.card?.pan ?? '0000000000000000'));
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    script,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------- App wiring ----------

/** The app's own decline error: its message and `acquirerResponse` carry what the acquirer sent. */
class CardDeclinedError extends Error {
  override readonly name = 'CardDeclinedError';
  readonly code = 'card_declined';

  constructor(
    message: string,
    readonly acquirerResponse: unknown,
  ) {
    super(message);
  }
}

/** Turns an acquirer 402 into the app's decline; everything else is thrown as Estela built it. */
function mapAcquirerError(error: OutboundRestError | Error): unknown {
  if (error instanceof OutboundHttpError && error.status === 402) {
    const body = error.body as { error: { message: string } };
    return new CardDeclinedError(`charge declined by acquirer: ${body.error.message}`, error.body);
  }
  return error;
}

const handled: CheckoutOrder[] = [];
const filterSaw: unknown[] = [];

@Injectable()
class Psp {
  constructor(private readonly gateway: OutboundRestGateway) {}

  @ServiceActivator('psp.charges')
  async charge(order: CheckoutOrder & { amount: number }): Promise<unknown> {
    handled.push(order);
    const response = await this.gateway.request<{ body: Record<string, unknown> }>('acquirer', {
      payload: {
        orderId: order.orderId,
        amount: order.amount,
        currency: order.currency,
        card: order.card,
      },
    });
    if ((response as { planB?: unknown }).planB === true) return response;
    // The merchant vault tokenizes the card from the reply, so the reply carries it.
    return { orderId: order.orderId, charge: response.body, card: order.card };
  }
}

@Controller()
class Checkout {
  @Post('checkout')
  @InboundRest({
    channel: 'checkout.pay',
    requestReply: true,
    timeoutMs: 5_000,
    idempotency: { onDuplicate: 'replay', remember: Remember.Sealed },
  })
  pay(@Body() body: unknown): unknown {
    return body;
  }
}

/** README guidance (Outside the trail): an app filter logs `errorForTrail`, never the raw error. */
@Catch()
class TrailExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('CheckoutExceptions');

  constructor(private readonly privacy: PrivacyEngine) {}

  catch(error: unknown, host: ArgumentsHost): void {
    filterSaw.push(error);
    const status = error instanceof HttpException ? error.getStatus() : 502;
    // The endpoint's channel brings the card profile to the app's own log line.
    this.logger.error(
      this.privacy.errorForTrail(error, { output: TrailOutput.Log, channel: 'checkout.pay' }),
    );
    host
      .switchToHttp()
      .getResponse<{ status(code: number): { json(body: unknown): void } }>()
      .status(status)
      .json({ statusCode: status, error: 'payment failed' });
  }
}

const price = (order: unknown): unknown => {
  const o = order as CheckoutOrder;
  const amount = o.items.reduce((sum, item) => sum + item.quantity * item.unitPrice * 100, 0);
  return { ...o, amount };
};

const checkoutFlow: FlowDefinition = {
  name: 'checkout',
  build: () =>
    // Flow level: the card profile shapes every step's trail, the audit tap channel included.
    IntegrationFlow.from('checkout.pay', { privacy: 'card' })
      .handle(price, { id: 'price' })
      .wireTap('checkout.audit', { id: 'audit' })
      .to('psp.charges', { id: 'charge' }),
};

const cardProfile = {
  packs: [Pack.PersonalV1],
  fields: [
    { path: '**.pan', name: 'card.pan', show: Show.Ends, showLast: 4 },
    { path: '**.cvv', name: 'card.cvv', show: Show.Omitted },
    { path: '**.expiry', name: 'card.expiry' },
    { path: '**.pinBlock', name: 'card.pin' },
    { path: '**.track2', name: 'card.track' },
  ],
};

const fingerprintSecret: FingerprintSecretProvider = {
  current: () => Promise.resolve({ id: 'fp1', secret: new Uint8Array(32).fill(7) }),
};
const sealKey: SealKey = { id: 'kms-1', key: new Uint8Array(32).fill(9) };
const sealKeys: SealKeyProvider = {
  current: () => Promise.resolve(sealKey),
  byId: (id: string) => Promise.resolve(id === sealKey.id ? sealKey : undefined),
};

const privacy: PrivacyModuleOptions = {
  packs: [Pack.SecretsV1],
  fingerprintSecret,
  sealKeys,
  profiles: { card: cardProfile },
};

// ---------- Helpers ----------

/** Bounded real-time wait for socket and dispatch events. */
async function until(what: string, check: () => boolean, boundMs = 3_000): Promise<void> {
  const giveUpAt = Date.now() + boundMs;
  while (!check()) {
    if (Date.now() > giveUpAt) throw new Error(`gave up after ${boundMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const capture = captureTrail();
const events: CareEvent[] = [];

function writesSince(mark: number, output?: TrailOutput): { where: string; text: string }[] {
  return capture.writes
    .slice(mark)
    .filter((write) => output === undefined || write.output === output);
}

/** CVV and expiry are too short for `expectNoLeak` (8+ chars): check the keys and the value. */
function expectNoShortCardData(texts: readonly string[]): void {
  for (const text of texts) {
    expect(text).not.toMatch(/"cvv"\s*:/i);
    expect(text).not.toContain(EXPIRY);
    expect(text).not.toContain(EXPIRY.replace('/', '\\/'));
  }
}

describe('scenario: PCI checkout (card data stays out of the trail)', () => {
  let acquirer: Acquirer;
  let app: INestApplication;
  let url: string;
  let registry: ChannelRegistry;

  beforeAll(async () => {
    acquirer = await startAcquirer();
    Logger.overrideLogger(capture.logger);

    @Module({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: 'checkout.pay', type: 'direct', privacy: 'card' },
              { name: 'psp.charges', type: 'direct', privacy: 'card' },
              { name: 'checkout.audit', type: 'pubsub' },
            ],
            idempotency: { store: capture.store(new MemoryIdempotencyStore()) },
            logging: { hops: true, level: 'debug', banner: false },
            care: { events: { onEvent: (event) => events.push(event) } },
            privacy,
            outbound: {
              rest: {
                bindings: [
                  {
                    name: 'acquirer',
                    url: `${acquirer.base}/v1/charges?api_key=${ACQUIRER_API_KEY}`,
                    method: 'POST',
                    idempotency: {
                      key: ({ payload }) => ['charge', (payload as { orderId: string }).orderId],
                    },
                    mapError: mapAcquirerError,
                    care: {
                      patience: { eachTryMs: 2_000, totalMs: 5_000 },
                      tries: { max: 3, spacing: 0, requireIdempotencyKey: true },
                      valve: {
                        failPercent: 50,
                        minCalls: 4,
                        lookBack: { lastCalls: 10 },
                        shutMs: 60_000,
                      },
                      planB: {
                        value: (_error, ctx) => ({
                          planB: true,
                          status: 'pending-review',
                          binding: ctx.binding,
                        }),
                      },
                    },
                  },
                  {
                    name: 'acquirer-refunds',
                    url: `${acquirer.base}/v1/refunds?api_key=${ACQUIRER_API_KEY}`,
                    method: 'POST',
                  },
                ],
              },
            },
          },
          [checkoutFlow],
        ),
      ],
      controllers: [Checkout],
      providers: [Psp],
    })
    class CheckoutAppModule {}

    const moduleRef = await Test.createTestingModule({ imports: [CheckoutAppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: capture.logger });
    app.useGlobalFilters(new TrailExceptionFilter(app.get(PrivacyEngine)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    registry = app.get(ChannelRegistry);
    capture.channel(registry, 'error.channel');
    capture.channel(registry, 'checkout.audit');
    capture.channel(registry, 'estela.care.events');
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    await acquirer?.close();
  });

  const checkout = async (
    order: CheckoutOrder,
    key: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${url}/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(order),
    });
    return { status: response.status, body: await response.json() };
  };

  const chargesFor = (orderId: string): AcquirerRequest[] =>
    acquirer.requests.filter((r) => r.path === '/v1/charges' && r.body.orderId === orderId);

  it('SD-02: a charge tried again after an acquirer 503 reaches the handler, the acquirer and the caller with the full card', async () => {
    acquirer.script.set(ORDER_ONLINE, [
      { status: 503, body: { error: 'acquirer busy' } },
      approvedCharge(ORDER_ONLINE, ONLINE_PAN),
    ]);
    const order = onlineOrder(ORDER_ONLINE, ONLINE_PAN);

    const response = await checkout(order, IDEM_ONLINE);

    expect(response.status).toBe(201);
    expect(handled.at(-1)?.card).toEqual(order.card);
    const tries = chargesFor(ORDER_ONLINE);
    expect(tries).toHaveLength(2);
    for (const request of tries) {
      expect(request.body.card).toEqual(order.card);
      expect(request.query).toBe(`api_key=${ACQUIRER_API_KEY}`);
    }
    // Both tries carry the same stable key, built from the order id.
    expect(tries[0]?.headers['idempotency-key']).toBe(tries[1]?.headers['idempotency-key']);
    expect(JSON.stringify(response.body)).toContain(ONLINE_PAN);
    expect(JSON.stringify(response.body)).toContain(CVV);
    expect(events.some((e) => e.type === 'try.again' && e.binding === 'acquirer')).toBe(true);
  });

  it('SD-28 + SD-52: the audit wire tap receives the order as the trail shows it: last four digits, no CVV, hidden expiry', () => {
    const taps = capture.writes.filter((w) => w.where === 'channel checkout.audit');
    expect(taps).toHaveLength(1);
    const copy = JSON.parse(taps[0]!.text) as { payload: Record<string, unknown> };
    expect(copy.payload).toMatchObject({
      orderId: ORDER_ONLINE,
      amount: 18_950,
      card: { pan: '***1111', expiry: '[HIDDEN:card.expiry]' },
    });
    expect(copy.payload.card).not.toHaveProperty('cvv');
    expect((copy.payload.customer as { email: string }).email).toMatch(/^fp:fp1:[0-9a-f]{16}$/);
    expectNoLeak(capture, [ONLINE_PAN, EMAIL]);
  });

  it('SD-31: the inbound record is sealed, and a duplicate checkout replays the real reply without charging again', async () => {
    const records = capture.writes.filter((w) => w.output === TrailOutput.Store);
    expect(records.some((w) => w.text.includes('estelaSealed'))).toBe(true);
    for (const record of records) expect(record.text).not.toContain('"pan"');
    const chargesBefore = chargesFor(ORDER_ONLINE).length;
    const handledBefore = handled.length;

    const replay = await checkout(onlineOrder(ORDER_ONLINE, ONLINE_PAN), IDEM_ONLINE);

    expect(replay.status).toBe(201);
    expect(JSON.stringify(replay.body)).toContain(ONLINE_PAN);
    expect(chargesFor(ORDER_ONLINE)).toHaveLength(chargesBefore);
    expect(handled).toHaveLength(handledBefore);
    expectNoLeak(capture, [ONLINE_PAN, IDEM_ONLINE, ACQUIRER_API_KEY]);
  });

  it('SD-11 + SD-04: a declined card whose acquirer message holds the PAN in free text is cut to the last four digits on the error channel, in logs and in records', async () => {
    acquirer.script.set(ORDER_DECLINED, [
      {
        status: 402,
        body: {
          error: {
            code: 'do_not_honor',
            message: `Do not honor: card ${DECLINED_PAN_GROUPED} declined for order ${ORDER_DECLINED}`,
          },
          // A legacy acquirer echoes the card it was sent.
          request: {
            card: { pan: DECLINED_PAN, expiry: EXPIRY, pinBlock: PIN_BLOCK, track2: TRACK2 },
          },
        },
      },
    ]);
    const mark = capture.writes.length;
    const seenBefore = filterSaw.length;

    const response = await checkout(
      kioskOrder(ORDER_DECLINED, DECLINED_PAN, TRACK2),
      IDEM_DECLINED,
    );
    await until(
      'the decline to reach the error channel',
      () => writesSince(mark, TrailOutput.ErrorEnvelope).length > 0,
    );

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ statusCode: 502, error: 'payment failed' });
    // A rejected failure is not tried again (classification: 4xx).
    expect(chargesFor(ORDER_DECLINED)).toHaveLength(1);
    expect(chargesFor(ORDER_DECLINED)[0]?.body.card).toMatchObject({
      pan: DECLINED_PAN,
      pinBlock: PIN_BLOCK,
      track2: TRACK2,
    });
    // The app's own code still gets the unchanged error (SD-02).
    const raw = filterSaw.slice(seenBefore);
    expect(raw.length).toBeGreaterThanOrEqual(1);
    expect(raw.some((e) => e instanceof Error && e.message.includes(DECLINED_PAN_GROUPED))).toBe(
      true,
    );

    const envelopes = writesSince(mark, TrailOutput.ErrorEnvelope);
    const declineEnvelope = envelopes.find((w) => w.text.includes('CardDeclinedError'));
    expect(declineEnvelope).toBeDefined();
    expect(declineEnvelope!.text).toContain('***4444');
    expect(declineEnvelope!.text).toContain(ORDER_DECLINED);
    // Wherever the decline's own properties are written, the echoed card is hidden field by field.
    const withEcho = writesSince(mark).filter((w) => w.text.includes('acquirerResponse'));
    expect(withEcho.length).toBeGreaterThanOrEqual(1);
    for (const write of withEcho) {
      expect(write.text).toContain('[HIDDEN:card.pin]');
      expect(write.text).toContain('[HIDDEN:card.track]');
      expect(write.text).toContain('[HIDDEN:card.expiry]');
    }

    const logs = writesSince(mark, TrailOutput.Log);
    const declineLogs = logs.filter((w) => w.text.includes('charge declined by acquirer'));
    expect(declineLogs.length).toBeGreaterThanOrEqual(1);
    for (const line of declineLogs) {
      expect(line.text).toContain('***4444');
      expect(line.text).toContain(ORDER_DECLINED);
    }

    expectNoShortCardData(writesSince(mark).map((w) => w.text));
    expectNoLeak(capture, [DECLINED_PAN, DECLINED_PAN_GROUPED, PIN_BLOCK, TRACK2, IDEM_DECLINED]);
  });

  it('SD-24: Luhn-invalid 16-digit order ids are never hidden, in the tap copy, envelopes or logs', () => {
    const texts = capture.writes.map((w) => w.text);
    expect(texts.some((t) => t.includes(ORDER_ONLINE))).toBe(true);
    expect(texts.some((t) => t.includes(ORDER_DECLINED))).toBe(true);
    for (const text of texts) {
      // No order id was turned into a "***dddd" token by the card rule.
      expect(text).not.toContain(`***${ORDER_ONLINE.slice(-4)}`);
      expect(text).not.toContain(`***${ORDER_DECLINED.slice(-4)}`);
    }
  });

  it('SD-33 + SD-63: a refund saga resolves the card profile through the engine; its ledger row and error lines keep only the last four digits', async () => {
    const engine = app.get(PrivacyEngine);
    const gateway = app.get(OutboundRestGateway);
    const ledger = capture.ledger(new MemoryIdempotencyLedger<null>());
    const runner = new SagaRunner<null>({
      transactions: { run: (work) => work(null) },
      ledger,
      logger: new HopLogger('debug', engine),
      privacy: { engine, rules: 'card', remember: Remember.AsShown },
    });
    interface RefundCtx {
      refundId: string;
      card: Card;
      acquirer?: unknown;
    }
    const refund = saga<RefundCtx, null, unknown>('refund')
      .idempotent((ctx) => ctx.refundId)
      .outbound('acquirer-refund', async (ctx) => {
        ctx.acquirer = await gateway.request('acquirer-refunds', {
          payload: { refundId: ctx.refundId, card: ctx.card, amount: 4_500 },
        });
      })
      .transaction('book', (_ctx, _tx, unit) => {
        unit.afterCommit(() => {
          throw new Error(`receipt mail for card ${REFUND_PAN} bounced`);
        });
      })
      .reply((ctx) => ({ refundId: ctx.refundId, card: ctx.card }));
    const mark = capture.writes.length;
    const ctx = (): RefundCtx => ({
      refundId: 'rf_20261111_0001',
      card: { pan: REFUND_PAN, expiry: EXPIRY, cvv: CVV },
    });

    const first = await runner.run(refund, ctx());
    const again = await runner.run(refund, ctx());
    await until('the afterCommit error line', () =>
      writesSince(mark, TrailOutput.Log).some((w) => w.text.includes('bounced')),
    );

    expect(first).toEqual({ refundId: 'rf_20261111_0001', card: ctx().card });
    const refunds = acquirer.requests.filter((r) => r.path === '/v1/refunds');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.body.card).toEqual(ctx().card);
    // Remember.AsShown replays the reply as the trail shows it.
    expect(again).toMatchObject({ card: { pan: '***0366', expiry: '[HIDDEN:card.expiry]' } });

    const rows = writesSince(mark, TrailOutput.Ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain('***0366');
    const lines = writesSince(mark, TrailOutput.Log).filter((w) => w.text.includes('bounced'));
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(line.text).toContain('***0366');
    expectNoShortCardData(writesSince(mark).map((w) => w.text));
    expectNoLeak(capture, [REFUND_PAN, ACQUIRER_API_KEY]);
  });

  it('SD-59: the graph endpoint shows channel and flow names, never card data or the acquirer key', async () => {
    const response = await fetch(`${url}/integration/graph`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('checkout.pay');
    expect(text).toContain('psp.charges');
    for (const secret of ALL_SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('api_key=');
  });

  it('SD-62: with the acquirer down, tries run out, the valve shuts and plan B answers; care events and logs carry no card data', async () => {
    for (const orderId of ORDER_OUTAGE) {
      acquirer.script.set(orderId, [{ status: 503, body: { error: 'acquirer down', orderId } }]);
    }
    const mark = capture.writes.length;
    const eventMark = events.length;

    const replies = [];
    for (const [index, orderId] of ORDER_OUTAGE.entries()) {
      replies.push(await checkout(onlineOrder(orderId, OUTAGE_PAN), `chk-outage-${index}-000001`));
    }

    for (const reply of replies) {
      expect(reply.status).toBe(201);
      expect(JSON.stringify(reply.body)).toContain('pending-review');
    }
    // The valve has judged the online charge (503, 201); the decline is rejected and not counted.
    // Two more 503s make 3 failures of 4 calls (>= 50%, minCalls 4): the valve shuts before the
    // third try of the first outage order, and the next orders never reach the acquirer.
    expect(chargesFor(ORDER_OUTAGE[0])).toHaveLength(2);
    expect(chargesFor(ORDER_OUTAGE[1])).toHaveLength(0);
    expect(chargesFor(ORDER_OUTAGE[2])).toHaveLength(0);
    const types = events.slice(eventMark).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['try.again', 'valve.shut', 'plan-b.used']));

    const careCopies = writesSince(mark).filter((w) => w.where === 'channel estela.care.events');
    expect(careCopies.length).toBeGreaterThan(0);
    for (const copy of careCopies) {
      expect(copy.text).not.toContain('pending-review');
      expect(copy.text).not.toContain('"card"');
    }
    expectNoShortCardData(writesSince(mark).map((w) => w.text));
    expectNoLeak(capture, [OUTAGE_PAN, EMAIL, ACQUIRER_API_KEY]);
  });

  it('SD-27: across the whole checkout no trail output holds a PAN, PIN block, track data, the customer email, idempotency keys or the acquirer key', () => {
    const outputs = new Set(capture.writes.map((w) => w.output));
    expect([...outputs].sort()).toEqual(['error-envelope', 'ledger', 'log', 'store', 'wiretap']);
    expectNoShortCardData(capture.writes.map((w) => w.text));
    expectNoLeak(capture, ALL_SECRETS);
  });
});

describe('scenario: PCI checkout receipt step (delivery reach)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('SD-50 + SD-47: the receipt step hides the card in the e-mailed receipt itself, with its reason logged at boot', async () => {
    const warns: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => warns.push(String(message)) as never);
    const toReceipt = (order: unknown): unknown => {
      const o = order as CheckoutOrder & { amount: number };
      return { orderId: o.orderId, amount: o.amount, card: o.card };
    };
    const receiptFlow: FlowDefinition = {
      name: 'receipt',
      build: () =>
        IntegrationFlow.from('checkout.receipt', { privacy: 'card' })
          .handle(price, { id: 'price' })
          .transform(toReceipt, {
            id: 'receipt',
            privacy: {
              use: 'card',
              reach: Reach.Delivery,
              reachReason: 'the e-mailed receipt shows the last four digits only',
            },
          })
          .to('receipt.email', { id: 'email' }),
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: 'checkout.receipt', type: 'direct', privacy: 'card' },
              { name: 'receipt.email', type: 'pubsub' },
            ],
            logging: { banner: false },
            privacy,
          },
          [receiptFlow],
        ),
      ],
    }).compile();
    const receiptApp = moduleRef.createNestApplication({ logger: false });
    await receiptApp.init();
    const emailed: unknown[] = [];
    receiptApp
      .get(ChannelRegistry)
      .get('receipt.email')
      .subscribe((message: IntegrationMessage) => {
        emailed.push(message.payload);
      });
    const order = onlineOrder(ORDER_ONLINE, ONLINE_PAN);
    await receiptApp.get(ChannelRegistry).send('checkout.receipt', order);
    await receiptApp.close();

    expect(emailed).toEqual([
      {
        orderId: ORDER_ONLINE,
        amount: 18_950,
        card: { pan: '***1111', expiry: '[HIDDEN:card.expiry]' },
      },
    ]);
    // The order the flow carried is untouched: only the receipt copy is hidden.
    expect(order.card).toEqual({ pan: ONLINE_PAN, expiry: EXPIRY, cvv: CVV });
    expect(
      warns.some(
        (line) =>
          line.includes('privacy delivery-reach') &&
          line.includes('the e-mailed receipt shows the last four digits only'),
      ),
    ).toBe(true);
  });

  it('SD-50: Reach.Delivery with a reason written on the receipt channel fails boot with DELIVERY_REACH_LEVEL (flow steps only)', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const receiptFlow: FlowDefinition = {
      name: 'receipt',
      build: () =>
        IntegrationFlow.from('checkout.receipt').transform((order) => order, { id: 'receipt' }),
    };
    const boot = Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              {
                name: 'checkout.receipt',
                type: 'direct',
                privacy: {
                  use: 'card',
                  reach: Reach.Delivery,
                  reachReason: 'the e-mailed receipt shows the last four digits only',
                },
              },
            ],
            logging: { banner: false },
            privacy,
          },
          [receiptFlow],
        ),
      ],
    })
      .compile()
      .then((moduleRef) => moduleRef.createNestApplication({ logger: false }).init());

    const error = await boot.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PrivacyConfigError);
    const findings = (error as PrivacyConfigError).findings;
    expect(findings.map((f) => f.code)).toContain(PRIVACY_FINDING_CODES.DELIVERY_REACH_LEVEL);
  });
});
