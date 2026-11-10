import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { ChannelGraph } from './graph/channel-graph';
import { IntegrationModule, type IntegrationModuleOptions } from './integration.module';
import { CareControl } from './resilience/registry';
import { CareConfigError } from './resilience/resilience.errors';
import { collectCareEvents } from './testing/resilience-events';
import type { OutboundFetch } from './outbound/outbound.types';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

@Injectable()
class QuotaActivator {
  calls = 0;

  @ServiceActivator('quota.in', {
    care: {
      classify: () => 'quota',
      valve: { quotaShutMs: 'until-resumed' },
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

describe('IntegrationModule.forRoot({ care })', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('RE-07 an invalid care option fails module boot', async () => {
    await expect(
      boot({
        care: {},
        outbound: {
          rest: {
            bindings: [
              {
                name: 'pay',
                url: 'https://pay.example/x',
                care: { tries: { max: 0 } },
              },
            ],
          },
        },
      }),
    ).rejects.toThrow(CareConfigError);
    await expect(
      boot({
        care: {},
        outbound: {
          rest: {
            bindings: [{ name: 'pay', url: 'https://pay.example/x', care: 'unknown' }],
          },
        },
      }),
    ).rejects.toThrow("pay: care.use unknown profile 'unknown'");
  });

  it('RU-49 resume closes a manual quota opening through the injectable registry', async () => {
    const moduleRef = await boot({ care: {} });
    const registry = moduleRef.get(ChannelRegistry);
    const events = collectCareEvents(moduleRef);
    const activator = moduleRef.get(QuotaActivator);
    await expect(registry.send('quota.in', {})).rejects.toThrow('flaky');
    await expect(registry.send('quota.in', {})).rejects.toThrow('valve shut');
    const resilience = moduleRef.get(CareControl);
    const binding = 'activator:QuotaActivator.run';
    expect(resilience.valveState(binding)).toEqual({ state: 'shut', forcedBy: 'quota' });
    await resilience.resume(binding);
    expect(resilience.valveState(binding)).toEqual({ state: 'flowing' });
    await registry.send('quota.in', {});
    expect(activator.calls).toBe(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.types()).toEqual(['valve.forced-shut', 'quota.used-up', 'valve.flowing']);
    expect(resilience.valveState('unknown')).toBeUndefined();
    await expect(resilience.resume('unknown', 'k')).resolves.toBeUndefined();
    await moduleRef.close();
  });

  it('provides CareControl only under forRoot({ care }) and keeps the graph unchanged without profiles', async () => {
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
    expect(() => plain.get(CareControl)).toThrow();
    const snapshot = plain.get(ChannelGraph).snapshot(plain.get(ChannelRegistry));
    expect(JSON.stringify(snapshot)).not.toContain('policy');
    expect(plain.get(ChannelRegistry).tryGet('estela.care.events')).toBeUndefined();
    await plain.close();
  });

  it('RU-42 graph shows the care summary on outbound refs and activator labels', async () => {
    const moduleRef = await boot({
      care: { events: { channel: false } },
      outbound: {
        rest: {
          bindings: [
            {
              channel: 'pay.out',
              url: 'https://pay.example/charges?token=s',
              fetchFn: okFetch,
              care: {
                patience: { eachTryMs: 2000 },
                tries: { max: 3 },
                valve: {},
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
        care: 'patience 2s · tries x3 · valve',
      },
    ]);
    const quota = graph.nodes.find((node) => node.channel === 'quota.in');
    expect(quota?.activators).toEqual(['QuotaActivator.run [valve]']);
    expect(graph.mermaid).toContain('[patience 2s · tries x3 · valve]');
    expect(graph.mermaid).not.toContain('token');
    expect(moduleRef.get(ChannelRegistry).tryGet('estela.care.events')).toBeUndefined();
    await moduleRef.close();
  });
});
