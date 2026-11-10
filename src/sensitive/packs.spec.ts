import { Pack } from './privacy.types';
import { PrivacyEngine, TrailOutput } from './privacy-engine';
import { builtInPacks, cardIssuerMatches, luhnValid, resolvePack } from './packs';
import { analyzeRegex, re2SyntaxProblem } from './regex-safety';
import { PrivacyConfigError } from './privacy-errors';

const LOG = { output: TrailOutput.Log };
const secret = { id: 'k1', secret: Buffer.alloc(32, 1) };

async function engineWith(packs: Pack[], fingerprint = false): Promise<PrivacyEngine> {
  return PrivacyEngine.compile({
    packs,
    ...(fingerprint ? { fingerprintSecret: { current: () => secret } } : {}),
  });
}

describe('built-in packs (6.4)', () => {
  it('SD-12 pack resolution: pinned, latest, unknown', async () => {
    expect(resolvePack('secrets')?.version).toBe(1);
    expect(resolvePack('secrets@1')?.name).toBe('secrets');
    expect(resolvePack('personal')?.name).toBe('personal');
    expect(resolvePack('secrets@2')).toBeUndefined();
    expect(resolvePack('secrets@01')).toBeUndefined();
    expect(resolvePack('acme')).toBeUndefined();
    expect(resolvePack('constructor')).toBeUndefined();
    await expect(engineWith([Pack.SecretsV1, Pack.Personal])).resolves.toBeInstanceOf(
      PrivacyEngine,
    );
    const error = (await PrivacyEngine.compile({ packs: ['acme' as Pack] }).catch(
      (e: unknown) => e,
    )) as PrivacyConfigError;
    expect(error).toBeInstanceOf(PrivacyConfigError);
    expect(error.findings.map((f) => f.code)).toEqual(['UNKNOWN_PACK']);
    expect(error.message).toContain("unknown pack 'acme'");
  });

  it('SD-13 built-in pack rules use RE2-compatible syntax only', () => {
    for (const pack of builtInPacks()) {
      for (const rule of pack.patterns) {
        expect([rule.name, re2SyntaxProblem(rule.regex)]).toEqual([rule.name, undefined]);
        expect([rule.name, analyzeRegex(rule.regex)]).toEqual([rule.name, undefined]);
      }
    }
  });

  it('SD-12 secrets pack positive and negative corpus', async () => {
    const engine = await engineWith([Pack.SecretsV1]);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlMTIz';
    const positives: [string, string][] = [
      [`token ${jwt} end`, 'token [HIDDEN:secrets.jwt] end'],
      ['Authorization: Bearer abc.DEF-123_x', 'Authorization: Bearer [HIDDEN:secrets.bearer]'],
      ['bearer QWERTY12', 'bearer [HIDDEN:secrets.bearer]'],
      ['https://user:pa55@host/x', 'https://[HIDDEN:secrets.basic-url]@host/x'],
      ['key AKIAABCDEFGHIJKLMNOP!', 'key [HIDDEN:secrets.aws-key-id]!'],
      ['GET /x?api_key=SECRET123&b=1', 'GET /x?api_key=[HIDDEN:secrets.query]&b=1'],
      ['x?token=key&y', 'x?token=[HIDDEN:secrets.query]&y'],
      ['password: hunter22 and more', 'password: [HIDDEN:secrets.assignment] and more'],
      ['{"password":"hunter22"}', '{"password":"[HIDDEN:secrets.assignment]"}'],
      ['{\\"secret\\":\\"abcdef\\"}', '{\\"secret\\":\\"[HIDDEN:secrets.assignment]\\"}'],
      [
        '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY----- tail',
        '[HIDDEN:secrets.pem] tail',
      ],
      ['-----BEGIN PRIVATE KEY-----\nMIIabc cut', '[HIDDEN:secrets.pem]'],
    ];
    for (const [input, expected] of positives) {
      expect(engine.textForTrail(input, LOG)).toBe(expected);
    }
    for (const negative of [
      'eyJhbGci only header',
      'https://host/x?page=2',
      'AKIA too short',
      'password: abc',
      '-----BEGIN PUBLIC KEY-----',
    ]) {
      expect(engine.textForTrail(negative, LOG)).toBe(negative);
    }
    // Over-masking is accepted (R2): any word after "bearer" is hidden.
    expect(engine.textForTrail('the bearer of news', LOG)).toBe(
      'the bearer [HIDDEN:secrets.bearer] news',
    );
    expect(engine.forTrail({ ApiKey: 'v', nested: [{ PASSWORD: 'v' }], ok: 'v' }, LOG)).toEqual({
      ApiKey: '[HIDDEN:secrets.keys]',
      nested: [{ PASSWORD: '[HIDDEN:secrets.keys]' }],
      ok: 'v',
    });
  });

  it('SD-12 personal pack positive and negative corpus', async () => {
    const engine = await engineWith([Pack.PersonalV1]);
    expect(engine.textForTrail('mail ana.perez+x@mail.example.com now', LOG)).toBe(
      'mail [HIDDEN:personal.email] now',
    );
    expect(engine.textForTrail('call +50212345678.', LOG)).toBe(
      'call [HIDDEN:personal.phone-e164].',
    );
    for (const card of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '5500-0000-0000-0004',
      '378282246310005',
      '3782 822463 10005',
      '6011111111111117',
      '2221000000000009',
    ]) {
      const out = engine.textForTrail(`card ${card}.`, LOG);
      expect([card, out]).toEqual([card, `card ***${card.slice(-4)}.`]);
    }
    for (const negative of ['no email here @ all', 'user@localhost', '+502 1234 5678']) {
      expect(engine.textForTrail(negative, LOG)).toBe(negative);
    }
  });

  it('SD-24 personal false-positive corpus: timestamps, ids, offsets', async () => {
    const engine = await engineWith([Pack.PersonalV1]);
    const ids = [
      '123456789012345678',
      '9876543210987654321',
      '4111111111111112',
      '411111111111111111',
      '30569309025904',
      '6759649826438453',
      '1731150000000',
    ];
    for (const value of [
      ...ids,
      '+05:30',
      '+0000',
      '+123',
      '+5021234567890123456',
      'ts=1731150000000',
    ]) {
      expect(engine.textForTrail(value, LOG)).toBe(value);
    }
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(cardIssuerMatches('6759649826438453')).toBe(false);
  });

  it('SD-24 adjacent phone numbers are both redacted', async () => {
    const engine = await engineWith([Pack.Personal]);
    expect(engine.textForTrail('call +50212345678 +50287654321', LOG)).toBe(
      'call [HIDDEN:personal.phone-e164] [HIDDEN:personal.phone-e164]',
    );
  });

  it('SD-25 personal phone rule fingerprints by default', async () => {
    const withSecret = await engineWith([Pack.Personal], true);
    expect(withSecret.textForTrail('from +50212345678', LOG)).toMatch(/^from fp:k1:[0-9a-f]{16}$/);
    const without = await engineWith([Pack.Personal]);
    const error = without.errorForTrail(new Error('from +50212345678'), LOG);
    expect(error.message).toBe('from [HIDDEN:personal.phone-e164]');
  });
});
