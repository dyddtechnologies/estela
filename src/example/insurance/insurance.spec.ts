import 'reflect-metadata';

import { ChannelRegistry } from '../../channel-registry';
import { TraceContext } from '../../trace/trace-context';
import { bindFlow, collect, waitFor } from '../../testing';
import { discoverActivators, subscribeActivators } from '../../activator/activator-wrapper';
import {
  CancelPolicyErrorFlow,
  CancelPolicyFlow,
  CreatePolicyFlow,
  CreateQuoteFlow,
  INSURANCE_CHANNELS,
  RouteQuoteByCountryFlow,
} from './insurance.channels';
import { CancelPolicyActivators } from './insurance.activators';

const quoteCmd = {
  planId: 'plan-apap-1',
  numberId: '12345678',
  dob: '1990-01-01',
  country: 'GT',
};

const quoted = {
  quoteId: 'qte-plan-apap-1',
  ...quoteCmd,
  premium: 250,
};

function setupRegistry(): ChannelRegistry {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  for (const spec of INSURANCE_CHANNELS) {
    if (registry.tryGet(spec.name) === undefined) registry.create(spec);
  }
  return registry;
}

function replyOn(registry: ChannelRegistry, channel: string, result: unknown): void {
  registry.get(channel).subscribe((msg) => {
    const replyChannel = msg.headers.replyChannel;
    if (typeof replyChannel !== 'string' || replyChannel.length === 0) return Promise.resolve();
    return registry.send(replyChannel, result);
  });
}

describe('insurance example — README EIP shape', () => {
  it('create-quote: filter → transform → wireTap → jumpTo → publish → reply → to', () => {
    const inspected = CreateQuoteFlow.build().inspect();
    expect(inspected.source).toBe('insurance.quotes.create');
    expect(inspected.steps.map((step) => step.kind)).toEqual([
      'filter',
      'transform',
      'wireTap',
      'jump',
      'publish',
      'reply',
      'to',
    ]);
    expect(inspected.steps).toEqual(
      expect.arrayContaining([
        { kind: 'wireTap', channel: 'insurance.quotes.audit' },
        {
          kind: 'jump',
          dests: [
            { channel: 'insurance.quotes.validate-rules', timeoutMs: 3_000 },
            { channel: 'insurance.quotes.price', timeoutMs: 3_000 },
          ],
        },
        { kind: 'publish', channel: 'insurance.quotes.created', routingKey: 'quote.created' },
        { kind: 'reply', payload: 'current' },
        { kind: 'to', channel: 'insurance.quotes.persist' },
      ]),
    );
  });

  it('create-policy: filter → transform → jump → publish → reply → to', () => {
    const inspected = CreatePolicyFlow.build().inspect();
    expect(inspected.source).toBe('insurance.policies.create');
    expect(inspected.steps.map((step) => step.kind)).toEqual([
      'filter',
      'transform',
      'jump',
      'publish',
      'reply',
      'to',
    ]);
  });

  it('create-quote: transform + jumps + publish + persist; filter descarta sin persistir', async () => {
    const registry = setupRegistry();
    registry.create({ name: 'reply.test', type: 'direct' });
    replyOn(registry, 'insurance.quotes.validate-rules', 'rules-ok');
    replyOn(registry, 'insurance.quotes.price', 'priced');
    const persist = collect(registry, 'insurance.quotes.persist');
    const events = collect(registry, 'insurance.quotes.created');
    bindFlow(CreateQuoteFlow, registry);

    await registry.send('insurance.quotes.create', { planId: 'x' });
    expect(persist.received).toEqual([]);

    const replied = waitFor(registry, 'reply.test', 2_000);
    const audited = waitFor(registry, 'insurance.quotes.audit', 2_000);
    await registry.send('insurance.quotes.create', quoteCmd, { replyChannel: 'reply.test' });
    expect((await replied).payload).toEqual(quoted);
    expect(persist.received).toEqual([quoted]);
    expect(events.received).toEqual([quoted]);
    expect((await audited).payload).toEqual(quoted);
  });

  it('persist → route-quote-by-country (GT → local); invariant: persist no es source de otro flow', async () => {
    const registry = setupRegistry();
    replyOn(registry, 'insurance.quotes.validate-rules', 'rules-ok');
    replyOn(registry, 'insurance.quotes.price', 'priced');
    registry.get('insurance.quotes.persist').subscribe((msg) => {
      return registry.send('insurance.quotes.country', msg.payload);
    });
    bindFlow(CreateQuoteFlow, registry);
    bindFlow(RouteQuoteByCountryFlow, registry);
    const routed = waitFor(registry, 'insurance.quotes.local', 2_000);

    await registry.send('insurance.quotes.create', quoteCmd);
    expect((await routed).payload).toEqual(quoted);
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bindCancel(registry: ChannelRegistry): CancelPolicyActivators {
  if (registry.tryGet('error.channel') === undefined) {
    registry.create({ name: 'error.channel', type: 'pubsub' });
  }
  const cancel = new CancelPolicyActivators(registry);
  subscribeActivators(discoverActivators([cancel]), {
    registry,
    trace: registry.trace,
    errorChannel: 'error.channel',
  });
  bindFlow(CancelPolicyFlow, registry);
  bindFlow(CancelPolicyErrorFlow, registry);
  return cancel;
}

describe('insurance example — cancel-policy (DSL entry + activator chain)', () => {
  it('cancel-policy DSL is from().to(first activator) — chain lives in activators', () => {
    const inspected = CancelPolicyFlow.build().inspect();
    expect(inspected.source).toBe('insurance.policies.cancel');
    expect(inspected.steps).toEqual([
      { kind: 'to', channel: 'insurance.policies.cancel.s1.save-db' },
    ]);
  });

  it('cancel-policy-errors DSL routes by failed step', () => {
    const inspected = CancelPolicyErrorFlow.build().inspect();
    expect(inspected.source).toBe('insurance.policies.cancel.errors');
    expect(inspected.steps.map((step) => step.kind)).toEqual(['route']);
  });

  it('happy path: db → email → billing queue → audit → policy-log; terminal auto-replies', async () => {
    const registry = setupRegistry();
    registry.create({ name: 'reply.cancel', type: 'direct' });
    const cancel = bindCancel(registry);
    const replied = waitFor(registry, 'reply.cancel', 2_000);

    await registry.send(
      'insurance.policies.cancel',
      { policyId: 'pol-1' },
      { replyChannel: 'reply.cancel' },
    );
    expect((await replied).payload).toEqual({ policyId: 'pol-1', status: 'CANCELLED' });
    expect(cancel.saved).toEqual([{ policyId: 'pol-1', status: 'CANCELLED' }]);
    expect(cancel.emails).toHaveLength(1);
    expect(cancel.audits).toHaveLength(1);
    expect(cancel.logs).toEqual([{ policyId: 'pol-1', status: 'CANCELLED' }]);
    await delay(50);
    expect(cancel.billingQueued).toEqual([{ policyId: 'pol-1', status: 'CANCELLED' }]);
  });

  it('failAt email: flow rejects and error flow routes to errors.email', async () => {
    const registry = setupRegistry();
    bindCancel(registry);
    const routed = waitFor(registry, 'insurance.policies.cancel.errors.email', 2_000);

    await expect(
      registry.send('insurance.policies.cancel', { policyId: 'pol-1', failAt: 'email' }),
    ).rejects.toThrow('cancel email failed');
    expect((await routed).payload).toMatchObject({ step: 'email', policyId: 'pol-1' });
  });
});
