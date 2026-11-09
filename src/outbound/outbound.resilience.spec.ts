import { createMessage } from '../message';
import { ResilienceDefinitionError, ResilienceKeyError } from '../resilience/resilience.errors';
import type { ResilienceClock, ResilienceModuleOptions } from '../resilience/resilience.types';
import { ResilienceScope } from '../resilience/retry-budget';
import { ResilienceRuntime } from '../resilience/runtime';
import { manualResilienceClock } from '../testing/manual-resilience-clock';
import { HopLogger } from '../trace/hop-logger';
import { OutboundRestGateway, type OutboundRestGatewayDeps } from './outbound-rest.gateway';
import { OutboundHttpError, OutboundNetworkError, OutboundTimeoutError } from './outbound.errors';
import type {
  OutboundFetch,
  OutboundFetchInit,
  OutboundFetchResponse,
  OutboundRestBinding,
} from './outbound.types';

interface Call {
  url: string;
  init: OutboundFetchInit;
}

type Reply = OutboundFetchResponse | Error | (() => Promise<OutboundFetchResponse>);

function answer(
  status: number,
  body: unknown = { ok: status },
  headers: Record<string, string> = {},
): OutboundFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { 'content-type': 'application/json', ...headers },
    text: async () => JSON.stringify(body),
  };
}

function fakeFetch(...replies: Reply[]): { fetchFn: OutboundFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: OutboundFetch = async (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length, replies.length) - 1] ?? answer(200);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  };
  return { fetchFn, calls };
}

/** Clock whose sleeps resolve at once and are recorded; its timers never fire. */
function recordingClock(): { clock: ResilienceClock; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    clock: {
      monotonic: () => 0,
      wall: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      setTimer: () => ({ cancel: () => undefined }),
    },
  };
}

const URL_ORDERS = 'https://erp.example/orders';

function setup(
  replies: Reply[],
  options: {
    resilience?: ResilienceModuleOptions;
    enabled?: boolean;
    deps?: Partial<OutboundRestGatewayDeps>;
  } = {},
) {
  const { fetchFn, calls } = fakeFetch(...replies);
  const sleeps: number[] = [];
  const runtime = new ResilienceRuntime(options.resilience ?? {}, {
    enabled: options.enabled ?? true,
  });
  const gateway = new OutboundRestGateway({
    fetchFn,
    resilience: runtime,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options.deps,
  });
  return { gateway, calls, sleeps, runtime };
}

describe('outbound REST under resilience', () => {
  it('RU-34 legacy retry and timeoutMs aliases produce identical attempts, delays, errors and headers', async () => {
    const legacy: OutboundRestBinding = {
      name: 'orders.http',
      url: URL_ORDERS,
      retry: {
        maxAttempts: 4,
        backoff: { initialMs: 100, factor: 3, maxMs: 500 },
        methods: ['POST'],
      },
      timeoutMs: 1234,
    };
    const scripts: Reply[][] = [
      [answer(503), new Error('reset'), answer(429), answer(200, { id: 1 })],
      [answer(503), answer(503), answer(503), answer(503)],
      [answer(400)],
    ];
    for (const script of scripts) {
      const before = setup(script);
      before.gateway.bind(legacy);
      const { clock, sleeps } = recordingClock();
      const after = setup(script, { resilience: { clock } });
      // `resilience: {}` routes the same legacy options through the executor as aliases.
      after.gateway.bind({ ...legacy, resilience: {} });
      const message = { payload: { a: 1 }, headers: { idempotencyKey: 'k-1' } };
      const outcome = (gateway: OutboundRestGateway) =>
        gateway.request('orders.http', message).then(
          (value) => ({ value }),
          (error: unknown) => ({
            error: (error as Error).constructor.name,
            status: (error as OutboundHttpError).status,
            attempts: (error as OutboundHttpError).attempts,
          }),
        );
      expect(await outcome(after.gateway)).toEqual(await outcome(before.gateway));
      expect(sleeps).toEqual(before.sleeps);
      const strip = (calls: Call[]) =>
        calls.map((c) => ({
          ...c.init,
          signal: undefined,
          headers: { ...c.init.headers, 'x-trace-id': '', 'x-span-id': '', 'x-correlation-id': '' },
        }));
      expect(strip(after.calls)).toEqual(strip(before.calls));
      expect(after.calls.every((c) => !('x-retry-budget' in c.init.headers))).toBe(true);
    }
  });

  it('RU-35 refuses legacy and resilience options for the same primitive on one layer', () => {
    const { gateway } = setup([]);
    expect(() =>
      gateway.bind({ name: 'a', url: URL_ORDERS, retry: {}, resilience: { retry: {} } }),
    ).toThrow(ResilienceDefinitionError);
    expect(() =>
      gateway.bind({
        name: 'b',
        url: URL_ORDERS,
        timeoutMs: 10,
        resilience: { timeout: { perAttemptMs: 10 } },
      }),
    ).toThrow(ResilienceDefinitionError);
    // Across layers the higher layer wins whichever spelling it uses.
    const layered = setup([], { deps: { defaults: { retry: { maxAttempts: 5 } } } });
    expect(() =>
      layered.gateway.bind({
        name: 'c',
        url: URL_ORDERS,
        resilience: { retry: { maxAttempts: 2 } },
      }),
    ).not.toThrow();
  });

  it('RU-48 requireIdempotencyKey rejects a non-safe call without a key before any attempt', async () => {
    const { gateway, calls } = setup([answer(200)]);
    gateway.bind({
      name: 'pay',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 1, requireIdempotencyKey: true } },
    });
    await expect(gateway.request('pay', { payload: {} })).rejects.toMatchObject({
      reason: 'idempotency-key-required',
    });
    expect(calls).toHaveLength(0);
    await gateway.request('pay', { payload: {}, headers: { idempotencyKey: 'k' } });
    expect(calls).toHaveLength(1);
    expect(() =>
      gateway.bind({
        name: 'pay2',
        url: URL_ORDERS,
        idempotency: false,
        resilience: { retry: { requireIdempotencyKey: true } },
      }),
    ).toThrow(ResilienceDefinitionError);
    const get = setup([answer(200)]);
    get.gateway.bind({
      name: 'read',
      url: URL_ORDERS,
      method: 'GET',
      resilience: { retry: { requireIdempotencyKey: true } },
    });
    await expect(get.gateway.request('read', { payload: {} })).resolves.toMatchObject({
      status: 200,
    });
  });

  it('RU-14 response mapper errors propagate unclassified and never reach mapError or the fallback', async () => {
    const mapError = jest.fn();
    const { gateway, calls } = setup([answer(200)]);
    gateway.bind({
      name: 'm',
      url: URL_ORDERS,
      response: () => {
        throw new Error('mapper');
      },
      mapError,
      resilience: {
        retry: { maxAttempts: 3, idempotent: true },
        fallback: { value: () => 'fb', on: ['unknown'] },
      },
    });
    await expect(gateway.request('m', { payload: {} })).rejects.toThrow('mapper');
    expect(mapError).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('RU-09b sends the same idempotency key on every attempt and never retries a timed-out POST without one', async () => {
    const clock = manualResilienceClock();
    const hang = () => new Promise<OutboundFetchResponse>(() => undefined);
    const keyed = setup([hang, answer(200)], { resilience: { clock } });
    keyed.gateway.bind({
      name: 'k',
      url: URL_ORDERS,
      resilience: { timeout: { perAttemptMs: 50 }, retry: { maxAttempts: 2, backoff: 0 } },
    });
    const result = keyed.gateway.request('k', {
      payload: {},
      headers: { idempotencyKey: 'key-1' },
    });
    await clock.advance(50);
    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(keyed.calls.map((c) => c.init.headers['Idempotency-Key'])).toEqual(['key-1', 'key-1']);
    expect(keyed.calls[0]!.init.signal?.aborted).toBe(true);
    const unkeyed = setup([hang, answer(200)], { resilience: { clock } });
    unkeyed.gateway.bind({
      name: 'u',
      url: URL_ORDERS,
      resilience: { timeout: { perAttemptMs: 50 }, retry: { maxAttempts: 2, backoff: 0 } },
    });
    const failed = unkeyed.gateway.request('u', { payload: {} }).catch((e: unknown) => e);
    await clock.advance(50);
    expect(await failed).toBeInstanceOf(OutboundTimeoutError);
    expect(unkeyed.calls).toHaveLength(1);
  });

  it('RS-33 retries 503s, calls mapError once with the last error and logs one hop', async () => {
    const lines: string[] = [];
    const logger = new HopLogger('log');
    jest.spyOn(logger, 'hopStart').mockImplementation(() => lines.push('start'));
    jest.spyOn(logger, 'hopEnd').mockImplementation(() => lines.push('end'));
    const mapError = jest.fn(
      (error: unknown) => new Error(`mapped ${(error as OutboundHttpError).attempts}`),
    );
    const { clock } = recordingClock();
    const { gateway, calls } = setup([answer(503)], { resilience: { clock }, deps: { logger } });
    gateway.bind({
      name: 'h',
      url: URL_ORDERS,
      mapError,
      resilience: {
        retry: { maxAttempts: 3, idempotent: true },
        circuitBreaker: { minimumCalls: 10 },
      },
    });
    await expect(gateway.request('h', { payload: {} })).rejects.toThrow('mapped 3');
    expect(calls).toHaveLength(3);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(mapError.mock.calls[0]![0]).toBeInstanceOf(OutboundHttpError);
    expect(lines).toEqual(['start', 'end']);
  });

  it('honours Retry-After and returns a fallback value without the response mapper or mapError', async () => {
    const { clock, sleeps } = recordingClock();
    const mapError = jest.fn();
    const { gateway, calls } = setup([answer(429, {}, { 'retry-after': '2' }), new Error('down')], {
      resilience: { clock },
    });
    gateway.bind({
      name: 'f',
      url: URL_ORDERS,
      method: 'GET',
      response: 'body',
      mapError,
      resilience: {
        retry: { maxAttempts: 2, backoff: { initialMs: 10, jitter: 'none' } },
        fallback: { value: () => ({ cached: true }) },
      },
    });
    await expect(gateway.request('f', { payload: {} })).resolves.toEqual({ cached: true });
    expect(sleeps).toEqual([2000]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.init.method).toBe('GET');
    expect(mapError).not.toHaveBeenCalled();
    expect(OutboundNetworkError).toBeDefined();
  });

  it('RU-29a reads the budget from header, message and scope only when resilience is enabled', async () => {
    const { clock } = recordingClock();
    const on = setup([answer(503)], { resilience: { clock } });
    on.gateway.bind({
      name: 'r',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 3, idempotent: true } },
    });
    await on.gateway.request('r', { payload: {} }).catch(() => undefined);
    expect(on.calls.map((c) => c.init.headers['x-retry-budget'])).toEqual(['0', '0', '0']);
    const zero = setup([answer(503)], { resilience: { clock } });
    zero.gateway.bind({
      name: 'r',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 3, idempotent: true } },
    });
    await zero.gateway
      .request('r', { payload: {}, headers: { retryBudget: 0 } })
      .catch(() => undefined);
    expect(zero.calls).toHaveLength(1);
    const scoped = setup([answer(503)], { resilience: { clock } });
    scoped.gateway.bind({
      name: 'r',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 3, idempotent: true } },
    });
    await ResilienceScope.run({ budget: 1 }, () =>
      scoped.gateway.request('r', { payload: {} }).catch(() => undefined),
    );
    expect(scoped.calls).toHaveLength(2);
    const off = setup([answer(503)], { resilience: { clock }, enabled: false });
    off.gateway.bind({
      name: 'r',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 3, idempotent: true } },
    });
    await off.gateway
      .request('r', { payload: {}, headers: { retryBudget: 0 } })
      .catch(() => undefined);
    expect(off.calls).toHaveLength(3);
    expect(off.calls.every((c) => !('x-retry-budget' in c.init.headers))).toBe(true);
  });

  it('refuses stateful primitives on ad-hoc options and skips the module ones', async () => {
    const warn = jest.fn();
    const { gateway, calls } = setup([answer(200)], {
      resilience: {
        logger: { log: () => undefined, warn, error: () => undefined, debug: () => undefined },
      },
      deps: { defaults: { resilience: { circuitBreaker: {}, bulkhead: { maxConcurrent: 1 } } } },
    });
    await expect(
      gateway.request({ url: URL_ORDERS, resilience: { circuitBreaker: {} } }, { payload: {} }),
    ).rejects.toBeInstanceOf(ResilienceDefinitionError);
    const options = { name: 'adhoc', url: URL_ORDERS };
    await gateway.request(options, { payload: {} });
    await gateway.request(options, { payload: {} });
    expect(calls).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('RU-42 adds the policy summary to the boot line and the binding info', () => {
    const { gateway } = setup([]);
    gateway.bind({
      name: 'p',
      url: URL_ORDERS,
      resilience: { retry: { maxAttempts: 3 }, circuitBreaker: {} },
    });
    gateway.bind({ name: 'q', url: URL_ORDERS });
    expect(gateway.bindings()).toEqual([
      {
        name: 'p',
        target: `POST ${URL_ORDERS}`,
        policy: 'retry x3 · breaker',
        line: `outbound rest: p -> POST ${URL_ORDERS} [retry x3 · breaker]`,
      },
      { name: 'q', target: `POST ${URL_ORDERS}`, line: `outbound rest: q -> POST ${URL_ORDERS}` },
    ]);
  });

  it('resolves named policies from the runtime', async () => {
    const { clock } = recordingClock();
    const { gateway, calls } = setup([answer(503)], {
      resilience: { clock, policies: { erp: { retry: { maxAttempts: 2, idempotent: true } } } },
    });
    gateway.bind({ name: 'n', url: URL_ORDERS, resilience: 'erp' });
    await gateway.request('n', { payload: {} }).catch(() => undefined);
    expect(calls).toHaveLength(2);
    expect(() => gateway.bind({ name: 'x', url: URL_ORDERS, resilience: 'nope' })).toThrow(
      ResilienceDefinitionError,
    );
    expect(ResilienceKeyError).toBeDefined();
    expect(createMessage).toBeDefined();
  });
});
