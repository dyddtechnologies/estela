import { ResilienceDefinitionError } from './resilience.errors';
import {
  describePolicy,
  expandPolicyRef,
  resolveResiliencePlan,
  validateProfiles,
} from './resilience.plan';
import type { NamedResiliencePolicy, ResiliencePolicy } from './resilience.types';

const resolve = (...layers: (ResiliencePolicy | string | undefined)[]) =>
  resolveResiliencePlan('orders.http', layers, 'outbound-rest');

function definitionError(fn: () => unknown): ResilienceDefinitionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ResilienceDefinitionError);
    return error as ResilienceDefinitionError;
  }
  throw new Error('expected a ResilienceDefinitionError');
}

describe('resolveResiliencePlan', () => {
  it('RU-03 rejects invalid policies at declaration with the option path', () => {
    expect(definitionError(() => resolve({ retry: { maxAttempts: 0 } })).message).toBe(
      'orders.http: resilience.retry.maxAttempts must be an integer 1..20',
    );
    const cases: [ResiliencePolicy, string][] = [
      [{ retry: { maxAttempts: 21 } }, 'retry.maxAttempts'],
      [{ timeout: { perAttemptMs: -1 } }, 'timeout.perAttemptMs'],
      [{ timeout: { deadlineMs: 0 } }, 'timeout.deadlineMs'],
      [{ circuitBreaker: { openMs: 0 } }, 'circuitBreaker.openMs'],
      [{ circuitBreaker: { minimumCalls: 0 } }, 'circuitBreaker.minimumCalls'],
      [
        { circuitBreaker: { minimumCalls: 10, window: { type: 'count', size: 5 } } },
        'circuitBreaker.window.size',
      ],
      [{ circuitBreaker: { window: { type: 'time', sizeMs: 0 } } }, 'circuitBreaker.window.sizeMs'],
      [{ circuitBreaker: { failureRateThreshold: 101 } }, 'circuitBreaker.failureRateThreshold'],
      [{ circuitBreaker: { recordOn: [] } }, 'circuitBreaker.recordOn'],
      [{ circuitBreaker: { recordOn: ['transient', 'transient'] } }, 'circuitBreaker.recordOn'],
      [{ circuitBreaker: { quotaOpenMs: 0 } }, 'circuitBreaker.quotaOpenMs'],
      [{ circuitBreaker: { state: {} as never } }, 'circuitBreaker.state'],
      [{ bulkhead: { maxConcurrent: 0 } }, 'bulkhead.maxConcurrent'],
      [{ bulkhead: { maxConcurrent: 1, maxQueue: -1 } }, 'bulkhead.maxQueue'],
      [{ rateLimit: { limitPerSec: 0 } }, 'rateLimit.limitPerSec'],
      [{ rateLimit: { limitPerSec: 1, maxWaitMs: -1 } }, 'rateLimit.maxWaitMs'],
      [{ rateLimit: { limitPerSec: 1, replicasHint: 0 } }, 'rateLimit.replicasHint'],
      [{ retry: { retryOn: ['quota' as never] } }, 'retry.retryOn'],
      [{ retry: { retryOn: ['bogus' as never] } }, 'retry.retryOn'],
      [{ retry: { backoff: { factor: 0.5 } } }, 'retry.backoff.factor'],
      [{ retry: { backoff: { initialMs: 100, maxMs: 50 } } }, 'retry.backoff.maxMs'],
      [{ fallback: {} }, 'fallback'],
      [{ fallback: { value: () => 1, channel: 'x' } }, 'fallback'],
      [{ fallback: { value: () => 1, on: ['nope' as never] } }, 'fallback.on'],
    ];
    for (const [policy, path] of cases) {
      expect(definitionError(() => resolve(policy)).path).toBe(path);
    }
  });

  it('RU-04 replaces each primitive whole by the highest level that sets it and false disables', () => {
    // The binding owns retry: the module's maxAttempts is not inherited (amended RS-04).
    const plan = resolve({ retry: { backoff: 50 } }, { retry: { maxAttempts: 5 } });
    expect(plan.retry?.maxAttempts).toBe(3);
    expect(plan.retry?.delay(1, undefined, () => 0)).toBe(50);
    const mixed = resolve(
      { circuitBreaker: false },
      { circuitBreaker: {}, timeout: { perAttemptMs: 700 } },
    );
    expect(mixed.circuitBreaker).toBeUndefined();
    expect(mixed.perAttemptMs).toBe(700);
    expect(resolve({ retry: { enabled: false, maxAttempts: 5 } }).retry).toBeUndefined();
    expect(resolve({}).empty).toBe(true);
  });

  it('RU-52 resilience false means no policy at this level and below', () => {
    const plan = resolveResiliencePlan('b', [false, { retry: { maxAttempts: 4 } }], 'activator');
    expect(plan.empty).toBe(true);
    const above = resolveResiliencePlan(
      'b',
      [{ timeout: { perAttemptMs: 5 } }, false, { retry: {} }],
      'activator',
    );
    expect(above.perAttemptMs).toBe(5);
    expect(above.retry).toBeUndefined();
  });

  it('RU-51 resolves named policies with inline fields deep-merged once and refuses unknown names', () => {
    const policies = {
      billing: { retry: { maxAttempts: 5, backoff: 100 }, timeout: { perAttemptMs: 2000 } },
    };
    const plan = resolveResiliencePlan(
      'b',
      [{ use: 'billing', retry: { backoff: 50 } }],
      'activator',
      { policies },
    );
    expect(plan.retry?.maxAttempts).toBe(5);
    expect(plan.retry?.delay(1, undefined, () => 0)).toBe(50);
    expect(plan.perAttemptMs).toBe(2000);
    expect(
      resolveResiliencePlan('b', ['billing'], 'activator', { policies }).retry?.maxAttempts,
    ).toBe(5);
    expect(
      definitionError(() => resolveResiliencePlan('b', ['missing'], 'activator', { policies }))
        .code,
    ).toBe('UNKNOWN_PROFILE');
    expect(definitionError(() => resolveResiliencePlan('b', ['billing'], 'activator')).path).toBe(
      'use',
    );
    const nested = { a: { use: 'b' } as NamedResiliencePolicy, b: {} };
    expect(definitionError(() => expandPolicyRef('x', 'a', nested)).path).toBe('use');
    const off = resolveResiliencePlan('b', [{ use: 'billing', retry: false }], 'activator', {
      policies,
    });
    expect(off.retry).toBeUndefined();
  });

  it('RU-53a resolves extends chains and fails on cycles and more than 8 hops', () => {
    const policies: Record<string, NamedResiliencePolicy> = {
      base: { retry: { maxAttempts: 2 }, timeout: { perAttemptMs: 100 } },
      child: { extends: 'base', retry: { backoff: 10 } },
    };
    const plan = resolveResiliencePlan('b', ['child'], 'activator', { policies });
    expect(plan.retry?.maxAttempts).toBe(2);
    expect(plan.retry?.delay(1, undefined, () => 0)).toBe(10);
    expect(plan.perAttemptMs).toBe(100);
    expect(
      definitionError(() => validateProfiles({ a: { extends: 'b' }, b: { extends: 'a' } })).code,
    ).toBe('PROFILE_CYCLE');
    const chain = (n: number): Record<string, NamedResiliencePolicy> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`p${i}`, i === n - 1 ? {} : { extends: `p${i + 1}` }]),
      );
    expect(definitionError(() => validateProfiles(chain(10))).code).toBe('PROFILE_DEPTH');
    expect(() => validateProfiles(chain(9))).not.toThrow();
    expect(definitionError(() => validateProfiles({ 'Bad Name': {} })).path).toBe(
      'policies.Bad Name',
    );
  });

  it('refuses primitives not allowed on the edge', () => {
    const error = definitionError(() =>
      resolveResiliencePlan('in', [{ retry: {} }], 'inbound', {
        allowed: ['bulkhead', 'rateLimit'],
      }),
    );
    expect(error.message).toBe('in: resilience.retry is not allowed on this edge');
  });

  it('warns when the deadline is shorter than the per-attempt timeout', () => {
    expect(resolve({ timeout: { perAttemptMs: 5000, deadlineMs: 1000 } }).warnings).toHaveLength(1);
  });

  it('RU-42 summarizes a plan with kinds, timeouts and attempts only', () => {
    const plan = resolve({
      timeout: { perAttemptMs: 2000, deadlineMs: 5000 },
      retry: { maxAttempts: 3 },
      circuitBreaker: { failureRateThreshold: 25 },
      bulkhead: { maxConcurrent: 7 },
      rateLimit: { limitPerSec: 9 },
      fallback: { value: () => 1 },
    });
    expect(describePolicy(plan)).toBe(
      'timeout 2s · deadline 5s · retry x3 · breaker · bulkhead · ratelimit · fallback',
    );
    expect(describePolicy(resolve({ timeout: { perAttemptMs: 1500 } }))).toBe('timeout 1500ms');
    expect(describePolicy(resolve({}))).toBeUndefined();
  });
});
