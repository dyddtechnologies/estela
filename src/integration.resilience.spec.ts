import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { ChannelGraph } from './graph/channel-graph';
import { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
import { ResilienceRegistry } from './resilience/registry';
import { ResilienceDefinitionError } from './resilience/resilience.errors';
import { collectResilienceEvents } from './testing/resilience-events';
import type { OutboundFetch } from './outbound/outbound.types';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

@Injectable()
class QuotaActivator {
  calls = 0;

  @ServiceActivator('quota.in', {
    resilience: {
      classify: () => 'quota',
      circuitBreaker: { quotaOpenMs: 'manual' },
    },
  })
  run(): string {
    this.calls += 1;
    if (this.calls === 1) throw flaky();
    return 'ok';
  }
}

const okFetch: OutboundFetch = () =>
  Promise.resolve({ ok: true, status: 200, headers: {}, text: () => Promise.resolve('{}') });

async function boot(
  options: Partial<IntegrationModuleOptions>,
  providers: unknown[] = [QuotaActivator],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({
        channels: [
          { name: 'quota.in', type: 'direct' },
          { name: 'pay.out', type: 'direct' },
        ],
        logging: { banner: false },
        ...options,
      }),
    ],
    providers: providers as never[],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('IntegrationModule.forRoot({ resilience })', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('RE-07 an invalid resilience option fails module boot', async () => {
    await expect(
      boot({
        resilience: {},
        outbound: {
          rest: {
            bindings: [
              {
                name: 'pay',
                url: 'https://pay.example/x',
                resilience: { retry: { maxAttempts: 0 } },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(ResilienceDefinitionError);
    await expect(
      boot({
        resilience: {},
        outbound: {
          rest: {
            bindings: [{ name: 'pay', url: 'https://pay.example/x', resilience: 'unknown' }],
          },
        },
      }),
    ).rejects.toThrow("pay: resilience.use names an unknown policy 'unknown'");
  });

  it('RU-49 resetBreaker closes a manual quota opening through the injectable registry', async () => {
    const moduleRef = await boot({ resilience: {} });
    const registry = moduleRef.get(ChannelRegistry);
    const events = collectResilienceEvents(moduleRef);
    const activator = moduleRef.get(QuotaActivator);
    await expect(registry.send('quota.in', {})).rejects.toThrow('flaky');
    await expect(registry.send('quota.in', {})).rejects.toThrow('circuit open');
    const resilience = moduleRef.get(ResilienceRegistry);
    const binding = 'activator:QuotaActivator.run';
    expect(resilience.breakerState(binding)).toEqual({ state: 'open', forcedBy: 'quota' });
    await resilience.resetBreaker(binding);
    expect(resilience.breakerState(binding)).toEqual({ state: 'closed' });
    await registry.send('quota.in', {});
    expect(activator.calls).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.types()).toEqual(['breaker.forced-open', 'quota.exhausted', 'breaker.closed']);
    expect(resilience.breakerState('unknown')).toBeUndefined();
    await expect(resilience.resetBreaker('unknown', 'k')).resolves.toBeUndefined();
    await moduleRef.close();
  });

  it('provides ResilienceRegistry only under forRoot({ resilience }) and keeps the graph unchanged without policies', async () => {
    const plain = await boot(
      {
        outbound: {
          rest: {
            bindings: [{ channel: 'pay.out', url: 'https://pay.example/x', fetchFn: okFetch }],
          },
        },
      },
      [],
    );
    expect(() => plain.get(ResilienceRegistry)).toThrow();
    const snapshot = plain.get(ChannelGraph).snapshot(plain.get(ChannelRegistry));
    expect(JSON.stringify(snapshot)).not.toContain('policy');
    expect(plain.get(ChannelRegistry).tryGet('estela.resilience.events')).toBeUndefined();
    await plain.close();
  });

  it('RU-42 graph shows the policy summary on outbound refs and activator labels', async () => {
    const moduleRef = await boot({
      resilience: { events: { channel: false } },
      outbound: {
        rest: {
          bindings: [
            {
              channel: 'pay.out',
              url: 'https://pay.example/charges?token=s',
              fetchFn: okFetch,
              resilience: {
                timeout: { perAttemptMs: 2000 },
                retry: { maxAttempts: 3 },
                circuitBreaker: {},
              },
            },
          ],
        },
      },
    });
    const graph = moduleRef.get(ChannelGraph).snapshot(moduleRef.get(ChannelRegistry));
    const pay = graph.nodes.find((node) => node.channel === 'pay.out');
    expect(pay?.outbounds).toEqual([
      {
        transport: 'rest',
        target: 'POST https://pay.example/charges',
        policy: 'timeout 2s · retry x3 · breaker',
      },
    ]);
    const quota = graph.nodes.find((node) => node.channel === 'quota.in');
    expect(quota?.activators).toEqual(['QuotaActivator.run [breaker]']);
    expect(graph.mermaid).toContain('[timeout 2s · retry x3 · breaker]');
    expect(graph.mermaid).not.toContain('token');
    expect(moduleRef.get(ChannelRegistry).tryGet('estela.resilience.events')).toBeUndefined();
    await moduleRef.close();
  });
});
