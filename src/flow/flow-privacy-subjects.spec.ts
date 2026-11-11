import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { ChannelRegistry } from '../channel-registry';
import type { ChannelSpec } from '../channel-factory';
import { ServiceActivator } from '../decorators';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage } from '../message';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { PrivacyConfigError } from '../sensitive/privacy-errors';
import { Pack, Reach, Remember } from '../sensitive/privacy.types';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { FlowDefinitionError } from './flow-definition-error';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const VALUES = {
  token: 'TOKENVALUE0001',
  card: 'CARDVALUE0001',
  iban: 'IBANVALUE0001',
  ssn: 'SSNVALUE0001',
  phone: '+50212345678',
};

function failure(): Error {
  const error = new Error(`partner refused ${VALUES.phone}`);
  return Object.assign(error, {
    token: VALUES.token,
    card: VALUES.card,
    iban: VALUES.iban,
    ssn: VALUES.ssn,
  });
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function boot(
  channels: ChannelSpec[],
  flows: FlowDefinition[],
  options: Partial<IntegrationModuleOptions> = {},
  providers: unknown[] = [],
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels, ...options }, flows)],
    providers: providers as never[],
  }).compile();
  await mod.init();
  return mod;
}

async function bootError(
  channels: ChannelSpec[],
  flows: FlowDefinition[],
  options: Partial<IntegrationModuleOptions> = {},
  providers: unknown[] = [],
): Promise<unknown> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels, ...options }, flows)],
    providers: providers as never[],
  }).compile();
  return mod.init().then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Every line a Nest logger level writes during `run`. */
async function linesOf(
  level: 'log' | 'warn' | 'error',
  run: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const spy = jest
    .spyOn(Logger.prototype, level as 'log')
    .mockImplementation((message: unknown) => lines.push(String(message)) as never);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

function errorEnvelopes(mod: TestingModule): IntegrationMessage[] {
  const seen: IntegrationMessage[] = [];
  mod
    .get(ChannelRegistry)
    .get('error.channel')
    .subscribe((msg) => {
      seen.push(msg);
    });
  return seen;
}

const codes = (findings: readonly { code: string }[]): string[] =>
  findings.map((finding) => finding.code).sort();

describe('flow and step privacy subjects (SD-45..SD-47, SD-52, SD-58)', () => {
  it('flow sinks use the failing step subject: union of module, source, destination, flow and step', async () => {
    const channels: ChannelSpec[] = [
      { name: 'loan.requests', type: 'direct', privacy: { fields: ['**.card'] } },
      { name: 'audit.out', type: 'direct', privacy: { fields: ['**.iban'] } },
    ];
    const publishing: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.requests', { privacy: { packs: [Pack.PersonalV1] } }).publish(
          'audit.out',
          { id: 'audit', privacy: { fields: ['**.ssn'] } },
        ),
    };
    const capture = captureTrail();
    const mod = await boot(channels, [publishing], {
      privacy: { fields: ['**.token'] },
      idempotency: { store: capture.store(new MemoryIdempotencyStore()) },
    });
    mod
      .get(ChannelRegistry)
      .get('audit.out')
      .subscribe(() => Promise.reject(failure()));
    const lines = await linesOf('error', async () => {
      await mod
        .get(ChannelRegistry)
        .send('loan.requests', { amount: 1 }, { idempotencyKey: 'k-1' })
        .catch(() => undefined);
      await settle();
    });
    const s3 = lines.filter((line) => line.startsWith('error.channel:'));
    expect(s3).toHaveLength(1);
    const fail = capture.writes.find((write) => write.where.startsWith('store.fail'));
    expect(fail).toBeDefined();
    for (const value of Object.values(VALUES)) {
      expect(s3[0]).not.toContain(value);
      expect(fail?.text).not.toContain(value);
    }
    expectNoLeak(capture, Object.values(VALUES));
    await mod.close();

    const handling: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.requests', { privacy: { packs: [Pack.PersonalV1] } }).handle(
          () => {
            throw failure();
          },
        ),
    };
    const plain = await boot(channels, [handling], { privacy: { fields: ['**.token'] } });
    const handled = await linesOf('error', async () => {
      await plain
        .get(ChannelRegistry)
        .send('loan.requests', { amount: 1 })
        .catch(() => undefined);
      await settle();
    });
    const line = handled.find((text) => text.startsWith('error.channel:')) ?? '';
    expect(line).not.toContain(VALUES.token);
    expect(line).not.toContain(VALUES.card);
    expect(line).not.toContain(VALUES.phone);
    expect(line).toContain(VALUES.iban);
    expect(line).toContain(VALUES.ssn);
    await plain.close();
  });

  it('flow-level privacy applies to flow sinks only', async () => {
    const email = 'ana.lopez@example.com';
    const received: unknown[] = [];
    const flow: FlowDefinition = {
      name: 'a',
      build: () =>
        IntegrationFlow.from('a', { privacy: 'personal' }).handle((payload) => {
          received.push(payload);
          throw new Error(`cannot reach ${(payload as { email: string }).email}`);
        }),
    };
    const mod = await boot([{ name: 'a', type: 'direct' }], [flow], {
      privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } },
    });
    const envelopes = errorEnvelopes(mod);
    const payload = { email };
    const lines = await linesOf('error', async () => {
      await mod
        .get(ChannelRegistry)
        .send('a', payload)
        .catch(() => undefined);
      await settle();
    });
    expect(received[0]).toBe(payload);
    expect((received[0] as { email: string }).email).toBe(email);
    const line = lines.find((text) => text.startsWith('error.channel:')) ?? '';
    expect(line).toContain('[HIDDEN:personal.email]');
    expect(line).not.toContain(email);
    expect(JSON.stringify(envelopes[0]?.payload)).not.toContain(email);
    await mod.close();
  });

  it('delivery-reach or remember at flow level fails boot', async () => {
    const reach = (await bootError(
      [{ name: 'a', type: 'direct' }],
      [
        {
          name: 'f',
          build: () =>
            IntegrationFlow.from('a', {
              privacy: { fields: ['x'], reach: Reach.Delivery, reachReason: 'x' },
            }).handle((p) => p),
        },
      ],
    )) as PrivacyConfigError;
    expect(reach).toBeInstanceOf(PrivacyConfigError);
    expect(reach.findings).toContainEqual(
      expect.objectContaining({
        code: 'DELIVERY_REACH_LEVEL',
        subject: "flow 'f'",
        path: 'privacy.reach',
      }),
    );
    const remember = (await bootError(
      [{ name: 'a', type: 'direct' }],
      [
        {
          name: 'f',
          build: () =>
            IntegrationFlow.from('a', { privacy: { remember: Remember.OutcomeOnly } }).handle(
              (p) => p,
            ),
        },
      ],
    )) as PrivacyConfigError;
    expect(remember).toBeInstanceOf(PrivacyConfigError);
    expect(remember.findings).toContainEqual(
      expect.objectContaining({ code: 'REMEMBER_LEVEL', subject: "flow 'f'" }),
    );
  });

  it('step and target privacy options are scoped to their own sinks', async () => {
    const SECRET = 'XSECRET1234';
    const rule = { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] };
    const flow: FlowDefinition = {
      name: 'spread',
      build: () =>
        IntegrationFlow.from('in').fanoutTo([
          { channel: 'a', wait: false, privacy: rule },
          { channel: 'b', wait: false },
          { channel: 'b', wait: false, privacy: rule },
        ]),
    };
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'a', type: 'direct' },
      { name: 'b', type: 'direct' },
    ];
    const mod = await boot(channels, [flow]);
    const registry = mod.get(ChannelRegistry);
    registry.get('a').subscribe(() => Promise.reject(new Error(`refused ${SECRET}`)));
    registry.get('b').subscribe(() => Promise.reject(new Error(`refused ${SECRET}`)));
    const envelopes = errorEnvelopes(mod);
    await linesOf('error', async () => {
      await registry.send('in', {});
      await settle();
      await settle();
    });
    const texts = (channel: string): string[] =>
      envelopes
        .filter((msg) => (msg.payload as { channel?: string }).channel === channel)
        .map((msg) => JSON.stringify(msg.payload));
    expect(texts('a')).toHaveLength(1);
    expect(texts('a')[0]).toContain('[HIDDEN:test.x]');
    expect(texts('a')[0]).not.toContain(SECRET);
    expect(texts('b')).toHaveLength(2);
    expect(texts('b').filter((text) => text.includes(SECRET))).toHaveLength(1);
    expect(texts('b').filter((text) => text.includes('[HIDDEN:test.x]'))).toHaveLength(1);
    await mod.close();
  });

  it('wireTap copy unions module, tap channel, source channel, flow and step levels', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'audit', type: 'pubsub' },
      { name: 'out', type: 'pubsub' },
    ];
    const taps = async (flow: FlowDefinition): Promise<unknown> => {
      const mod = await boot(channels, [flow]);
      const seen: unknown[] = [];
      mod
        .get(ChannelRegistry)
        .get('audit')
        .subscribe((msg) => {
          seen.push(msg.payload);
        });
      await mod.get(ChannelRegistry).send('in', { pan: '4111111111111111', ssn: '123-45-6789' });
      await settle();
      await mod.close();
      return seen[0];
    };
    const byFlow = await taps({
      name: 'f',
      build: () =>
        IntegrationFlow.from('in', { privacy: { fields: ['**.pan'] } })
          .wireTap('audit')
          .to('out'),
    });
    expect(byFlow).toEqual({ pan: '[HIDDEN:field]', ssn: '123-45-6789' });
    const byStep = await taps({
      name: 'f',
      build: () =>
        IntegrationFlow.from('in')
          .wireTap('audit', { privacy: { fields: ['**.ssn'] } })
          .to('out'),
    });
    expect(byStep).toEqual({ pan: '4111111111111111', ssn: '[HIDDEN:field]' });
    const elsewhere = await taps({
      name: 'f',
      build: () =>
        IntegrationFlow.from('in')
          .wireTap('audit')
          .to('out', { privacy: { fields: ['**.ssn'] } }),
    });
    expect(elsewhere).toEqual({ pan: '4111111111111111', ssn: '123-45-6789' });
  });

  it('remember on flow or step levels fails boot; inherited remember is ignored there', async () => {
    const error = (await bootError(
      [
        {
          name: 'a',
          type: 'direct',
          privacy: { remember: Remember.Everything, rememberReason: 'r' },
        },
      ],
      [
        {
          name: 'f',
          build: () =>
            IntegrationFlow.from('a').handle((p) => p, {
              id: 's',
              privacy: { remember: Remember.Sealed },
            }),
        },
      ],
    )) as PrivacyConfigError;
    expect(error).toBeInstanceOf(PrivacyConfigError);
    const remember = error.findings.filter((finding) => finding.code === 'REMEMBER_LEVEL');
    expect(remember).toEqual([
      {
        code: 'REMEMBER_LEVEL',
        severity: 'error',
        subject: "flow 'f' step 's'",
        path: 'privacy.remember',
      },
    ]);
  });

  it('privacy false below the module or with lower references fails boot (flow levels)', async () => {
    const below = (await bootError(
      [{ name: 'a', type: 'direct' }],
      [
        {
          name: 'f',
          build: () =>
            IntegrationFlow.from('a').handle((p) => p, { id: 's', privacy: false as never }),
        },
      ],
    )) as PrivacyConfigError;
    expect(below.findings).toContainEqual(
      expect.objectContaining({ code: 'PRIVACY_FALSE_BELOW_MODULE', subject: "flow 'f' step 's'" }),
    );
    const off = (await bootError(
      [{ name: 'a', type: 'direct' }],
      [{ name: 'f', build: () => IntegrationFlow.from('a', { privacy: { fields: ['x'] } }) }],
      { privacy: false },
    )) as PrivacyConfigError;
    expect(off.findings).toContainEqual(
      expect.objectContaining({ code: 'PRIVACY_OFF_WITH_REFS', subject: "flow 'f'" }),
    );
  });
});

describe('boot resolution of flow privacy (SD-55, SD-60, SD-67)', () => {
  it('boot resolver reports every privacy finding once with subject and path', async () => {
    const handled = jest.fn();
    @Injectable()
    class Scorer {
      @ServiceActivator('score.in')
      score(payload: unknown): unknown {
        handled(payload);
        return payload;
      }
    }
    const channels: ChannelSpec[] = [
      { name: 'loan.requests', type: 'direct' },
      { name: 'credit.check', type: 'direct' },
      { name: 'score.in', type: 'direct' },
    ];
    const flow: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.requests', { privacy: { packs: [Pack.PersonalV1] } })
          .filter(() => true, {
            id: 'gate',
            privacy: { fields: ['**.ssn'], reach: Reach.Delivery, reachReason: 'r' },
          })
          .jumpTo([{ channel: 'credit.check' }], {
            id: 'credit',
            privacy: { use: 'nope', fields: ['**.ssn'] },
          })
          .handle((p) => p, { id: 'next' }),
    };
    const error = (await bootError(
      channels,
      [flow],
      { privacy: { profiles: { loop: { extends: 'loop' } } } },
      [Scorer],
    )) as PrivacyConfigError;
    expect(error).toBeInstanceOf(PrivacyConfigError);
    expect(codes(error.findings)).toEqual(
      ['DELIVERY_REACH_LEVEL', 'PROFILE_CYCLE', 'UNKNOWN_PROFILE'].sort(),
    );
    const unknown = error.findings.find((finding) => finding.code === 'UNKNOWN_PROFILE');
    expect(unknown).toEqual({
      code: 'UNKNOWN_PROFILE',
      severity: 'error',
      subject: "flow 'loan' step 'credit'",
      path: 'privacy.use',
    });
    expect(error.message).toContain("flow 'loan' step 'credit': privacy.use unknown profile");
    expect(error.message).not.toContain('ssn');
  });

  it('boot resolver subscribes no activator or flow when privacy fails', async () => {
    const handled = jest.fn();
    @Injectable()
    class Scorer {
      @ServiceActivator('score.in')
      score(payload: unknown): unknown {
        handled(payload);
        return payload;
      }
    }
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'score.in', type: 'direct' },
    ];
    const flowRan = jest.fn();
    const mod = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({ channels }, [
          {
            name: 'f',
            build: () =>
              IntegrationFlow.from('in', { privacy: 'missing' }).handle((p) => {
                flowRan(p);
                return p;
              }),
          },
        ]),
      ],
      providers: [Scorer],
    }).compile();
    await expect(mod.init()).rejects.toBeInstanceOf(PrivacyConfigError);
    const registry = mod.get(ChannelRegistry);
    await registry.send('in', {}).catch(() => undefined);
    await registry.send('score.in', {}).catch(() => undefined);
    expect(flowRan).not.toHaveBeenCalled();
    expect(handled).not.toHaveBeenCalled();
  });

  it('privacy members extend the SPI-445 flow scaffolding and keep 0.9.0 behaviour', async () => {
    const mixed = (await bootError(
      [{ name: 'a', type: 'direct' }],
      [
        {
          name: 'f',
          build: () =>
            IntegrationFlow.from('a', { privacy: 'missing', care: { handle: 'nope' } }).handle(
              (p) => p,
            ),
        },
      ],
    )) as FlowDefinitionError;
    expect(mixed).toBeInstanceOf(FlowDefinitionError);
    const unknown = mixed.findings.filter((finding) => finding.code === 'UNKNOWN_PROFILE');
    expect(unknown.map((finding) => finding.concern).sort()).toEqual(['care', 'privacy']);
    const privacy = unknown.find((finding) => finding.concern === 'privacy');
    expect(privacy).toMatchObject({ subject: "flow 'f'", path: 'privacy', severity: 'error' });
    expect(privacy?.message).toContain("flow 'f': privacy unknown profile 'missing'");

    const ok = await boot(
      [{ name: 'a', type: 'direct' }],
      [{ name: 'f', build: () => IntegrationFlow.from('a', { privacy: 'personal' }) }],
      { privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } } },
    );
    expect(ok.get(PrivacyEngine).planOfScope('flow:f')?.names).toContain('personal');
    await ok.close();
  });

  it('route resolves target plans once per channel', async () => {
    const SECRET = 'XSECRET1234';
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      {
        name: 'r1',
        type: 'direct',
        privacy: { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] },
      },
      { name: 'r2', type: 'direct' },
    ];
    let targets: string[] = [];
    const flow: FlowDefinition = {
      name: 'f',
      build: () => IntegrationFlow.from('in').route(() => targets, { id: 'pick' }),
    };
    const mod = await boot(channels, [flow]);
    const registry = mod.get(ChannelRegistry);
    registry.get('r1').subscribe(() => Promise.reject(new Error(`r1 refused ${SECRET}`)));
    registry.get('r2').subscribe(() => Promise.reject(new Error(`r2 refused ${SECRET}`)));
    const envelopes = errorEnvelopes(mod);
    const engine = mod.get(PrivacyEngine);
    const added = jest.spyOn(engine, 'addScopes');
    await linesOf('error', async () => {
      for (const next of [['r1'], ['r1'], ['r2'], ['r2'], ['nowhere'], ['nowhere']]) {
        targets = next;
        await registry.send('in', {}).catch(() => undefined);
      }
      await settle();
    });
    expect(added).toHaveBeenCalledTimes(2);
    const texts = envelopes.map((msg) =>
      JSON.stringify(msg.payload, (_key, value: unknown) =>
        value instanceof Error ? { message: value.message } : value,
      ),
    );
    expect(texts).toHaveLength(6);
    expect(texts.slice(0, 2).every((text) => text.includes('[HIDDEN:test.x]'))).toBe(true);
    expect(texts.slice(2, 4).every((text) => text.includes(SECRET))).toBe(true);
    added.mockRestore();
    await mod.close();
  });

  it('boot summary lists flow and step subjects without rules', async () => {
    const channels: ChannelSpec[] = [
      { name: 'loan.requests', type: 'direct' },
      { name: 'loan.audit', type: 'pubsub' },
      { name: 'credit.check', type: 'direct' },
      { name: 'partner.out', type: 'pubsub' },
      { name: 'payments.charge', type: 'direct', privacy: 'card' },
    ];
    const flow: FlowDefinition = {
      name: 'loan',
      build: () =>
        IntegrationFlow.from('loan.requests', { privacy: 'personal' })
          .handle((p) => p, { id: 'enrich', privacy: { fields: ['ssn'] } })
          .wireTap('loan.audit', { id: 'audit' })
          .jumpTo([{ channel: 'credit.check', privacy: 'card' }], { id: 'credit' })
          .transform((p) => p, {
            id: 'partner',
            privacy: {
              fields: ['ssn'],
              reach: Reach.Delivery,
              reachReason: 'partner must not receive SSN',
            },
          })
          .to('partner.out', { id: 'send' }),
    };
    const options: Partial<IntegrationModuleOptions> = {
      privacy: {
        packs: [Pack.SecretsV1],
        profiles: {
          personal: { packs: [Pack.PersonalV1] },
          card: { fields: [{ path: '**.pan' }] },
          'card-personal': { extends: ['card', 'personal'] },
        },
      },
    };
    const warns: string[] = [];
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => warns.push(String(message)) as never);
    let mod: TestingModule | undefined;
    const infos = await linesOf('log', async () => {
      mod = await boot(channels, [flow], options);
    });
    warnSpy.mockRestore();
    const subjects = [
      'loan',
      'loan#enrich',
      'loan#audit',
      'loan#credit',
      'loan#partner',
      'loan#send',
    ];
    for (const subject of subjects) {
      expect(infos.filter((line) => line.includes(`privacy scope 'flow:${subject}'`))).toHaveLength(
        1,
      );
    }
    const flowLines = infos.filter((line) => line.includes("privacy scope 'flow:"));
    expect(flowLines).toHaveLength(subjects.length);
    for (const line of flowLines) {
      expect(line).not.toContain('ssn');
      expect(line).not.toContain('**.pan');
    }
    expect(flowLines.find((line) => line.includes("'flow:loan#partner'"))).toContain(
      'reach=delivery',
    );
    const reach = warns.filter((line) => line.includes('delivery-reach'));
    expect(reach).toEqual([
      'privacy delivery-reach flow:loan#partner: partner must not receive SSN',
    ]);
    await mod?.close();
  });

  it('a flow without privacy logs no flow or step summary line', async () => {
    const infos = await linesOf('log', async () => {
      const mod = await boot(
        [
          { name: 'in', type: 'direct' },
          { name: 'out', type: 'pubsub' },
        ],
        [{ name: 'f', build: () => IntegrationFlow.from('in').to('out') }],
      );
      await mod.close();
    });
    expect(infos.filter((line) => line.includes("privacy scope 'flow:"))).toEqual([]);
  });
});
