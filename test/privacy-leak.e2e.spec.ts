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
import { PrivacyEngine, TrailOutput } from '../src/sensitive/privacy-engine';
import { Pack, Remember } from '../src/sensitive/privacy.types';
import type { SealKey } from '../src/sensitive/seal-key';
import { HopLogger } from '../src/trace/hop-logger';
import { captureTrail } from '../src/testing/capture-trail';
import { expectNoLeak } from '../src/testing/expect-no-leak';

/** Canary secrets planted on every path; none may reach the trail in any encoded form. */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJsZWFrIn0.bGVhay1zaWduYXR1cmUtY2FuYXJ5';
const API_KEY = 'AKIAABCDEFGHIJKLMNOP';
const PHONE = '+50212345678';
const EMAIL = 'canary.person@example.com';
const CARD = '4111111111111111';
const IDEM_KEY = 'idem-CANARY-KEY-0001';

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
        ],
        idempotency: { store: capture.store(store) },
        logging: { hops: true, level: 'debug', banner: false },
        privacy: {
          packs: [Pack.SecretsV1, Pack.PersonalV1],
          fields: ['**.contact.email'],
          sealKeys,
        },
      },
      [PayFlow, FailFlow],
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
});
