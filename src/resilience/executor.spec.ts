import { createMessage } from '../message';
import { MemoryCareState } from '../testing/memory-resilience-state-port';
import { manualCareClock } from '../testing/manual-resilience-clock';
import { currentTrySignal } from './executor';
import { CareObserver } from './observability';
import {
  LanesFullError,
  ValveShutError,
  OutOfTimeError,
  PlanBFailedError,
  OverPaceError,
  CareKeyError,
} from './resilience.errors';
import { CareScope } from './retry-budget';
import {
  ctxOf,
  harness,
  rejected,
  settle,
  TestTimeoutError,
  transient,
} from './test-kit.spec-helper';

const ok =
  <T>(value: T) =>
  () =>
    Promise.resolve(value);

describe('CareExecutor', () => {
  it('RU-01 runs a care with no part as one direct try', async () => {
    const h = harness({});
    let calls = 0;
    const result = await h.exec.execute(ctxOf(), (attempt) => {
      calls += 1;
      expect(attempt.signal).toBeUndefined();
      return Promise.resolve('v');
    });
    expect(result).toMatchObject({ value: 'v', tries: 1, planB: false });
    expect(calls).toBe(1);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('RU-02 composes plan B > total patience > lanes > extra try > valve > pace > eachTryMs in that order', async () => {
    const order: string[] = [];
    const h = harness({
      patience: { eachTryMs: 100, totalMs: 10_000 },
      tries: { max: 3, spacing: 10, idempotent: true },
      valve: { minCalls: 10 },
      lanes: { count: 1 },
      pace: { perSecond: 1, burst: 3 },
      planB: { value: () => 'fb' },
    });
    let calls = 0;
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        calls += 1;
        order.push(`attempt ${attempt.tryNumber} signal=${attempt.signal !== undefined}`);
        return calls < 3 ? Promise.reject(transient()) : Promise.resolve('done');
      }),
    );
    await h.clock.advance(100);
    expect(p.value).toMatchObject({ value: 'done', tries: 3, planB: false });
    expect(order).toEqual([
      'attempt 1 signal=true',
      'attempt 2 signal=true',
      'attempt 3 signal=true',
    ]);
    // 3 tokens taken: a 4th call at the same instant is rate limited.
    const fourth = settle(h.exec.execute(ctxOf(), ok('x')));
    await h.clock.flush();
    expect(fourth.value).toMatchObject({ value: 'fb', planB: true });
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
  });

  it('RU-06 aborts the try signal and rejects even when work ignores it', async () => {
    const h = harness({ patience: { eachTryMs: 100 } });
    let seen: AbortSignal | undefined;
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        seen = attempt.signal;
        return new Promise(() => undefined);
      }),
    );
    await h.clock.advance(99);
    expect(p.done).toBe(false);
    await h.clock.advance(1);
    expect(p.error).toBeInstanceOf(TestTimeoutError);
    expect(seen?.aborted).toBe(true);
  });

  it('RU-07a caps each try at the remaining total patience', async () => {
    const h = harness({
      patience: { eachTryMs: 5000, totalMs: 1000 },
      tries: { max: 3, spacing: 400, idempotent: true },
    });
    const timeouts: number[] = [];
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        timeouts.push(attempt.eachTryMs);
        return new Promise<never>((_r, reject) => h.clock.setTimer(100, () => reject(transient())));
      }),
    );
    await h.clock.advance(1000);
    expect(timeouts).toEqual([1000, 500]);
    expect(p.error).toBeInstanceOf(OutOfTimeError);
  });

  it('RU-07b never sleeps or queues past the total patience and does not record an try cut by it', async () => {
    const h = harness({
      patience: { totalMs: 1000 },
      tries: { max: 5, spacing: 600, idempotent: true },
      valve: {
        minCalls: 2,
        failPercent: 100,
        lookBack: { lastCalls: 2 },
      },
    });
    const timeouts: number[] = [];
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        timeouts.push(attempt.eachTryMs);
        return new Promise<never>((_r, reject) =>
          h.clock.setTimer(300, () => reject(transient('slow'))),
        );
      }),
    );
    await h.clock.advance(1000);
    expect(timeouts).toEqual([1000, 100]);
    expect(p.error).toBeInstanceOf(OutOfTimeError);
    expect((p.error as OutOfTimeError).cause).toBeInstanceOf(TestTimeoutError);
    // One failure recorded (attempt 1), not two: with minCalls 2 the breaker stays closed.
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    expect(h.events.map((e) => e.type)).toContain('patience.ran-out');
  });

  it('RU-08 extra tries only classes in tries.on while tries, tries left and total patience remain', async () => {
    const h = harness({ tries: { max: 3, spacing: 0, idempotent: true } });
    let calls = 0;
    const error = rejected();
    await expect(
      h.exec.execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(error);
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('RU-09a does not extra try a non-repeatable operation, including after a eachTryMs', async () => {
    const h = harness(
      { patience: { eachTryMs: 50 }, tries: { max: 3, spacing: 0 } },
      { adapter: { repeatable: () => false } },
    );
    let calls = 0;
    const p = settle(
      h.exec.execute(ctxOf(), () => {
        calls += 1;
        return new Promise(() => undefined);
      }),
    );
    await h.clock.advance(500);
    expect(p.error).toBeInstanceOf(TestTimeoutError);
    expect(calls).toBe(1);
    expect(h.events.map((e) => e.type)).toEqual(['try.held']);
  });

  it('RU-11a waits max(backoff, Retry-After)', async () => {
    const h = harness({
      tries: { max: 2, spacing: { firstMs: 100, spread: 'none' }, idempotent: true },
      classify: () => ({ class: 'busy', readyInMs: 2000 }),
    });
    const starts: number[] = [];
    const p = settle(
      h.exec.execute(ctxOf(), () => {
        starts.push(h.clock.monotonic());
        return starts.length === 1 ? Promise.reject(new Error('429')) : Promise.resolve('ok');
      }),
    );
    await h.clock.advance(1999);
    expect(starts).toHaveLength(1);
    await h.clock.advance(1);
    expect(p.value).toMatchObject({ value: 'ok', tries: 2 });
    expect(starts[1]! - starts[0]!).toBe(2000);
  });

  it('RU-11b treats Retry-After above maxServerWaitMs as final', async () => {
    const h = harness({
      tries: { max: 3, spacing: 100, idempotent: true, maxServerWaitMs: 10_000 },
      classify: () => ({ class: 'busy', readyInMs: 3_600_000 }),
    });
    let calls = 0;
    const error = new Error('429');
    await expect(
      h.exec.execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(error);
      }),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });

  it('RU-12 never extra tries engine rejections and keeps the previous error as cause', async () => {
    const h = harness({
      tries: { max: 5, spacing: 1000, idempotent: true },
      valve: {
        minCalls: 1,
        failPercent: 100,
        lookBack: { lastCalls: 1 },
      },
    });
    const first = transient('E');
    let calls = 0;
    const p = settle(
      h.exec.execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(first);
      }),
    );
    await h.clock.advance(1000);
    // Attempt 1 opened the breaker; attempt 2 is rejected without a call.
    expect(calls).toBe(1);
    expect(p.error).toBeInstanceOf(ValveShutError);
    expect((p.error as ValveShutError).cause).toBe(first);
    const again = settle(h.exec.execute(ctxOf(), ok('x')));
    await h.clock.flush();
    expect(again.error).toBeInstanceOf(ValveShutError);
    expect(calls).toBe(1);
  });

  it('RU-13a runs app classifiers first, first defined wins', async () => {
    const h = harness({
      classify: [() => undefined, () => 'quota'],
      valve: {},
      planB: { value: () => 'fb' },
    });
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(transient()))).rejects.toThrow(
      'transient',
    );
    expect(h.events.map((e) => e.type)).toEqual(['valve.forced-shut', 'quota.used-up']);
  });

  it('RU-13b treats a throwing classifier as unknown and logs once', async () => {
    const h = harness({
      tries: { max: 3, spacing: 0, idempotent: true },
      classify: () => {
        throw new Error('bug');
      },
    });
    let calls = 0;
    await expect(
      h.exec.execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(transient());
      }),
    ).rejects.toThrow('transient');
    expect(calls).toBe(1);
    expect(h.lines.error).toHaveLength(1);
  });

  it('RU-16a quota is final, forces the valve open and skips the default plan B', async () => {
    const h = harness({
      tries: { max: 3, spacing: 0, idempotent: true },
      classify: (error) =>
        (error as { reason?: string }).reason === 'quota' ? 'quota' : undefined,
      valve: { minCalls: 10 },
      planB: { value: () => 'fb' },
    });
    let calls = 0;
    const quota = Object.assign(new Error('429'), { reason: 'quota' });
    const call = () => {
      calls += 1;
      return Promise.reject(quota);
    };
    await expect(h.exec.execute(ctxOf(), call)).rejects.toBe(quota);
    const second = await h.exec.execute(ctxOf(), call).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ValveShutError);
    expect((second as ValveShutError).forcedBy).toBe('quota');
    expect(calls).toBe(1);
    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === 'quota.used-up')).toHaveLength(1);
    expect(types.filter((t) => t === 'valve.forced-shut')).toHaveLength(1);
    expect(types).not.toContain('plan-b.used');
  });

  it('RU-16c manual quota opening never probes until resume', async () => {
    const h = harness({
      classify: () => 'quota',
      valve: { quotaShutMs: 'until-resumed', shutMs: 10 },
    });
    let calls = 0;
    const call = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('q')) : Promise.resolve('ok');
    };
    await expect(h.exec.execute(ctxOf(), call)).rejects.toThrow('q');
    await h.clock.advance(10_000_000);
    await expect(h.exec.execute(ctxOf(), call)).rejects.toBeInstanceOf(ValveShutError);
    expect(calls).toBe(1);
    expect(h.exec.valveState()).toEqual({ state: 'shut', forcedBy: 'quota' });
    await h.exec.resume();
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    await expect(h.exec.execute(ctxOf(), call)).resolves.toMatchObject({ value: 'ok' });
  });

  it('RU-17 throttled is tried again but not recorded by the valve', async () => {
    const policy = {
      valve: { failPercent: 50, minCalls: 10 },
      classify: (error: unknown) => (error as Error).message as 'busy' | 'transient',
    };
    const throttled = harness(policy);
    for (let i = 0; i < 20; i += 1) {
      await throttled.exec
        .execute(ctxOf(), () => Promise.reject(new Error('busy')))
        .catch(() => undefined);
    }
    expect(throttled.exec.valveState()).toEqual({ state: 'flowing' });
    const failing = harness(policy);
    for (let i = 0; i < 20; i += 1) {
      await failing.exec
        .execute(ctxOf(), () => Promise.reject(new Error('transient')))
        .catch(() => undefined);
    }
    expect(failing.exec.valveState()?.state).toBe('shut');
  });

  it('RU-18a opens at the failure rate after minCalls in a count window', async () => {
    const h = harness({ valve: {} });
    for (let i = 0; i < 5; i += 1) await h.exec.execute(ctxOf(), ok('x'));
    for (let i = 0; i < 4; i += 1)
      await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.valveState()).toEqual({ state: 'shut' });
    expect(h.lines.warn).toEqual(["valve.shut for activator 'b'"]);
  });

  it('RU-18b opens in a time window and probes after shutMs', async () => {
    const h = harness({
      valve: { minCalls: 2, lookBack: { lastMs: 1000 }, shutMs: 500 },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(1500);
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    // The first failure left the window.
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.valveState()).toEqual({ state: 'shut' });
    await h.clock.advance(500);
    expect(h.exec.valveState()).toEqual({ state: 'probing' });
  });

  it('RU-19 limits probing probes and closes or re-opens on their outcome', async () => {
    const h = harness({
      valve: { minCalls: 1, lookBack: { lastCalls: 1 }, shutMs: 100 },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(100);
    const gate: { finish?: (v: string) => void } = {};
    const probe = settle(
      h.exec.execute(
        ctxOf(),
        () =>
          new Promise<string>((resolve) => {
            gate.finish = resolve;
          }),
      ),
    );
    const second = await h.exec.execute(ctxOf(), ok('x')).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ValveShutError);
    gate.finish?.('ok');
    await h.clock.flush();
    expect(probe.value).toMatchObject({ value: 'ok' });
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    // A failing probe re-opens; a rejected (not recorded) probe frees the slot only.
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(100);
    await h.exec.execute(ctxOf(), () => Promise.reject(rejected())).catch(() => undefined);
    expect(h.exec.valveState()).toEqual({ state: 'probing' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.valveState()).toEqual({ state: 'shut' });
  });

  it('RU-20a evicts only closed valves when maxKeys is reached', async () => {
    const key = (ctx: { message?: { payload: unknown } }) => String(ctx.message?.payload);
    const h = harness({
      valve: { key, maxKeys: 2, minCalls: 1, lookBack: { lastCalls: 1 } },
    });
    const call = (k: string, fail: boolean) =>
      h.exec
        .execute({ ...ctxOf(), message: createMessage(k) }, () =>
          fail ? Promise.reject(transient()) : Promise.resolve(k),
        )
        .catch(() => undefined);
    await call('a', true); // open
    await call('b', false); // closed
    await call('c', false); // evicts b
    expect(h.exec.valveState('a')?.state).toBe('shut');
    expect(h.exec.valveState('b')).toBeUndefined();
    expect(h.exec.stateSizes.valves).toBe(2);
    await call('c', true); // open: both open now
    await call('d', false);
    expect(h.exec.stateSizes.valves).toBe(2);
    expect(h.events.filter((e) => e.type === 'valve.keys-full')).toHaveLength(1);
  });

  it('RU-20b fails with CareKeyError before any try when the key function throws', async () => {
    const h = harness({
      valve: {
        key: () => {
          throw new Error('no tenant');
        },
      },
      planB: { value: () => 'fb' },
    });
    let calls = 0;
    const error = await h.exec
      .execute(ctxOf(), () => {
        calls += 1;
        return Promise.resolve('x');
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CareKeyError);
    expect((error as CareKeyError).reason).toBe('key-fn');
    expect(calls).toBe(0);
  });

  it('RU-21 lanes admits count, queues FIFO and always releases the slot', async () => {
    const h = harness({ lanes: { count: 1, waitlist: 1, waitlistMs: 50 } });
    let release: () => void = () => undefined;
    const first = settle(
      h.exec.execute(
        ctxOf(),
        () => new Promise<string>((resolve) => (release = () => resolve('1'))),
      ),
    );
    const second = settle(h.exec.execute(ctxOf(), ok('2')));
    const third = settle(h.exec.execute(ctxOf(), ok('3')));
    await h.clock.flush();
    expect(third.error).toBeInstanceOf(LanesFullError);
    expect((third.error as LanesFullError).reason).toBe('full');
    await h.clock.advance(50);
    expect((second.error as LanesFullError).reason).toBe('waitlist-expired');
    release();
    await h.clock.flush();
    expect(first.value).toMatchObject({ value: '1' });
    await expect(h.exec.execute(ctxOf(), ok('4'))).resolves.toMatchObject({ value: '4' });
  });

  it('RU-22a token bucket refills on the monotonic clock and reports readyInMs', async () => {
    const h = harness({ pace: { perSecond: 2, burst: 2 } });
    await h.exec.execute(ctxOf(), ok(1));
    await h.exec.execute(ctxOf(), ok(2));
    const third = await h.exec.execute(ctxOf(), ok(3)).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(OverPaceError);
    expect((third as OverPaceError).readyInMs).toBe(500);
    await h.clock.advance(500);
    await expect(h.exec.execute(ctxOf(), ok(4))).resolves.toMatchObject({ value: 4 });
    const keyed = harness({
      pace: { perSecond: 1, maxKeys: 2, key: (c) => String(c.message?.payload) },
    });
    for (const k of ['a', 'b', 'c'])
      await keyed.exec.execute({ ...ctxOf(), message: createMessage(k) }, ok(k));
    expect(keyed.exec.stateSizes.turns).toBe(2);
  });

  it('RU-22b extra tries consume tokens', async () => {
    const h = harness({
      tries: { max: 3, spacing: 0, idempotent: true },
      pace: { perSecond: 1, burst: 2 },
    });
    let calls = 0;
    const error = await h.exec
      .execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(transient());
      })
      .catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(OverPaceError);
  });

  it('RU-24a degrades to a bounded local limit when the state port is down', async () => {
    const clock = manualCareClock();
    const port = new MemoryCareState(() => clock.wall()).down();
    const h = harness({ pace: { perSecond: 4, burst: 4, replicas: 2, state: port } }, { clock });
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.exec.execute(ctxOf(), ok('x')).then(
          () => 'ok',
          (e: unknown) => e,
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
    expect(outcomes.filter((o) => o instanceof OverPaceError)).toHaveLength(8);
    expect(h.events.filter((e) => e.type === 'shared-state.lost')).toHaveLength(1);
    await clock.advance(1000);
    const later = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.exec.execute(ctxOf(), ok('x')).then(
          () => 'ok',
          () => 'no',
        ),
      ),
    );
    expect(later.filter((o) => o === 'ok')).toHaveLength(2);
  });

  it('RU-24b probes the state port and recovers with one event per transition', async () => {
    const clock = manualCareClock();
    const port = new MemoryCareState(() => clock.wall()).hang();
    const h = harness(
      { pace: { perSecond: 1000, burst: 1000, state: port } },
      { clock, deps: { sharedStateWaitMs: 100, sharedStateCheckMs: 5000 } },
    );
    const calls = Array.from({ length: 50 }, () => settle(h.exec.execute(ctxOf(), ok('x'))));
    await clock.advance(100);
    expect(calls.every((c) => c.done)).toBe(true);
    expect(h.events.filter((e) => e.type === 'shared-state.lost')).toHaveLength(1);
    port.up();
    await clock.advance(5000);
    await h.exec.execute(ctxOf(), ok('x'));
    expect(h.events.filter((e) => e.type === 'shared-state.back')).toHaveLength(1);
  });

  it('RU-25a runs the plan B for triggers in on and marks the result', async () => {
    const h = harness({
      valve: { minCalls: 1, lookBack: { lastCalls: 1 } },
      planB: { value: () => 'fb' },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    let calls = 0;
    const result = await h.exec.execute(ctxOf(), () => {
      calls += 1;
      return Promise.resolve('real');
    });
    expect(result).toMatchObject({ value: 'fb', planB: true });
    expect(calls).toBe(0);
    expect(h.events.filter((e) => e.type === 'plan-b.used')).toHaveLength(2);
  });

  it('RU-25b does not run the plan B for rejected, quota or unknown by default', async () => {
    const h = harness({ planB: { value: () => 'fb' } });
    const bad = rejected('400');
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(bad))).rejects.toBe(bad);
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(new Error('?')))).rejects.toThrow(
      '?',
    );
  });

  it('RU-26 wraps a failing plan B in PlanBFailedError with cause and original', async () => {
    const x = new Error('X');
    const h = harness({
      valve: { minCalls: 1, lookBack: { lastCalls: 1 } },
      planB: {
        value: () => {
          throw x;
        },
      },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    const error = await h.exec.execute(ctxOf(), ok('x')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanBFailedError);
    expect((error as PlanBFailedError).cause).toBe(x);
    expect((error as PlanBFailedError).original).toBeInstanceOf(ValveShutError);
    expect(h.events.map((e) => e.type)).toContain('plan-b.failed');
  });

  it('RU-27 a plan B marks the current message scope plan-B-marked unless cacheable', async () => {
    const h = harness({ planB: { value: () => 'fb', on: ['transient'] } });
    const degraded = await CareScope.runMessage({ traceId: 't' }, async (scope) => {
      await h.exec.execute(ctxOf(), () => Promise.reject(transient()));
      return scope.planB();
    });
    expect(degraded).toBe(true);
    const cacheable = harness({
      planB: { value: () => 'fb', on: ['transient'], cacheable: true },
    });
    const notDegraded = await CareScope.runMessage({ traceId: 't' }, async (scope) => {
      await cacheable.exec.execute(ctxOf(), () => Promise.reject(transient()));
      return scope.planB();
    });
    expect(notDegraded).toBe(false);
  });

  it('RU-30a a trying-again layer claims the tries left for downstream and nested executors', async () => {
    const budgets: (number | undefined)[] = [];
    const nested: (number | undefined)[] = [];
    const h = harness(
      { tries: { max: 3, spacing: 0, idempotent: true } },
      {
        deps: { triesLeft: { enabled: true } },
        adapter: { outgoingTriesLeft: (b) => budgets.push(b) },
      },
    );
    let calls = 0;
    await h.exec.execute(ctxOf(), () => {
      calls += 1;
      nested.push(CareScope.current()?.triesLeft);
      return calls < 3 ? Promise.reject(transient()) : Promise.resolve('x');
    });
    expect(budgets).toEqual([0, 0, 0]);
    expect(nested).toEqual([0, 0, 0]);
  });

  it('RU-30b a non-trying-again layer forwards the incoming tries left', async () => {
    const budgets: (number | undefined)[] = [];
    const h = harness(
      { patience: { eachTryMs: 100 } },
      {
        deps: { triesLeft: { enabled: true } },
        adapter: { outgoingTriesLeft: (b) => budgets.push(b) },
      },
    );
    const msg = createMessage('p', { triesLeft: 2 });
    await h.exec.execute({ ...ctxOf(), message: msg }, ok('x'));
    expect(budgets).toEqual([2]);
    const inner = harness(
      { tries: { max: 5, spacing: 0, idempotent: true } },
      { deps: { triesLeft: { enabled: true } } },
    );
    let calls = 0;
    await CareScope.run({ triesLeft: 2 }, () =>
      inner.exec.execute(ctxOf(), () => {
        calls += 1;
        return calls < 10 ? Promise.reject(transient()) : Promise.resolve('x');
      }),
    ).catch(() => undefined);
    expect(calls).toBe(3);
  });

  it('RU-32 emits extra try.suppressed once when the tries left removes extra tries', async () => {
    const h = harness(
      { tries: { max: 3, spacing: 0, idempotent: true } },
      { deps: { triesLeft: { enabled: true } } },
    );
    let calls = 0;
    const msg = createMessage('p', { triesLeft: 0 });
    await h.exec
      .execute({ ...ctxOf(), message: msg }, () => {
        calls += 1;
        return Promise.reject(transient());
      })
      .catch(() => undefined);
    expect(calls).toBe(1);
    expect(h.events.filter((e) => e.type === 'try.held')).toHaveLength(1);
  });

  it('RU-36b exposes the try signal through currentTrySignal', async () => {
    const h = harness({ patience: { eachTryMs: 100 } });
    let seen: AbortSignal | undefined;
    await h.exec.execute(ctxOf(), () => {
      seen = currentTrySignal();
      return Promise.resolve('x');
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(currentTrySignal()).toBeUndefined();
  });

  it('RU-39 executor runs every part through a fake edge adapter', async () => {
    const h = harness({
      patience: { eachTryMs: 100, totalMs: 1000 },
      tries: { max: 2, spacing: 0, idempotent: true },
      valve: {},
      lanes: { count: 2 },
      pace: { perSecond: 10 },
      planB: { value: () => 'fb', on: ['transient'] },
    });
    const result = await h.exec.execute(ctxOf(), () => Promise.reject(transient()));
    expect(result).toMatchObject({ value: 'fb', planB: true, tries: 2 });
  });

  it('RU-40a event publishing failures never change the call outcome', async () => {
    const h = harness({ valve: { minCalls: 1, lookBack: { lastCalls: 1 } } });
    const throwing = harness(
      { valve: { minCalls: 1, lookBack: { lastCalls: 1 } } },
      {
        deps: {
          observer: new CareObserver({
            clock: h.clock,
            logger: {
              log: () => undefined,
              warn: (m) => h.lines.warn.push(m),
              error: () => undefined,
              debug: () => undefined,
            },
            onEvent: () => {
              throw new Error('subscriber');
            },
            publish: () => Promise.reject(new Error('channel')),
          }),
        },
      },
    );
    const error = transient();
    await expect(throwing.exec.execute(ctxOf(), () => Promise.reject(error))).rejects.toBe(error);
    await h.clock.flush();
    expect(h.lines.warn.filter((l) => l.includes('care event'))).toHaveLength(1);
  });

  it('RU-40b events raised while handling the events channel are dropped', async () => {
    const h = harness({ tries: { max: 2, spacing: 0 } }, { adapter: { repeatable: () => false } });
    await CareScope.runMessage({ fromEventsChannel: true }, () =>
      h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined),
    );
    expect(h.events).toEqual([]);
  });

  it('RU-41 metrics carry no key label and swallow port errors', async () => {
    const h = harness({
      tries: { max: 2, spacing: 0, idempotent: true },
      valve: { key: () => '+50255501234' },
    });
    let calls = 0;
    await h.exec.execute(ctxOf(), () => {
      calls += 1;
      return calls === 1 ? Promise.reject(transient()) : Promise.resolve('x');
    });
    const attempts = h.metrics.filter((m) => m.name === 'estela_care_tries_total');
    expect(attempts).toHaveLength(2);
    expect(h.metrics.filter((m) => m.name === 'estela_care_extra_tries_total')).toHaveLength(1);
    expect(JSON.stringify(h.metrics)).not.toContain('50255501234');
    for (const m of h.metrics) {
      expect(
        Object.keys(m.labels).every((l) =>
          ['edge', 'binding', 'outcome', 'class', 'reason'].includes(l),
        ),
      ).toBe(true);
    }
  });

  it('RU-43a raw keys never reach events, logs, metrics, errors or state keys', async () => {
    const clock = manualCareClock();
    const port = new MemoryCareState(() => clock.wall());
    const h = harness(
      {
        valve: {
          key: () => '+50255501234',
          minCalls: 1,
          lookBack: { lastCalls: 1 },
          state: port,
        },
      },
      { clock, deps: { keyHasher: () => 'hmac-abc123' } },
    );
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    const err = await h.exec.execute(ctxOf(), ok('x')).catch((e: unknown) => e);
    await clock.flush();
    const sinks = JSON.stringify([
      h.events,
      h.lines,
      h.metrics,
      (err as Error).message,
      port.calls,
    ]);
    expect(sinks).not.toContain('50255501234');
    expect(port.markerKeys()).toEqual(['estela:care:valve:b:hmac-abc123']);
  });

  it('RU-43b keyLabel and keyHasher outputs are used when configured and invalid outputs fail with CareKeyError', async () => {
    const h = harness(
      { valve: { key: () => 'k', minCalls: 1, lookBack: { lastCalls: 1 } } },
      { deps: { keyLabel: () => 'label-1' } },
    );
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.events.find((e) => e.type === 'valve.shut')?.keyLabel).toBe('label-1');
    const bad = harness({ valve: { key: () => 'k' } }, { deps: { keyLabel: () => 'has space' } });
    await expect(bad.exec.execute(ctxOf(), ok('x'))).rejects.toBeInstanceOf(CareKeyError);
    const port = new MemoryCareState();
    const badHash = harness(
      { pace: { perSecond: 1, key: () => 'k', state: port } },
      { deps: { keyHasher: () => '' } },
    );
    await expect(badHash.exec.execute(ctxOf(), ok('x'))).rejects.toMatchObject({
      reason: 'hasher',
    });
  });

  it('RU-45 logs one line per state transition and none per successful call', async () => {
    const h = harness({
      valve: { minCalls: 1, lookBack: { lastCalls: 1 }, shutMs: 10 },
    });
    for (let i = 0; i < 5; i += 1) await h.exec.execute(ctxOf(), ok('x'));
    expect([...h.lines.log, ...h.lines.warn, ...h.lines.error]).toEqual([]);
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(10);
    await h.exec.execute(ctxOf(), ok('x'));
    expect(h.lines.warn).toHaveLength(1);
    expect(h.lines.log).toHaveLength(1);
  });

  it('RU-47 engine timers use only the injected clock', async () => {
    const h = harness({
      patience: { eachTryMs: 50 },
      tries: { max: 2, spacing: 1000, idempotent: true },
    });
    const started = Date.now();
    const p = settle(h.exec.execute(ctxOf(), () => Promise.reject(transient())));
    await h.clock.advance(1000);
    expect(p.done).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('RU-48 requireIdempotencyKey rejects a non-safe call without a key before any try', async () => {
    const h = harness(
      { tries: { max: 1, requireIdempotencyKey: true } },
      { adapter: { safe: () => false, idempotencyKey: (c) => c.message?.headers.idempotencyKey } },
    );
    let calls = 0;
    const run = () => {
      calls += 1;
      return Promise.resolve('x');
    };
    const error = await h.exec
      .execute({ ...ctxOf(), message: createMessage('p') }, run)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'idempotency-key-required' });
    expect(calls).toBe(0);
    await h.exec.execute({ ...ctxOf(), message: createMessage('p', { idempotencyKey: 'k' }) }, run);
    expect(calls).toBe(1);
  });

  it('RU-49 resume closes a manual quota opening and clears the shared marker', async () => {
    const clock = manualCareClock();
    const port = new MemoryCareState(() => clock.wall());
    const h = harness(
      { classify: () => 'quota', valve: { quotaShutMs: 'until-resumed', state: port } },
      { clock },
    );
    await h.exec.execute(ctxOf(), () => Promise.reject(new Error('q'))).catch(() => undefined);
    await clock.flush();
    expect(port.markerKeys()).toEqual(['estela:care:valve:b:quota']);
    await h.exec.resume();
    expect(port.markerKeys()).toEqual([]);
    expect(h.exec.valveState()).toEqual({ state: 'flowing' });
    expect(h.events.filter((e) => e.type === 'valve.flowing')).toHaveLength(1);
  });
});
