import { Pack, Reach, Remember, Show, type PrivacyModuleOptions } from './privacy.types';
import { PrivacyEngine, TrailOutput, type PrivacyLogger } from './privacy-engine';
import { PrivacyConfigError } from './privacy-errors';
import type { PrivacyLevel, PrivacyScopes } from './policy-resolver';

const LOG = { output: TrailOutput.Log };
const sealKeys = {
  current: () => Promise.resolve({ id: 'd1', key: Buffer.alloc(32, 1) }),
  byId: () => Promise.resolve(undefined),
};

function recorder(): PrivacyLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(`log ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

async function findings(
  options: PrivacyModuleOptions | false | undefined,
  scopes: PrivacyScopes,
): Promise<{ code: string; subject: string; path: string }[]> {
  const result = await PrivacyEngine.inspect(options, scopes);
  return result.findings.map(({ code, subject, path }) => ({ code, subject, path }));
}

const level = (
  subject: string,
  kind: PrivacyLevel['kind'],
  ref: PrivacyLevel['ref'],
  stepKind?: string,
): PrivacyLevel =>
  stepKind === undefined ? { subject, kind, ref } : { subject, kind, ref, stepKind };

describe('policy resolution (6.6)', () => {
  it('SD-29 remember default: Everything without privacy, OutcomeOnly with one, defaulted scopes listed at boot', async () => {
    const scopes: PrivacyScopes = {
      'inbound:orders': { durable: true, levels: [] },
      'activator:Svc.run': { durable: true, levels: [] },
    };
    const logger = recorder();
    const explicit = await PrivacyEngine.compile({ fields: ['**.ssn'] }, scopes, logger);
    expect(explicit.rememberOf('inbound:orders')).toBe(Remember.OutcomeOnly);
    expect(explicit.rememberOf('activator:Svc.run')).toBe(Remember.OutcomeOnly);
    expect(logger.lines.filter((l) => l.includes('remember defaulted'))).toEqual([
      "warn privacy scope 'inbound:orders': remember defaulted to outcome-only",
      "warn privacy scope 'activator:Svc.run': remember defaulted to outcome-only",
    ]);
    const quiet = recorder();
    const baseline = await PrivacyEngine.compile(undefined, scopes, quiet);
    expect(baseline.rememberOf('inbound:orders')).toBe(Remember.Everything);
    expect(quiet.lines.filter((l) => l.includes('remember defaulted'))).toEqual([]);
    const chosen = await PrivacyEngine.compile(
      { fields: ['x'], sealKeys },
      {
        'inbound:a': {
          durable: true,
          levels: [level("channel 'a'", 'channel', { remember: Remember.Sealed })],
        },
      },
    );
    expect(chosen.rememberOf('inbound:a')).toBe(Remember.Sealed);
    expect((await PrivacyEngine.compile(false)).rememberOf('inbound:a')).toBe(Remember.Everything);
  });

  it('SD-29 Remember.Everything needs a reason and Remember.Sealed needs seal keys', async () => {
    expect(await findings({ remember: Remember.Everything }, {})).toEqual([
      { code: 'REMEMBER_REASON_MISSING', subject: 'module', path: 'privacy.rememberReason' },
    ]);
    expect(
      await findings(
        {},
        {
          'inbound:a': {
            durable: true,
            levels: [level("endpoint 'a'", 'endpoint', { remember: Remember.Sealed })],
          },
        },
      ),
    ).toEqual([{ code: 'SEALED_WITHOUT_KEYS', subject: "endpoint 'a'", path: 'privacy.remember' }]);
  });

  it('SD-30 outcome-only plus replay on request/reply fails boot', async () => {
    const scopes: PrivacyScopes = { 'inbound:pay': { durable: true, replays: true, levels: [] } };
    expect(await findings({ fields: ['x'] }, scopes)).toEqual([
      { code: 'OUTCOME_ONLY_REPLAY', subject: 'inbound:pay', path: 'privacy.remember' },
    ]);
    const sealed: PrivacyScopes = {
      'inbound:pay': {
        durable: true,
        replays: true,
        levels: [level("endpoint 'pay'", 'endpoint', { remember: Remember.Sealed })],
      },
    };
    expect(await findings({ fields: ['x'], sealKeys }, sealed)).toEqual([]);
  });

  it('SD-48 profiles: extends, list union, cycle, depth and unknown names', async () => {
    const chain = (n: number): NonNullable<PrivacyModuleOptions['profiles']> => {
      const profiles: Record<string, { extends?: string; fields?: string[] }> = {};
      for (let i = 0; i < n; i++)
        profiles[`p${i}`] = i + 1 < n ? { extends: `p${i + 1}` } : { fields: ['z'] };
      return profiles;
    };
    const bad = await findings(
      { profiles: { a: { extends: 'b' }, b: { extends: 'a' }, ...chain(10) } },
      { 'channel:c': { levels: [level("channel 'c'", 'channel', 'missing')] } },
    );
    expect(bad.map((f) => f.code).sort()).toEqual(
      ['PROFILE_CYCLE', 'PROFILE_CYCLE', 'PROFILE_DEPTH', 'UNKNOWN_PROFILE'].sort(),
    );
    expect(await findings({ profiles: chain(9) }, {})).toEqual([]);
    expect(await findings({ profiles: { 'Bad Name': {} } }, {})).toEqual([
      { code: 'PROFILE_NAME', subject: "profile 'Bad Name'", path: 'privacy.profiles.Bad Name' },
    ]);
    const engine = await PrivacyEngine.compile(
      {
        profiles: {
          card: { fields: [{ path: '**.pan', show: Show.Ends, showLast: 4 }] },
          personal: { packs: [Pack.PersonalV1] },
          'card-personal': { extends: ['card', 'personal'] },
        },
      },
      { 'channel:pay': { levels: [level("channel 'pay'", 'channel', ['card-personal'])] } },
    );
    expect(
      engine.forTrail(
        { pan: '4111111111111111', mail: 'a@b.co' },
        { output: TrailOutput.Log, channel: 'pay' },
      ),
    ).toEqual({ pan: '***1111', mail: '[HIDDEN:personal.email]' });
    expect(engine.planOfScope('channel:pay')?.names).toEqual(['card-personal', 'personal@1']);
    const unreferencedBad = await findings({ profiles: { x: { fields: ['a..b'] } } }, {});
    expect(unreferencedBad.map((f) => f.code)).toEqual(['INVALID_SELECTOR']);
  });

  it('SD-48 an unreferenced profile changes nothing', async () => {
    const plain = await PrivacyEngine.compile(undefined);
    const withProfile = await PrivacyEngine.compile({ profiles: { card: { fields: ['**.pan'] } } });
    const value = { pan: '4111111111111111', token: 't' };
    expect(withProfile.forTrail(value, LOG)).toEqual(plain.forTrail(value, LOG));
  });

  it('SD-49 privacy false below the module or with lower references fails boot', async () => {
    expect(
      await findings(false, {
        'channel:a': { levels: [level("channel 'a'", 'channel', { fields: ['x'] })] },
      }),
    ).toEqual([{ code: 'PRIVACY_OFF_WITH_REFS', subject: "channel 'a'", path: 'privacy' }]);
    expect(
      await findings(undefined, {
        'flow:f#s': { levels: [level("flow 'f' step 's'", 'step', false)] },
      }),
    ).toEqual([
      { code: 'PRIVACY_FALSE_BELOW_MODULE', subject: "flow 'f' step 's'", path: 'privacy' },
    ]);
  });

  it('SD-50 delivery-reach level and reason are validated at boot', async () => {
    const delivery = { fields: ['ssn'], reach: Reach.Delivery, reachReason: 'partner' };
    const bad = await findings(undefined, {
      'flow:f': { levels: [level("flow 'f'", 'flow', delivery)] },
      'flow:f#filter': { levels: [level("flow 'f' step 'filter'", 'step', delivery, 'filter')] },
      'flow:f#tap': { levels: [level("flow 'f' step 'tap'", 'step', delivery, 'wireTap')] },
      'flow:f#t': {
        levels: [level("flow 'f' step 't'", 'step', { ...delivery, reachReason: '' }, 'transform')],
      },
    });
    expect(bad).toEqual([
      { code: 'DELIVERY_REACH_LEVEL', subject: "flow 'f'", path: 'privacy.reach' },
      { code: 'DELIVERY_REACH_LEVEL', subject: "flow 'f' step 'filter'", path: 'privacy.reach' },
      { code: 'DELIVERY_REACH_LEVEL', subject: "flow 'f' step 'tap'", path: 'privacy.reach' },
      { code: 'DELIVERY_REACH_LEVEL', subject: "flow 'f' step 't'", path: 'privacy.reachReason' },
    ]);
    const logger = recorder();
    await PrivacyEngine.compile(
      undefined,
      { 'flow:f#p': { levels: [level("flow 'f' step 'p'", 'step', delivery, 'publish')] } },
      logger,
    );
    expect(logger.lines).toContain('warn privacy delivery-reach flow:f#p: partner');
  });

  it('SD-57 profiles-only module options do not opt durable scopes in', async () => {
    const engine = await PrivacyEngine.compile(
      { profiles: { personal: { packs: [Pack.PersonalV1] } } },
      { 'activator:A.b': { durable: true, levels: [] } },
    );
    expect(engine.rememberOf('activator:A.b')).toBe(Remember.Everything);
    expect(engine.planOfScope('activator:A.b')?.explicit).toBe(false);
  });

  it('SD-58 remember on flow or step levels fails boot; inherited remember is ignored there', async () => {
    const result = await findings(undefined, {
      'flow:f#s': {
        levels: [
          level("channel 'a'", 'channel', { remember: Remember.Everything, rememberReason: 'r' }),
          level("flow 'f' step 's'", 'step', { remember: Remember.OutcomeOnly }),
        ],
      },
    });
    expect(result).toEqual([
      { code: 'REMEMBER_LEVEL', subject: "flow 'f' step 's'", path: 'privacy.remember' },
    ]);
    const engine = await PrivacyEngine.compile(undefined, {
      'flow:f': {
        levels: [
          level("channel 'a'", 'channel', { remember: Remember.Everything, rememberReason: 'r' }),
        ],
      },
    });
    expect(engine.planOfScope('flow:f')?.remember).toBeUndefined();
  });

  it('SD-17 an inner exemption weakens outer rules only; inner rules still apply', async () => {
    const engine = await PrivacyEngine.compile(
      { fields: ['**.from'], packs: [Pack.Personal] },
      {
        s: {
          levels: [
            level("endpoint 's'", 'endpoint', { exempt: [{ path: 'from', reason: 'sender' }] }),
            level("call 's'", 'call', { fields: ['from'] }),
          ],
        },
        'only-exempt': {
          levels: [
            level("endpoint 'e'", 'endpoint', { exempt: [{ path: 'from', reason: 'sender' }] }),
          ],
        },
      },
    );
    expect(
      engine.forTrail({ from: '+50212345678' }, { output: TrailOutput.Log, scope: 'only-exempt' }),
    ).toEqual({
      from: '+50212345678',
    });
    expect(
      engine.forTrail({ from: '+50212345678' }, { output: TrailOutput.Log, scope: 's' }),
    ).toEqual({
      from: '[HIDDEN:field]',
    });
    expect(engine.forTrail({ from: '+50212345678' }, LOG)).toEqual({ from: '[HIDDEN:field]' });
  });

  it('SD-55 compile throws one PrivacyConfigError with subjects and option paths, never rule bodies', async () => {
    const error = (await PrivacyEngine.compile(
      { profiles: { a: { extends: 'b' }, b: { extends: 'a' } } },
      {
        'flow:loan#credit': {
          levels: [level("flow 'loan' step 'credit'", 'step', { use: 'nope', fields: ['**.ssn'] })],
        },
        'flow:loan#f': {
          levels: [
            level(
              "flow 'loan' step 'f'",
              'step',
              { fields: ['x'], reach: Reach.Delivery, reachReason: 'r' },
              'filter',
            ),
          ],
        },
      },
    ).catch((e: unknown) => e)) as PrivacyConfigError;
    expect(error).toBeInstanceOf(PrivacyConfigError);
    expect(error.message).toContain(
      "flow 'loan' step 'credit': privacy.use unknown profile 'nope'",
    );
    expect(error.message).not.toContain('ssn');
    expect(error.findings.map((f) => f.code).sort()).toEqual(
      ['DELIVERY_REACH_LEVEL', 'PROFILE_CYCLE', 'PROFILE_CYCLE', 'UNKNOWN_PROFILE'].sort(),
    );
  });
});
