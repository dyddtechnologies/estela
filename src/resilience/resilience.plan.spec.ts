import { CareConfigError } from './resilience.errors';
import { describeCare, expandCareRef, resolveCarePlan, validateProfiles } from './resilience.plan';
import type { CareProfile, Care } from './resilience.types';

const resolve = (...layers: (Care | string | undefined)[]) =>
  resolveCarePlan('orders.http', layers, 'outbound-rest');

function definitionError(fn: () => unknown): CareConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CareConfigError);
    return error as CareConfigError;
  }
  throw new Error('expected a CareConfigError');
}

describe('resolveCarePlan', () => {
  it('RU-03 rejects invalid profiles at declaration with the option path', () => {
    expect(definitionError(() => resolve({ tries: { max: 0 } })).message).toBe(
      'orders.http: care.tries.max must be an integer 1..20',
    );
    const cases: [Care, string][] = [
      [{ tries: { max: 21 } }, 'tries.max'],
      [{ patience: { eachTryMs: -1 } }, 'patience.eachTryMs'],
      [{ patience: { totalMs: 0 } }, 'patience.totalMs'],
      [{ valve: { shutMs: 0 } }, 'valve.shutMs'],
      [{ valve: { minCalls: 0 } }, 'valve.minCalls'],
      [{ valve: { minCalls: 10, lookBack: { lastCalls: 5 } } }, 'valve.lookBack.lastCalls'],
      [{ valve: { lookBack: { lastMs: 0 } } }, 'valve.lookBack.lastMs'],
      [{ valve: { failPercent: 101 } }, 'valve.failPercent'],
      [{ valve: { countOn: [] } }, 'valve.countOn'],
      [{ valve: { countOn: ['transient', 'transient'] } }, 'valve.countOn'],
      [{ valve: { quotaShutMs: 0 } }, 'valve.quotaShutMs'],
      [{ valve: { state: {} as never } }, 'valve.state'],
      [{ lanes: { count: 0 } }, 'lanes.count'],
      [{ lanes: { count: 1, waitlist: -1 } }, 'lanes.waitlist'],
      [{ pace: { perSecond: 0 } }, 'pace.perSecond'],
      [{ pace: { perSecond: 1, waitMs: -1 } }, 'pace.waitMs'],
      [{ pace: { perSecond: 1, replicas: 0 } }, 'pace.replicas'],
      [{ tries: { on: ['quota' as never] } }, 'tries.on'],
      [{ tries: { on: ['bogus' as never] } }, 'tries.on'],
      [{ tries: { spacing: { growth: 0.5 } } }, 'tries.spacing.growth'],
      [{ tries: { spacing: { firstMs: 100, capMs: 50 } } }, 'tries.spacing.capMs'],
      [{ planB: {} }, 'planB'],
      [{ planB: { value: () => 1, channel: 'x' } }, 'planB'],
      [{ planB: { value: () => 1, on: ['nope' as never] } }, 'planB.on'],
    ];
    for (const [policy, path] of cases) {
      expect(definitionError(() => resolve(policy)).path).toBe(path);
    }
  });

  it('RU-04 replaces each part whole by the highest level that sets it and false disables', () => {
    // The binding owns tries: the module's max is not inherited (amended RS-04).
    const plan = resolve({ tries: { spacing: 50 } }, { tries: { max: 5 } });
    expect(plan.tries?.max).toBe(3);
    expect(plan.tries?.delay(1, undefined, () => 0)).toBe(50);
    const mixed = resolve({ valve: false }, { valve: {}, patience: { eachTryMs: 700 } });
    expect(mixed.valve).toBeUndefined();
    expect(mixed.eachTryMs).toBe(700);
    expect(resolve({ tries: { enabled: false, max: 5 } }).tries).toBeUndefined();
    expect(resolve({}).empty).toBe(true);
  });

  it('RU-52 care false means no care at this level and below', () => {
    const plan = resolveCarePlan('b', [false, { tries: { max: 4 } }], 'activator');
    expect(plan.empty).toBe(true);
    const above = resolveCarePlan(
      'b',
      [{ patience: { eachTryMs: 5 } }, false, { tries: {} }],
      'activator',
    );
    expect(above.eachTryMs).toBe(5);
    expect(above.tries).toBeUndefined();
  });

  it('RU-51 resolves named profiles with inline fields deep-merged once and refuses unknown names', () => {
    const policies = {
      billing: { tries: { max: 5, spacing: 100 }, patience: { eachTryMs: 2000 } },
    };
    const plan = resolveCarePlan('b', [{ use: 'billing', tries: { spacing: 50 } }], 'activator', {
      profiles: policies,
    });
    expect(plan.tries?.max).toBe(5);
    expect(plan.tries?.delay(1, undefined, () => 0)).toBe(50);
    expect(plan.eachTryMs).toBe(2000);
    expect(resolveCarePlan('b', ['billing'], 'activator', { profiles: policies }).tries?.max).toBe(
      5,
    );
    expect(
      definitionError(() => resolveCarePlan('b', ['missing'], 'activator', { profiles: policies }))
        .code,
    ).toBe('UNKNOWN_PROFILE');
    expect(definitionError(() => resolveCarePlan('b', ['billing'], 'activator')).path).toBe('use');
    const nested = { a: { use: 'b' } as CareProfile, b: {} };
    expect(definitionError(() => expandCareRef('x', 'a', nested)).path).toBe('use');
    const off = resolveCarePlan('b', [{ use: 'billing', tries: false }], 'activator', {
      profiles: policies,
    });
    expect(off.tries).toBeUndefined();
  });

  it('RU-53a resolves extends chains and fails on cycles and more than 8 hops', () => {
    const profiles: Record<string, CareProfile> = {
      base: { tries: { max: 2 }, patience: { eachTryMs: 100 } },
      child: { extends: 'base', tries: { spacing: 10 } },
    };
    const plan = resolveCarePlan('b', ['child'], 'activator', { profiles });
    expect(plan.tries?.max).toBe(2);
    expect(plan.tries?.delay(1, undefined, () => 0)).toBe(10);
    expect(plan.eachTryMs).toBe(100);
    expect(
      definitionError(() => validateProfiles({ a: { extends: 'b' }, b: { extends: 'a' } })).code,
    ).toBe('PROFILE_CYCLE');
    const chain = (n: number): Record<string, CareProfile> =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`p${i}`, i === n - 1 ? {} : { extends: `p${i + 1}` }]),
      );
    expect(definitionError(() => validateProfiles(chain(10))).code).toBe('PROFILE_DEPTH');
    expect(() => validateProfiles(chain(9))).not.toThrow();
    expect(definitionError(() => validateProfiles({ 'Bad Name': {} })).path).toBe(
      'profiles.Bad Name',
    );
  });

  it('refuses parts not allowed on the edge', () => {
    const error = definitionError(() =>
      resolveCarePlan('in', [{ tries: {} }], 'inbound', {
        allowed: ['lanes', 'pace'],
      }),
    );
    expect(error.message).toBe('in: care.tries is not allowed on this edge');
  });

  it('warns when the total patience is shorter than the per-try eachTryMs', () => {
    expect(resolve({ patience: { eachTryMs: 5000, totalMs: 1000 } }).warnings).toHaveLength(1);
  });

  it('RU-42 summarizes a plan with kinds, eachTryMs and tries only', () => {
    const plan = resolve({
      patience: { eachTryMs: 2000, totalMs: 5000 },
      tries: { max: 3 },
      valve: { failPercent: 25 },
      lanes: { count: 7 },
      pace: { perSecond: 9 },
      planB: { value: () => 1 },
    });
    expect(describeCare(plan)).toBe(
      'patience 2s · total 5s · tries x3 · valve · lanes · pace · plan-b',
    );
    expect(describeCare(resolve({ patience: { eachTryMs: 1500 } }))).toBe('patience 1500ms');
    expect(describeCare(resolve({}))).toBeUndefined();
  });
});
