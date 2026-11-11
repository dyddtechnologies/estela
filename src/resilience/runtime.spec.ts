import { MemoryCareState } from '../testing/memory-resilience-state-port';
import { CareConfigError } from './resilience.errors';
import { CareEngine } from './runtime';
import { ctxOf, fakeAdapter, transient } from './test-kit.spec-helper';

describe('CareEngine', () => {
  it('RU-43c a custom key with shared state and no keyHasher fails boot', () => {
    const runtime = new CareEngine();
    const state = new MemoryCareState();
    const resolve = (policy: object) => () => runtime.plan('b', [policy], 'activator');
    expect(resolve({ valve: { key: () => 'k', state } })).toThrow(
      'b: care.valve.state needs a module keyHasher with a custom key',
    );
    expect(resolve({ pace: { perSecond: 1, key: () => 'k', state } })).toThrow(CareConfigError);
    const hashed = new CareEngine({ keyHasher: () => 'h' });
    expect(() =>
      hashed.plan('b', [{ valve: { key: () => 'k', state } }], 'activator'),
    ).not.toThrow();
  });

  it('RU-53b a profile is a template: each subject gets its own valve', async () => {
    const runtime = new CareEngine({
      profiles: {
        'http-guarded': { valve: { minCalls: 1, lookBack: { lastCalls: 1 } } },
      },
    });
    const a = runtime.executor(runtime.plan('a', ['http-guarded'], 'activator'), fakeAdapter());
    const b = runtime.executor(runtime.plan('b', ['http-guarded'], 'activator'), fakeAdapter());
    await a.execute(ctxOf('a'), () => Promise.reject(transient())).catch(() => undefined);
    expect(a.valveState()?.state).toBe('shut');
    expect(b.valveState()).toBeUndefined();
    await expect(b.execute(ctxOf('b'), () => Promise.resolve('ok'))).resolves.toMatchObject({
      value: 'ok',
    });
  });

  it('RU-54 refuses care.defaults.inbound and resolves defaults per edge kind', () => {
    expect(() => new CareEngine({ defaults: { inbound: {} } })).toThrow(
      'care: care.defaults.inbound is not allowed; inbound care comes from InboundDefaults.care',
    );
    const runtime = new CareEngine({
      profiles: { 'jump-sla': { tries: { max: 2 } } },
      defaults: { 'flow-jump': 'jump-sla' },
    });
    expect(runtime.options.defaults?.['flow-jump']).toBe('jump-sla');
    expect(
      runtime.plan('j', [undefined, runtime.options.defaults?.['flow-jump']], 'flow-jump').tries
        ?.max,
    ).toBe(2);
    expect(
      runtime.plan('s', [undefined, runtime.options.defaults?.['flow-send']], 'flow-send').empty,
    ).toBe(true);
  });
});
