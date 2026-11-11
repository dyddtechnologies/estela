import 'reflect-metadata';

import { Body, Controller, Injectable, Post } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from '../channel-registry';
import { IntegrationFlow, type FlowDefinition } from '../flow/integration-flow';
import { TapCopy } from '../flow/flow-step';
import { InboundRest } from '../inbound/inbound.decorators';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { OutboundRest } from '../outbound/outbound.decorators';
import type { OutboundFetch, OutboundRestTarget } from '../outbound/outbound.types';
import { Reach, Remember, Show } from '../sensitive/privacy.types';
import { ChannelGraph, type GraphSnapshot } from './channel-graph';
import { ChannelGraphController } from './channel-graph.controller';

const EXEMPT_REASON = 'audit-team-needs-memo-zqx';
const REACH_REASON = 'partner-must-not-see-pan-zqx';
const COPY_REASON = 'replay-tool-needs-original-zqx';
const REMEMBER_REASON = 'support-reads-requests-zqx';

const fetchFn: OutboundFetch = async () => ({
  ok: true,
  status: 200,
  headers: {},
  text: async () => '',
});

@Injectable()
class Crm {
  @OutboundRest({ channel: 'crm.push', privacy: 'personal' })
  push(): OutboundRestTarget {
    return { url: 'https://crm.example/contacts' };
  }
}

@Controller()
class SignupApi {
  @Post('signup')
  @InboundRest({
    channel: 'signup.in',
    privacy: { use: 'personal', remember: Remember.AsShown, rememberReason: REMEMBER_REASON },
  })
  signup(@Body() body: unknown): unknown {
    return body;
  }
}

const flowOf = (name: string, build: () => IntegrationFlow): FlowDefinition => ({ name, build });

async function boot(
  options: Partial<IntegrationModuleOptions>,
  flows: FlowDefinition[],
  extra: { controllers?: unknown[]; providers?: unknown[] } = {},
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({ channels: [], logging: { banner: false }, ...options }, flows),
    ],
    controllers: (extra.controllers ?? []) as never[],
    providers: (extra.providers ?? []) as never[],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

/** What `GET /integration/graph` serves: the controller's handler, as JSON. */
function graphJson(moduleRef: TestingModule): { json: string; snapshot: GraphSnapshot } {
  const snapshot = moduleRef.get(ChannelGraphController).graphSnapshot();
  const json = JSON.stringify(snapshot);
  return { json, snapshot: JSON.parse(json) as GraphSnapshot };
}

const CHANNELS = [
  { name: 'pay.in', type: 'direct' as const },
  { name: 'pay.out', type: 'direct' as const },
  { name: 'audit', type: 'pubsub' as const },
  { name: 'ledger', type: 'direct' as const, privacy: 'card' },
  { name: 'notify', type: 'direct' as const },
];

const PROFILES = {
  personal: { fields: ['**.email'] },
  card: { fields: ['**.pan'] },
};

describe('graph privacy annotations (SD-59)', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('graph shows privacy profile names only, never rules or reasons', async () => {
    moduleRef = await boot(
      {
        channels: [
          ...CHANNELS,
          { name: 'signup.in', type: 'direct' },
          { name: 'crm.push', type: 'direct' },
        ],
        privacy: { profiles: PROFILES },
        inbound: { privacy: 'personal' },
        outbound: { rest: { defaults: { fetchFn } } },
      },
      [
        flowOf('pay', () =>
          IntegrationFlow.from('pay.in', { privacy: 'personal' })
            .handle((p) => p, {
              id: 'check',
              privacy: {
                use: 'personal',
                fields: ['**.ssn'],
                exempt: [{ path: '**.memo', show: Show.Length, reason: EXEMPT_REASON }],
              },
            })
            .transform((p) => p, {
              id: 'mask',
              privacy: { fields: ['**.cvv'], reach: Reach.Delivery, reachReason: REACH_REASON },
            })
            .wireTap('audit', { id: 'tap', copy: TapCopy.Original, copyReason: COPY_REASON })
            .fanoutTo(['pay.out', { channel: 'notify', privacy: 'card' }], { id: 'spread' })
            .to('ledger'),
        ),
      ],
      { controllers: [SignupApi], providers: [Crm] },
    );
    const { json, snapshot } = graphJson(moduleRef);
    const pay = snapshot.flows.find((flow) => flow.name === 'pay');
    expect(pay?.options).toEqual({ privacy: ['secrets@1', 'personal'] });
    expect(pay?.steps[0]).toEqual({
      kind: 'handle',
      id: 'check',
      privacy: ['secrets@1', 'personal', 'inline'],
    });
    expect(pay?.steps[1]).toEqual({
      kind: 'transform',
      id: 'mask',
      privacy: ['secrets@1', 'personal', 'inline'],
    });
    expect(pay?.steps[2]).toEqual({
      kind: 'wireTap',
      id: 'tap',
      channel: 'audit',
      privacy: ['secrets@1', 'personal'],
    });
    expect(pay?.steps[3]).toEqual({
      kind: 'fanout',
      id: 'spread',
      dests: [
        { channel: 'pay.out', privacy: ['secrets@1', 'personal'] },
        { channel: 'notify', privacy: ['secrets@1', 'personal', 'card'] },
      ],
      privacy: ['secrets@1', 'personal', 'card'],
    });
    expect(pay?.steps[4]).toEqual({
      kind: 'to',
      id: 'to#4',
      channel: 'ledger',
      privacy: ['secrets@1', 'card', 'personal'],
    });
    const node = (name: string) => snapshot.nodes.find((n) => n.channel === name);
    expect(node('ledger')?.privacy).toEqual(['secrets@1', 'card']);
    expect(node('pay.in')).not.toHaveProperty('privacy');
    expect(node('signup.in')?.inbounds[0]?.privacy).toEqual(['secrets@1', 'personal', 'inline']);
    expect(node('crm.push')?.outbounds[0]?.privacy).toEqual(['secrets@1', 'personal']);
    expect(snapshot.module).toEqual({ privacyProfiles: ['card', 'personal'] });
    for (const secret of [
      'ssn',
      'memo',
      'cvv',
      'email',
      'pan',
      EXEMPT_REASON,
      REACH_REASON,
      COPY_REASON,
      REMEMBER_REASON,
      'reach',
      'copy',
      'remember',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('SD-59 a flow without privacy keeps the 0.9.0 graph: no privacy key and no module block', async () => {
    const plain = (): IntegrationFlow =>
      IntegrationFlow.from('pay.in')
        .handle((p) => p)
        .wireTap('audit')
        .fanoutTo(['pay.out', 'notify'])
        .to('ledger');
    moduleRef = await boot({ channels: CHANNELS.map(({ name, type }) => ({ name, type })) }, [
      flowOf('plain', plain),
    ]);
    const { json, snapshot } = graphJson(moduleRef);
    expect(snapshot.flows).toEqual([
      { name: 'plain', source: 'pay.in', steps: plain().inspect().steps },
    ]);
    expect(snapshot).not.toHaveProperty('module');
    expect(json).not.toContain('privacy');
  });

  it('SD-59 module rules alone add no privacy key; declared profiles are listed by name', async () => {
    moduleRef = await boot(
      {
        channels: CHANNELS.map(({ name, type }) => ({ name, type })),
        privacy: { fields: ['**.token'], profiles: PROFILES },
      },
      [
        flowOf('plain', () =>
          IntegrationFlow.from('pay.in')
            .handle((p) => p)
            .to('ledger'),
        ),
      ],
    );
    const { json, snapshot } = graphJson(moduleRef);
    expect(snapshot.flows[0]).toEqual({
      name: 'plain',
      source: 'pay.in',
      steps: [{ kind: 'handle' }, { kind: 'to', channel: 'ledger' }],
    });
    expect(snapshot.module).toEqual({ privacyProfiles: ['card', 'personal'] });
    expect(json).not.toContain('token');
  });

  it('SD-59 care and privacy profiles share the module block', async () => {
    moduleRef = await boot(
      {
        channels: CHANNELS.map(({ name, type }) => ({ name, type })),
        care: { profiles: { std: { tries: { max: 2 } } } },
        privacy: { profiles: { personal: PROFILES.personal } },
      },
      [],
    );
    const snapshot = moduleRef.get(ChannelGraph).snapshot(moduleRef.get(ChannelRegistry));
    expect(snapshot.module).toEqual({ careProfiles: ['std'], privacyProfiles: ['personal'] });
  });

  it('SD-59 module packs are named on every annotated step, after the baseline', async () => {
    moduleRef = await boot(
      {
        channels: CHANNELS.map(({ name, type }) => ({ name, type })),
        privacy: { packs: ['personal@1'], profiles: PROFILES },
      },
      [flowOf('p', () => IntegrationFlow.from('pay.in').handle((p) => p, { privacy: 'card' }))],
    );
    const { snapshot } = graphJson(moduleRef);
    expect(snapshot.flows[0]?.steps).toEqual([
      { kind: 'handle', id: 'handle#0', privacy: ['secrets@1', 'card', 'personal@1'] },
    ]);
  });
});
