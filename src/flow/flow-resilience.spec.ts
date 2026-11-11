import { ChannelRegistry } from '../channel-registry';
import * as oneShot from '../channels/one-shot';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage, MessageHeadersInit } from '../message';
import { CareConfigError, CareKeyError } from '../resilience/resilience.errors';
import type { CareEvent, CareModuleOptions } from '../resilience/resilience.types';
import { CareEngine } from '../resilience/runtime';
import { recordingLogger, type Lines } from '../resilience/test-kit.spec-helper';
import { manualCareClock, type ManualCareClock } from '../testing/manual-resilience-clock';
import { bindFlow } from '../testing';
import type { HopLogger } from '../trace/hop-logger';
import { TraceContext } from '../trace/trace-context';
import { FlowExecutor } from './flow-executor';
import { FlowParameterResolver } from './flow-parameter-resolver';
import { classifyFlowError } from './flow-resilience';
import { JumpTimeoutError } from './flow-step';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const flaky = (message = 'flaky'): Error => Object.assign(new Error(message), { retryable: true });
const named = (name: string): Error => Object.assign(new Error(name), { name });

interface World {
  runtime: CareEngine;
  registry: ChannelRegistry;
  clock: ManualCareClock;
  events: CareEvent[];
  lines: Lines;
  errors: Record<string, unknown>[];
  bind(name: string, flow: IntegrationFlow, extra?: Parameters<typeof bindFlow>[2]): FlowExecutor;
  resolve(name: string, flow: IntegrationFlow): Record<string, unknown>[];
  inbox(channel: string, handler?: (msg: IntegrationMessage) => unknown): IntegrationMessage[];
  send(channel: string, payload: unknown, headers?: MessageHeadersInit): Promise<void>;
}

function world(options: CareModuleOptions = {}, enabled = true): World {
  const clock = manualCareClock();
  const events: CareEvent[] = [];
  const { logger, lines } = recordingLogger();
  const runtime = new CareEngine(
    {
      clock,
      random: (max) => max - 1,
      logger,
      events: { onEvent: (e) => events.push(e) },
      ...options,
    },
    { enabled },
  );
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  const errors: Record<string, unknown>[] = [];
  registry.get('error.channel').subscribe((msg) => {
    errors.push(msg.payload as Record<string, unknown>);
  });
  const definition = (name: string, flow: IntegrationFlow): FlowDefinition => ({
    name,
    build: () => flow,
  });
  return {
    runtime,
    registry,
    clock,
    events,
    lines,
    errors,
    bind: (name, flow, extra = {}) =>
      bindFlow(definition(name, flow), registry, { care: runtime, ...extra }),
    resolve: (name, flow) => [
      ...(new FlowParameterResolver(runtime, registry).resolve([definition(name, flow)]).flows[0]
        ?.described ?? []),
    ],
    inbox: (channel, handler) => {
      const received: IntegrationMessage[] = [];
      const target = registry.tryGet(channel) ?? registry.create({ name: channel, type: 'direct' });
      target.subscribe(async (msg) => {
        received.push(msg);
        await handler?.(msg);
      });
      return received;
    },
    send: (channel, payload, headers) => registry.send(channel, payload, headers),
  };
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

describe('flow care (SPI-445 section 2.13)', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('resolution (RS-51, RS-52, RS-55, RS-57)', () => {
    it('RU-51 resolves each part from the highest level that sets it, with the destination channel as L2 for send steps', async () => {
      const w = world({
        profiles: { p1: { patience: { eachTryMs: 1000 }, tries: { max: 2 } } },
        defaults: { 'flow-send': 'p1' },
      });
      w.runtime.declareChannels([
        { name: 'c', care: { tries: { max: 4, idempotent: true, spacing: 0 } } },
      ]);
      const flow = (): IntegrationFlow =>
        IntegrationFlow.from('in', { care: { send: { patience: { eachTryMs: 500 } } } }).to('c', {
          care: { lanes: { count: 1 } },
        });
      expect(w.resolve('f', flow())).toEqual([
        {
          kind: 'to',
          id: 'to#0',
          channel: 'c',
          care: 'patience 500ms · tries x4 · lanes',
          repeatableBy: 'declared',
        },
      ]);
      let calls = 0;
      w.inbox('c', () => {
        calls += 1;
        throw flaky();
      });
      w.bind('f', flow());
      // An incoming budget of 0 caps the resolved tries x4 at run time (runtime cap, not a level).
      await expect(w.send('in', 'x', { triesLeft: 0 })).rejects.toThrow('flaky');
      expect(calls).toBe(1);
    });

    it('RU-52 deep-merges inline fields over a named profile once and replaces whole parts across levels', () => {
      const w = world({
        profiles: {
          p: { tries: { max: 5, spacing: 100 }, patience: { eachTryMs: 2000 } },
        },
      });
      const merged = w.resolve(
        'f1',
        IntegrationFlow.from('in').to('out', { care: { use: 'p', tries: { spacing: 50 } } }),
      );
      expect(merged[0]).toMatchObject({ care: 'patience 2s · tries x5' });
      const replaced = w.resolve(
        'f2',
        IntegrationFlow.from('in', { care: { send: 'p' } }).to('out', {
          care: { tries: { spacing: 50 } },
        }),
      );
      expect(replaced[0]).toMatchObject({ care: 'patience 2s · tries x3' });
      const cut = w.resolve(
        'f3',
        IntegrationFlow.from('in', { care: { send: 'p' } }).to('out', { care: false }),
      );
      expect(cut).toEqual([{ kind: 'to', channel: 'out' }]);
    });

    it('RU-55 flow options apply per step family and never to wireTap, filter, transform or reply', () => {
      const w = world();
      const described = w.resolve(
        'f',
        IntegrationFlow.from('in', {
          care: {
            send: { tries: { max: 2 } },
            handle: { patience: { eachTryMs: 100 } },
            jump: { patience: { eachTryMs: 300 } },
          },
        })
          .wireTap('tap')
          .filter(() => true)
          .transform((p) => p)
          .handle((p) => p)
          .jump('svc')
          .reply()
          .to('out'),
      );
      expect(described).toEqual([
        { kind: 'wireTap', channel: 'tap' },
        { kind: 'filter' },
        { kind: 'transform' },
        { kind: 'handle', id: 'handle#3', care: 'patience 100ms', repeatableBy: 'none' },
        {
          kind: 'jump',
          id: 'jump#4',
          dests: [{ channel: 'svc', care: 'patience 300ms', repeatableBy: 'none' }],
        },
        { kind: 'reply', payload: 'current' },
        { kind: 'to', id: 'to#6', channel: 'out', care: 'tries x2', repeatableBy: 'key' },
      ]);
    });

    it('RU-57 a target care replaces the step care per part for that target', () => {
      const w = world({
        profiles: { p: { tries: { max: 3 }, patience: { eachTryMs: 700 } } },
      });
      const described = w.resolve(
        'f',
        IntegrationFlow.from('in').jumpTo(['a', { channel: 'b', care: { tries: false } }], {
          care: 'p',
        }),
      );
      expect(described[0]?.dests).toEqual([
        { channel: 'a', care: 'patience 700ms · tries x3', repeatableBy: 'key' },
        { channel: 'b', care: 'patience 700ms', repeatableBy: 'none' },
      ]);
    });
  });

  describe('edge rules (RS-58, RS-59, RS-62)', () => {
    it('RU-58 wireTap skips channel defaults, is sent once and strips triesLeft from the copy', async () => {
      const w = world();
      w.runtime.declareChannels([
        { name: 't', care: { tries: { max: 3, idempotent: true, spacing: 0 } } },
      ]);
      const taps = w.inbox('t', () => {
        throw flaky();
      });
      const out = w.inbox('out');
      w.bind('f', IntegrationFlow.from('in').wireTap('t').to('out'));
      await w.send('in', 'x', { triesLeft: 2, idempotencyKey: 'k' });
      await w.clock.flush();
      expect(taps).toHaveLength(1);
      expect(taps[0]?.headers).not.toHaveProperty('triesLeft');
      expect(out[0]?.headers.triesLeft).toBe(2);
    });

    it('RU-59 drops parts inherited from L1..L3 that an edge refuses and fails boot when L4 sets them', async () => {
      const w = world({ defaults: { 'flow-send': { planB: { value: () => 1 } } } });
      expect(() =>
        w.resolve(
          'bad',
          IntegrationFlow.from('in').fanoutTo(['a'], {
            care: { planB: { value: () => 1 } },
          }),
        ),
      ).toThrow(expect.objectContaining({ code: 'CARE_PART_NOT_ALLOWED' }) as Error);
      const described = w.resolve('ok', IntegrationFlow.from('in').publish('a').to('b'));
      expect(described).toEqual([
        { kind: 'publish', channel: 'a', routingKey: undefined },
        { kind: 'to', channel: 'b' },
      ]);
      expect(w.lines.warn.filter((line) => line.startsWith('CARE_PART_DROPPED'))).toHaveLength(2);

      const v = world();
      v.inbox('a', () => {
        throw flaky();
      });
      const fallback = v.inbox('b');
      v.bind('f', IntegrationFlow.from('in').to('a', { care: { planB: { channel: 'b' } } }));
      await v.send('in', 'x', { replyChannel: 'caller' });
      expect(fallback).toHaveLength(1);
      expect(fallback[0]?.headers.replyChannel).toBe('caller');
    });

    it('RU-62a a jump try opens a fresh reply channel, always unregisters it, and drops late replies', async () => {
      const w = world();
      const baseline = w.registry.list().length;
      let attempt = 0;
      const replies: string[] = [];
      w.inbox('svc', (msg) => {
        attempt += 1;
        const replyTo = String(msg.headers.replyChannel);
        replies.push(replyTo);
        const answer = `answer-${attempt}`;
        const reply = (): Promise<void> => w.registry.send(replyTo, answer).catch(() => undefined);
        if (attempt === 1) w.clock.setTimer(150, () => void reply());
        else return reply();
        return undefined;
      });
      const out = w.inbox('out');
      w.bind(
        'f',
        IntegrationFlow.from('in')
          .jump('svc', {
            care: {
              patience: { eachTryMs: 100 },
              tries: { max: 2, idempotent: true, spacing: 0 },
            },
          })
          .to('out'),
      );
      const done = w.send('in', 'x');
      await w.clock.advance(100);
      await done;
      await w.clock.advance(100);
      expect(new Set(replies).size).toBe(2);
      expect(out[0]?.headers.jumpReplies).toEqual({ svc: 'answer-2' });
      expect(w.registry.list().filter((c) => c.name.startsWith('reply.'))).toEqual([]);
      expect(w.registry.list()).toHaveLength(baseline + 3);
    });

    it('RU-62b legacy jump timeoutMs aliases eachTryMs, both on one target fail boot, and the wait is never unbounded', async () => {
      const w = world();
      expect(() =>
        w.resolve(
          'both',
          IntegrationFlow.from('in').jump('svc', {
            timeoutMs: 50,
            care: { patience: { eachTryMs: 80 } },
          }),
        ),
      ).toThrow(expect.objectContaining({ code: 'LEGACY_AND_NEW_SAME_LAYER' }) as Error);

      const waits: number[] = [];
      const original = oneShot.openFirstMessageWait;
      jest.spyOn(oneShot, 'openFirstMessageWait').mockImplementation((channel, options) => {
        // The effective wait is the one the try's timeout error reports (the engine times it).
        waits.push((options.timeoutError?.() as JumpTimeoutError).timeoutMs);
        return original(channel, options);
      });
      w.inbox('svc', (msg) => w.registry.send(String(msg.headers.replyChannel), 'ok'));
      w.bind('a', IntegrationFlow.from('in.a').jump('svc', { care: { patience: false } }));
      w.bind(
        'b',
        IntegrationFlow.from('in.b').jump('svc', {
          care: { tries: { max: 2, idempotent: true } },
        }),
      );
      w.bind(
        'c',
        IntegrationFlow.from('in.c').jump('svc', {
          timeoutMs: 40,
          care: { tries: { max: 2, idempotent: true } },
        }),
      );
      w.bind(
        'd',
        IntegrationFlow.from('in.d').jump('svc', {
          care: { patience: { eachTryMs: 0, totalMs: 3000 }, tries: false },
        }),
      );
      for (const source of ['in.a', 'in.b', 'in.c', 'in.d']) await w.send(source, 'x');
      expect(waits).toEqual([10_000, 10_000, 40, 3000]);
    });

    it('RU-62d a jump try is timed on the care clock only, never by a real timer of its own', async () => {
      const w = world();
      w.inbox('svc');
      w.bind(
        'f',
        IntegrationFlow.from('in').jump('svc', {
          care: { patience: { eachTryMs: 20 }, tries: { max: 2, idempotent: true, spacing: 0 } },
        }),
      );
      const done = settle(w.send('in', 'x'));
      // Real time well past eachTryMs while the care clock stands still: the try keeps waiting.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await w.clock.flush();
      expect(w.events.filter((e) => e.type === 'try.again')).toHaveLength(0);
      await w.clock.advance(20);
      expect(w.events.filter((e) => e.type === 'try.again')).toHaveLength(1);
      await w.clock.advance(20);
      expect(await done).toBeInstanceOf(JumpTimeoutError);
      expect(((await done) as JumpTimeoutError).timeoutMs).toBe(20);
      expect(w.registry.list().filter((c) => c.name.startsWith('reply.'))).toEqual([]);
    });

    it('RU-62c wait:false targets extra try in the background, refuse plan B, report one final failure, and start no try after shutdown begins', async () => {
      const w = world();
      expect(() =>
        w.resolve(
          'fb',
          IntegrationFlow.from('in').jumpTo([{ channel: 'svc', wait: false }], {
            care: { planB: { value: () => 1 } },
          }),
        ),
      ).toThrow(expect.objectContaining({ code: 'CARE_PART_NOT_ALLOWED' }) as Error);

      let calls = 0;
      w.inbox('svc', () => {
        calls += 1;
        throw flaky();
      });
      w.bind(
        'f',
        IntegrationFlow.from('in').jumpTo([{ channel: 'svc', wait: false }], {
          care: { tries: { max: 3, idempotent: true, spacing: 0 } },
        }),
      );
      await w.send('in', 'x');
      await w.clock.flush();
      expect(calls).toBe(3);
      expect(w.errors).toEqual([
        expect.objectContaining({ fireAndForget: true, channel: 'svc', flow: 'f' }),
      ]);

      const s = world();
      let slow = 0;
      s.inbox('svc', () => {
        slow += 1;
        throw flaky();
      });
      s.bind(
        'g',
        IntegrationFlow.from('in').fanoutTo([{ channel: 'svc', wait: false }], {
          care: { tries: { max: 3, idempotent: true, spacing: 1000 } },
        }),
      );
      await s.send('in', 'x');
      await s.clock.flush();
      s.runtime.shutdown();
      await s.clock.flush();
      expect(slow).toBe(1);
      expect(s.errors).toHaveLength(1);
      expect(s.clock.pendingTimers).toBe(0);
    });
  });

  describe('extra try gate, tries and classification (RS-60, RS-61, RS-63)', () => {
    it('RU-60a a flow step extra tries only under a message key, a key resolver or idempotent: true', async () => {
      const w = world();
      let calls = 0;
      const fn = (): never => {
        calls += 1;
        throw flaky();
      };
      w.bind(
        'keyed',
        IntegrationFlow.from('in').handle(fn, {
          care: { tries: { max: 3, spacing: 0 } },
        }),
      );
      await settle(w.send('in', 'x'));
      expect(calls).toBe(1);
      expect(w.events.filter((e) => e.type === 'try.held')).toHaveLength(1);
      calls = 0;
      await settle(w.send('in', 'x', { idempotencyKey: 'k1' }));
      expect(calls).toBe(3);
      calls = 0;
      w.bind(
        'declared',
        IntegrationFlow.from('in.d').handle(fn, {
          care: { tries: { max: 2, spacing: 0, idempotent: true } },
        }),
      );
      await settle(w.send('in.d', 'x'));
      expect(calls).toBe(2);
    });

    it('RU-60b logs no TRIES_WITHOUT_KEY under the default flow claim and honours requireIdempotencyKey', async () => {
      const w = world();
      let calls = 0;
      w.bind(
        'f',
        IntegrationFlow.from('in').handle(
          () => {
            calls += 1;
            return 'never';
          },
          { care: { tries: { max: 3, requireIdempotencyKey: true } } },
        ),
      );
      expect(w.lines.warn.some((line) => line.includes('TRIES_WITHOUT_KEY'))).toBe(false);
      const error = await settle(w.send('in', 'x'));
      expect(error).toBeInstanceOf(CareKeyError);
      expect(calls).toBe(0);
    });

    it('RU-61 a send try resends an identical hop copy, route runs its function once, one flow hop pair per run', async () => {
      const w = world();
      let failures = 1;
      const seen = w.inbox('c', () => {
        if (failures-- > 0) throw flaky();
      });
      const lines: string[] = [];
      const logger = {
        flowStart: () => lines.push('start'),
        flowEnd: () => lines.push('end'),
      } as unknown as HopLogger;
      const definition = {
        name: 'f',
        build: () =>
          IntegrationFlow.from('in').to('c', {
            care: { tries: { max: 2, spacing: 0 } },
          }),
      };
      const resolved = new FlowParameterResolver(w.runtime, w.registry).resolve([definition])
        .flows[0];
      w.registry.create({ name: 'in', type: 'direct' });
      new FlowExecutor('f', resolved!.built, {
        registry: w.registry,
        trace: w.registry.trace,
        errorChannel: 'error.channel',
        care: w.runtime,
        stepCare: resolved!.stepCare,
        logger,
      }).attachTo(w.registry);
      await w.send('in', 'x', { idempotencyKey: 'k' });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.headers.id).toBe(seen[1]?.headers.id);
      // The step builds the hop once; only the hop the channel records on delivery differs.
      expect(seen[0]?.headers.history.slice(0, -1)).toEqual(seen[1]?.headers.history.slice(0, -1));
      expect(seen[0]?.headers.history.at(-2)).toMatchObject({ channel: 'c', component: 'to:f' });
      expect(lines).toEqual(['start', 'end']);

      let routed = 0;
      w.bind(
        'r',
        IntegrationFlow.from('in.r').route(
          () => {
            routed += 1;
            throw flaky('route');
          },
          { care: { tries: { max: 3, spacing: 0, idempotent: true } } },
        ),
      );
      const before = w.events.length;
      await settle(w.send('in.r', 'x', { idempotencyKey: 'k' }));
      expect(routed).toBe(1);
      expect(w.events).toHaveLength(before);
    });

    it('RU-63 flow adapters classify channel errors by name per the section 5.7 table', async () => {
      const rows: [string, 'flow-send' | 'flow-jump' | 'flow-handle', string][] = [
        ['JumpTimeoutError', 'flow-jump', 'transient'],
        ['JumpTimeoutError', 'flow-send', 'unknown'],
        ['CapacityExceededError', 'flow-send', 'busy'],
        ['CapacityExceededError', 'flow-jump', 'busy'],
        ['NoSubscriberError', 'flow-send', 'rejected'],
        ['ChannelNotFoundError', 'flow-jump', 'rejected'],
        ['FanoutCycleError', 'flow-send', 'rejected'],
        ['CapacityExceededError', 'flow-handle', 'unknown'],
      ];
      for (const [name, edge, expected] of rows) {
        expect([name, edge, classifyFlowError(edge, named(name)).class]).toEqual([
          name,
          edge,
          expected,
        ]);
      }
      expect(classifyFlowError('flow-send', flaky()).class).toBe('transient');

      const w = world();
      let calls = 0;
      w.inbox('full', () => {
        calls += 1;
        if (calls === 1) throw named('CapacityExceededError');
      });
      w.bind(
        'f',
        IntegrationFlow.from('in').to('full', {
          care: {
            tries: { max: 3, spacing: 0, on: ['transient', 'busy'] },
          },
        }),
      );
      await w.send('in', 'x', { idempotencyKey: 'k' });
      expect(calls).toBe(2);

      w.bind(
        'g',
        IntegrationFlow.from('in.g').to('nosub', {
          care: { tries: { max: 3, spacing: 0 } },
        }),
      );
      w.registry.create({ name: 'nosub', type: 'direct' });
      const error = await settle(w.send('in.g', 'x', { idempotencyKey: 'k' }));
      expect((error as Error).name).toBe('NoSubscriberError');
      expect(w.events.filter((e) => e.type === 'try.again' && e.channel === 'nosub')).toHaveLength(
        0,
      );
    });
  });

  describe('plan-B-marked runs and the tries left (RS-64, RS-65)', () => {
    it('RU-64a a jump plan B lands in jumpReplies with jumpPlanB and the flow claim is not completed', async () => {
      const w = world();
      const store = new MemoryIdempotencyStore();
      const idempotency = new IdempotencyService({ store });
      let runs = 0;
      w.inbox('svc', () => {
        throw flaky();
      });
      const out = w.inbox('out', () => {
        runs += 1;
      });
      w.bind(
        'loan',
        IntegrationFlow.from('in')
          .jump('svc', { care: { planB: { value: () => ({ status: 'unknown' }) } } })
          .to('out'),
        { idempotency },
      );
      await w.send('in', 'x', { idempotencyKey: 'k' });
      await w.send('in', 'x', { idempotencyKey: 'k' });
      expect(runs).toBe(2);
      expect(out[0]?.headers.jumpReplies).toEqual({ svc: { status: 'unknown' } });
      expect(out[0]?.headers.jumpPlanB).toEqual({ svc: true });
      expect((await store.get('flow:loan', 'k'))?.status).not.toBe('completed');

      const failing = {
        begin: jest.fn(() => Promise.resolve(true)),
        complete: jest.fn(() => Promise.resolve()),
        fail: jest.fn(() => Promise.resolve()),
      };
      w.bind(
        'nostore',
        IntegrationFlow.from('in.n').jump('svc', {
          care: { planB: { value: () => 'fb' } },
        }),
        { idempotency: failing },
      );
      await w.send('in.n', 'x', { idempotencyKey: 'k2' });
      expect(failing.complete).not.toHaveBeenCalled();
      expect(failing.fail).toHaveBeenCalledTimes(1);
    });

    it('RU-64b a handle plan B becomes the payload, a plan-B-marked jump reply header marks the flow scope, and a plan-B-marked flow reply step sets planB: true', async () => {
      const w = world();
      const replies = w.inbox('caller');
      w.bind(
        'inner',
        IntegrationFlow.from('inner.in')
          .handle(
            () => {
              throw flaky();
            },
            { care: { planB: { value: () => 'fallback-payload' } } },
          )
          .reply(),
      );
      await w.send('inner.in', 'x', { replyChannel: 'caller' });
      expect(replies[0]?.payload).toBe('fallback-payload');
      expect(replies[0]?.headers.planB).toBe(true);

      const store = new MemoryIdempotencyStore();
      w.bind('outer', IntegrationFlow.from('outer.in').jump('inner.in').reply(), {
        idempotency: new IdempotencyService({ store }),
      });
      await w.send('outer.in', 'y', { replyChannel: 'caller', idempotencyKey: 'k' });
      expect(replies[1]?.headers.planB).toBe(true);
      expect(await store.get('flow:outer', 'k')).toBeUndefined();

      w.bind('plain', IntegrationFlow.from('plain.in').reply());
      await w.send('plain.in', 'z', { replyChannel: 'caller' });
      expect(replies[2]?.headers).not.toHaveProperty('planB');
    });

    it('RU-65 a trying-again flow step stamps triesLeft 0 on its hops and a non-trying-again step forwards the tries left', async () => {
      const w = world();
      const c = w.inbox('c');
      const d = w.inbox('d');
      w.bind(
        'f',
        IntegrationFlow.from('in')
          .publish('c', { care: { tries: { max: 3, spacing: 0 } } })
          .to('d'),
      );
      await w.send('in', 'x', { triesLeft: 2, idempotencyKey: 'k' });
      expect(c[0]?.headers.triesLeft).toBe(0);
      expect(d[0]?.headers.triesLeft).toBe(2);

      const off = world({}, false);
      const e = off.inbox('e');
      off.bind('g', IntegrationFlow.from('in').to('e', { care: { tries: { max: 3 } } }));
      await off.send('in', 'x', { idempotencyKey: 'k' });
      expect(e[0]?.headers).not.toHaveProperty('triesLeft');
    });
  });

  describe('observability and compatibility (RS-66, RS-70)', () => {
    it('RU-66a flow edge events and metrics use the step subject and never a payload value', async () => {
      const w = world();
      let failures = 1;
      w.inbox('c', () => {
        if (failures-- > 0) throw flaky();
      });
      w.bind(
        'orders',
        IntegrationFlow.from('in').to('c', {
          id: 'persist',
          care: { tries: { max: 2, spacing: 0 } },
        }),
      );
      await w.send('in', { card: 'secret-123' }, { idempotencyKey: 'k' });
      expect(w.events).toEqual([
        expect.objectContaining({
          type: 'try.again',
          edge: 'flow-send',
          binding: 'flow:orders#persist:c',
          channel: 'c',
        }),
      ]);
      expect(JSON.stringify(w.events)).not.toContain('secret-123');
    });

    it('RU-66a valve events of a flow send target carry the target channel', async () => {
      const w = world();
      w.inbox('crm', () => {
        throw flaky();
      });
      w.bind(
        'wa',
        IntegrationFlow.from('in').fanoutTo([
          { channel: 'crm', care: { valve: { minCalls: 1, failPercent: 50, shutMs: 60_000 } } },
        ]),
      );
      await settle(w.send('in', { text: 'secret-123' }));
      const valve = w.events.filter((event) => event.type.startsWith('valve.'));
      expect(valve).toEqual([
        expect.objectContaining({
          type: 'valve.shut',
          edge: 'flow-send',
          binding: 'flow:wa#fanout#0:crm',
          channel: 'crm',
        }),
      ]);
    });

    it('RU-70 flows without any care configuration behave as in 0.9.0', async () => {
      const shapes = async (withRuntime: boolean): Promise<unknown[]> => {
        const w = world();
        const out = w.inbox('out');
        w.inbox('svc', (msg) => w.registry.send(String(msg.headers.replyChannel), 'pong'));
        w.inbox('bad', () => {
          throw new Error('boom');
        });
        const flow = IntegrationFlow.from('in')
          .wireTap('tap')
          .jump('svc')
          .fanoutTo(['out', { channel: 'bad', wait: false }])
          .to('out');
        w.registry.create({ name: 'tap', type: 'pubsub' });
        if (withRuntime) w.bind('f', flow);
        else bindFlow({ name: 'f', build: () => flow }, w.registry);
        await w.send('in', 'x', { triesLeft: 1 });
        await w.clock.flush();
        expect(w.events).toEqual([]);
        if (withRuntime) {
          expect(w.resolve('f', flow)).toEqual(flow.inspect().steps);
        }
        return [
          out.map((msg) => Object.keys(msg.headers).sort()),
          out.map((msg) => msg.headers.jumpReplies),
          w.errors.map((error) => Object.keys(error).sort()),
          w.registry.list().map((c) => c.name),
        ];
      };
      expect(await shapes(true)).toEqual(await shapes(false));
    });

    it('RU-67 the resolver collects every finding of every flow before it throws once', () => {
      const w = world({ profiles: { known: { tries: { max: 2 } } } });
      const definitions: FlowDefinition[] = [
        { name: 'a', build: () => IntegrationFlow.from('a').to('x', { care: 'jump-slo' }) },
        {
          name: 'b',
          build: () => IntegrationFlow.from('b').handle((p) => p, { id: 'h', care: 'nope' }),
        },
      ];
      let error: unknown;
      try {
        new FlowParameterResolver(w.runtime, w.registry).resolve(definitions);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(CareConfigError);
      const findings = (error as CareConfigError).findings;
      expect(findings.map((f) => [f.code, f.subject])).toEqual([
        ['UNKNOWN_PROFILE', "flow 'a' step 'to#0' target 'x'"],
        ['UNKNOWN_PROFILE', "flow 'b' step 'h'"],
      ]);
      expect((error as Error).message).toContain("flow 'a' step 'to#0' target 'x': care.use");
    });
  });
});
