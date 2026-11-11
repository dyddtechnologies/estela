import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { MemoryIdempotencyStore } from './idempotency/memory-idempotency.store';
import { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
import type { IntegrationMessage } from './message';
import { MemoryIdempotencyLedger } from './saga/idempotency-ledger';
import { saga } from './saga/saga';
import { SagaRunner } from './saga/saga-runner';
import { PrivacyEngine, TrailOutput } from './sensitive/privacy-engine';
import { Pack, Remember, type PrivacyModuleOptions } from './sensitive/privacy.types';
import { captureTrail, type TrailCapture } from './testing/capture-trail';
import { expectNoLeak } from './testing/expect-no-leak';
import { HopLogger } from './trace/hop-logger';

const CARD = '4111111111111111';
const TOKEN = 'CANARYTOKEN0001';
const SCOPE = 'activator:Psp.charge';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === 'object' && item !== null) deepFreeze(item as object);
  }
  return Object.freeze(value);
}

@Injectable()
class Psp {
  readonly received: unknown[] = [];

  @ServiceActivator('pay.charge', { privacy: { remember: Remember.AsShown } })
  charge(payload: { pan: string; amount: number }): unknown {
    this.received.push(payload);
    if (payload.amount < 0) throw new Error(`refused card ${payload.pan}`);
    return payload;
  }
}

@Injectable()
class PlainPsp {
  readonly received: unknown[] = [];

  @ServiceActivator('pay.charge')
  charge(payload: unknown): unknown {
    this.received.push(payload);
    return payload;
  }
}

const payFlow: FlowDefinition = {
  name: 'pay',
  build: () =>
    IntegrationFlow.from('pay.in')
      .wireTap('audit', { id: 'audit' })
      .to('pay.charge', { id: 'charge' }),
};

async function boot(
  options: Partial<IntegrationModuleOptions>,
  flows: FlowDefinition[],
  providers: unknown[],
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        {
          channels: [
            { name: 'pay.in', type: 'direct' },
            { name: 'pay.charge', type: 'direct' },
            { name: 'audit', type: 'pubsub' },
          ],
          ...options,
        },
        flows,
      ),
    ],
    providers: providers as never[],
  }).compile();
  await mod.init();
  return mod;
}

function collect(mod: TestingModule, channel: string): IntegrationMessage[] {
  const seen: IntegrationMessage[] = [];
  mod
    .get(ChannelRegistry)
    .get(channel)
    .subscribe((msg) => {
      seen.push(msg);
    });
  return seen;
}

/** Routes every Nest logger level into the capture for the duration of `run`. */
async function withLogger(capture: TrailCapture, run: () => Promise<void>): Promise<void> {
  const levels = ['log', 'error', 'warn', 'debug', 'verbose'] as const;
  const spies = levels.map((level) =>
    jest
      .spyOn(Logger.prototype, level)
      .mockImplementation((message: unknown, ...rest: unknown[]): void => {
        capture.logger[level]?.(message, ...rest);
      }),
  );
  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

describe('privacy never changes what is delivered (SD-02)', () => {
  it('activator receives the original payload while sinks get redacted copies', async () => {
    const store = new MemoryIdempotencyStore();
    const capture = captureTrail();
    const mod = await boot(
      {
        idempotency: { store: capture.store(store) },
        privacy: { packs: [Pack.PersonalV1], fields: ['**.pan'] },
      },
      [payFlow],
      [Psp],
    );
    capture.channel(mod.get(ChannelRegistry), 'audit');
    capture.channel(mod.get(ChannelRegistry), 'error.channel');
    const audit = collect(mod, 'audit');
    const registry = mod.get(ChannelRegistry);

    const payload = deepFreeze({ pan: CARD, amount: 10 });
    await registry.send('pay.in', payload, { idempotencyKey: 'k-1' });
    await settle();
    // The activator gets the very reference the caller sent; no frozen write was attempted.
    expect(mod.get(Psp).received[0]).toBe(payload);
    expect(audit[0]?.payload).toEqual({ pan: '[HIDDEN:field]', amount: 10 });
    const stored = await store.get(SCOPE, 'k-1');
    expect(JSON.stringify(stored?.result)).toContain('[HIDDEN:field]');

    const refused = deepFreeze({ pan: CARD, amount: -1 });
    let thrown: unknown;
    await withLogger(capture, () =>
      registry.send('pay.in', refused, { idempotencyKey: 'k-2' }).catch((error: unknown) => {
        thrown = error;
      }),
    );
    await settle();
    expect(mod.get(Psp).received[1]).toBe(refused);
    // The caller's error keeps the message it was thrown with; only the trail copies are hidden.
    expect((thrown as Error).message).toBe(`refused card ${CARD}`);
    const outputs = new Set(capture.writes.map((write) => write.output));
    expect(outputs.has(TrailOutput.WireTap)).toBe(true);
    expect(outputs.has(TrailOutput.ErrorEnvelope)).toBe(true);
    expect(outputs.has(TrailOutput.Store)).toBe(true);
    expectNoLeak(capture, [CARD]);
    await mod.close();
  });
});

interface LineCounts {
  flowStart: number;
  flowEndError: number;
  errorChannel: number;
  hopStart: number;
  hopEndFail: number;
  hopError: number;
}

function countLines(capture: TrailCapture): LineCounts {
  const texts = capture.writes.map((write) => write.text);
  const count = (test: (text: string) => boolean): number => texts.filter(test).length;
  return {
    flowStart: count((t) => t.startsWith('▶ flow fail ')),
    flowEndError: count((t) => t.startsWith('■ flow fail ') && t.includes(' error ')),
    errorChannel: count((t) => t.startsWith('error.channel: ')),
    hopStart: count((t) => t.startsWith('→ hop saga:refund after-commit:')),
    hopEndFail: count((t) => t.startsWith('← hop saga:refund after-commit:tx#0#0 FAIL')),
    hopError: count((t) => t.startsWith('✖ hop saga:refund after-commit:tx#0#0 ERROR')),
  };
}

async function runFailures(privacy: PrivacyModuleOptions | undefined): Promise<TrailCapture> {
  const capture = captureTrail();
  const failFlow: FlowDefinition = {
    name: 'fail',
    build: () =>
      IntegrationFlow.from('fail.in').handle(
        () => {
          throw new Error(`partner refused card ${CARD} with ${TOKEN}`);
        },
        { id: 'call' },
      ),
  };
  await withLogger(capture, async () => {
    const mod = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [{ name: 'fail.in', type: 'direct' }],
            logging: { hops: true, banner: false },
            ...(privacy === undefined ? {} : { privacy }),
          },
          [failFlow],
        ),
      ],
    }).compile();
    await mod.init();
    await mod
      .get(ChannelRegistry)
      .send('fail.in', { pan: CARD })
      .catch(() => undefined);
    await settle();

    const engine = mod.get(PrivacyEngine);
    const runner = new SagaRunner<null>({
      transactions: { run: (work) => work(null) },
      ledger: new MemoryIdempotencyLedger<null>(),
      logger: new HopLogger('log', engine),
      privacy: { engine, remember: Remember.AsShown },
    });
    const refund = saga<{ key: string }, null, unknown>('refund')
      .idempotent((ctx) => ctx.key)
      .transaction('book', (_ctx, _tx, unit) => {
        unit.afterCommit(() => {
          throw new Error(`receipt for card ${CARD} failed`);
        });
      })
      .reply(() => ({ ok: true }));
    await runner.run(refund, { key: 'r-1' });
    await settle();
    await mod.close();
  });
  return capture;
}

describe('a policy never suppresses a line (SD-03)', () => {
  it('flow, hop and error lines are still emitted with a policy active', async () => {
    const without = countLines(await runFailures(undefined));
    const capture = await runFailures({
      packs: [Pack.SecretsV1, Pack.PersonalV1],
      fields: ['**.pan'],
    });
    const withPolicy = countLines(capture);
    expect(without).toEqual({
      flowStart: 1,
      flowEndError: 1,
      errorChannel: 1,
      hopStart: 1,
      hopEndFail: 1,
      hopError: 1,
    });
    expect(withPolicy).toEqual(without);
    expectNoLeak(capture, [CARD]);
  });
});

describe('profiles-only module options (SD-57)', () => {
  it('profiles-only module options do not opt durable scopes or taps in', async () => {
    const store = new MemoryIdempotencyStore();
    const warns: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => warns.push(String(message)) as never);
    const mod = await boot(
      {
        idempotency: { store },
        privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } },
      },
      [payFlow],
      [PlainPsp],
    );
    spy.mockRestore();
    expect(warns.filter((line) => line.includes('remember defaulted'))).toEqual([]);
    expect(mod.get(PrivacyEngine).rememberOf('activator:PlainPsp.charge')).toBe(
      Remember.Everything,
    );

    const audit = collect(mod, 'audit');
    const payload = { email: 'ana@example.com', amount: 1 };
    await mod.get(ChannelRegistry).send('pay.in', payload, { idempotencyKey: 'k-1' });
    await settle();
    expect(audit[0]?.payload).toBe(payload);
    expect(mod.get(PlainPsp).received[0]).toBe(payload);
    expect((await store.get('activator:PlainPsp.charge', 'k-1'))?.result).toEqual({
      cachedResult: payload,
    });
    await mod.close();
  });
});
