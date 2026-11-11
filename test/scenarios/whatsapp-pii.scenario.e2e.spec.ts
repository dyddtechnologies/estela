import 'reflect-metadata';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body,
  Catch,
  Controller,
  Headers,
  HttpException,
  Injectable,
  Logger,
  Post,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ChannelRegistry,
  InboundRest,
  IntegrationFlow,
  IntegrationModule,
  Pack,
  PrivacyEngine,
  Reach,
  Remember,
  SEALED_RECORD_KEY,
  ServiceActivator,
  Show,
  TrailOutput,
  type FingerprintSecret,
  type FingerprintSecretProvider,
  type IdempotencyRecord,
  type IdempotencyStore,
  type IntegrationMessage,
  type SealKey,
  type SealKeyProvider,
} from '../../src/index';
import {
  MemoryIdempotencyStore,
  captureTrail,
  expectNoLeak,
  type TrailCapture,
} from '../../src/testing';

/**
 * Scenario "whatsapp-pii": a WhatsApp inbound webhook the way Koletz receives it (D-PHONE).
 *
 * Real Nest app on a loopback socket. The carrier posts a Twilio-style form
 * (`application/x-www-form-urlencoded`) signed with `X-Twilio-Signature`; the endpoint
 * (`@InboundRest`, request/reply) is gated by `MessageSid` and remembers its replies sealed
 * (`Remember.Sealed`) in a store that round-trips records through JSON, like Redis. A flow taps
 * an audit copy, feeds conversation analytics a copy hidden on delivery (the target's
 * `Reach.Delivery`), and hands the turn to an assistant activator that verifies the signature.
 *
 * What the trail may show of each field is the product decision under test:
 * - customer number (`From`, `WaId`): a keyed fingerprint, stable per number and per secret id;
 * - business sender number (`To`): its last digits, through an exemption with a reason;
 * - message text (`Body`): its length only; media URLs and location: hidden;
 * - a Guatemalan DPI (CUI) typed in free text: caught by an app pattern wherever it lands;
 * - `X-Twilio-Signature`: hidden like any credential header;
 * - `MessageSid`: shown as it is, through an exemption with a reason (opaque carrier id);
 *   every other Twilio SID (account, media) stays hidden by the app's `twilio.sid` pattern.
 *
 * Every secret below is a fixture derived from a fixed label: the run is deterministic.
 */

// ---------- Deterministic key material (fixtures, not real secrets) ----------

const derive = (label: string): Buffer =>
  createHash('sha256').update(`whatsapp-pii scenario ${label}`).digest();

const FP_K1: FingerprintSecret = { id: 'wa-fp-1', secret: derive('fingerprint 1') };
const FP_K2: FingerprintSecret = { id: 'wa-fp-2', secret: derive('fingerprint 2') };
const SEAL_K1: SealKey = { id: 'kms-2026-10', key: derive('seal 1') };
const SEAL_K2: SealKey = { id: 'kms-2026-11', key: derive('seal 2') };

/** The carrier account's auth token: only the signature derived from it travels. */
const CARRIER_AUTH_TOKEN = derive('carrier auth token').toString('hex').slice(0, 32);
/** The public URL the carrier signs (the app sits behind a proxy; the loopback URL differs). */
const PUBLIC_WEBHOOK_URL = 'https://channels.example.test/webhooks/twilio/whatsapp';

// ---------- Realistic payloads ----------

// Built at run time so no SID-shaped literal sits in the source (secret scanners flag one).
const ACCOUNT_SID = `AC${'5ca1ab1e'.repeat(4)}`;
const BUSINESS_NUMBER = 'whatsapp:+14155238886';
const CUSTOMER = { from: 'whatsapp:+50255501234', waId: '50255501234', name: 'Ana Lucía Pérez' };
const OTHER_CUSTOMER = { from: 'whatsapp:+50241128877', waId: '50241128877', name: 'Jorge Ixcot' };
/** A Guatemalan DPI (CUI): 4 + 5 + 4 digits, written with spaces as people type it. */
const DPI = '2547 61234 0101';

const SID = {
  photo: 'SM7c1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a',
  followUp: 'SM8d2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b',
  other: 'SM9e3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c',
  location: 'SMa04b5c6d7e8f9a0b1c2d3e4f5a6b7c8d',
  dpi: 'SMb15c6d7e8f9a0b1c2d3e4f5a6b7c8d9e',
  afterRotation: 'SMc26d7e8f9a0b1c2d3e4f5a6b7c8d9e0f',
} as const;

const MEDIA_SID = 'ME5b8e2c4d6f8a0b2c4d6e8f0a2b4c6d8e';
const MEDIA_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${SID.photo}/Media/${MEDIA_SID}`;
const PHOTO_CAPTION = 'Buenas tardes, le mando la foto de mi receta para el pedido de mañana';
const FOLLOW_UP_TEXT = '¿A qué hora pasa el repartidor? Estoy en la zona 10';
const LOCATION = {
  Latitude: '14.5985623',
  Longitude: '-90.5076914',
  Address: '12 Calle 1-25, Zona 10, Ciudad de Guatemala',
  Label: 'Casa de Ana',
};
const DPI_TEXT = `Hola, mi DPI es ${DPI}, necesito actualizar mis datos de entrega`;

type TwilioForm = Record<string, string>;

function twilioForm(
  messageSid: string,
  customer: typeof CUSTOMER,
  body: string,
  extra: TwilioForm = {},
): TwilioForm {
  return {
    SmsMessageSid: messageSid,
    NumMedia: '0',
    ProfileName: customer.name,
    MessageType: 'text',
    SmsSid: messageSid,
    WaId: customer.waId,
    SmsStatus: 'received',
    Body: body,
    To: BUSINESS_NUMBER,
    NumSegments: '1',
    ReferralNumMedia: '0',
    MessageSid: messageSid,
    AccountSid: ACCOUNT_SID,
    From: customer.from,
    ApiVersion: '2010-04-01',
    ...extra,
  };
}

const photoMessage = (): TwilioForm =>
  twilioForm(SID.photo, CUSTOMER, PHOTO_CAPTION, {
    NumMedia: '1',
    MessageType: 'image',
    MediaContentType0: 'image/jpeg',
    MediaUrl0: MEDIA_URL,
  });
const followUpMessage = (): TwilioForm => twilioForm(SID.followUp, CUSTOMER, FOLLOW_UP_TEXT);
const otherCustomerMessage = (): TwilioForm =>
  twilioForm(SID.other, OTHER_CUSTOMER, 'Buenos días, ¿tienen servicio a domicilio?');
const locationMessage = (): TwilioForm =>
  twilioForm(SID.location, CUSTOMER, '', { MessageType: 'location', ...LOCATION });
const dpiMessage = (): TwilioForm => twilioForm(SID.dpi, CUSTOMER, DPI_TEXT);
const afterRotationMessage = (): TwilioForm =>
  twilioForm(SID.afterRotation, CUSTOMER, 'Gracias, ya recibí la confirmación');

/** Twilio's request signature: HMAC-SHA1 over the URL plus the sorted form pairs, base64. */
function twilioSignature(url: string, form: TwilioForm): string {
  const signed = Object.keys(form)
    .sort()
    .reduce((text, key) => `${text}${key}${form[key]}`, url);
  return createHmac('sha1', CARRIER_AUTH_TOKEN).update(signed, 'utf8').digest('base64');
}

// ---------- App: webhook -> wa.twilio.inbound (flow: audit tap) -> wa.assistant ----------

const INBOUND = 'wa.twilio.inbound';
const ASSISTANT = 'wa.assistant';
const AUDIT = 'wa.audit';
const ANALYTICS = 'wa.analytics';
const SCOPE = `inbound:${INBOUND}`;

/** What the controller hands to Estela: the form plus what the activator needs to verify it. */
interface CarrierWebhook {
  request: { url: string; headers: Record<string, string> };
  form: TwilioForm;
}

interface AssistantReply {
  recipient: string;
  text: string;
  mediaCount: number;
}

@Controller('webhooks/twilio')
class TwilioWhatsAppController {
  @Post('whatsapp')
  @InboundRest({
    channel: INBOUND,
    requestReply: true,
    timeoutMs: 2_000,
    idempotency: {
      // The carrier redelivers a webhook with the same MessageSid: that opaque id is the key.
      clientKey: (ctx) => (ctx.payload as CarrierWebhook).form.MessageSid,
      onDuplicate: 'replay',
      remember: Remember.Sealed,
    },
  })
  receive(
    @Body() form: TwilioForm,
    @Headers('x-twilio-signature') signature: string,
  ): CarrierWebhook {
    return {
      request: { url: PUBLIC_WEBHOOK_URL, headers: { 'x-twilio-signature': signature } },
      form: { ...form },
    };
  }
}

class UnknownCustomerError extends Error {
  override readonly name = 'UnknownCustomerError';
}

@Injectable()
class WhatsAppAssistant {
  runs = 0;
  /** The payloads exactly as delivered: privacy never changes them (SD-02). */
  readonly delivered: CarrierWebhook[] = [];

  @ServiceActivator(ASSISTANT)
  answer(webhook: CarrierWebhook): AssistantReply {
    this.runs += 1;
    this.delivered.push(webhook);
    const { form, request } = webhook;
    const expected = Buffer.from(twilioSignature(request.url, form));
    const received = Buffer.from(request.headers['x-twilio-signature'] ?? '');
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error('carrier signature mismatch');
    }
    if (form.Body?.includes('DPI')) {
      // A realistic leak path: the app quotes the customer's own words and number in its error.
      // Only the E.164 `From` is quoted: a bare `WaId` in free text is a documented pattern miss.
      throw new UnknownCustomerError(`no customer record for '${form.Body}' (from ${form.From})`);
    }
    return {
      recipient: form.From ?? '',
      text: `Hola ${form.ProfileName ?? ''}, recibimos tu mensaje.`,
      mediaCount: Number(form.NumMedia ?? '0'),
    };
  }
}

/**
 * The README "Outside the trail" guidance: an inbound handler's own throw reaches Nest's
 * ExceptionsHandler (an app surface, spec 1.3), so the app logs it through `errorForTrail` and
 * never echoes the upstream message to the carrier.
 */
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

// ---------- Ports the app owns: fingerprint secret, seal keys, a JSON store ----------

class RotatingFingerprintSecret implements FingerprintSecretProvider {
  material: FingerprintSecret = FP_K1;
  current(): FingerprintSecret {
    return this.material;
  }
}

class RotatingSealKeys implements SealKeyProvider {
  active: SealKey = SEAL_K1;
  readonly byIdCalls: string[] = [];
  private readonly known = new Map([SEAL_K1, SEAL_K2].map((key) => [key.id, key]));
  current(): Promise<SealKey> {
    return Promise.resolve(this.active);
  }
  byId(id: string): Promise<SealKey | undefined> {
    this.byIdCalls.push(id);
    return Promise.resolve(this.known.get(id));
  }
}

/** Records round-trip through JSON on write and read, as in a Redis-backed store (SD-35). */
class JsonRoundTripStore implements IdempotencyStore {
  private readonly inner = new MemoryIdempotencyStore();
  readonly raw = new Map<string, string>();
  begin(scope: string, key: string, ttlMs: number): Promise<boolean> {
    return this.inner.begin(scope, key, ttlMs);
  }
  async complete(scope: string, key: string, result: Record<string, unknown>): Promise<void> {
    const text = JSON.stringify(result);
    this.raw.set(`${scope}::${key}`, text);
    await this.inner.complete(scope, key, JSON.parse(text) as Record<string, unknown>);
  }
  fail(scope: string, key: string, error: unknown): Promise<void> {
    return this.inner.fail(scope, key, error);
  }
  async get(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
    const record = await this.inner.get(scope, key);
    return record === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(record)) as IdempotencyRecord);
  }
  purgeExpired(): Promise<number> {
    return this.inner.purgeExpired();
  }
  async release(scope: string, key: string): Promise<void> {
    await this.inner.release(scope, key);
  }
}

/** The Twilio SID shape (`AC`, `SM`, `MM`, `ME` + 32 hex): an app pattern, not a built-in pack. */
const TWILIO_SID = { name: 'twilio.sid', regex: /\b(?:AC|SM|MM|ME)[0-9a-f]{32}\b/ };

/** Guatemalan DPI (CUI): 13 digits as 4-5-4, with or without spaces; no digit may touch it. */
const GT_DPI = {
  name: 'gt.dpi',
  regex: /\d{4} ?\d{5} ?\d{4}/,
  confirm: (match: string, input: string, offset: number): boolean =>
    !/\d/.test(input[offset - 1] ?? '') && !/\d/.test(input[offset + match.length] ?? ''),
};

interface Scenario {
  app: INestApplication;
  capture: TrailCapture;
  store: JsonRoundTripStore;
  fingerprint: RotatingFingerprintSecret;
  sealKeys: RotatingSealKeys;
  assistant: WhatsAppAssistant;
  audit: CarrierWebhook[];
  /** What the analytics feed receives: a delivered copy shaped by its target privacy (SD-50). */
  analytics: CarrierWebhook[];
  deliver(form: TwilioForm): Promise<Response>;
}

interface ReplyEnvelope {
  status: string;
  result: AssistantReply;
}

/** The fingerprint the README promises: HMAC-SHA256 under the secret, 16 hex chars, with its id. */
const expectedFingerprint = (material: FingerprintSecret, value: string): string =>
  `fp:${material.id}:${createHmac('sha256', material.secret).update(value, 'utf8').digest('hex').slice(0, 16)}`;

describe('scenario whatsapp-pii: a Twilio-style WhatsApp webhook under explicit privacy (D-PHONE)', () => {
  const apps: INestApplication[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']);
  });

  async function boot(): Promise<Scenario> {
    const capture = captureTrail();
    const store = new JsonRoundTripStore();
    const fingerprint = new RotatingFingerprintSecret();
    const sealKeys = new RotatingSealKeys();
    Logger.overrideLogger(capture.logger);
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [
              { name: INBOUND, type: 'direct', privacy: 'wa-twilio' },
              { name: ASSISTANT, type: 'direct', privacy: 'wa-twilio' },
              { name: AUDIT, type: 'pubsub' },
              { name: ANALYTICS, type: 'pubsub' },
            ],
            idempotency: { store: capture.store(store) },
            logging: { hops: true, level: 'debug', banner: false },
            privacy: {
              packs: [Pack.SecretsV1, Pack.PersonalV1],
              headers: ['x-twilio-signature'],
              // Module-wide: a national id is private on every surface, the app filter included.
              patterns: [TWILIO_SID, GT_DPI],
              fingerprintSecret: fingerprint,
              sealKeys,
              profiles: {
                'wa-twilio': {
                  fields: [
                    { path: '**.From', name: 'wa.customer', show: Show.Fingerprint },
                    { path: '**.WaId', name: 'wa.customer', show: Show.Fingerprint },
                    { path: '**.ProfileName', name: 'wa.name' },
                    { path: '**.Body', name: 'wa.body', show: Show.Length },
                    { path: '**.MediaUrl0', name: 'wa.media' },
                    { path: '**.Latitude', name: 'wa.location' },
                    { path: '**.Longitude', name: 'wa.location' },
                    { path: '**.Address', name: 'wa.location' },
                    { path: '**.Label', name: 'wa.location' },
                  ],
                  exempt: [
                    {
                      path: '**.To',
                      show: Show.Ends,
                      reason: 'our own WhatsApp business sender number',
                    },
                    {
                      path: '**.MessageSid',
                      reason: 'opaque carrier message id, needed to trace support tickets',
                    },
                  ],
                },
              },
            },
          },
          [
            {
              name: 'wa-twilio-inbound',
              build: () =>
                // Flow level: every step's trail follows the WhatsApp profile, the analytics hop
                // included, though that channel declares no privacy of its own.
                IntegrationFlow.from(INBOUND, { privacy: 'wa-twilio' })
                  .wireTap(AUDIT, { id: 'audit' })
                  .fanoutTo(
                    [
                      {
                        channel: ANALYTICS,
                        wait: false,
                        privacy: {
                          use: 'wa-twilio',
                          reach: Reach.Delivery,
                          reachReason: 'conversation analytics counts customers, never reads them',
                        },
                      },
                    ],
                    { id: 'analytics' },
                  )
                  .to(ASSISTANT, { id: 'assistant' }),
            },
          ],
        ),
      ],
      controllers: [TwilioWhatsAppController],
      providers: [WhatsAppAssistant],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: capture.logger });
    app.useGlobalFilters(new TrailExceptionFilter(app.get(PrivacyEngine)));
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    const registry = app.get(ChannelRegistry);
    capture.channel(registry, 'error.channel');
    capture.channel(registry, AUDIT);
    const audit: CarrierWebhook[] = [];
    registry.get(AUDIT).subscribe((message: IntegrationMessage) => {
      audit.push(message.payload as CarrierWebhook);
    });
    const analytics: CarrierWebhook[] = [];
    registry.get(ANALYTICS).subscribe((message: IntegrationMessage) => {
      analytics.push(message.payload as CarrierWebhook);
    });
    const url = `${await app.getUrl()}/webhooks/twilio/whatsapp`;
    return {
      app,
      capture,
      store,
      fingerprint,
      sealKeys,
      assistant: app.get(WhatsAppAssistant),
      audit,
      analytics,
      deliver: (form) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-twilio-signature': twilioSignature(PUBLIC_WEBHOOK_URL, form),
            'user-agent': 'TwilioProxy/1.1',
          },
          body: new URLSearchParams(form).toString(),
        }),
    };
  }

  /** Bounded real-time wait for writes that land after the HTTP response. */
  async function until(what: string, check: () => boolean, boundMs = 3_000): Promise<void> {
    const giveUpAt = Date.now() + boundMs;
    while (!check()) {
      if (Date.now() > giveUpAt) throw new Error(`gave up after ${boundMs}ms waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  async function deliverOk(s: Scenario, form: TwilioForm): Promise<ReplyEnvelope> {
    const response = await s.deliver(form);
    expect(response.status).toBe(201);
    return (await response.json()) as ReplyEnvelope;
  }

  /** The audit copy of one MessageSid (the exempted id is shown as it is). */
  function auditOf(s: Scenario, messageSid: string): TwilioForm {
    const copy = s.audit.find((webhook) => webhook.form.MessageSid === messageSid);
    if (copy === undefined) throw new Error(`no audit copy for ${messageSid}`);
    return copy.form;
  }

  it('SD-25 SD-15: the customer number is a keyed fingerprint, stable across messages and distinct per customer', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    await deliverOk(s, followUpMessage());
    await deliverOk(s, otherCustomerMessage());

    const photo = auditOf(s, SID.photo);
    const followUp = auditOf(s, SID.followUp);
    const other = auditOf(s, SID.other);
    expect(photo.From).toBe(expectedFingerprint(FP_K1, CUSTOMER.from));
    expect(photo.WaId).toBe(expectedFingerprint(FP_K1, CUSTOMER.waId));
    expect(followUp.From).toBe(photo.From);
    expect(followUp.WaId).toBe(photo.WaId);
    expect(other.From).toBe(expectedFingerprint(FP_K1, OTHER_CUSTOMER.from));
    expect(other.From).not.toBe(photo.From);
    expect(photo.ProfileName).toBe('[HIDDEN:wa.name]');
    expectNoLeak(s.capture, [
      CUSTOMER.from,
      CUSTOMER.waId,
      CUSTOMER.name,
      OTHER_CUSTOMER.from,
      OTHER_CUSTOMER.waId,
      OTHER_CUSTOMER.name,
    ]);
  });

  it('SD-16 SD-15: a new fingerprint secret id gives the same customer a new token, stable again under it', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    const before = auditOf(s, SID.photo).From ?? '';

    s.fingerprint.material = FP_K2;
    await s.app.get(PrivacyEngine).refreshFingerprintSecret();
    await deliverOk(s, followUpMessage());
    await deliverOk(s, afterRotationMessage());

    const after = auditOf(s, SID.followUp).From ?? '';
    expect(before).toMatch(/^fp:wa-fp-1:[0-9a-f]{16}$/);
    expect(after).toBe(expectedFingerprint(FP_K2, CUSTOMER.from));
    expect(after.slice(after.lastIndexOf(':'))).not.toBe(before.slice(before.lastIndexOf(':')));
    expect(auditOf(s, SID.afterRotation).From).toBe(after);
    // The secret bytes never reach the trail, only their ids (SD-42).
    expectNoLeak(s.capture, [
      Buffer.from(FP_K1.secret).toString('base64'),
      Buffer.from(FP_K2.secret).toString('base64'),
      Buffer.from(FP_K1.secret).toString('hex'),
      Buffer.from(FP_K2.secret).toString('hex'),
    ]);
  });

  it('SD-47 SD-50: the analytics target gets the message as the trail shows it; the assistant gets it whole', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    await until('the analytics copy', () => s.analytics.length === 1);

    const counted = s.analytics[0]!.form;
    const audited = auditOf(s, SID.photo);
    // The same customer gets the same token in the analytics feed and in the trail: a join key.
    expect(counted.From).toBe(expectedFingerprint(FP_K1, CUSTOMER.from));
    expect(counted.From).toBe(audited.From);
    expect(counted.WaId).toBe(audited.WaId);
    expect(counted.ProfileName).toBe('[HIDDEN:wa.name]');
    expect(counted.Body).toBe(`[HIDDEN:wa.body len=${PHOTO_CAPTION.length}]`);
    expect(counted.MediaUrl0).toBe('[HIDDEN:wa.media]');
    expect(counted.To).toBe('***8886');
    expect(counted.MessageSid).toBe(SID.photo);
    // The assistant, on the same flow, receives every value as the carrier sent it.
    expect(s.assistant.delivered[0]?.form).toEqual(photoMessage());
    const feed = JSON.stringify(s.analytics);
    for (const value of [CUSTOMER.from, CUSTOMER.waId, CUSTOMER.name, PHOTO_CAPTION, MEDIA_URL]) {
      expect(feed).not.toContain(value);
    }
  });

  it('SD-18 SD-25: the business sender number shows only its last 4 digits, through an exemption logged with its reason', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    expect(auditOf(s, SID.photo).To).toBe('***8886');
    const exemptionLines = s.capture.writes
      .filter((write) => write.text.includes('privacy exemption'))
      .map((write) => write.text);
    expect(
      exemptionLines.some(
        (line) =>
          line.includes("path '**.To' show ends") &&
          line.includes('reason: our own WhatsApp business sender number'),
      ),
    ).toBe(true);
    expectNoLeak(s.capture, [BUSINESS_NUMBER, '+14155238886']);
  });

  it('SD-14: the message text is written as its length only', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    await deliverOk(s, followUpMessage());
    expect(auditOf(s, SID.photo).Body).toBe(`[HIDDEN:wa.body len=${PHOTO_CAPTION.length}]`);
    expect(auditOf(s, SID.followUp).Body).toBe(`[HIDDEN:wa.body len=${FOLLOW_UP_TEXT.length}]`);
    expectNoLeak(s.capture, [PHOTO_CAPTION, FOLLOW_UP_TEXT, 'receta para el pedido']);
  });

  it('SD-17 SD-11: media URLs and location are hidden; account and media SIDs stay hidden by the app pattern', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    await deliverOk(s, locationMessage());
    const photo = auditOf(s, SID.photo);
    const location = auditOf(s, SID.location);
    expect(photo.MediaUrl0).toBe('[HIDDEN:wa.media]');
    expect(photo.MediaContentType0).toBe('image/jpeg');
    expect(photo.AccountSid).toBe('[HIDDEN:twilio.sid]');
    expect(photo.SmsSid).toBe('[HIDDEN:twilio.sid]');
    for (const field of ['Latitude', 'Longitude', 'Address', 'Label'] as const) {
      expect(location[field]).toBe('[HIDDEN:wa.location]');
    }
    expectNoLeak(s.capture, [
      MEDIA_URL,
      MEDIA_SID,
      ACCOUNT_SID,
      LOCATION.Latitude,
      LOCATION.Longitude,
      LOCATION.Address,
      LOCATION.Label,
    ]);
  });

  it('SD-18: MessageSid is shown as it is, through an exemption with a reason', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    expect(auditOf(s, SID.photo).MessageSid).toBe(SID.photo);
    expect(
      s.capture.writes.some(
        (write) =>
          write.text.includes("'**.MessageSid'") &&
          write.text.includes('opaque carrier message id, needed to trace support tickets'),
      ),
    ).toBe(true);
  });

  it('SD-09: X-Twilio-Signature is hidden in the trail and reaches the assistant intact', async () => {
    const s = await boot();
    await deliverOk(s, photoMessage());
    const signature = twilioSignature(PUBLIC_WEBHOOK_URL, photoMessage());
    const copy = s.audit.find((webhook) => webhook.form.MessageSid === SID.photo);
    expect(copy?.request.headers['x-twilio-signature']).toBe('[HIDDEN:header]');
    expect(s.assistant.delivered[0]?.request.headers['x-twilio-signature']).toBe(signature);
    expectNoLeak(s.capture, [signature, CARRIER_AUTH_TOKEN]);
  });

  it('SD-11 SD-24: a DPI typed in free text is caught by the app pattern in the error trail', async () => {
    const s = await boot();
    const response = await s.deliver(dpiMessage());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ statusCode: 500 });
    await until('the error trail', () =>
      s.capture.writes.some((write) => write.text.includes('UnknownCustomerError')),
    );
    // The audit copy shows only the body length; the error message quotes the text itself.
    expect(auditOf(s, SID.dpi).Body).toBe(`[HIDDEN:wa.body len=${DPI_TEXT.length}]`);
    const errorWrites = s.capture.writes.filter((write) =>
      write.text.includes('UnknownCustomerError'),
    );
    expect(errorWrites.length).toBeGreaterThan(0);
    expect(errorWrites.some((write) => write.text.includes('[HIDDEN:gt.dpi]'))).toBe(true);
    expect(
      errorWrites.some((write) => write.text.includes(expectedFingerprint(FP_K1, '+50255501234'))),
    ).toBe(true);
    expectNoLeak(s.capture, [DPI, DPI.replace(/ /g, ''), '+50255501234', CUSTOMER.waId]);
  });

  it('SD-31 SD-35 SD-02: the reply is remembered sealed and a duplicate webhook replays it without running again', async () => {
    const s = await boot();
    const first = await deliverOk(s, photoMessage());
    expect(first.result).toEqual({
      recipient: CUSTOMER.from,
      text: `Hola ${CUSTOMER.name}, recibimos tu mensaje.`,
      mediaCount: 1,
    });

    const raw = s.store.raw.get(`${SCOPE}::${SID.photo}`);
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual([SEALED_RECORD_KEY]);
    expect(record[SEALED_RECORD_KEY]).toMatchObject({ v: 1, kid: SEAL_K1.id });

    const duplicate = await deliverOk(s, photoMessage());
    expect(duplicate.result).toEqual(first.result);
    expect(s.assistant.runs).toBe(1);
    expect(s.sealKeys.byIdCalls).toEqual([SEAL_K1.id]);
    // Handlers received the real form; only the trail copies were hidden.
    expect(s.assistant.delivered[0]?.form).toEqual(photoMessage());
    expectNoLeak(s.capture, [CUSTOMER.from, CUSTOMER.name, PHOTO_CAPTION, MEDIA_URL]);
  });

  it('SD-32 SD-31: after the seal key rotates, old records still replay and new ones seal with the new key', async () => {
    const s = await boot();
    const before = await deliverOk(s, photoMessage());

    s.sealKeys.active = SEAL_K2;
    const replayed = await deliverOk(s, photoMessage());
    expect(replayed.result).toEqual(before.result);
    expect(s.assistant.runs).toBe(1);

    await deliverOk(s, afterRotationMessage());
    expect(s.assistant.runs).toBe(2);
    const kidOf = (sid: string): string | undefined =>
      (JSON.parse(s.store.raw.get(`${SCOPE}::${sid}`)!) as Record<string, { kid: string }>)[
        SEALED_RECORD_KEY
      ]?.kid;
    expect(kidOf(SID.photo)).toBe(SEAL_K1.id);
    expect(kidOf(SID.afterRotation)).toBe(SEAL_K2.id);

    const again = await deliverOk(s, afterRotationMessage());
    expect(again.result.recipient).toBe(CUSTOMER.from);
    expect(s.assistant.runs).toBe(2);
    expect(s.sealKeys.byIdCalls).toEqual([SEAL_K1.id, SEAL_K2.id]);
    expectNoLeak(s.capture, [
      Buffer.from(SEAL_K1.key).toString('base64'),
      Buffer.from(SEAL_K2.key).toString('base64'),
    ]);
  });

  it('SD-27 SD-38: a full conversation leaves no personal data or credential in any trail output', async () => {
    const s = await boot();
    for (const form of [
      photoMessage(),
      photoMessage(),
      followUpMessage(),
      locationMessage(),
      otherCustomerMessage(),
    ]) {
      await deliverOk(s, form);
    }
    await s.deliver(dpiMessage());
    await until('the error envelope', () =>
      s.capture.writes.some((write) => write.output === TrailOutput.ErrorEnvelope),
    );

    const outputs = new Set(s.capture.writes.map((write) => write.output));
    expect([...outputs].sort()).toEqual(['error-envelope', 'log', 'store', 'wiretap']);
    expectNoLeak(s.capture, [
      CUSTOMER.from,
      CUSTOMER.waId,
      CUSTOMER.name,
      OTHER_CUSTOMER.from,
      OTHER_CUSTOMER.name,
      BUSINESS_NUMBER,
      PHOTO_CAPTION,
      FOLLOW_UP_TEXT,
      MEDIA_URL,
      ACCOUNT_SID,
      LOCATION.Address,
      LOCATION.Latitude,
      DPI,
      twilioSignature(PUBLIC_WEBHOOK_URL, photoMessage()),
    ]);
  });
});
