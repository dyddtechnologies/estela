import 'reflect-metadata';

import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator } from '../decorators';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import type { CareEvent } from '../resilience/resilience.types';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const SECRET = 'XSECRET1234';
const TEST_X = { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] };
const EVENTS = 'estela.care.events';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

const failing = (): never => {
  throw Object.assign(new Error(`partner refused ${SECRET}`), { retryable: true });
};

/** A valve per tenant whose key, and so the app `keyLabel`, carries the secret. */
const valve = {
  key: (): string => `tenant.${SECRET}`,
  minCalls: 2,
  failPercent: 50,
  shutMs: 60_000,
};

@Injectable()
class Partner {
  @ServiceActivator('partner.call', {
    privacy: TEST_X,
    care: { tries: { max: 2, spacing: 0, idempotent: true }, valve },
  })
  call(): never {
    return failing();
  }
}

async function boot(
  options: Partial<IntegrationModuleOptions>,
  flows: FlowDefinition[],
  providers: unknown[] = [],
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        {
          channels: [
            { name: 'loan.in', type: 'direct' },
            { name: 'partner.call', type: 'direct' },
          ],
          care: { keyLabel: (key) => key },
          logging: { banner: false },
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

function eventsOf(mod: TestingModule): CareEvent[] {
  const seen: CareEvent[] = [];
  mod
    .get(ChannelRegistry)
    .get(EVENTS)
    .subscribe((msg) => {
      seen.push(msg.payload as CareEvent);
    });
  return seen;
}

describe('care events are trail copies of their subject (SD-62)', () => {
  it('care events are redacted with the step privacy', async () => {
    const flow: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.in').handle(failing, {
          id: 'enrich',
          care: { tries: { max: 2, spacing: 0, idempotent: true }, valve },
          privacy: TEST_X,
        }),
    };
    const mod = await boot({}, [flow]);
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), EVENTS);
    capture.channel(mod.get(ChannelRegistry), 'error.channel');
    const events = eventsOf(mod);
    await mod
      .get(ChannelRegistry)
      .send('loan.in', { amount: 1 })
      .catch(() => undefined);
    await settle();

    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(['try.again', 'valve.shut']),
    );
    expect(events.find((event) => event.type === 'try.again')).toMatchObject({
      edge: 'flow-handle',
      binding: 'flow:loan#enrich',
    });
    expect(events.find((event) => event.type === 'valve.shut')?.keyLabel).toBe(
      'tenant.[HIDDEN:test.x]',
    );
    const envelope = capture.writes.find((write) => write.where === 'channel error.channel');
    expect(envelope?.text).toContain('[HIDDEN:test.x]');
    expectNoLeak(capture, [SECRET]);
    await mod.close();
  });

  it('SD-62 activator care events use the activator privacy', async () => {
    const mod = await boot({}, [], [Partner]);
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), EVENTS);
    const events = eventsOf(mod);
    await mod
      .get(ChannelRegistry)
      .send('partner.call', {})
      .catch(() => undefined);
    await settle();

    expect(events.find((event) => event.type === 'valve.shut')).toMatchObject({
      edge: 'activator',
      binding: 'activator:Partner.call',
      keyLabel: 'tenant.[HIDDEN:test.x]',
    });
    expectNoLeak(capture, [SECRET]);
    await mod.close();
  });

  it('SD-62 without privacy a care event keeps the app key label as in SPI-445', async () => {
    const flow: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.in').handle(failing, {
          id: 'enrich',
          care: { tries: { max: 2, spacing: 0, idempotent: true }, valve },
        }),
    };
    const mod = await boot({}, [flow]);
    const events = eventsOf(mod);
    await mod
      .get(ChannelRegistry)
      .send('loan.in', { amount: 1 })
      .catch(() => undefined);
    await settle();
    expect(events.find((event) => event.type === 'valve.shut')?.keyLabel).toBe(`tenant.${SECRET}`);
    await mod.close();
  });
});
