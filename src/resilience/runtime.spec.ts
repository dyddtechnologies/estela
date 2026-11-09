import { MemoryResilienceStatePort } from '../testing/memory-resilience-state-port';
import { ResilienceDefinitionError } from './resilience.errors';
import { ResilienceRuntime } from './runtime';
import { ctxOf, fakeAdapter, transient } from './test-kit.spec-helper';

describe('ResilienceRuntime', () => {
  it('RU-43c a custom key with shared state and no keyHasher fails boot', () => {
    const runtime = new ResilienceRuntime();
    const state = new MemoryResilienceStatePort();
    const resolve = (policy: object) => () => runtime.plan('b', [policy], 'activator');
    expect(resolve({ circuitBreaker: { key: () => 'k', state } })).toThrow(
      'b: resilience.circuitBreaker.state needs a module keyHasher with a custom key',
    );
    expect(resolve({ rateLimit: { limitPerSec: 1, key: () => 'k', state } })).toThrow(
      ResilienceDefinitionError,
    );
    const hashed = new ResilienceRuntime({ keyHasher: () => 'h' });
    expect(() =>
      hashed.plan('b', [{ circuitBreaker: { key: () => 'k', state } }], 'activator'),
    ).not.toThrow();
  });

  it('RU-53b a profile is a template: each subject gets its own breaker', async () => {
    const runtime = new ResilienceRuntime({
      policies: {
        'http-guarded': { circuitBreaker: { minimumCalls: 1, window: { type: 'count', size: 1 } } },
      },
    });
    const a = runtime.executor(runtime.plan('a', ['http-guarded'], 'activator'), fakeAdapter());
    const b = runtime.executor(runtime.plan('b', ['http-guarded'], 'activator'), fakeAdapter());
    await a.execute(ctxOf('a'), () => Promise.reject(transient())).catch(() => undefined);
    expect(a.breakerState()?.state).toBe('open');
    expect(b.breakerState()).toBeUndefined();
    await expect(b.execute(ctxOf('b'), () => Promise.resolve('ok'))).resolves.toMatchObject({
      value: 'ok',
    });
  });

  it('RU-54 refuses resilience.defaults.inbound and resolves defaults per edge kind', () => {
    expect(() => new ResilienceRuntime({ defaults: { inbound: {} } })).toThrow(
      'resilience: resilience.defaults.inbound is not allowed; inbound load shedding comes from InboundDefaults.resilience',
    );
    const runtime = new ResilienceRuntime({
      policies: { 'jump-sla': { retry: { maxAttempts: 2 } } },
      defaults: { 'flow-jump': 'jump-sla' },
    });
    expect(runtime.options.defaults?.['flow-jump']).toBe('jump-sla');
    expect(
      runtime.plan('j', [undefined, runtime.options.defaults?.['flow-jump']], 'flow-jump').retry
        ?.maxAttempts,
    ).toBe(2);
    expect(
      runtime.plan('s', [undefined, runtime.options.defaults?.['flow-send']], 'flow-send').empty,
    ).toBe(true);
  });
});
