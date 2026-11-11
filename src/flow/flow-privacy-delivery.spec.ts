import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { ChannelRegistry } from '../channel-registry';
import type { ChannelSpec } from '../channel-factory';
import type { IntegrationMessage } from '../message';
import { DeliveryCopyError, PrivacyConfigError } from '../sensitive/privacy-errors';
import { Pack, Reach, Show } from '../sensitive/privacy.types';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function boot(
  channels: ChannelSpec[],
  flows: FlowDefinition[],
  options: Partial<IntegrationModuleOptions> = {},
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels, ...options }, flows)],
  }).compile();
  await mod.init();
  return mod;
}

async function bootError(
  channels: ChannelSpec[],
  flows: FlowDefinition[],
  options: Partial<IntegrationModuleOptions> = {},
): Promise<unknown> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels, ...options }, flows)],
  }).compile();
  return mod.init().then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function warnsOf(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation((message: unknown) => lines.push(String(message)) as never);
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

/** Every message a channel receives; `answer` replies on the hop's `replyChannel`. */
function inbox(
  mod: TestingModule,
  channel: string,
  answer?: (msg: IntegrationMessage) => unknown,
): IntegrationMessage[] {
  const registry = mod.get(ChannelRegistry);
  const seen: IntegrationMessage[] = [];
  registry.get(channel).subscribe(async (msg) => {
    seen.push(msg);
    const reply = msg.headers.replyChannel;
    if (answer !== undefined && reply !== undefined) await registry.send(reply, answer(msg));
  });
  return seen;
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Object && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const flow = (name: string, built: IntegrationFlow): FlowDefinition => ({
  name,
  build: () => built,
});

const delivery = (fields: string[], extra: Record<string, unknown> = {}) => ({
  fields,
  reach: Reach.Delivery,
  reachReason: 'partner must not receive SSN',
  ...extra,
});

const quiet = <T>(run: () => Promise<T>): Promise<T> => {
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return run().finally(() => spy.mockRestore());
};

describe('delivery reach (SD-50, SD-51)', () => {
  it("delivery-reach masks only the step's own rules and only the delivered copy", async () => {
    const spy = jest.fn((payload: unknown) => payload);
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'p', type: 'pubsub', privacy: { fields: ['**.name'] } },
    ];
    const definition = flow(
      'partner',
      IntegrationFlow.from('in', { privacy: { fields: ['**.phone'] } })
        .publish('p', { id: 'share', privacy: delivery(['ssn']) })
        .handle(spy, { id: 'after' }),
    );
    let mod: TestingModule | undefined;
    const warns = await warnsOf(async () => {
      mod = await boot(channels, [definition], { privacy: { fields: ['**.email'] } });
    });
    const delivered = inbox(mod!, 'p');
    const payload = { ssn: '123', email: 'ana@example.com', phone: '+50212345678', name: 'Ana' };
    await mod!.get(ChannelRegistry).send('in', payload);
    await settle();
    expect(delivered).toHaveLength(1);
    // Only the step's own rules: module (email), flow (phone) and channel (name) rules stay out.
    expect(delivered[0]!.payload).toEqual({ ...payload, ssn: '[HIDDEN:field]' });
    // The main path keeps the message it received.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBe(payload);
    expect(payload.ssn).toBe('123');
    const reach = warns.filter((line) => line.includes('delivery-reach'));
    expect(reach).toHaveLength(1);
    expect(reach[0]).toContain('flow:partner#share');
    expect(reach[0]).toContain('partner must not receive SSN');
    expect(reach[0]).not.toContain('ssn');
    await mod!.close();
  });

  it('delivery-reach masks transform and handle outputs, other headers stay untouched', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'out', type: 'pubsub' },
    ];
    const definition = flow(
      'shape',
      IntegrationFlow.from('in')
        .transform((p) => ({ ...(p as object), shaped: true }), {
          id: 'shape',
          privacy: delivery(['ssn']),
        })
        .handle((p) => ({ ...(p as object), card: '4111111111111111' }), {
          id: 'enrich',
          privacy: delivery(['card']),
        })
        .to('out'),
    );
    const mod = await boot(channels, [definition]);
    const out = inbox(mod, 'out');
    await mod.get(ChannelRegistry).send('in', { ssn: '123' }, { tenant: 'acme' });
    await settle();
    expect(out[0]!.payload).toEqual({
      ssn: '[HIDDEN:field]',
      shaped: true,
      card: '[HIDDEN:field]',
    });
    expect(out[0]!.headers.tenant).toBe('acme');
    await mod.close();
  });

  it('delivery-reach on fanoutTo and jumpTo targets masks each hop copy and its jump replies', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'score', type: 'direct' },
      { name: 'a', type: 'pubsub' },
      { name: 'b', type: 'pubsub' },
      { name: 'j', type: 'direct' },
    ];
    const definition = flow(
      'spread',
      IntegrationFlow.from('in')
        .jump('score', { id: 'score' })
        .fanoutTo([{ channel: 'a', privacy: delivery(['**.ssn']) }, 'b'], { id: 'spread' })
        .jumpTo(['j'], { id: 'ask', privacy: delivery(['**.ssn']) })
        .handle((p) => p),
    );
    const mod = await boot(channels, [definition]);
    const scoreReply = { ssn: '999', score: 7 };
    inbox(mod, 'score', () => scoreReply);
    const a = inbox(mod, 'a');
    const b = inbox(mod, 'b');
    const j = inbox(mod, 'j', () => ({ ok: true }));
    const payload = { ssn: '123', amount: 5 };
    await mod.get(ChannelRegistry).send('in', payload);
    await settle();
    expect(a[0]!.payload).toEqual({ ssn: '[HIDDEN:field]', amount: 5 });
    expect(a[0]!.headers.jumpReplies).toEqual({ score: { ssn: '[HIDDEN:field]', score: 7 } });
    expect(b[0]!.payload).toBe(payload);
    expect(b[0]!.headers.jumpReplies!.score).toBe(scoreReply);
    expect(j[0]!.payload).toEqual({ ssn: '[HIDDEN:field]', amount: 5 });
    expect(j[0]!.headers.jumpReplies).toEqual({ score: { ssn: '[HIDDEN:field]', score: 7 } });
    await mod.close();
  });

  it('delivery-reach level and reason are validated at boot', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'out', type: 'direct' },
    ];
    const reach = { fields: ['ssn'], reach: Reach.Delivery, reachReason: 'r' };
    const cases: [string, FlowDefinition, Partial<IntegrationModuleOptions>, string, string][] = [
      [
        'filter',
        flow(
          'f',
          IntegrationFlow.from('in').filter(() => true, { id: 'x', privacy: reach }),
        ),
        {},
        "flow 'f' step 'x'",
        'privacy.reach',
      ],
      [
        'wireTap',
        flow('f', IntegrationFlow.from('in').wireTap('out', { id: 'x', privacy: reach })),
        {},
        "flow 'f' step 'x'",
        'privacy.reach',
      ],
      [
        'headers',
        flow('f', IntegrationFlow.from('in').headers({ tenant: 'a' }, { id: 'x', privacy: reach })),
        {},
        "flow 'f' step 'x'",
        'privacy.reach',
      ],
      [
        'route',
        flow(
          'f',
          IntegrationFlow.from('in').route(() => 'out', { id: 'x', privacy: reach }),
        ),
        {},
        "flow 'f' step 'x'",
        'privacy.reach',
      ],
      [
        'missing reason',
        flow(
          'f',
          IntegrationFlow.from('in').transform((p) => p, {
            id: 'x',
            privacy: { fields: ['ssn'], reach: Reach.Delivery },
          }),
        ),
        {},
        "flow 'f' step 'x'",
        'privacy.reachReason',
      ],
      [
        'long reason',
        flow(
          'f',
          IntegrationFlow.from('in').to('out', {
            id: 'x',
            privacy: { ...reach, reachReason: 'r'.repeat(201) },
          }),
        ),
        {},
        "flow 'f' step 'x'",
        'privacy.reachReason',
      ],
      [
        'flow level',
        flow('f', IntegrationFlow.from('in', { privacy: reach }).to('out')),
        {},
        "flow 'f'",
        'privacy.reach',
      ],
      [
        'channel level',
        flow('f', IntegrationFlow.from('in').to('out')),
        { channels: [channels[0]!, { name: 'out', type: 'direct', privacy: reach }] },
        "channel 'out'",
        'privacy.reach',
      ],
      [
        'module level',
        flow('f', IntegrationFlow.from('in').to('out')),
        { privacy: reach },
        'module',
        'privacy.reach',
      ],
    ];
    for (const [label, definition, options, subject, path] of cases) {
      const error = (await bootError(channels, [definition], options)) as PrivacyConfigError;
      expect({ label, error: error instanceof PrivacyConfigError }).toEqual({ label, error: true });
      expect(error.findings).toContainEqual(
        expect.objectContaining({ code: 'DELIVERY_REACH_LEVEL', subject, path }),
      );
      expect(error.message).not.toContain('ssn');
    }
    const ok = await boot(channels, [
      flow('f', IntegrationFlow.from('in').to('out', { id: 'x', privacy: reach })),
    ]);
    await ok.close();
  });

  it('delivery-reach keeps untouched references and fails instead of truncating', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'dest', type: 'pubsub' },
    ];
    const definition = flow(
      'partner',
      IntegrationFlow.from('in')
        .transform((p) => p, {
          id: 'partner',
          privacy: delivery(['ssn'], { patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }] }),
        })
        .to('dest', { id: 'send' }),
    );
    const mod = await boot(channels, [definition]);
    const dest = inbox(mod, 'dest');
    const envelopes = inbox(mod, 'error.channel');
    const blob = Buffer.from('raw bytes');
    const when = new Date(0);
    await mod.get(ChannelRegistry).send('in', { ssn: '123', blob, when, note: 'XSECRET1234' });
    await settle();
    expect(dest).toHaveLength(1);
    const first = dest[0]!.payload as Record<string, unknown>;
    expect(first.ssn).toBe('[HIDDEN:field]');
    expect(first.blob).toBe(blob);
    expect(first.when).toBe(when);
    expect(first.note).toBe('[HIDDEN:test.x]');
    const big = { ssn: '1', note: 'x '.repeat(35 * 1024) };
    const failed = await quiet(() =>
      mod
        .get(ChannelRegistry)
        .send('in', big)
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    );
    await settle();
    expect(failed).toBeInstanceOf(DeliveryCopyError);
    expect((failed as DeliveryCopyError).retryable).toBe(false);
    expect(dest).toHaveLength(1);
    const envelope = envelopes.find((msg) => (msg.payload as { flow?: string }).flow === 'partner');
    expect((envelope?.payload as { error: { code?: string } }).error.code).toBe(
      'DELIVERY_COPY_FAILED',
    );
    expect(JSON.stringify(envelope?.payload)).not.toContain('x x x');
    await mod.close();
  });

  it('delivery-reach copy failures are not retried by care and send nothing', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'dest', type: 'direct' },
      { name: 'many', type: 'pubsub' },
    ];
    const handled = jest.fn((p: unknown) => p);
    const tries = { tries: { max: 3, idempotent: true, spacing: 0 } };
    const definition = flow(
      'partner',
      IntegrationFlow.from('in')
        .handle(handled, { id: 'work', care: tries, privacy: delivery(['ssn']) })
        .fanoutTo(['many', { channel: 'dest', wait: false, privacy: delivery(['**.ssn']) }], {
          id: 'spread',
          care: tries,
        }),
    );
    class Inner {
      ssn = '1';
    }
    const mod = await boot(channels, [definition], { care: {} });
    const dest = inbox(mod, 'dest');
    const many = inbox(mod, 'many');
    const run = (payload: unknown): Promise<unknown> =>
      quiet(() =>
        mod
          .get(ChannelRegistry)
          .send('in', payload, { idempotencyKey: `k-${handled.mock.calls.length}` })
          .then(
            () => undefined,
            (error: unknown) => error,
          ),
      );
    // The handle output cannot be copied faithfully: one call, no retry.
    expect(await run(new Inner())).toBeInstanceOf(DeliveryCopyError);
    expect(handled).toHaveBeenCalledTimes(1);
    // The fanout copy for 'dest' cannot be faithful: no target receives anything.
    expect(await run({ ssn: '1', inner: new Inner() })).toBeInstanceOf(DeliveryCopyError);
    expect(handled).toHaveBeenCalledTimes(2);
    await settle();
    expect(many).toHaveLength(0);
    expect(dest).toHaveLength(0);
    expect(await run({ ssn: '1', inner: { ssn: '2' } })).toBeUndefined();
    await settle();
    expect(many).toHaveLength(1);
    expect(many[0]!.payload).toEqual({ ssn: '[HIDDEN:field]', inner: { ssn: '2' } });
    expect(dest[0]!.payload).toEqual({ ssn: '[HIDDEN:field]', inner: { ssn: '[HIDDEN:field]' } });
    await mod.close();
  });
});

describe('jump replies and delivered messages (SD-53, SD-54)', () => {
  it('jump replies are redacted in sink copies and delivered intact', async () => {
    const pan = '4111111111111111';
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct' },
      { name: 'credit.check', type: 'direct', privacy: { fields: ['**.score'] } },
      { name: 'audit', type: 'pubsub' },
      { name: 'caller', type: 'direct' },
    ];
    const definition = flow(
      'loan',
      IntegrationFlow.from('in')
        .jumpTo([{ channel: 'credit.check', privacy: 'card' }], { id: 'credit' })
        .wireTap('audit', { id: 'audit' })
        .reply({ payload: 'jumpMerge' }),
    );
    const mod = await boot(channels, [definition], {
      privacy: {
        fields: ['**.customer'],
        profiles: { card: { fields: [{ path: '**.pan', show: Show.Ends, showLast: 4 }] } },
      },
    });
    const reply = { pan, score: 720 };
    inbox(mod, 'credit.check', () => reply);
    const audit = inbox(mod, 'audit');
    const caller = inbox(mod, 'caller');
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), 'audit');
    await mod
      .get(ChannelRegistry)
      .send('in', { customer: 'CUSTOMER-0077' }, { replyChannel: 'caller' });
    await settle();
    expect(audit).toHaveLength(1);
    const copied = audit[0]!.headers.jumpReplies as Record<string, Record<string, unknown>>;
    expect(Object.keys(copied)).toEqual(['credit.check']);
    expect(copied['credit.check']).toEqual({ pan: '***1111', score: '[HIDDEN:field]' });
    expect(audit[0]!.payload).toEqual({ customer: '[HIDDEN:field]' });
    expectNoLeak(capture, [pan, 'CUSTOMER-0077']);
    expect(caller).toHaveLength(1);
    const answered = caller[0]!.payload as { jumpReplies: Record<string, unknown> };
    expect(answered.jumpReplies['credit.check']).toBe(reply);
    expect(reply.pan).toBe(pan);
    await mod.close();
  });

  it('flow DSL privacy references never change delivered messages', async () => {
    const channels: ChannelSpec[] = [
      { name: 'in', type: 'direct', privacy: 'personal' },
      { name: 'p.out', type: 'pubsub', privacy: { fields: ['**.ssn'] } },
      { name: 'f.a', type: 'pubsub', privacy: 'card' },
      { name: 'f.b', type: 'pubsub' },
      { name: 'j.a', type: 'direct', privacy: 'card' },
      { name: 'j.b', type: 'direct' },
      { name: 'audit', type: 'pubsub' },
      { name: 'r.out', type: 'pubsub' },
      { name: 't.out', type: 'pubsub' },
      { name: 'caller', type: 'direct' },
    ];
    const step = { privacy: { use: 'card', fields: ['**.ssn'] } };
    const seen: unknown[] = [];
    const keep = (p: unknown): unknown => {
      seen.push(p);
      return p;
    };
    const full = flow(
      'full',
      IntegrationFlow.from('in', { privacy: { packs: [Pack.PersonalV1], fields: ['**.name'] } })
        .filter(() => true, { id: 'gate', ...step })
        .transform(keep, { id: 'shape', ...step })
        .handle(keep, { id: 'work', ...step })
        .wireTap('audit', { id: 'tap', ...step })
        .publish('p.out', { id: 'pub', ...step })
        .fanoutTo([{ channel: 'f.a', privacy: 'personal' }, { channel: 'f.b' }], {
          id: 'spread',
          ...step,
        })
        .jumpTo([{ channel: 'j.a', privacy: { fields: ['**.pan'] } }], { id: 'ask', ...step })
        .jump('j.b', { id: 'ask2', ...step })
        .reply({ id: 'answer' })
        .route(() => 'r.out', { id: 'route', ...step }),
    );
    const terminal = flow(
      'terminal',
      IntegrationFlow.from('t.in', { privacy: 'personal' }).to('t.out', { id: 'send', ...step }),
    );
    const mod = await boot(
      [...channels, { name: 't.in', type: 'direct', privacy: 'card' }],
      [full, terminal],
      {
        privacy: {
          packs: [Pack.SecretsV1],
          fields: ['**.token'],
          profiles: {
            personal: { packs: [Pack.PersonalV1] },
            card: { fields: [{ path: '**.pan', show: Show.Ends }] },
          },
        },
      },
    );
    const replyA = deepFreeze({ pan: '4111111111111111' });
    const replyB = deepFreeze({ ssn: '123-45-6789' });
    const spies = ['p.out', 'f.a', 'f.b', 'r.out', 't.out'].map((name) => inbox(mod, name));
    const jumps = [inbox(mod, 'j.a', () => replyA), inbox(mod, 'j.b', () => replyB)];
    const caller = inbox(mod, 'caller');
    const payload = deepFreeze({
      token: 'T0K3N',
      pan: '4111111111111111',
      ssn: '123-45-6789',
      name: 'Ana',
      email: 'ana@example.com',
      nested: { phone: '+50212345678' },
    });
    await mod.get(ChannelRegistry).send('in', payload, { replyChannel: 'caller', tenant: 'acme' });
    await mod.get(ChannelRegistry).send('t.in', payload);
    await settle();
    expect(seen).toEqual([payload, payload]);
    expect(seen.every((value) => value === payload)).toBe(true);
    for (const received of [...spies, ...jumps]) {
      expect(received).toHaveLength(1);
      expect(received[0]!.payload).toBe(payload);
      expect(received[0]!.headers.tenant ?? 'acme').toBe('acme');
    }
    const routed = spies[3]![0]!.headers.jumpReplies!;
    expect(routed['j.a']).toBe(replyA);
    expect(routed['j.b']).toBe(replyB);
    expect(caller).toHaveLength(1);
    expect(caller[0]!.payload).toBe(payload);
    await mod.close();
  });
});
