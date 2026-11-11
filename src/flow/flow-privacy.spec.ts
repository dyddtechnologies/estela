import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { ChannelRegistry } from '../channel-registry';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { ChannelGraph } from '../graph/channel-graph';
import { createMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from '../message';
import { PrivacyConfigError } from '../sensitive/privacy-errors';
import { captureTrail } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { TapCopy } from './flow-step';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const TOKEN = 'CANARYTOKEN0001';
const FAIL = 'XCANARY1234';

const channels = [
  { name: 'pay.in', type: 'direct' as const },
  { name: 'audit', type: 'pubsub' as const },
  { name: 'sink', type: 'pubsub' as const },
];

async function boot(
  flows: FlowDefinition[],
  options: Partial<IntegrationModuleOptions> = {},
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot({ channels, ...options }, flows)],
  }).compile();
  await mod.init();
  return mod;
}

function tapFlow(copy?: { copy?: TapCopy; copyReason?: string }): FlowDefinition {
  return {
    name: 'tap',
    build: () =>
      IntegrationFlow.from('pay.in')
        .wireTap('audit', { id: 'audit', ...copy })
        .to('sink'),
  };
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

describe('S10 wire-tap copies (SD-28, SD-52)', () => {
  it('wireTap copy AsShown delivers a hidden copy', async () => {
    const mod = await boot([tapFlow({ copy: TapCopy.AsShown })]);
    const audit = collect(mod, 'audit');
    const main = collect(mod, 'sink');
    const payload = { token: TOKEN, amount: 1 };
    const input = createMessage(payload, { authorization: `Bearer ${TOKEN}` });
    await mod.get(ChannelRegistry).sendMessage('pay.in', input);
    await settle();
    expect(main[0]?.payload).toBe(payload);
    expect(audit[0]?.payload).toEqual({ token: '[HIDDEN:secrets.keys]', amount: 1 });
    expect(audit[0]?.headers.authorization).toBe('[HIDDEN:header]');
    expect(audit[0]?.headers.id).toBe(input.headers.id);
    expect(audit[0]?.headers.traceId).toBe(input.headers.traceId);
    expect(audit[0]?.headers.history.length).toBeGreaterThan(0);
    await mod.close();
  });

  it('compat: flow DSL without options keeps the 0.9.0 shared tap copy', async () => {
    const mod = await boot([tapFlow()]);
    const audit = collect(mod, 'audit');
    const payload = { token: TOKEN };
    await mod.get(ChannelRegistry).send('pay.in', payload);
    await settle();
    expect(audit[0]?.payload).toBe(payload);
    await mod.close();
  });

  it('wireTap copies AsShown by default under explicit privacy; copy Original needs a reason', async () => {
    const privacy = { fields: ['**.pan'] };
    const hidden = await boot([tapFlow()], { privacy });
    const audit = collect(hidden, 'audit');
    await hidden.get(ChannelRegistry).send('pay.in', { pan: '4111111111111111', token: TOKEN });
    await settle();
    expect(audit[0]?.payload).toEqual({ pan: '[HIDDEN:field]', token: '[HIDDEN:secrets.keys]' });
    await hidden.close();

    await expect(boot([tapFlow({ copy: TapCopy.Original })], { privacy })).rejects.toBeInstanceOf(
      PrivacyConfigError,
    );

    const warns: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => warns.push(String(m)) as never);
    const original = await boot(
      [tapFlow({ copy: TapCopy.Original, copyReason: 'raw audit store' })],
      { privacy },
    );
    spy.mockRestore();
    const raw = collect(original, 'audit');
    const payload = { pan: '4111111111111111' };
    await original.get(ChannelRegistry).send('pay.in', payload);
    await settle();
    expect(raw[0]?.payload).toBe(payload);
    expect(
      warns.some((w) => w.includes('original-copy tap') && w.includes('raw audit store')),
    ).toBe(true);
    await original.close();
  });

  it('a channel privacy on the tap channel turns the hidden copy on', async () => {
    const mod = await boot([tapFlow()], {
      channels: [
        { name: 'pay.in', type: 'direct' },
        { name: 'audit', type: 'pubsub', privacy: { fields: ['**.pan'] } },
        { name: 'sink', type: 'pubsub' },
      ],
    });
    const audit = collect(mod, 'audit');
    await mod.get(ChannelRegistry).send('pay.in', { pan: '4111111111111111' });
    await settle();
    expect(audit[0]?.payload).toEqual({ pan: '[HIDDEN:field]' });
    await mod.close();
  });
});

describe('S10 wire-tap copies compose with the reply routing strip (SD-52, D38)', () => {
  it('a hidden tap copy has no reply routing and the main path keeps it', async () => {
    const mod = await boot([tapFlow({ copy: TapCopy.AsShown })]);
    const audit = collect(mod, 'audit');
    const main = collect(mod, 'sink');
    const input = createMessage(
      { token: TOKEN },
      { authorization: `Bearer ${TOKEN}`, replyChannel: 'caller.reply', [JUMP_REPLY_HEADER]: true },
    );
    await mod.get(ChannelRegistry).sendMessage('pay.in', input);
    await settle();
    expect(audit[0]?.payload).toEqual({ token: '[HIDDEN:secrets.keys]' });
    expect(audit[0]?.headers.authorization).toBe('[HIDDEN:header]');
    expect(audit[0]?.headers).not.toHaveProperty('replyChannel');
    expect(audit[0]?.headers).not.toHaveProperty(JUMP_REPLY_HEADER);
    expect(audit[0]?.headers.id).toBe(input.headers.id);
    expect(main[0]?.headers.replyChannel).toBe('caller.reply');
    expect(input.headers.replyChannel).toBe('caller.reply');
    await mod.close();
  });
});

describe('S10 headers step under privacy (SD-27, SD-52, D37)', () => {
  const PARTNER = 'CANARYPARTNER0042';

  function headersFlow(): FlowDefinition {
    return {
      name: 'enrich',
      build: () =>
        IntegrationFlow.from('pay.in')
          .headers({ partnerRef: PARTNER, tenant: 'acme' }, { id: 'fixed' })
          .headers(() => ({ sessionRef: PARTNER }), { id: 'computed' })
          .wireTap('audit', { id: 'audit' })
          .to('sink'),
    };
  }

  it('headers step graph shows header names only, never values, under privacy', async () => {
    const mod = await boot([headersFlow()], { privacy: { headers: ['partnerRef', 'sessionRef'] } });
    const text = JSON.stringify(mod.get(ChannelGraph).snapshot(mod.get(ChannelRegistry)));
    expect(text).toContain('partnerRef');
    expect(text).toContain('tenant');
    expect(text).not.toContain(PARTNER);
    expect(text).not.toContain('acme');
    await mod.close();
  });

  it('headers set by a headers step pass the privacy header rules on the tap copy', async () => {
    const mod = await boot([headersFlow()], { privacy: { headers: ['partnerRef', 'sessionRef'] } });
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), 'audit');
    const main = collect(mod, 'sink');
    await mod.get(ChannelRegistry).send('pay.in', { amount: 1 });
    await settle();
    const tap = capture.writes.find((w) => w.where === 'channel audit');
    expect(tap?.text).toContain('[HIDDEN:header]');
    expect(tap?.text).toContain('acme');
    expect(main[0]?.headers.partnerRef).toBe(PARTNER);
    expect(main[0]?.headers.sessionRef).toBe(PARTNER);
    expectNoLeak(capture, [PARTNER]);
    await mod.close();
  });
});

describe('S4 forget envelopes and S8 flow records', () => {
  const failingTarget = (mod: TestingModule): void => {
    mod
      .get(ChannelRegistry)
      .get('sink')
      .subscribe(() => Promise.reject(new Error(`target refused ${FAIL}`)));
  };

  it('wait false envelopes hide with the flow privacy', async () => {
    const flow: FlowDefinition = {
      name: 'spread',
      build: () => IntegrationFlow.from('pay.in').fanoutTo([{ channel: 'sink', wait: false }]),
    };
    const mod = await boot([flow], {
      privacy: { patterns: [{ name: 'test.x', regex: /XCANARY\d{4}/ }] },
    });
    failingTarget(mod);
    const capture = captureTrail();
    capture.channel(mod.get(ChannelRegistry), 'error.channel');
    const { restore } = silenceErrors();
    await mod.get(ChannelRegistry).send('pay.in', {});
    await settle();
    await settle();
    restore();
    expect(capture.writes.some((w) => w.text.includes('[HIDDEN:test.x]'))).toBe(true);
    expectNoLeak(capture, [FAIL]);
    await mod.close();
  });

  it('flow failure records keep a hidden error under explicit privacy', async () => {
    const store = new MemoryIdempotencyStore();
    const capture = captureTrail();
    const flow: FlowDefinition = {
      name: 'charge',
      build: () =>
        IntegrationFlow.from('pay.in').handle(() => {
          throw new Error(`card declined ${FAIL}`);
        }),
    };
    const mod = await boot([flow], {
      idempotency: { store: capture.store(store) },
      privacy: { patterns: [{ name: 'test.x', regex: /XCANARY\d{4}/ }] },
    });
    const { restore } = silenceErrors();
    await mod
      .get(ChannelRegistry)
      .send('pay.in', {}, { idempotencyKey: 'k-1' })
      .catch(() => undefined);
    restore();
    const fail = capture.writes.find((w) => w.where.startsWith('store.fail'));
    expect(fail?.text).toContain('[HIDDEN:test.x]');
    expectNoLeak(capture, [FAIL]);
    await mod.close();
  });
});

function silenceErrors(): { restore: () => void } {
  const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return { restore: () => spy.mockRestore() };
}
