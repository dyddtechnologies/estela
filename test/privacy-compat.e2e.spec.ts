import 'reflect-metadata';

import { Body, Controller, Injectable, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRegistry } from '../src/channel-registry';
import { ServiceActivator } from '../src/decorators';
import { IntegrationFlow, type FlowDefinition } from '../src/flow/integration-flow';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-idempotency.store';
import { InboundRest } from '../src/inbound/inbound.decorators';
import { IntegrationModule } from '../src/integration.module';
import type { IntegrationMessage } from '../src/message';
import { MemoryIdempotencyLedger } from '../src/saga/idempotency-ledger';
import { saga } from '../src/saga/saga';
import { SagaRunner } from '../src/saga/saga-runner';
import { TrailOutput } from '../src/sensitive/privacy-engine';
import { captureTrail, type TrailCapture } from '../src/testing/capture-trail';

/** Values a policy would hide; without one, every record, reply and message keeps them (SD-01). */
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjb21wYXQifQ.Y29tcGF0LXNpZ25hdHVyZS1jYW5hcnk';
const CARD = '4111111111111111';
const EMAIL = 'compat.person@example.com';

@Injectable()
class Psp {
  readonly received: unknown[] = [];

  @ServiceActivator('pay.charge')
  charge(payload: { pan: string }): unknown {
    this.received.push(payload);
    return { approved: true, token: JWT, pan: payload.pan, contact: { email: EMAIL } };
  }
}

@Controller()
class Checkout {
  @Post('pay')
  @InboundRest({
    channel: 'pay.in',
    requestReply: true,
    timeoutMs: 2000,
    idempotency: { onDuplicate: 'replay' },
  })
  pay(@Body() body: unknown): unknown {
    return body;
  }
}

const payFlow: FlowDefinition = {
  name: 'pay',
  build: () => IntegrationFlow.from('pay.in').wireTap('audit').to('pay.charge'),
};

interface Outcome {
  replies: unknown[];
  records: { output: string; where: string; text: string }[];
  activatorGotTheReference: boolean;
  tapSharesThePayload: boolean;
}

async function run(privacy: false | undefined): Promise<Outcome> {
  const capture: TrailCapture = captureTrail();

  @Module({
    imports: [
      IntegrationModule.forRoot(
        {
          channels: [
            { name: 'pay.in', type: 'direct' },
            { name: 'pay.charge', type: 'direct' },
            { name: 'audit', type: 'pubsub' },
          ],
          idempotency: { store: capture.store(new MemoryIdempotencyStore()) },
          logging: { banner: false },
          ...(privacy === undefined ? {} : { privacy }),
        },
        [payFlow],
      ),
    ],
    controllers: [Checkout],
    providers: [Psp],
  })
  class CompatModule {}

  const moduleRef = await Test.createTestingModule({ imports: [CompatModule] }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  try {
    const registry = moduleRef.get(ChannelRegistry);
    const taps: IntegrationMessage[] = [];
    registry.get('audit').subscribe((msg) => {
      taps.push(msg);
    });

    const replies: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${url}/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'compat-key-1' },
        body: JSON.stringify({ pan: CARD, contact: { email: EMAIL } }),
      });
      replies.push(((await response.json()) as { result: unknown }).result);
    }

    // A message sent in-process: the flow, its tap and the activator see this very object.
    const direct = Object.freeze({ pan: CARD, token: JWT });
    await registry.send('pay.in', direct, { idempotencyKey: 'compat-key-2' });
    const psp = moduleRef.get(Psp);

    const runner = new SagaRunner<null>({
      transactions: { run: (work) => work(null) },
      ledger: capture.ledger(new MemoryIdempotencyLedger<null>()),
    });
    const refund = saga<{ key: string }, null, unknown>('refund')
      .idempotent((ctx) => ctx.key)
      .transaction('book', () => undefined)
      .reply(() => ({ token: JWT, card: CARD }));
    replies.push(await runner.run(refund, { key: 'compat-saga-1' }));
    replies.push(await runner.run(refund, { key: 'compat-saga-1' }));

    return {
      replies,
      records: capture.writes.filter(
        (write) => write.output === TrailOutput.Store || write.output === TrailOutput.Ledger,
      ),
      activatorGotTheReference: psp.received.at(-1) === direct,
      tapSharesThePayload: taps.at(-1)?.payload === direct,
    };
  } finally {
    await app.close();
  }
}

describe('backward compatibility without a privacy option (SD-01, section 2)', () => {
  it('compat: no privacy option keeps records, replies and messages identical', async () => {
    const plain = await run(undefined);
    const off = await run(false);

    // `privacy: false` is the 0.9.0 reference: no option at all must not differ from it.
    expect(plain).toEqual(off);
    expect(plain.activatorGotTheReference).toBe(true);
    expect(plain.tapSharesThePayload).toBe(true);

    const reply = { approved: true, token: JWT, pan: CARD, contact: { email: EMAIL } };
    const refund = { token: JWT, card: CARD };
    expect(plain.replies).toEqual([reply, reply, refund, refund]);
    // Records keep every value as the reply had it (Remember.Everything, 0.9.0).
    expect(plain.records.map((record) => record.where).sort()).toEqual([
      'ledger.record refund',
      'store.complete activator:Psp.charge',
      'store.complete activator:Psp.charge',
      'store.complete flow:pay',
      'store.complete flow:pay',
      'store.complete inbound:pay.in',
    ]);
    for (const record of plain.records) {
      // A flow record holds its outcome only, as in 0.9.0; every other record holds the reply.
      if (!record.where.includes('flow:')) expect(record.text).toContain(JWT);
      expect(record.text).not.toContain('[HIDDEN:');
      expect(record.text).not.toContain('estela');
    }
  }, 20_000);
});
