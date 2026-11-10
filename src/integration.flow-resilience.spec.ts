import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { ChannelGraph } from './graph/channel-graph';
import {
  IntegrationModule,
  CARE_ENGINE,
  type IntegrationModuleOptions,
} from './integration.module';
import { CareConfigError } from './resilience/resilience.errors';
import type { CareEngine } from './resilience/runtime';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

@Injectable()
class StackedActivator {
  calls = 0;

  @ServiceActivator('c')
  run(): never {
    this.calls += 1;
    throw flaky();
  }
}

@Injectable()
class ChannelPolicyActivator {
  calls = 0;

  @ServiceActivator('act.in')
  run(): string {
    this.calls += 1;
    if (this.calls === 1) throw flaky();
    return 'ok';
  }
}

@Injectable()
class ProfileActivator {
  @ServiceActivator('profiled.in', { care: 'act-std' })
  run(): string {
    return 'ok';
  }
}

const flowOf = (name: string, build: () => IntegrationFlow): FlowDefinition => ({ name, build });

async function boot(
  options: Partial<IntegrationModuleOptions>,
  flows: FlowDefinition[],
  providers: unknown[] = [],
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({ channels: [], logging: { banner: false }, ...options }, flows),
    ],
    providers: providers as never[],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('IntegrationModule flow parameters (RS-56, RS-66, RS-67)', () => {
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('RU-56 channel care applies to senders into the channel and activators on it, never to inbound or to handle steps', async () => {
    const moduleRef = await boot(
      {
        care: {},
        channels: [
          { name: 'in', type: 'direct' },
          {
            name: 'c',
            type: 'direct',
            care: { tries: { max: 3, idempotent: true, spacing: 0 } },
          },
          { name: 'c.src', type: 'direct', care: { tries: { max: 3 } } },
        ],
      },
      [
        flowOf('sender', () => IntegrationFlow.from('in').to('c')),
        flowOf('own', () => IntegrationFlow.from('c.src').handle((p) => p)),
      ],
      [StackedActivator],
    );
    const stacked = warnings.filter((line) => line.startsWith('TRIES_STACKED'));
    expect(stacked).toHaveLength(1);
    expect(stacked[0]).toContain("flow 'sender' step 'to#0' target 'c'");
    expect(stacked[0]).toContain('activator StackedActivator.run');

    const registry = moduleRef.get(ChannelRegistry);
    const snapshot = moduleRef.get(ChannelGraph).snapshot(registry);
    expect(snapshot.flows.find((flow) => flow.name === 'own')?.steps).toEqual([{ kind: 'handle' }]);
    await expect(registry.send('in', 'x')).rejects.toThrow('flaky');
    expect(moduleRef.get(StackedActivator).calls).toBe(3);
    await moduleRef.close();
  });

  it('RU-56 an activator without its own care inherits the care of its channel', async () => {
    const moduleRef = await boot(
      {
        channels: [
          {
            name: 'act.in',
            type: 'direct',
            care: { tries: { max: 2, idempotent: true, spacing: 0 } },
          },
        ],
      },
      [],
      [ChannelPolicyActivator],
    );
    await moduleRef.get(ChannelRegistry).send('act.in', 'x');
    expect(moduleRef.get(ChannelPolicyActivator).calls).toBe(2);
    await moduleRef.close();
  });

  it('RU-66b graph shows step id, care and repeatableBy only on configured steps', async () => {
    const plain = (): IntegrationFlow =>
      IntegrationFlow.from('p.in')
        .filter(() => true)
        .jump('svc')
        .fanoutTo(['a', 'b'])
        .to('out');
    const moduleRef = await boot(
      {
        care: { profiles: { 'jump-sla': { patience: { eachTryMs: 3000 } } } },
        channels: [
          { name: 'p.in', type: 'direct' },
          { name: 'l.in', type: 'direct' },
          { name: 'svc', type: 'direct' },
          { name: 'guarded', type: 'direct', care: { tries: { max: 2 } } },
        ],
      },
      [
        flowOf('plain', plain),
        flowOf('loan', () =>
          IntegrationFlow.from('l.in')
            .jump('svc', {
              id: 'credit',
              care: { use: 'jump-sla', tries: { max: 2, idempotent: true } },
            })
            .handle((p) => p, { id: 'enrich' })
            .to('guarded'),
        ),
      ],
    );
    const snapshot = moduleRef.get(ChannelGraph).snapshot(moduleRef.get(ChannelRegistry));
    const flows = Object.fromEntries(snapshot.flows.map((flow) => [flow.name, flow.steps]));
    expect(flows.plain).toEqual(plain().inspect().steps);
    expect(flows.loan).toEqual([
      {
        kind: 'jump',
        id: 'credit',
        dests: [{ channel: 'svc', care: 'patience 3s · tries x2', repeatableBy: 'declared' }],
      },
      { kind: 'handle', id: 'enrich' },
      { kind: 'to', id: 'to#2', channel: 'guarded', care: 'tries x2', repeatableBy: 'key' },
    ]);
    const guarded = snapshot.nodes.find((node) => node.channel === 'guarded');
    expect(guarded?.care).toBe('tries x2');
    expect(snapshot.nodes.find((node) => node.channel === 'svc')).not.toHaveProperty('care');
    expect(snapshot.module).toEqual({ careProfiles: ['jump-sla'] });
    expect(snapshot.mermaid).toContain('direct: guarded [tries x2]');
    await moduleRef.close();
  });

  it('RU-66b a module without flow parameters keeps the 0.9.0 graph keys', async () => {
    const moduleRef = await boot({ channels: [{ name: 'x', type: 'direct' }] }, [
      flowOf('f', () => IntegrationFlow.from('x').to('y')),
    ]);
    const snapshot = moduleRef.get(ChannelGraph).snapshot(moduleRef.get(ChannelRegistry));
    expect(Object.keys(snapshot)).toEqual(['nodes', 'edges', 'flows', 'mermaid']);
    expect(snapshot.nodes.every((node) => !('care' in node))).toBe(true);
    await moduleRef.close();
  });

  it('RU-67 FlowParameterResolver collects every finding, throws once, and runs before activators bind', async () => {
    let failure: unknown;
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            channels: [{ name: 'profiled.in', type: 'direct' }],
            logging: { banner: false },
            care: { profiles: { 'act-std': { tries: { max: 2 } } } },
          },
          [
            flowOf('a', () => IntegrationFlow.from('a.in').to('x', { care: 'missing-a' })),
            flowOf('b', () => IntegrationFlow.from('b.in').jump('y', { care: 'missing-b' })),
          ],
        ),
      ],
      providers: [ProfileActivator],
    }).compile();
    try {
      await moduleRef.init();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CareConfigError);
    expect((failure as CareConfigError).findings.map((f) => f.code)).toEqual([
      'UNKNOWN_PROFILE',
      'UNKNOWN_PROFILE',
    ]);
    // The boot failed before step 2: the activator never subscribed.
    await expect(moduleRef.get(ChannelRegistry).send('profiled.in', 'x')).rejects.toThrow(
      /subscriber/,
    );

    const ok = await boot(
      {
        channels: [{ name: 'profiled.in', type: 'direct' }],
        care: { profiles: { 'act-std': { tries: { max: 2 } } } },
      },
      [],
      [ProfileActivator],
    );
    await expect(ok.get(ChannelRegistry).send('profiled.in', 'x')).resolves.toBeUndefined();
    await ok.close();
  });

  it('RU-67 flow-shape findings fail the boot with FlowDefinitionError', async () => {
    await expect(
      boot({ channels: [{ name: 'd.in', type: 'direct' }] }, [
        flowOf('dup', () =>
          IntegrationFlow.from('d.in')
            .handle((p) => p, { id: 'x' })
            .to('d.out', { id: 'x' }),
        ),
      ]),
    ).rejects.toMatchObject({
      name: 'FlowDefinitionError',
      findings: [
        expect.objectContaining({ code: 'DUPLICATE_STEP_ID', subject: "flow 'dup' step 'x'" }),
      ],
    });
  });

  it('RU-62c application shutdown aborts the background tries of the runtime', async () => {
    const moduleRef = await boot({ channels: [] }, []);
    const runtime = moduleRef.get<CareEngine>(CARE_ENGINE);
    expect(runtime.shutdownSignal.aborted).toBe(false);
    await moduleRef.close();
    expect(runtime.shutdownSignal.aborted).toBe(true);
  });
});
