import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
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
import { ServiceActivator } from '../src/decorators';
import { IntegrationFlow, type FlowDefinition } from '../src/flow/integration-flow';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-idempotency.store';
import { InboundRest } from '../src/inbound/inbound.decorators';
import { IntegrationModule } from '../src/integration.module';
import { ChannelRegistry } from '../src/channel-registry';
import { OutboundHttpError } from '../src/outbound/outbound.errors';
import { MemoryIdempotencyLedger } from '../src/saga/idempotency-ledger';
import { saga } from '../src/saga/saga';
import { SagaRunner } from '../src/saga/saga-runner';
import { envFingerprintSecret } from '../src/sensitive/fingerprint-secret';
import { PrivacyEngine, TrailOutput } from '../src/sensitive/privacy-engine';
import { Pack, Reach, Remember, Show } from '../src/sensitive/privacy.types';
import type { SealKey } from '../src/sensitive/seal-key';
import { HopLogger } from '../src/trace/hop-logger';
import type { IntegrationMessage } from '../src/message';
import { captureTrail } from '../src/testing/capture-trail';
import { expectNoLeak } from '../src/testing/expect-no-leak';

/** Canary secrets planted on every path; none may reach the trail in any encoded form. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrIn0.bGVhay1zaWduYXR1cmUtY2FuYXJ5';
const API_KEY = 'AKIAABCDEFGHIJKLMNOP';
const PHONE = '+50212345678';
const EMAIL = 'canary.person@example.com';
const CARD = '4111111111111111';
const IDEM_KEY = 'idem-CANARY-KEY-0001';
const SSN = '078-05-1120';
const LOAN_CARD = '5555555555554444';

const capture = captureTrail();
const store = new MemoryIdempotencyStore();
const sealKey: SealKey = { id: 'k1', key: randomBytes(32) };
const sealKeys = {
  current: (): Promise<SealKey> => Promise.resolve(sealKey),
  byId: (id: string): Promise<SealKey | undefined> =>
    Promise.resolve(id === sealKey.id ? sealKey : undefined),
};

@Injectable()
class Psp {
  calls = 0;

  @ServiceActivator('pay.charge')
  charge(payload: { pan: string }): unknown {
    this.calls++;
    return { approved: true, token: JWT, pan: payload.pan, contact: { email: EMAIL } };
  }

  @ServiceActivator('notify.send')
  notify(): never {
    throw new Error(`sms to ${PHONE} failed, key ${API_KEY}, mail ${EMAIL}`);
  }
}

@Controller()
class Checkout {
  @Post('pay')
  @InboundRest({
    channel: 'pay.in',
    requestReply: true,
    timeoutMs: 2000,
    idempotency: { onDuplicate: 'replay', remember: Remember.Sealed },
  })
  pay(@Body() body: unknown): unknown {
    return body;
  }

  @Post('fail')
  @InboundRest({
    channel: 'fail.in',
    requestReply: true,
    timeoutMs: 2000,
    idempotency: { onFailure: 'store', remember: Remember.AsShown },
  })
  fail(@Body() body: unknown): unknown {
    return body;
  }

  @Post('notify')
  @InboundRest({ channel: 'notify.send' })
  notify(@Body() body: unknown): unknown {
    return body;
  }
}

/**
 * Nest's ExceptionsHandler is an app surface (spec 1.3): an inbound handler's own throw reaches it,
 * not error.channel. The README guidance is an app filter that logs `errorForTrail(error)`.
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

const PayFlow: FlowDefinition = {
  name: 'pay',
  build: () =>
    IntegrationFlow.from('pay.in')
      .wireTap('audit', { id: 'audit' })
      .handle((payload) => payload, { id: 'price' })
      .to('pay.charge', { id: 'charge' }),
};

const FailFlow: FlowDefinition = {
  name: 'fail',
  build: () =>
    IntegrationFlow.from('fail.in').handle(() => {
      throw new OutboundHttpError(
        {
          binding: 'psp',
          url: `https://u:p@psp.example/x?api_key=${API_KEY}`,
          method: 'POST',
          attempts: 1,
        },
        502,
        'Bad Gateway',
        { 'set-cookie': `session=${JWT}` },
        { token: JWT, card: CARD, phone: PHONE },
      );
    }),
};

/**
 * The section 18.3 flow: profiles at L1, a channel profile, flow and step privacy, a tap hidden by
 * default, a jump whose reply holds a card number and a `Reach.Delivery` transform. A second tap
 * after the jump puts `jumpReplies` on a sink (SD-53).
 */
const LoanFlow: FlowDefinition = {
  name: 'loan',
  build: () =>
    IntegrationFlow.from('loan.requests', { privacy: 'personal' })
      .handle((p) => ({ ...(p as object), enriched: true }), {
        id: 'enrich',
        privacy: { fields: ['ssn'] },
      })
      .wireTap('loan.audit', { id: 'audit' })
      .jumpTo([{ channel: 'credit.check', privacy: 'card' }], { id: 'credit' })
      .wireTap('loan.audit', { id: 'audit-after-credit' })
      .transform((p) => ({ ...(p as object), shape: 'partner' }), {
        id: 'partner',
        privacy: {
          fields: ['ssn'],
          reach: Reach.Delivery,
          reachReason: 'partner must not receive SSN',
        },
      })
      .to('partner.out', { id: 'send' }),
};

@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'pay.in', type: 'direct' },
          { name: 'pay.charge', type: 'direct', privacy: { fields: ['**.pan'] } },
          { name: 'fail.in', type: 'direct' },
          { name: 'notify.send', type: 'direct' },
          { name: 'audit', type: 'pubsub' },
          { name: 'loan.requests', type: 'direct' },
          { name: 'loan.audit', type: 'pubsub' },
          { name: 'credit.check', type: 'direct', privacy: 'card' },
          { name: 'partner.out', type: 'direct' },
        ],
        idempotency: { store: capture.store(store) },
        logging: { hops: true, level: 'debug', banner: false },
        privacy: {
          packs: [Pack.SecretsV1, Pack.PersonalV1],
          fields: ['**.contact.email'],
          sealKeys,
          fingerprintSecret: envFingerprintSecret('ESTELA_FP_SECRET', 'ESTELA_FP_SECRET_ID', {
            ESTELA_FP_SECRET: randomBytes(32).toString('base64'),
            ESTELA_FP_SECRET_ID: 'k1',
          }),
          profiles: {
            personal: { packs: [Pack.PersonalV1], fields: ['**.ssn'] },
            card: { fields: [{ path: '**.pan', show: Show.Ends, showLast: 4 }] },
            'card-personal': { extends: ['card', 'personal'] },
          },
        },
      },
      [PayFlow, FailFlow, LoanFlow],
    ),
  ],
  controllers: [Checkout],
  providers: [Psp],
})
class CheckoutModule {}

describe('privacy leak e2e: no secret reaches any trail output at debug level (SD-27)', () => {
  let app: INestApplication | undefined;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CheckoutModule] }).compile();
    app = moduleRef.createNestApplication({ logger: capture.logger });
    Logger.overrideLogger(capture.logger);
    app.useGlobalFilters(new TrailExceptionFilter(app.get(PrivacyEngine)));
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    capture.channel(moduleRef.get(ChannelRegistry), 'error.channel');
    capture.channel(moduleRef.get(ChannelRegistry), 'audit');
    capture.channel(moduleRef.get(ChannelRegistry), 'loan.audit');
  }, 20_000);

  afterAll(async () => {
    await app?.close();
  });

  const post = async (
    path: string,
    body: unknown,
    key?: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${JWT}`,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  it('test/privacy-leak.e2e.spec.ts: no secret reaches any sink at debug level', async () => {
    const payload = { pan: CARD, phone: PHONE, apiKey: API_KEY };
    const first = await post('/pay', payload, IDEM_KEY);
    expect(first.status).toBe(201);
    // The caller receives the real reply; only the trail is hidden (SD-02).
    expect(JSON.stringify(first.body)).toContain(JWT);
    const replay = await post('/pay', payload, IDEM_KEY);
    // A replay wraps the remembered reply in a new envelope (new ids), as in 0.9.0.
    expect((replay.body as { result: unknown }).result).toEqual(
      (first.body as { result: unknown }).result,
    );
    expect(app?.get(Psp).calls).toBe(1);

    await post('/fail', { card: CARD }, `${IDEM_KEY}-f`);
    await post('/fail', { card: CARD }, `${IDEM_KEY}-f`);
    await post('/notify', { phone: PHONE }, `${IDEM_KEY}-n`);

    const engine = app!.get(PrivacyEngine);
    const runner = new SagaRunner<null>({
      transactions: { run: (work) => work(null) },
      ledger: capture.ledger(new MemoryIdempotencyLedger<null>()),
      logger: new HopLogger('debug', engine),
      privacy: { engine, remember: Remember.Sealed },
    });
    const refund = saga<{ key: string }, null, unknown>('refund')
      .idempotent((ctx) => ctx.key)
      .transaction('book', (_ctx, _tx, unit) => {
        unit.afterCommit(() => {
          throw new Error(`receipt to ${EMAIL} with ${JWT} failed`);
        });
      })
      .reply(() => ({ token: JWT, card: CARD }));
    await runner.run(refund, { key: IDEM_KEY });
    await runner.run(refund, { key: IDEM_KEY });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outputs = new Set(capture.writes.map((write) => write.output));
    expect([...outputs].sort()).toEqual(['error-envelope', 'ledger', 'log', 'store', 'wiretap']);
    expect(capture.writes.some((w) => w.text.includes('hop'))).toBe(true);
    expectNoLeak(capture, [JWT, API_KEY, PHONE, EMAIL, CARD, IDEM_KEY]);
  }, 20_000);
  it('the section 18.3 flow keeps every secret off the trail and delivers SD-54 values', async () => {
    const registry = app!.get(ChannelRegistry);
    const creditReply = { score: 720, pan: LOAN_CARD };
    const credit: IntegrationMessage[] = [];
    registry.get('credit.check').subscribe((msg) => {
      credit.push(msg);
      return registry.send(String(msg.headers.replyChannel), creditReply);
    });
    const partner: IntegrationMessage[] = [];
    let partnerDown = false;
    registry.get('partner.out').subscribe((msg) => {
      partner.push(msg);
      if (partnerDown) {
        const refused = new Error(`partner refused applicant ${EMAIL}`);
        return Promise.reject(Object.assign(refused, { ssn: SSN, phone: PHONE }));
      }
      return Promise.resolve();
    });
    const request = { applicant: { email: EMAIL, phone: PHONE }, ssn: SSN };
    await registry.send('loan.requests', request);
    partnerDown = true;
    await registry.send('loan.requests', request).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Delivered values (SD-54, SD-50): the credit check gets the real data; the partner gets
    // everything but the SSN, and the real jump reply.
    expect(credit[0]?.payload).toEqual({ ...request, enriched: true });
    const sent = partner[0]!;
    expect(sent.payload).toEqual({
      applicant: { email: EMAIL, phone: PHONE },
      ssn: '[HIDDEN:field]',
      enriched: true,
      shape: 'partner',
    });
    const replies = sent.headers.jumpReplies!;
    expect(replies['credit.check']).toBe(creditReply);
    expect(request.ssn).toBe(SSN);

    // Trail copies: both taps are hidden by default and the later one hides the jump reply.
    const taps = capture.writes.filter((write) => write.where === 'channel loan.audit');
    expect(taps).toHaveLength(4);
    expect(taps.some((write) => write.text.includes('"pan":"***4444"'))).toBe(true);
    const envelopes = capture.writes.filter(
      (write) => write.output === TrailOutput.ErrorEnvelope && write.text.includes('"loan"'),
    );
    expect(envelopes).toHaveLength(1);
    expectNoLeak(capture, [SSN, LOAN_CARD, EMAIL, PHONE]);
  }, 20_000);
});
