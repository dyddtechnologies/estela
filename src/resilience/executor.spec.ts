import { createMessage } from '../message';
import { MemoryResilienceStatePort } from '../testing/memory-resilience-state-port';
import { manualResilienceClock } from '../testing/manual-resilience-clock';
import { currentResilienceSignal } from './executor';
import { ResilienceObserver } from './observability';
import {
  BulkheadFullError,
  CircuitOpenError,
  DeadlineExceededError,
  FallbackFailedError,
  RateLimitedError,
  ResilienceKeyError,
} from './resilience.errors';
import { ResilienceScope } from './retry-budget';
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

describe('ResilienceExecutor', () => {
  it('RU-01 runs a policy with no primitive as one direct attempt', async () => {
    const h = harness({});
    let calls = 0;
    const result = await h.exec.execute(ctxOf(), (attempt) => {
      calls += 1;
      expect(attempt.signal).toBeUndefined();
      return Promise.resolve('v');
    });
    expect(result).toMatchObject({ value: 'v', attempts: 1, fallback: false });
    expect(calls).toBe(1);
    expect(h.clock.pendingTimers).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('RU-02 composes fallback > deadline > bulkhead > retry > breaker > rateLimit > timeout in that order', async () => {
    const order: string[] = [];
    const h = harness({
      timeout: { perAttemptMs: 100, deadlineMs: 10_000 },
      retry: { maxAttempts: 3, backoff: 10, idempotent: true },
      circuitBreaker: { minimumCalls: 10 },
      bulkhead: { maxConcurrent: 1 },
      rateLimit: { limitPerSec: 1, burst: 3 },
      fallback: { value: () => 'fb' },
    });
    let calls = 0;
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        calls += 1;
        order.push(`attempt ${attempt.attempt} signal=${attempt.signal !== undefined}`);
        return calls < 3 ? Promise.reject(transient()) : Promise.resolve('done');
      }),
    );
    await h.clock.advance(100);
    expect(p.value).toMatchObject({ value: 'done', attempts: 3, fallback: false });
    expect(order).toEqual([
      'attempt 1 signal=true',
      'attempt 2 signal=true',
      'attempt 3 signal=true',
    ]);
    // 3 tokens taken: a 4th call at the same instant is rate limited.
    const fourth = settle(h.exec.execute(ctxOf(), ok('x')));
    await h.clock.flush();
    expect(fourth.value).toMatchObject({ value: 'fb', fallback: true });
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
  });

  it('RU-06 aborts the attempt signal and rejects even when work ignores it', async () => {
    const h = harness({ timeout: { perAttemptMs: 100 } });
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

  it('RU-07a caps each attempt at the remaining deadline', async () => {
    const h = harness({
      timeout: { perAttemptMs: 5000, deadlineMs: 1000 },
      retry: { maxAttempts: 3, backoff: 400, idempotent: true },
    });
    const timeouts: number[] = [];
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        timeouts.push(attempt.timeoutMs);
        return new Promise<never>((_r, reject) => h.clock.setTimer(100, () => reject(transient())));
      }),
    );
    await h.clock.advance(1000);
    expect(timeouts).toEqual([1000, 500]);
    expect(p.error).toBeInstanceOf(DeadlineExceededError);
  });

  it('RU-07b never sleeps or queues past the deadline and does not record an attempt cut by it', async () => {
    const h = harness({
      timeout: { deadlineMs: 1000 },
      retry: { maxAttempts: 5, backoff: 600, idempotent: true },
      circuitBreaker: {
        minimumCalls: 2,
        failureRateThreshold: 100,
        window: { type: 'count', size: 2 },
      },
    });
    const timeouts: number[] = [];
    const p = settle(
      h.exec.execute(ctxOf(), (attempt) => {
        timeouts.push(attempt.timeoutMs);
        return new Promise<never>((_r, reject) =>
          h.clock.setTimer(300, () => reject(transient('slow'))),
        );
      }),
    );
    await h.clock.advance(1000);
    expect(timeouts).toEqual([1000, 100]);
    expect(p.error).toBeInstanceOf(DeadlineExceededError);
    expect((p.error as DeadlineExceededError).cause).toBeInstanceOf(TestTimeoutError);
    // One failure recorded (attempt 1), not two: with minimumCalls 2 the breaker stays closed.
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    expect(h.events.map((e) => e.type)).toContain('deadline.exceeded');
  });

  it('RU-08 retries only classes in retryOn while attempts, budget and deadline remain', async () => {
    const h = harness({ retry: { maxAttempts: 3, backoff: 0, idempotent: true } });
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

  it('RU-09a does not retry a non-repeatable operation, including after a timeout', async () => {
    const h = harness(
      { timeout: { perAttemptMs: 50 }, retry: { maxAttempts: 3, backoff: 0 } },
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
    expect(h.events.map((e) => e.type)).toEqual(['retry.suppressed']);
  });

  it('RU-11a waits max(backoff, Retry-After)', async () => {
    const h = harness({
      retry: { maxAttempts: 2, backoff: { initialMs: 100, jitter: 'none' }, idempotent: true },
      classify: () => ({ class: 'throttled', retryAfterMs: 2000 }),
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
    expect(p.value).toMatchObject({ value: 'ok', attempts: 2 });
    expect(starts[1]! - starts[0]!).toBe(2000);
  });

  it('RU-11b treats Retry-After above maxRetryAfterMs as final', async () => {
    const h = harness({
      retry: { maxAttempts: 3, backoff: 100, idempotent: true, maxRetryAfterMs: 10_000 },
      classify: () => ({ class: 'throttled', retryAfterMs: 3_600_000 }),
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

  it('RU-12 never retries engine rejections and keeps the previous error as cause', async () => {
    const h = harness({
      retry: { maxAttempts: 5, backoff: 1000, idempotent: true },
      circuitBreaker: {
        minimumCalls: 1,
        failureRateThreshold: 100,
        window: { type: 'count', size: 1 },
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
    expect(p.error).toBeInstanceOf(CircuitOpenError);
    expect((p.error as CircuitOpenError).cause).toBe(first);
    const again = settle(h.exec.execute(ctxOf(), ok('x')));
    await h.clock.flush();
    expect(again.error).toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(1);
  });

  it('RU-13a runs app classifiers first, first defined wins', async () => {
    const h = harness({
      classify: [() => undefined, () => 'quota'],
      circuitBreaker: {},
      fallback: { value: () => 'fb' },
    });
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(transient()))).rejects.toThrow(
      'transient',
    );
    expect(h.events.map((e) => e.type)).toEqual(['breaker.forced-open', 'quota.exhausted']);
  });

  it('RU-13b treats a throwing classifier as unknown and logs once', async () => {
    const h = harness({
      retry: { maxAttempts: 3, backoff: 0, idempotent: true },
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

  it('RU-16a quota is final, forces the breaker open and skips the default fallback', async () => {
    const h = harness({
      retry: { maxAttempts: 3, backoff: 0, idempotent: true },
      classify: (error) =>
        (error as { reason?: string }).reason === 'quota' ? 'quota' : undefined,
      circuitBreaker: { minimumCalls: 10 },
      fallback: { value: () => 'fb' },
    });
    let calls = 0;
    const quota = Object.assign(new Error('429'), { reason: 'quota' });
    const call = () => {
      calls += 1;
      return Promise.reject(quota);
    };
    await expect(h.exec.execute(ctxOf(), call)).rejects.toBe(quota);
    const second = await h.exec.execute(ctxOf(), call).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(CircuitOpenError);
    expect((second as CircuitOpenError).forcedBy).toBe('quota');
    expect(calls).toBe(1);
    const types = h.events.map((e) => e.type);
    expect(types.filter((t) => t === 'quota.exhausted')).toHaveLength(1);
    expect(types.filter((t) => t === 'breaker.forced-open')).toHaveLength(1);
    expect(types).not.toContain('fallback.used');
  });

  it('RU-16c manual quota opening never probes until resetBreaker', async () => {
    const h = harness({
      classify: () => 'quota',
      circuitBreaker: { quotaOpenMs: 'manual', openMs: 10 },
    });
    let calls = 0;
    const call = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('q')) : Promise.resolve('ok');
    };
    await expect(h.exec.execute(ctxOf(), call)).rejects.toThrow('q');
    await h.clock.advance(10_000_000);
    await expect(h.exec.execute(ctxOf(), call)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(1);
    expect(h.exec.breakerState()).toEqual({ state: 'open', forcedBy: 'quota' });
    await h.exec.resetBreaker();
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    await expect(h.exec.execute(ctxOf(), call)).resolves.toMatchObject({ value: 'ok' });
  });

  it('RU-17 throttled is retried but not recorded by the breaker', async () => {
    const policy = {
      circuitBreaker: { failureRateThreshold: 50, minimumCalls: 10 },
      classify: (error: unknown) => (error as Error).message as 'throttled' | 'transient',
    };
    const throttled = harness(policy);
    for (let i = 0; i < 20; i += 1) {
      await throttled.exec
        .execute(ctxOf(), () => Promise.reject(new Error('throttled')))
        .catch(() => undefined);
    }
    expect(throttled.exec.breakerState()).toEqual({ state: 'closed' });
    const failing = harness(policy);
    for (let i = 0; i < 20; i += 1) {
      await failing.exec
        .execute(ctxOf(), () => Promise.reject(new Error('transient')))
        .catch(() => undefined);
    }
    expect(failing.exec.breakerState()?.state).toBe('open');
  });

  it('RU-18a opens at the failure rate after minimumCalls in a count window', async () => {
    const h = harness({ circuitBreaker: {} });
    for (let i = 0; i < 5; i += 1) await h.exec.execute(ctxOf(), ok('x'));
    for (let i = 0; i < 4; i += 1)
      await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.breakerState()).toEqual({ state: 'open' });
    expect(h.lines.warn).toEqual(["breaker.open for activator 'b'"]);
  });

  it('RU-18b opens in a time window and half-opens after openMs', async () => {
    const h = harness({
      circuitBreaker: { minimumCalls: 2, window: { type: 'time', sizeMs: 1000 }, openMs: 500 },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(1500);
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    // The first failure left the window.
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.breakerState()).toEqual({ state: 'open' });
    await h.clock.advance(500);
    expect(h.exec.breakerState()).toEqual({ state: 'half-open' });
  });

  it('RU-19 limits half-open probes and closes or re-opens on their outcome', async () => {
    const h = harness({
      circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 }, openMs: 100 },
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
    expect(second).toBeInstanceOf(CircuitOpenError);
    gate.finish?.('ok');
    await h.clock.flush();
    expect(probe.value).toMatchObject({ value: 'ok' });
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    // A failing probe re-opens; a rejected (not recorded) probe frees the slot only.
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await h.clock.advance(100);
    await h.exec.execute(ctxOf(), () => Promise.reject(rejected())).catch(() => undefined);
    expect(h.exec.breakerState()).toEqual({ state: 'half-open' });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.exec.breakerState()).toEqual({ state: 'open' });
  });

  it('RU-20a evicts only closed breakers when maxKeys is reached', async () => {
    const key = (ctx: { message?: { payload: unknown } }) => String(ctx.message?.payload);
    const h = harness({
      circuitBreaker: { key, maxKeys: 2, minimumCalls: 1, window: { type: 'count', size: 1 } },
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
    expect(h.exec.breakerState('a')?.state).toBe('open');
    expect(h.exec.breakerState('b')).toBeUndefined();
    expect(h.exec.stateSizes.breakers).toBe(2);
    await call('c', true); // open: both open now
    await call('d', false);
    expect(h.exec.stateSizes.breakers).toBe(2);
    expect(h.events.filter((e) => e.type === 'breaker.capacity')).toHaveLength(1);
  });

  it('RU-20b fails with ResilienceKeyError before any attempt when the key function throws', async () => {
    const h = harness({
      circuitBreaker: {
        key: () => {
          throw new Error('no tenant');
        },
      },
      fallback: { value: () => 'fb' },
    });
    let calls = 0;
    const error = await h.exec
      .execute(ctxOf(), () => {
        calls += 1;
        return Promise.resolve('x');
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResilienceKeyError);
    expect((error as ResilienceKeyError).reason).toBe('key-fn');
    expect(calls).toBe(0);
  });

  it('RU-21 bulkhead admits maxConcurrent, queues FIFO and always releases the slot', async () => {
    const h = harness({ bulkhead: { maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 50 } });
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
    expect(third.error).toBeInstanceOf(BulkheadFullError);
    expect((third.error as BulkheadFullError).reason).toBe('full');
    await h.clock.advance(50);
    expect((second.error as BulkheadFullError).reason).toBe('queue-timeout');
    release();
    await h.clock.flush();
    expect(first.value).toMatchObject({ value: '1' });
    await expect(h.exec.execute(ctxOf(), ok('4'))).resolves.toMatchObject({ value: '4' });
  });

  it('RU-22a token bucket refills on the monotonic clock and reports retryAfterMs', async () => {
    const h = harness({ rateLimit: { limitPerSec: 2, burst: 2 } });
    await h.exec.execute(ctxOf(), ok(1));
    await h.exec.execute(ctxOf(), ok(2));
    const third = await h.exec.execute(ctxOf(), ok(3)).catch((e: unknown) => e);
    expect(third).toBeInstanceOf(RateLimitedError);
    expect((third as RateLimitedError).retryAfterMs).toBe(500);
    await h.clock.advance(500);
    await expect(h.exec.execute(ctxOf(), ok(4))).resolves.toMatchObject({ value: 4 });
    const keyed = harness({
      rateLimit: { limitPerSec: 1, maxKeys: 2, key: (c) => String(c.message?.payload) },
    });
    for (const k of ['a', 'b', 'c'])
      await keyed.exec.execute({ ...ctxOf(), message: createMessage(k) }, ok(k));
    expect(keyed.exec.stateSizes.buckets).toBe(2);
  });

  it('RU-22b retries consume tokens', async () => {
    const h = harness({
      retry: { maxAttempts: 3, backoff: 0, idempotent: true },
      rateLimit: { limitPerSec: 1, burst: 2 },
    });
    let calls = 0;
    const error = await h.exec
      .execute(ctxOf(), () => {
        calls += 1;
        return Promise.reject(transient());
      })
      .catch((e: unknown) => e);
    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it('RU-24a degrades to a bounded local limit when the state port is down', async () => {
    const clock = manualResilienceClock();
    const port = new MemoryResilienceStatePort(() => clock.wall()).down();
    const h = harness(
      { rateLimit: { limitPerSec: 4, burst: 4, replicasHint: 2, state: port } },
      { clock },
    );
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.exec.execute(ctxOf(), ok('x')).then(
          () => 'ok',
          (e: unknown) => e,
        ),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
    expect(outcomes.filter((o) => o instanceof RateLimitedError)).toHaveLength(8);
    expect(h.events.filter((e) => e.type === 'state.degraded')).toHaveLength(1);
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
    const clock = manualResilienceClock();
    const port = new MemoryResilienceStatePort(() => clock.wall()).hang();
    const h = harness(
      { rateLimit: { limitPerSec: 1000, burst: 1000, state: port } },
      { clock, deps: { stateTimeoutMs: 100, stateProbeMs: 5000 } },
    );
    const calls = Array.from({ length: 50 }, () => settle(h.exec.execute(ctxOf(), ok('x'))));
    await clock.advance(100);
    expect(calls.every((c) => c.done)).toBe(true);
    expect(h.events.filter((e) => e.type === 'state.degraded')).toHaveLength(1);
    port.up();
    await clock.advance(5000);
    await h.exec.execute(ctxOf(), ok('x'));
    expect(h.events.filter((e) => e.type === 'state.recovered')).toHaveLength(1);
  });

  it('RU-25a runs the fallback for triggers in on and marks the result', async () => {
    const h = harness({
      circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 } },
      fallback: { value: () => 'fb' },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    let calls = 0;
    const result = await h.exec.execute(ctxOf(), () => {
      calls += 1;
      return Promise.resolve('real');
    });
    expect(result).toMatchObject({ value: 'fb', fallback: true });
    expect(calls).toBe(0);
    expect(h.events.filter((e) => e.type === 'fallback.used')).toHaveLength(2);
  });

  it('RU-25b does not run the fallback for rejected, quota or unknown by default', async () => {
    const h = harness({ fallback: { value: () => 'fb' } });
    const bad = rejected('400');
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(bad))).rejects.toBe(bad);
    await expect(h.exec.execute(ctxOf(), () => Promise.reject(new Error('?')))).rejects.toThrow(
      '?',
    );
  });

  it('RU-26 wraps a failing fallback in FallbackFailedError with cause and original', async () => {
    const x = new Error('X');
    const h = harness({
      circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 } },
      fallback: {
        value: () => {
          throw x;
        },
      },
    });
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    const error = await h.exec.execute(ctxOf(), ok('x')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FallbackFailedError);
    expect((error as FallbackFailedError).cause).toBe(x);
    expect((error as FallbackFailedError).original).toBeInstanceOf(CircuitOpenError);
    expect(h.events.map((e) => e.type)).toContain('fallback.failed');
  });

  it('RU-27 a fallback marks the current message scope degraded unless cacheable', async () => {
    const h = harness({ fallback: { value: () => 'fb', on: ['transient'] } });
    const degraded = await ResilienceScope.runMessage({ traceId: 't' }, async (scope) => {
      await h.exec.execute(ctxOf(), () => Promise.reject(transient()));
      return scope.degraded();
    });
    expect(degraded).toBe(true);
    const cacheable = harness({
      fallback: { value: () => 'fb', on: ['transient'], cacheable: true },
    });
    const notDegraded = await ResilienceScope.runMessage({ traceId: 't' }, async (scope) => {
      await cacheable.exec.execute(ctxOf(), () => Promise.reject(transient()));
      return scope.degraded();
    });
    expect(notDegraded).toBe(false);
  });

  it('RU-30a a retrying layer claims the budget for downstream and nested executors', async () => {
    const budgets: (number | undefined)[] = [];
    const nested: (number | undefined)[] = [];
    const h = harness(
      { retry: { maxAttempts: 3, backoff: 0, idempotent: true } },
      { deps: { budget: { enabled: true } }, adapter: { outgoingBudget: (b) => budgets.push(b) } },
    );
    let calls = 0;
    await h.exec.execute(ctxOf(), () => {
      calls += 1;
      nested.push(ResilienceScope.current()?.budget);
      return calls < 3 ? Promise.reject(transient()) : Promise.resolve('x');
    });
    expect(budgets).toEqual([0, 0, 0]);
    expect(nested).toEqual([0, 0, 0]);
  });

  it('RU-30b a non-retrying layer forwards the incoming budget', async () => {
    const budgets: (number | undefined)[] = [];
    const h = harness(
      { timeout: { perAttemptMs: 100 } },
      { deps: { budget: { enabled: true } }, adapter: { outgoingBudget: (b) => budgets.push(b) } },
    );
    const msg = createMessage('p', { retryBudget: 2 });
    await h.exec.execute({ ...ctxOf(), message: msg }, ok('x'));
    expect(budgets).toEqual([2]);
    const inner = harness(
      { retry: { maxAttempts: 5, backoff: 0, idempotent: true } },
      { deps: { budget: { enabled: true } } },
    );
    let calls = 0;
    await ResilienceScope.run({ budget: 2 }, () =>
      inner.exec.execute(ctxOf(), () => {
        calls += 1;
        return calls < 10 ? Promise.reject(transient()) : Promise.resolve('x');
      }),
    ).catch(() => undefined);
    expect(calls).toBe(3);
  });

  it('RU-32 emits retry.suppressed once when the budget removes retries', async () => {
    const h = harness(
      { retry: { maxAttempts: 3, backoff: 0, idempotent: true } },
      { deps: { budget: { enabled: true } } },
    );
    let calls = 0;
    const msg = createMessage('p', { retryBudget: 0 });
    await h.exec
      .execute({ ...ctxOf(), message: msg }, () => {
        calls += 1;
        return Promise.reject(transient());
      })
      .catch(() => undefined);
    expect(calls).toBe(1);
    expect(h.events.filter((e) => e.type === 'retry.suppressed')).toHaveLength(1);
  });

  it('RU-36b exposes the attempt signal through currentResilienceSignal', async () => {
    const h = harness({ timeout: { perAttemptMs: 100 } });
    let seen: AbortSignal | undefined;
    await h.exec.execute(ctxOf(), () => {
      seen = currentResilienceSignal();
      return Promise.resolve('x');
    });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(currentResilienceSignal()).toBeUndefined();
  });

  it('RU-39 executor runs every primitive through a fake edge adapter', async () => {
    const h = harness({
      timeout: { perAttemptMs: 100, deadlineMs: 1000 },
      retry: { maxAttempts: 2, backoff: 0, idempotent: true },
      circuitBreaker: {},
      bulkhead: { maxConcurrent: 2 },
      rateLimit: { limitPerSec: 10 },
      fallback: { value: () => 'fb', on: ['transient'] },
    });
    const result = await h.exec.execute(ctxOf(), () => Promise.reject(transient()));
    expect(result).toMatchObject({ value: 'fb', fallback: true, attempts: 2 });
  });

  it('RU-40a event publishing failures never change the call outcome', async () => {
    const h = harness({ circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 } } });
    const throwing = harness(
      { circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 } } },
      {
        deps: {
          observer: new ResilienceObserver({
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
    expect(h.lines.warn.filter((l) => l.includes('resilience event'))).toHaveLength(1);
  });

  it('RU-40b events raised while handling the events channel are dropped', async () => {
    const h = harness(
      { retry: { maxAttempts: 2, backoff: 0 } },
      { adapter: { repeatable: () => false } },
    );
    await ResilienceScope.runMessage({ fromEventsChannel: true }, () =>
      h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined),
    );
    expect(h.events).toEqual([]);
  });

  it('RU-41 metrics carry no key label and swallow port errors', async () => {
    const h = harness({
      retry: { maxAttempts: 2, backoff: 0, idempotent: true },
      circuitBreaker: { key: () => '+50255501234' },
    });
    let calls = 0;
    await h.exec.execute(ctxOf(), () => {
      calls += 1;
      return calls === 1 ? Promise.reject(transient()) : Promise.resolve('x');
    });
    const attempts = h.metrics.filter((m) => m.name === 'estela_resilience_attempts_total');
    expect(attempts).toHaveLength(2);
    expect(h.metrics.filter((m) => m.name === 'estela_resilience_retries_total')).toHaveLength(1);
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
    const clock = manualResilienceClock();
    const port = new MemoryResilienceStatePort(() => clock.wall());
    const h = harness(
      {
        circuitBreaker: {
          key: () => '+50255501234',
          minimumCalls: 1,
          window: { type: 'count', size: 1 },
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
    expect(port.markerKeys()).toEqual(['estela:rs:breaker:b:hmac-abc123']);
  });

  it('RU-43b keyLabel and keyHasher outputs are used when configured and invalid outputs fail with ResilienceKeyError', async () => {
    const h = harness(
      { circuitBreaker: { key: () => 'k', minimumCalls: 1, window: { type: 'count', size: 1 } } },
      { deps: { keyLabel: () => 'label-1' } },
    );
    await h.exec.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    expect(h.events.find((e) => e.type === 'breaker.open')?.keyLabel).toBe('label-1');
    const bad = harness(
      { circuitBreaker: { key: () => 'k' } },
      { deps: { keyLabel: () => 'has space' } },
    );
    await expect(bad.exec.execute(ctxOf(), ok('x'))).rejects.toBeInstanceOf(ResilienceKeyError);
    const port = new MemoryResilienceStatePort();
    const badHash = harness(
      { rateLimit: { limitPerSec: 1, key: () => 'k', state: port } },
      { deps: { keyHasher: () => '' } },
    );
    await expect(badHash.exec.execute(ctxOf(), ok('x'))).rejects.toMatchObject({
      reason: 'hasher',
    });
  });

  it('RU-45 logs one line per state transition and none per successful call', async () => {
    const h = harness({
      circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 }, openMs: 10 },
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
      timeout: { perAttemptMs: 50 },
      retry: { maxAttempts: 2, backoff: 1000, idempotent: true },
    });
    const started = Date.now();
    const p = settle(h.exec.execute(ctxOf(), () => Promise.reject(transient())));
    await h.clock.advance(1000);
    expect(p.done).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('RU-48 requireIdempotencyKey rejects a non-safe call without a key before any attempt', async () => {
    const h = harness(
      { retry: { maxAttempts: 1, requireIdempotencyKey: true } },
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

  it('RU-49 resetBreaker closes a manual quota opening and clears the shared marker', async () => {
    const clock = manualResilienceClock();
    const port = new MemoryResilienceStatePort(() => clock.wall());
    const h = harness(
      { classify: () => 'quota', circuitBreaker: { quotaOpenMs: 'manual', state: port } },
      { clock },
    );
    await h.exec.execute(ctxOf(), () => Promise.reject(new Error('q'))).catch(() => undefined);
    await clock.flush();
    expect(port.markerKeys()).toEqual(['estela:rs:breaker:b:quota']);
    await h.exec.resetBreaker();
    expect(port.markerKeys()).toEqual([]);
    expect(h.exec.breakerState()).toEqual({ state: 'closed' });
    expect(h.events.filter((e) => e.type === 'breaker.closed')).toHaveLength(1);
  });
});
