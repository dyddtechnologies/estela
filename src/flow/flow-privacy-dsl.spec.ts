import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from '../channel-registry';
import { ChannelGraph } from '../graph/channel-graph';
import { IntegrationModule } from '../integration.module';
import type { IntegrationMessage } from '../message';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import type { PrivacyRef } from '../sensitive/privacy.types';
import { FlowDefinitionError } from './flow-definition-error';
import { serializeError, type FlowStep } from './flow-step';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const CARD: PrivacyRef = 'card';
const SSN: PrivacyRef = { fields: ['ssn'] };

/** Every DSL step except `reply`, each with an id and a privacy reference. */
function everyStepWith(privacy: PrivacyRef): IntegrationFlow {
  return IntegrationFlow.from('in')
    .filter(() => true, { id: 'filter', privacy })
    .transform((p) => p, { id: 'transform', privacy })
    .headers({ tenant: 'acme' }, { id: 'headers', privacy })
    .handle((p) => p, { id: 'handle', privacy })
    .wireTap('audit', { id: 'tap', privacy })
    .fanoutTo(['a'], { id: 'fanout', privacy })
    .jumpTo(['b'], { id: 'jumps', privacy })
    .jump('c', { id: 'jump', privacy })
    .publish('d', { id: 'publish', privacy })
    .publish('e', 'rk', { id: 'publish-rk', privacy })
    .route(() => 'f', { id: 'route', privacy })
    .to('g', { id: 'to', privacy });
}

/** The same flow without any option: the 0.9.0 spelling. */
function everyStepBare(): IntegrationFlow {
  return IntegrationFlow.from('in')
    .filter(() => true)
    .transform((p) => p)
    .headers({ tenant: 'acme' })
    .handle((p) => p)
    .wireTap('audit')
    .fanoutTo(['a'])
    .jumpTo(['b'])
    .jump('c')
    .publish('d')
    .publish('e', 'rk')
    .route(() => 'f')
    .to('g');
}

describe('flow DSL privacy references (SD-46, SD-47, SD-67 types)', () => {
  it('SD-46 from(source, { privacy }) keeps the L3 reference in BuiltFlow.options', () => {
    const built = IntegrationFlow.from('in', { privacy: 'personal' }).to('out').build();
    expect(built.options?.privacy).toBe('personal');
    const both = IntegrationFlow.from('in', { privacy: SSN, care: { send: 'quick' } })
      .to('out')
      .build();
    expect(both.options).toEqual({ privacy: SSN, care: { send: 'quick' } });
  });

  it('SD-47 every step except reply captures its privacy reference in StepParams', () => {
    const built = everyStepWith(CARD).build();
    expect(built.steps.map((step) => [step.params?.id, step.params?.privacy])).toEqual([
      ['filter', CARD],
      ['transform', CARD],
      ['headers', CARD],
      ['handle', CARD],
      ['tap', CARD],
      ['fanout', CARD],
      ['jumps', CARD],
      ['jump', CARD],
      ['publish', CARD],
      ['publish-rk', CARD],
      ['route', CARD],
      ['to', CARD],
    ]);
  });

  it('SD-47 a step without privacy carries no privacy key', () => {
    const built = everyStepBare().reply().build();
    for (const step of built.steps) expect(step.params ?? {}).not.toHaveProperty('privacy');
  });

  it('SD-47 each target keeps its own privacy reference; siblings stay without one', () => {
    const built = IntegrationFlow.from('in')
      .fanoutTo(
        [
          { channel: 'a', wait: false, privacy: SSN },
          { channel: 'b', wait: false },
        ],
        { id: 'spread' },
      )
      .jumpTo(['c', { channel: 'd', privacy: ['card', 'personal'] }], { privacy: 'personal' })
      .build();
    const [fanout, jump] = built.steps as [FlowStep, FlowStep];
    expect(fanout.params?.targets).toEqual([
      { channel: 'a', wait: false, privacy: SSN },
      { channel: 'b', wait: false },
    ]);
    expect(fanout.params).not.toHaveProperty('privacy');
    expect(jump.params?.privacy).toBe('personal');
    expect(jump.params?.targets).toEqual([
      { channel: 'c' },
      { channel: 'd', privacy: ['card', 'personal'] },
    ]);
  });

  it('SD-47 jump(channel, { privacy }) carries the reference as the step privacy', () => {
    const built = IntegrationFlow.from('in')
      .jump('c', { wait: false, timeoutMs: 50, id: 'j', privacy: SSN })
      .build();
    const step = built.steps[0];
    expect(step?.params?.privacy).toBe(SSN);
    expect(step?.params?.targets).toEqual([{ channel: 'c', wait: false, timeoutMs: 50 }]);
  });

  it('SD-47 reply takes an id only, never a privacy reference', () => {
    const flow = IntegrationFlow.from('in');
    // @ts-expect-error -- reply keeps the caller's data and has no privacy option (18.3)
    flow.reply({ id: 'r', privacy: 'card' });
    expect(flow.build().steps[0]?.params).toEqual({ id: 'r' });
  });

  it('SD-65 describe() never shows a privacy reference', () => {
    const withPrivacy = everyStepWith(CARD)
      .fanoutTo([{ channel: 'x', wait: false, privacy: SSN }])
      .inspect();
    const bare = everyStepBare()
      .fanoutTo([{ channel: 'x', wait: false }])
      .inspect();
    expect(withPrivacy).toEqual(bare);
    expect(JSON.stringify(withPrivacy)).not.toContain('privacy');
  });

  it('SD-67 privacy members ride on the SPI-445 scaffolding: duplicate ids still fail once', () => {
    let error: unknown;
    try {
      IntegrationFlow.from('in', { privacy: 'personal' })
        .handle((p) => p, { id: 'x', privacy: SSN })
        .to('out', { id: 'x', privacy: CARD })
        .build();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FlowDefinitionError);
    expect((error as FlowDefinitionError).codes).toEqual(['DUPLICATE_STEP_ID']);
  });
});

const channels = [
  { name: 'pay.in', type: 'direct' as const },
  { name: 'audit', type: 'pubsub' as const },
  { name: 'refuse', type: 'direct' as const },
  { name: 'sink', type: 'pubsub' as const },
];

async function boot(flows: FlowDefinition[]): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels }, flows)],
  }).compile();
  await mod.init();
  return mod;
}

function collect(mod: TestingModule, name: string): IntegrationMessage[] {
  const seen: IntegrationMessage[] = [];
  mod
    .get(ChannelRegistry)
    .get(name)
    .subscribe((msg) => {
      seen.push(msg);
    });
  return seen;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('flow DSL compatibility (SD-65)', () => {
  it('compat: flow DSL without options keeps 0.9.0 describe output, tap copies and envelopes', async () => {
    const flow: FlowDefinition = {
      name: 'legacy',
      build: () =>
        IntegrationFlow.from('pay.in')
          .wireTap('audit')
          .fanoutTo([{ channel: 'refuse', wait: false }])
          .jump('refuse', { wait: false })
          .to('sink'),
    };
    const steps0_9_0 = [
      { kind: 'wireTap', channel: 'audit' },
      { kind: 'fanout', dests: [{ channel: 'refuse', wait: false }] },
      { kind: 'jump', dests: [{ channel: 'refuse', wait: false }] },
      { kind: 'to', channel: 'sink' },
    ];
    expect(flow.build().inspect().steps).toEqual(steps0_9_0);

    const mod = await boot([flow]);
    const graph = mod.get(ChannelGraph).snapshot(mod.get(ChannelRegistry));
    expect(graph.flows).toEqual([{ name: 'legacy', source: 'pay.in', steps: steps0_9_0 }]);
    expect(graph).not.toHaveProperty('module');

    const refused = new Error('target refused');
    mod
      .get(ChannelRegistry)
      .get('refuse')
      .subscribe(() => Promise.reject(refused));
    const audit = collect(mod, 'audit');
    const sink = collect(mod, 'sink');
    const errors = collect(mod, 'error.channel');
    const quiet = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const payload = { amount: 1 };
    await mod.get(ChannelRegistry).send('pay.in', payload);
    await settle();
    await settle();
    quiet.mockRestore();

    expect(audit[0]?.payload).toBe(payload);
    expect(sink[0]?.payload).toBe(payload);
    const envelopes = errors.map((msg) => msg.payload);
    expect(envelopes).toHaveLength(2);
    for (const envelope of envelopes) {
      expect(envelope).toEqual({
        fireAndForget: true,
        channel: 'refuse',
        error: serializeError(refused),
        flow: 'legacy',
      });
    }
    await mod.close();
  });

  it('compat: a successful flow without options never calls the redactor (SD-65, SD-36)', async () => {
    const flow: FlowDefinition = {
      name: 'ok',
      build: () =>
        IntegrationFlow.from('pay.in')
          .wireTap('audit')
          .handle((p) => p)
          .to('sink'),
    };
    const mod = await boot([flow]);
    const forTrail = jest.spyOn(PrivacyEngine.prototype, 'forTrail');
    const errorForTrail = jest.spyOn(PrivacyEngine.prototype, 'errorForTrail');
    for (let i = 0; i < 20; i++) await mod.get(ChannelRegistry).send('pay.in', { amount: i });
    await settle();
    expect(forTrail).not.toHaveBeenCalled();
    expect(errorForTrail).not.toHaveBeenCalled();
    forTrail.mockRestore();
    errorForTrail.mockRestore();
    await mod.close();
  });
});
