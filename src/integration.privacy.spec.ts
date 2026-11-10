import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { OutboundHttpError } from './outbound/outbound.errors';
import { IdempotencyInProgressError } from './saga/idempotency-ledger';
import { PrivacyEngine } from './sensitive/privacy-engine';
import { PrivacyConfigError } from './sensitive/privacy-errors';
import { captureTrail } from './testing/capture-trail';
import { expectNoLeak } from './testing/expect-no-leak';
import type { IntegrationMessage } from './message';

const SECRET1 = 'CANARYQUERY0001';
const SECRET2 = 'CANARYCOOKIE0002';
const SECRET3 = 'CANARYBODY0003';
const KEY = 'K-CANARY-555';

function outboundFailure(): OutboundHttpError {
  return new OutboundHttpError(
    {
      binding: 'psp',
      url: `https://u:p@h.example/x?api_key=${SECRET1}`,
      method: 'POST',
      attempts: 1,
    },
    502,
    'Bad Gateway',
    { 'set-cookie': SECRET2, 'content-type': 'application/json' },
    { token: SECRET3 },
  );
}

function failingFlow(error: () => unknown): FlowDefinition {
  return {
    name: 'pay',
    build: () =>
      IntegrationFlow.from('pay.in').handle(() => {
        throw error();
      }),
  };
}

async function boot(
  options: Partial<IntegrationModuleOptions>,
  flows: FlowDefinition[] = [],
  providers: (new (...args: never[]) => unknown)[] = [],
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        { channels: [{ name: 'pay.in', type: 'direct' }], ...options },
        flows,
      ),
    ],
    providers,
  }).compile();
  await mod.init();
  return mod;
}

function errorLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation((...args: unknown[]) => lines.push(args.map(String).join(' ')) as never);
  return { lines, restore: () => spy.mockRestore() };
}

async function runFailing(mod: TestingModule): Promise<void> {
  await mod
    .get(ChannelRegistry)
    .send('pay.in', { amount: 1 })
    .catch(() => undefined);
}

describe('S3 error.channel logger (SD-04, section 2)', () => {
  it('error.channel logger never prints raw OutboundHttpError url, headers or body', async () => {
    const mod = await boot({}, [failingFlow(outboundFailure)]);
    const { lines, restore } = errorLines();
    await runFailing(mod);
    restore();
    const line = lines.find((l) => l.startsWith('error.channel:')) ?? '';
    for (const leak of [SECRET1, SECRET2, SECRET3, 'u:p@', '?api_key']) {
      expect(line).not.toContain(leak);
    }
    expect(line).toContain('https://h.example/x');
    expect(line).toContain('"status":502');
    await mod.close();
  });

  it('error.channel logger with privacy false keeps only name, message, code, status, url', async () => {
    const mod = await boot({ privacy: false }, [failingFlow(outboundFailure)]);
    const { lines, restore } = errorLines();
    await runFailing(mod);
    restore();
    const line = lines.find((l) => l.startsWith('error.channel:')) ?? '';
    const payload = JSON.parse(line.slice('error.channel: '.length)) as {
      error: Record<string, unknown>;
    };
    expect(Object.keys(payload.error).sort()).toEqual(['message', 'name', 'status', 'url']);
    expect(payload.error.url).toBe('https://h.example/x');
    expect(line).not.toContain(SECRET1);
    expect(line).not.toContain(SECRET2);
    expect(line).not.toContain(SECRET3);
    await mod.close();
  });

  it('in-progress errors keep the key out of message and sinks', async () => {
    const mod = await boot({}, [
      failingFlow(() => new IdempotencyInProgressError('saga:pay', KEY)),
    ]);
    const { lines, restore } = errorLines();
    await runFailing(mod);
    restore();
    const line = lines.find((l) => l.startsWith('error.channel:')) ?? '';
    expect(line).toContain('IDEMPOTENCY_KEY_IN_PROGRESS: saga:pay');
    expect(line).not.toContain(KEY);
    await mod.close();
  });
});

describe('S4 error envelopes (SD-01, SD-27)', () => {
  function envelopes(mod: TestingModule): IntegrationMessage[] {
    const seen: IntegrationMessage[] = [];
    mod
      .get(ChannelRegistry)
      .get('error.channel')
      .subscribe((msg) => {
        seen.push(msg);
      });
    return seen;
  }

  it('compat: no privacy option keeps the raw error in the flow envelope', async () => {
    const thrown = outboundFailure();
    const mod = await boot({}, [failingFlow(() => thrown)]);
    const seen = envelopes(mod);
    const { restore } = errorLines();
    await runFailing(mod);
    restore();
    expect((seen[0]?.payload as { error: unknown }).error).toBe(thrown);
    await mod.close();
  });

  it('flow envelopes are hidden when an explicit privacy reaches the flow', async () => {
    const mod = await boot({ privacy: { fields: ['**.amount'] } }, [failingFlow(outboundFailure)]);
    const seen = envelopes(mod);
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), 'error.channel');
    const { restore } = errorLines();
    await runFailing(mod);
    restore();
    const error = (seen[0]?.payload as { error: Record<string, unknown> }).error;
    expect(error).not.toBeInstanceOf(Error);
    expect(error.url).toBe('https://h.example/x');
    expectNoLeak(capture, [SECRET1, SECRET2, SECRET3]);
    await mod.close();
  });
});

@Injectable()
class Upstream {
  @ServiceActivator('upstream.call')
  call(): never {
    throw new Error(`denied for token=${SECRET1}`);
  }
}

describe('PrivacyEngine provider (SD-39, SD-36, section 2)', () => {
  it('PrivacyEngine is injectable and scoped to its module', async () => {
    const a = await boot({ privacy: { patterns: [{ name: 'test.a', regex: /AAA\d{4}/ }] } });
    const b = await boot({ privacy: { patterns: [{ name: 'test.b', regex: /BBB\d{4}/ }] } });
    const engineA = a.get(PrivacyEngine);
    const engineB = b.get(PrivacyEngine);
    expect(engineA).not.toBe(engineB);
    expect(engineA.forLog('AAA1234 BBB1234')).toBe('[HIDDEN:test.a] BBB1234');
    expect(engineB.forLog('AAA1234 BBB1234')).toBe('AAA1234 [HIDDEN:test.b]');
    expect(engineA.errorForTrail(new Error('AAA1234'), { output: 'log' as never }).message).toBe(
      '[HIDDEN:test.a]',
    );
    await a.close();
    await b.close();
  });

  it('redactor is not called when no sink writes', async () => {
    const flow: FlowDefinition = {
      name: 'ok',
      build: () => IntegrationFlow.from('pay.in').handle((p) => p),
    };
    const mod = await boot({ privacy: { fields: ['**.amount'] } }, [flow]);
    const forTrail = jest.spyOn(PrivacyEngine.prototype, 'forTrail');
    const errorForTrail = jest.spyOn(PrivacyEngine.prototype, 'errorForTrail');
    for (let i = 0; i < 100; i++) await mod.get(ChannelRegistry).send('pay.in', { amount: i });
    expect(forTrail).not.toHaveBeenCalled();
    expect(errorForTrail).not.toHaveBeenCalled();
    forTrail.mockRestore();
    errorForTrail.mockRestore();
    await mod.close();
  });

  it('activator envelopes and the channel error envelope hide with the activator privacy', async () => {
    const mod = await boot(
      {
        channels: [
          { name: 'pay.in', type: 'direct' },
          { name: 'upstream.call', type: 'direct', privacy: { packs: ['secrets@1'] } },
        ],
      },
      [],
      [Upstream],
    );
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), 'error.channel');
    const { restore } = errorLines();
    await mod
      .get(ChannelRegistry)
      .send('upstream.call', {})
      .catch(() => undefined);
    restore();
    expect(capture.writes.length).toBeGreaterThan(0);
    expectNoLeak(capture, [SECRET1]);
    await mod.close();
  });

  it('a privacy reference on a channel fails boot when forRoot turns privacy off', async () => {
    await expect(
      boot({
        privacy: false,
        channels: [{ name: 'pay.in', type: 'direct', privacy: { fields: ['**.pan'] } }],
      }),
    ).rejects.toBeInstanceOf(PrivacyConfigError);
  });

  it('inbound discovery warn line is redacted', async () => {
    const spy = jest.spyOn(DiscoveryService.prototype, 'getControllers').mockImplementation(() => {
      throw new Error(`discovery broke near password=${SECRET1}`);
    });
    const lines: string[] = [];
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => lines.push(String(m)) as never);
    const mod = await boot({});
    spy.mockRestore();
    warn.mockRestore();
    const line = lines.find((l) => l.startsWith('inbound discovery skipped')) ?? '';
    expect(line).toContain('discovery broke');
    expect(line).not.toContain(SECRET1);
    await mod.close();
  });
});
