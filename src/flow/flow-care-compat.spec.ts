import { ChannelRegistry } from '../channel-registry';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage, MessageHeadersInit } from '../message';
import { CareScope, PLAN_B_HEADER, TRIES_LEFT_MESSAGE_HEADER } from '../resilience/retry-budget';
import { CareEngine } from '../resilience/runtime';
import { bindFlow } from '../testing';
import { TraceContext } from '../trace/trace-context';
import { IntegrationFlow } from './integration-flow';

type Mode = 'without care' | 'with forRoot({ care })' | 'with step care only';

interface World {
  engine: CareEngine;
  registry: ChannelRegistry;
  bind(name: string, flow: IntegrationFlow, store?: MemoryIdempotencyStore): void;
  inbox(channel: string): IntegrationMessage[];
  send(channel: string, payload: unknown, headers?: MessageHeadersInit): Promise<void>;
}

/** A registry and an engine as `IntegrationModule` builds them, with or without care. */
function world(mode: Mode): World {
  const engine = new CareEngine({}, { enabled: mode === 'with forRoot({ care })' });
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  return {
    engine,
    registry,
    bind: (name, flow, store) => {
      bindFlow({ name, build: () => flow }, registry, {
        care: engine,
        ...(store === undefined ? {} : { idempotency: new IdempotencyService({ store }) }),
      });
    },
    inbox: (channel) => {
      const received: IntegrationMessage[] = [];
      const target = registry.tryGet(channel) ?? registry.create({ name: channel, type: 'direct' });
      target.subscribe((msg) => {
        received.push(msg);
      });
      return received;
    },
    send: (channel, payload, headers) => registry.send(channel, payload, headers),
  };
}

/** A downstream service that answers every request with a reply marked as plan B. */
function planBService(w: World, channel: string): void {
  w.registry.create({ name: channel, type: 'direct' }).subscribe(async (msg) => {
    const replyChannel = msg.headers.replyChannel;
    if (typeof replyChannel !== 'string') return;
    await w.registry.send(replyChannel, 'from plan B', {
      correlationId: msg.headers.correlationId,
      [PLAN_B_HEADER]: true,
    });
  });
}

/** Step care that never changes the outcome: it only makes the module "configured". */
const passiveCare = { care: { patience: { eachTryMs: 60_000 } } } as const;

describe('flows keep the 0.9.0 behaviour without any care configuration (RS-70)', () => {
  it('a module without care has no configuration; forRoot({ care }) or any care reference has', () => {
    expect(new CareEngine({}, { enabled: false }).configured).toBe(false);
    expect(new CareEngine({}, { enabled: true }).configured).toBe(true);
    const declared = new CareEngine({}, { enabled: false });
    declared.declareChannels([{ name: 'c', care: { lanes: { count: 1 } } }]);
    expect(declared.configured).toBe(true);
    const planned = new CareEngine({}, { enabled: false });
    planned.plan('b', [undefined, undefined], 'flow-send');
    expect(planned.configured).toBe(false);
    planned.plan('b', [{ patience: { eachTryMs: 10 } }], 'flow-send');
    expect(planned.configured).toBe(true);
  });

  describe('(a) a wireTap copy keeps the tries-left header unless the module has care', () => {
    it.each<[Mode, unknown]>([
      ['without care', 2],
      ['with forRoot({ care })', undefined],
      ['with step care only', undefined],
    ])('%s', async (mode, expected) => {
      const w = world(mode);
      const taps = w.inbox('tap');
      const out = w.inbox('out');
      const opts = mode === 'with step care only' ? passiveCare : {};
      w.bind('f', IntegrationFlow.from('in').wireTap('tap').to('out', opts));
      await w.send('in', 'x', { [TRIES_LEFT_MESSAGE_HEADER]: 2 });
      await new Promise((resolve) => setImmediate(resolve));
      expect(taps).toHaveLength(1);
      expect(taps[0]?.headers[TRIES_LEFT_MESSAGE_HEADER]).toBe(expected);
      expect(out[0]?.headers[TRIES_LEFT_MESSAGE_HEADER]).toBe(2);
    });
  });

  describe('(b) a downstream plan B reply releases the flow claim only when the module has care', () => {
    it.each<[Mode, boolean]>([
      ['without care', true],
      ['with forRoot({ care })', false],
      ['with step care only', false],
    ])('%s', async (mode, stored) => {
      const w = world(mode);
      planBService(w, 'svc');
      w.inbox('caller');
      const store = new MemoryIdempotencyStore();
      const flow =
        mode === 'with step care only'
          ? IntegrationFlow.from('in').jump('svc').to('done', passiveCare)
          : IntegrationFlow.from('in').jump('svc').to('done');
      w.inbox('done');
      w.bind('f', flow, store);
      await w.send('in', 'x', { idempotencyKey: 'k-1' });
      const record = await store.get('flow:f', 'k-1');
      if (stored) expect(record?.result).toEqual({ completed: true });
      else expect(record).toBeUndefined();
    });
  });

  describe('(c) a jump reply carrying the plan B header marks the flow only when the module has care', () => {
    it.each<[Mode, unknown]>([
      ['without care', undefined],
      ['with forRoot({ care })', true],
      ['with step care only', true],
    ])('%s', async (mode, expected) => {
      const w = world(mode);
      planBService(w, 'svc');
      const replies = w.inbox('caller');
      const flow =
        mode === 'with step care only'
          ? IntegrationFlow.from('in')
              .handle((p) => p, passiveCare)
              .jump('svc')
              .reply()
          : IntegrationFlow.from('in').jump('svc').reply();
      w.bind('f', flow);
      await w.send('in', 'x', { replyChannel: 'caller' });
      expect(replies).toHaveLength(1);
      expect(replies[0]?.headers[PLAN_B_HEADER]).toBe(expected);
    });
  });

  describe('(d) the flow opens a message scope only when the module has care', () => {
    it.each<[Mode, boolean]>([
      ['without care', false],
      ['with forRoot({ care })', true],
      ['with step care only', true],
    ])('%s', async (mode, scoped) => {
      const w = world(mode);
      const seen: boolean[] = [];
      const probe = (payload: unknown): unknown => {
        seen.push(CareScope.current() !== undefined);
        return payload;
      };
      w.inbox('out');
      const opts = mode === 'with step care only' ? passiveCare : {};
      w.bind('f', IntegrationFlow.from('in').handle(probe).to('out', opts));
      await w.send('in', 'x');
      expect(seen).toEqual([scoped]);
    });
  });
});
