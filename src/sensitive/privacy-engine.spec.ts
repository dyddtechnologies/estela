/* eslint-disable sonarjs/super-linear-regex, sonarjs/slow-regex, security/detect-unsafe-regex -- unsafe patterns are fixtures for the analysis */
import { KeyCase, Pack, Reach, Show, type PrivacyModuleOptions } from './privacy.types';
import { PrivacyEngine, TrailOutput, urlForTrail, type PrivacyLogger } from './privacy-engine';
import {
  DeliveryCopyError,
  PrivacyConfigError,
  PrivacyError,
  ReplayUnavailableError,
  SealBrokenError,
  SealKeyUnavailableError,
} from './privacy-errors';
import { Private } from './private.decorator';
import type { RegexEngine } from './regex-engine';
import type { PrivacyScopes } from './policy-resolver';

const LOG = { output: TrailOutput.Log };
const SECRET = { id: 'k1', secret: Buffer.alloc(32, 3) };
const withSecret = { fingerprintSecret: { current: () => SECRET } };

function recorder(): PrivacyLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (m) => lines.push(`log ${m}`),
    warn: (m) => lines.push(`warn ${m}`),
    error: (m) => lines.push(`error ${m}`),
  };
}

async function configError(
  options: PrivacyModuleOptions | false | undefined,
  scopes?: PrivacyScopes,
): Promise<PrivacyConfigError> {
  const error = await PrivacyEngine.compile(options, scopes).then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof PrivacyConfigError)) throw new Error('expected a PrivacyConfigError');
  return error;
}

/** JSON replacer that writes Maps as objects and Sets as arrays. */
function collections(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value as Map<string, unknown>);
  if (value instanceof Set) return [...(value as Set<unknown>)];
  return value;
}

function deepFreeze<T>(input: T): T {
  const value: unknown = input;
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return input;
}

describe('PrivacyEngine: invariants (7.4)', () => {
  it('I1 / SD-02 redactor never mutates its input (deep-frozen payload)', async () => {
    const engine = await PrivacyEngine.compile({ fields: ['**.ssn'], packs: [Pack.Personal] });
    const payload = deepFreeze({
      ssn: '123-45-6789',
      keep: { a: 1 },
      list: ['call +50212345678', 'plain'],
      headers: { authorization: 'Bearer abcdef', other: 'x' },
    });
    const copy = engine.forTrail(payload, LOG) as Record<string, unknown>;
    expect(copy).toEqual({
      ssn: '[HIDDEN:field]',
      keep: { a: 1 },
      list: ['call [HIDDEN:personal.phone-e164]', 'plain'],
      headers: { authorization: '[HIDDEN:header]', other: 'x' },
    });
    expect(copy).not.toBe(payload);
    expect(copy.keep).toBe(payload.keep);
    expect(payload.ssn).toBe('123-45-6789');
    const untouched = deepFreeze({ a: { b: 'plain' } });
    expect(engine.forTrail(untouched, LOG)).toBe(untouched);
  });

  it('I2 / SD-23 redaction failure writes a placeholder, never the raw value', async () => {
    const logger = recorder();
    const throwing: RegexEngine = {
      name: 'broken',
      compile: () => ({
        replaceAll: () => {
          throw new Error('engine bug with SECRET-1');
        },
      }),
    };
    const engine = await PrivacyEngine.compile(
      { regexEngine: throwing, patterns: [{ name: 'test.x', regex: /x/ }] },
      {},
      logger,
    );
    expect(engine.forTrail({ a: 'SECRET-1' }, LOG)).toBe('[HIDE_FAILED]');
    expect(engine.textForTrail('SECRET-1', LOG)).toBe('[HIDE_FAILED]');
    expect(engine.errorForTrail(new Error('SECRET-1'), LOG)).toEqual({
      name: 'Error',
      message: '[HIDE_FAILED]',
    });
    const errors = logger.lines.filter((line) => line.startsWith('error'));
    expect(errors).toEqual(["error privacy: hiding failed for trail output 'log'"]);
    expect(engine.stats().hideFailed).toBe(3);
  });

  it('I5 / SD-17 merge: unions, stricter show wins, inner levels cannot weaken, ties keep the outer show', async () => {
    const engine = await PrivacyEngine.compile(
      {
        fields: [
          { path: '**.token', show: Show.Hidden },
          { path: 'code', show: Show.Text, text: 'x' },
        ],
      },
      {
        endpoint: {
          levels: [
            {
              subject: "endpoint 'e'",
              kind: 'endpoint',
              ref: {
                fields: [
                  { path: 'token', show: Show.Ends },
                  { path: 'code', show: Show.Hidden },
                  'extra',
                ],
              },
            },
          ],
        },
      },
    );
    const copy = engine.forTrail(
      { token: 'abcdefghijkl', code: 'c', extra: 'e', other: 'o' },
      { output: TrailOutput.Log, scope: 'endpoint' },
    );
    expect(copy).toEqual({
      token: '[HIDDEN:secrets.keys]',
      code: 'x',
      extra: '[HIDDEN:field]',
      other: 'o',
    });
    expect(engine.forTrail({ code: 'c', extra: 'e' }, LOG)).toEqual({ code: 'x', extra: 'e' });
  });

  it('I6 / SD-15 fingerprint requires a fingerprint secret of 32 bytes', async () => {
    const missing = await configError({ fields: [{ path: 'phone', show: Show.Fingerprint }] });
    expect(missing.findings).toEqual([
      {
        code: 'FINGERPRINT_WITHOUT_SECRET',
        severity: 'error',
        subject: 'module',
        path: 'privacy.fields[0].show',
      },
    ]);
    const short = await configError({
      fingerprintSecret: { current: () => ({ id: 'k1', secret: Buffer.alloc(16, 9) }) },
    });
    expect(short.findings.map((f) => f.code)).toEqual(['FINGERPRINT_SECRET_SHORT']);
    expect(short.message).toContain("'k1' is 16 bytes, below 32");
    const badId = await configError({
      fingerprintSecret: { current: () => ({ id: 'bad id!', secret: Buffer.alloc(32) }) },
    });
    expect(badId.findings.map((f) => f.code)).toEqual(['FINGERPRINT_SECRET_SHORT']);
    const failing = await configError({
      fingerprintSecret: {
        current: () => {
          throw new Error('vault down');
        },
      },
    });
    expect(failing.findings.map((f) => f.path)).toEqual(['privacy.fingerprintSecret']);
    const exempt = await configError({
      exempt: [{ path: 'a', show: Show.Fingerprint, reason: 'r' }],
      defaultShow: Show.Fingerprint,
      fields: ['b'],
    });
    expect(exempt.findings.map((f) => f.code)).toEqual([
      'FINGERPRINT_WITHOUT_SECRET',
      'FINGERPRINT_WITHOUT_SECRET',
      'FINGERPRINT_WITHOUT_SECRET',
    ]);
  });

  it('I7 / SD-10 trace fields are never redacted', async () => {
    const engine = await PrivacyEngine.compile({ packs: [Pack.Personal] });
    const card = '4111111111111111';
    const message = {
      payload: { note: `card ${card}` },
      headers: {
        id: card,
        traceId: card,
        spanId: card,
        correlationId: card,
        causationId: card,
        parentSpanId: card,
        timestamp: 1731150000000,
        history: [{ channel: card, at: 1 }],
      },
    };
    const copy = engine.forTrail(message, LOG) as typeof message;
    expect(copy.headers).toBe(message.headers);
    expect(copy.payload.note).toBe('card ***1111');
  });

  it('SD-10 field rule on a protected trace field fails boot', async () => {
    for (const path of ['headers.traceId', '**.correlationId', 'headers.history[*]']) {
      const error = await configError({ fields: [path] });
      expect(error.findings.map((f) => f.code)).toEqual(['PROTECTED_TRACE_FIELD']);
    }
  });

  it('I8 / SD-37 boot reports all configuration errors at once', async () => {
    const error = await configError({
      fields: ['a..b'],
      packs: ['acme' as Pack],
      patterns: [{ name: 'My Rule!', regex: /(a+)+/ }],
      exempt: [{ path: 'x', reason: '' }],
      maxScanBytes: 10,
      fingerprintChars: 70,
    });
    expect(error.findings.map((f) => f.code).sort()).toEqual(
      [
        'EXEMPT_REASON_MISSING',
        'INVALID_OPTION',
        'INVALID_OPTION',
        'INVALID_SELECTOR',
        'RULE_NAME',
        'UNKNOWN_PACK',
        'UNSAFE_PATTERN',
      ].sort(),
    );
    expect(error.problems).toHaveLength(7);
    expect(error).toBeInstanceOf(PrivacyError);
    expect(error.kind).toBe('config');
    expect(error.retryable).toBe(false);
  });
});

describe('PrivacyEngine: marking and patterns', () => {
  it('SD-08 invalid selector fails boot with level and selector', async () => {
    const error = await configError(
      { fields: ['ok'] },
      {
        'inbound:a': {
          levels: [{ subject: "channel 'a'", kind: 'channel', ref: { fields: ['a..b'] } }],
        },
      },
    );
    expect(error.message).toContain(
      "channel 'a': privacy.fields[0].path selector 'a..b' does not parse",
    );
  });

  it('SD-08 keyCase Match opts out of case-insensitive keys', async () => {
    const engine = await PrivacyEngine.compile({ fields: ['Token2'], keyCase: KeyCase.Match });
    expect(engine.forTrail({ token2: 'a', Token2: 'b' }, LOG)).toEqual({
      token2: 'a',
      Token2: '[HIDDEN:field]',
    });
  });

  it('SD-09 hidden headers are hidden case-insensitively', async () => {
    const engine = await PrivacyEngine.compile({ headers: ['X-Tenant-Secret'] });
    const message = {
      payload: {},
      headers: { Authorization: 'Bearer X', COOKIE: 'c', 'x-tenant-secret': 's', plain: 'p' },
    };
    expect((engine.forTrail(message, LOG) as typeof message).headers).toEqual({
      Authorization: '[HIDDEN:header]',
      COOKIE: '[HIDDEN:header]',
      'x-tenant-secret': '[HIDDEN:header]',
      plain: 'p',
    });
    const error = Object.assign(new Error('boom'), { headers: { 'set-cookie': 'SECRET2' } });
    expect(engine.errorForTrail(error, LOG).headers).toEqual({ 'set-cookie': '[HIDDEN:header]' });
  });

  it('SD-09 idempotency key header is fingerprinted, or hidden without a fingerprint secret', async () => {
    const message = {
      payload: {},
      headers: { idempotencyKey: 'K-555', 'Idempotency-Key': 'K-555', leftFromKey: 'K-555' },
    };
    const hidden = (await PrivacyEngine.compile(undefined)).forTrail(
      message,
      LOG,
    ) as typeof message;
    expect(hidden.headers).toEqual({
      idempotencyKey: '[HIDDEN:header]',
      'Idempotency-Key': '[HIDDEN:header]',
      leftFromKey: '[HIDDEN:header]',
    });
    const engine = await PrivacyEngine.compile(withSecret);
    const shown = engine.forTrail(message, LOG) as typeof message;
    expect(shown.headers.idempotencyKey).toMatch(/^fp:k1:[0-9a-f]{16}$/);
    // D42: the origin key of a left message correlates with the key it was left from.
    expect(shown.headers.leftFromKey).toBe(shown.headers.idempotencyKey);
  });

  it('SD-11 patterns redact nested strings, messages, stacks and causes', async () => {
    const engine = await PrivacyEngine.compile({
      patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }],
    });
    const error = new Error('failed with XSECRET1111', {
      cause: new Error('inner XSECRET2222'),
    });
    Object.assign(error, { detail: { deep: ['XSECRET3333'] } });
    const text = JSON.stringify(engine.errorForTrail(error, LOG));
    expect(text).not.toMatch(/XSECRET\d/);
    expect(text).toContain('[HIDDEN:test.x]');
    const payload = JSON.stringify(engine.forTrail({ a: { b: ['XSECRET4444'] } }, LOG));
    expect(payload).toBe('{"a":{"b":["[HIDDEN:test.x]"]}}');
  });

  it('SD-06 class instances are hidden by their @Private metadata', async () => {
    class Card {
      @Private({ show: Show.Ends })
      pan = '4111111111111111';
      @Private({ name: 'card.cvv', show: Show.Omitted })
      cvv = '123';
      brand = 'visa';
    }
    const engine = await PrivacyEngine.compile(undefined);
    expect(engine.forTrail({ card: new Card() }, LOG)).toEqual({
      card: { pan: '***1111', brand: 'visa' },
    });
  });

  it('SD-26 hidden tokens name the rule; invalid names fail boot', async () => {
    const error = await configError({ fields: [{ path: 'a', name: 'My Rule!' }] });
    expect(error.findings.map((f) => f.code)).toEqual(['RULE_NAME']);
    const engine = await PrivacyEngine.compile({ packs: [Pack.Personal] });
    expect(engine.textForTrail('a@b.co', LOG)).toBe('[HIDDEN:personal.email]');
  });

  it('SD-18 exemptions need a reason, are logged at boot and win over patterns', async () => {
    const logger = recorder();
    const options = {
      packs: [Pack.Personal],
      fields: [{ path: 'from', name: 'wa.customer', show: Show.Fingerprint }],
      exempt: [{ path: 'from', show: Show.Ends, reason: 'business sender number' }],
      ...withSecret,
    };
    const engine = await PrivacyEngine.compile(options, {}, logger);
    expect(engine.forTrail({ from: '+50212345678', to: '+50212345678' }, LOG)).toEqual({
      from: '***5678',
      to: expect.stringMatching(/^fp:k1:/) as unknown,
    });
    expect(logger.lines).toContain(
      "warn privacy exemption: module path 'from' show ends reason: business sender number",
    );
    const asIs = await PrivacyEngine.compile({
      packs: [Pack.Personal],
      exempt: [{ path: 'own', reason: 'our number' }],
    });
    expect(asIs.forTrail({ own: '+50212345678' }, LOG)).toEqual({ own: '+50212345678' });
    const missing = await configError({
      exempt: [{ path: 'from', reason: undefined as unknown as string }],
    });
    expect(missing.findings.map((f) => f.code)).toEqual(['EXEMPT_REASON_MISSING']);
  });

  it('SD-19 unsafe user patterns fail boot naming the rule', async () => {
    const error = await configError({ patterns: [{ name: 'test.bad', regex: /(a|ab)*c/ }] });
    expect(error.message).toContain("rule 'test.bad' is unsafe: quantified alternation");
    const ok = await PrivacyEngine.compile({
      patterns: [{ name: 'test.aws', regex: /AKIA[0-9A-Z]{16}/ }],
    });
    expect(ok).toBeInstanceOf(PrivacyEngine);
  });

  it('SD-20 regex engine port compiles every rule and reports rejects at boot', async () => {
    const compiled: string[] = [];
    const fake: RegexEngine = {
      name: 'fake-re2',
      compile(source, flags) {
        if (source.includes('(?<=')) throw new Error('lookbehind');
        compiled.push(`${source}/${flags}`);
        const native = new RegExp(source, flags);
        return {
          replaceAll: (input, fn) => input.replace(native, (m: string, o: number) => fn(m, [], o)),
        };
      },
    };
    const error = await configError({
      regexEngine: fake,
      patterns: [{ name: 'test.look', regex: /(?<=x)y/ }],
    });
    expect(error.message).toContain("rule 'test.look' is refused by regex engine 'fake-re2'");
    const engine = await PrivacyEngine.compile({
      regexEngine: fake,
      patterns: [{ name: 'test.nested', regex: /(a+)+b/ }],
    });
    expect(compiled).toContain('(a+)+b/g');
    expect(engine.textForTrail('aab', LOG)).toBe('[HIDDEN:test.nested]');
  });

  it('SD-24 confirm leaves rejected matches as they are', async () => {
    const engine = await PrivacyEngine.compile({
      patterns: [{ name: 'test.even', regex: /N\d/, confirm: (m) => Number(m[1]) % 2 === 0 }],
    });
    expect(engine.textForTrail('N1 N2 N3 N4', LOG)).toBe(
      'N1 [HIDDEN:test.even] N3 [HIDDEN:test.even]',
    );
  });
});

describe('PrivacyEngine: limits and walker (SD-21, SD-22)', () => {
  it('SD-21 long strings are cut after scanning, dropping the token that reaches the cut', async () => {
    const engine = await PrivacyEngine.compile({});
    const jwt = `eyJ${'a'.repeat(1000)}.eyJ${'b'.repeat(500)}.${'c'.repeat(500)}`;
    const head = 'word '.repeat(Math.floor((64 * 1024 - 1024) / 5));
    const input = `${head}${jwt} ${'tail '.repeat(1000)}`;
    expect(Buffer.byteLength(input)).toBeGreaterThan(65_536);
    const out = engine.textForTrail(input, LOG);
    for (let i = 0; i + 8 <= jwt.length; i += 97) expect(out).not.toContain(jwt.slice(i, i + 9));
    expect(out).toMatch(/\[truncated \d+ bytes\]$/);
    const dropped = Number(/\[truncated (\d+) bytes\]$/.exec(out)?.[1]);
    expect(dropped).toBe(
      Buffer.byteLength(input) - Buffer.byteLength(out.replace(/\[truncated \d+ bytes\]$/, '')),
    );
    const blob = 'A'.repeat(70 * 1024);
    expect(engine.textForTrail(blob, LOG)).toBe(`[truncated ${70 * 1024} bytes]`);
    const short = 'x'.repeat(1000);
    expect(engine.textForTrail(short, LOG)).toBe(short);
  });

  it('SD-22 walker limits: depth, nodes, cycles, getters, toJSON, binary, Map and Set', async () => {
    const engine = await PrivacyEngine.compile({ fields: ['**.pin'] });
    const cyclic: Record<string, unknown> = { name: 'c' };
    cyclic.self = cyclic;
    const getter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter ran');
      },
    });
    const toJson = {
      plain: 'p',
      toJSON() {
        throw new Error('toJSON ran');
      },
    };
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const date = new Date('2026-11-10T00:00:00.000Z');
    const value = {
      cyclic,
      getter,
      toJson,
      buffer: Buffer.from('token=SECRET-BUFFER'),
      bytes: new Uint8Array(3),
      date,
      deep,
      map: new Map<string, unknown>([
        ['pin', 'm'],
        ['ok', 'v'],
      ]),
      set: new Set(['a', { pin: 's' }]),
    };
    const out = engine.forTrail(value, LOG) as Record<string, unknown>;
    const text = JSON.stringify(out, collections);
    expect(text).not.toContain('SECRET-BUFFER');
    expect(out.cyclic).toEqual({ name: 'c', self: '[Circular]' });
    expect(out.getter).toEqual({ boom: '[Getter]' });
    expect(out.buffer).toBe('[Binary len=19]');
    expect(out.bytes).toBe('[Binary len=3]');
    expect(out.date).toBe('2026-11-10T00:00:00.000Z');
    expect(text).toContain('[TRUNCATED]');
    expect(out.map).toEqual(
      new Map([
        ['pin', '[HIDDEN:field]'],
        ['ok', 'v'],
      ]),
    );
    expect(out.set).toEqual(new Set(['a', { pin: '[HIDDEN:field]' }]));
    expect(out.toJson).toEqual({ plain: 'p' });
    const nodes = await PrivacyEngine.compile({ maxNodes: 5 });
    expect(JSON.stringify(nodes.forTrail({ a: [1, 2, 3, 4, 5, 6] }, LOG))).toContain('[TRUNCATED]');
  });
});

describe('PrivacyEngine: fingerprint secret, stats and boot lines', () => {
  it('SD-15 built-in fingerprint-or-hide rules hide without a fingerprint secret', async () => {
    const engine = await PrivacyEngine.compile({ packs: [Pack.Personal] });
    expect(engine.textForTrail('+50212345678', LOG)).toBe('[HIDDEN:personal.phone-e164]');
  });

  it('SD-16 failed fingerprint secret refresh keeps the current secret and warns', async () => {
    const logger = recorder();
    let calls = 0;
    const provider = {
      current: () => {
        calls++;
        if (calls > 1) throw new Error('vault down: material abc');
        return SECRET;
      },
    };
    const engine = await PrivacyEngine.compile(
      { packs: [Pack.Personal], fingerprintSecret: provider },
      {},
      logger,
    );
    const before = engine.textForTrail('+50212345678', LOG);
    await engine.refreshFingerprintSecret();
    expect(engine.textForTrail('+50212345678', LOG)).toBe(before);
    const warns = logger.lines.filter((line) => line.startsWith('warn'));
    expect(warns).toEqual([
      "warn privacy: fingerprint secret refresh failed; keeping secret id 'k1'",
    ]);
    calls = 0;
    const rotated = { current: () => ({ id: 'k2', secret: Buffer.alloc(32, 5) }) };
    const second = await PrivacyEngine.compile({
      packs: [Pack.Personal],
      fingerprintSecret: rotated,
    });
    await second.refreshFingerprintSecret();
    expect(second.textForTrail('+50212345678', LOG)).toMatch(/^fp:k2:/);
  });

  it('SD-37 / SD-42 boot summary line has no data and config errors never print key material', async () => {
    const logger = recorder();
    await PrivacyEngine.compile(
      {
        packs: [Pack.SecretsV1],
        fields: ['**.ssn'],
        patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }],
        ...withSecret,
      },
      {},
      logger,
    );
    const summary = logger.lines.find((line) => line.startsWith("log privacy scope 'module'"));
    expect(summary).toBe(
      "log privacy scope 'module': fields=29 patterns=8 uses=secrets@1 remember=outcome-only fingerprint=k1",
    );
    const text = logger.lines.join('\n');
    expect(text).not.toContain('ssn');
    expect(text).not.toContain('XSECRET');
    const material = Buffer.alloc(16, 0x41);
    const error = await configError({
      fingerprintSecret: { current: () => ({ id: 'k9', secret: material }) },
    });
    expect(error.message).toContain("'k9' is 16 bytes");
    expect(error.message).not.toContain(material.toString('base64'));
    expect(error.message).not.toContain('AAAA');
  });

  it('SD-61 engine stats count hidden values by rule, output and subject without values', async () => {
    const engine = await PrivacyEngine.compile({ packs: [Pack.Personal] });
    for (let i = 0; i < 3; i++)
      engine.textForTrail(`phone +5021234567${i}`, { output: TrailOutput.Log, scope: 'flow:wa' });
    const stats = engine.stats();
    expect(stats.byRule['personal.phone-e164']).toBe(3);
    expect(stats.byOutput.log).toBe(3);
    expect(stats.bySubject['flow:wa']).toBe(3);
    expect(JSON.stringify(stats)).not.toContain('+502');
  });

  it('SD-36 redactor is not called when no sink writes', async () => {
    const confirm = jest.fn(() => true);
    const engine = await PrivacyEngine.compile({
      patterns: [{ name: 'test.x', regex: /x/, confirm }],
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(engine.stats().byRule).toEqual({});
  });

  it('SD-39 PrivacyEngine instances keep separate policies', async () => {
    const a = await PrivacyEngine.compile({ fields: ['**.a'] });
    const b = await PrivacyEngine.compile({ fields: ['**.b'] });
    expect(a.forLog({ a: 1, b: 2 })).toEqual({ a: '[HIDDEN:field]', b: 2 });
    expect(b.forLog({ a: 1, b: 2 })).toEqual({ a: 1, b: '[HIDDEN:field]' });
    expect(b.forLog({ b: 2 }, { channel: 'x' })).toEqual({ b: '[HIDDEN:field]' });
  });
});

describe('PrivacyEngine: errors and urls', () => {
  it('SD-04 errorForTrail never returns raw url, headers or body', async () => {
    const engine = await PrivacyEngine.compile(undefined);
    const error = Object.assign(new Error('POST failed 500'), {
      code: 'E_HTTP',
      status: 500,
      url: 'https://u:p@h/x?api_key=SECRET1',
      headers: { 'set-cookie': 'SECRET2' },
      body: { token: 'SECRET3' },
    });
    const shown = engine.errorForTrail(error, LOG);
    const text = JSON.stringify(shown);
    for (const leak of ['SECRET1', 'SECRET2', 'SECRET3', 'u:p@', '?api_key']) {
      expect(text).not.toContain(leak);
    }
    expect(shown).toMatchObject({ name: 'Error', code: 'E_HTTP', status: 500, url: 'https://h/x' });
    expect(engine.errorForTrail({ token: 'SECRET4' }, LOG)).toEqual({
      name: 'NonError',
      message: '',
      value: { token: '[HIDDEN:secrets.keys]' },
    });
    expect(engine.errorForTrail('password=hunter22', LOG).message).toBe(
      'password=[HIDDEN:secrets.query]',
    );
  });

  it('SD-04 privacy false keeps only name, message, code, status, url', async () => {
    const engine = await PrivacyEngine.compile(false);
    const error = Object.assign(new Error('boom'), {
      code: 'E',
      status: 502,
      url: 'https://u:p@h/x?k=1',
      headers: { a: 'b' },
      body: 'b',
    });
    expect(engine.errorForTrail(error, LOG)).toEqual({
      name: 'Error',
      message: 'boom',
      code: 'E',
      status: 502,
      url: 'https://h/x',
    });
    const payload = { token: 't' };
    expect(engine.forTrail(payload, LOG)).toBe(payload);
    expect(engine.textForTrail('Bearer abc', LOG)).toBe('Bearer abc');
  });

  it('SD-05 urlForTrail drops userinfo, query string and fragment', () => {
    expect(urlForTrail('https://u:p@h/x?token=SECRET#frag')).toBe('https://h/x');
    expect(urlForTrail('/relative/path?token=SECRET')).toBe('/relative/path');
    expect(urlForTrail('nonsense://u:p@h?x')).toBe('nonsense://h');
  });

  it('SD-05 urlForTrail drops a password that holds a raw @ whole', () => {
    expect(urlForTrail('https://svc:Lg@Pw-Secret-6630@h/x?k=1')).toBe('https://h/x');
    expect(urlForTrail('nonsense://svc:Lg@Pw-Secret-6630@h /x?k=1')).toBe('nonsense://h /x');
    expect(urlForTrail('/relative/a@b?k=1')).toBe('/relative/a@b');
  });

  it('SD-43 in-progress errors keep the key out of message and sinks', async () => {
    class IdempotencyInProgressError extends Error {
      constructor(readonly key: string) {
        super('IDEMPOTENCY_KEY_IN_PROGRESS: saga');
        this.name = 'IdempotencyInProgressError';
      }
    }
    const error = new IdempotencyInProgressError('K-555');
    const hidden = (await PrivacyEngine.compile(undefined)).errorForTrail(error, LOG);
    expect(hidden.key).toBe('[HIDDEN:header]');
    const fp = (await PrivacyEngine.compile(withSecret)).errorForTrail(error, LOG);
    expect(fp.key).toMatch(/^fp:k1:/);
    expect(JSON.stringify(fp)).not.toContain('K-555');
    expect(error.key).toBe('K-555');
  });
});

describe('PrivacyEngine: delivery copies (SD-51)', () => {
  const scopes: PrivacyScopes = {
    'flow:f#t': {
      levels: [
        {
          subject: "flow 'f' step 't'",
          kind: 'step',
          stepKind: 'transform',
          ref: {
            fields: ['ssn'],
            patterns: [{ name: 'test.x', regex: /XSECRET\d{4}/ }],
            reach: Reach.Delivery,
            reachReason: 'partner must not receive SSN',
          },
        },
      ],
    },
  };

  it('SD-51 delivery-reach keeps untouched references and fails instead of truncating', async () => {
    const engine = await PrivacyEngine.compile({ fields: ['**.email'] }, scopes);
    const buffer = Buffer.from('raw');
    const out = engine.forDelivery({ ssn: '123', buffer, email: 'a@b.co' }, 'flow:f#t') as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ ssn: '[HIDDEN:field]', buffer, email: 'a@b.co' });
    expect(out.buffer).toBe(buffer);
    const big = { ssn: '1', note: 'x '.repeat(40 * 1024) };
    expect(() => engine.forDelivery(big, 'flow:f#t')).toThrow(DeliveryCopyError);
    class Dto {
      ssn = '1';
    }
    expect(() => engine.forDelivery({ inner: new Dto() }, 'flow:f#t')).not.toThrow();
    expect(() => engine.forDelivery(new Dto(), 'flow:f#t')).toThrow(DeliveryCopyError);
    expect(engine.stats().deliveryCopyFailed).toBe(2);
    expect(engine.forDelivery({ ssn: '1' }, 'flow:other')).toEqual({ ssn: '1' });
  });
});

describe('privacy errors (4.7)', () => {
  it('SD-37 privacy errors carry the PrivacyError brand, kind, code and retryable', () => {
    const errors = [
      [new PrivacyConfigError(['a']), 'config', undefined, false],
      [new SealKeyUnavailableError('s'), 'seal-key', 'SEAL_KEY_UNAVAILABLE', true],
      [new ReplayUnavailableError('s', 'why'), 'replay', 'REPLAY_UNAVAILABLE', false],
      [new SealBrokenError('s'), 'seal-broken', 'SEAL_BROKEN', false],
      [new DeliveryCopyError('s', 'why'), 'delivery-copy', 'DELIVERY_COPY_FAILED', false],
    ] as const;
    for (const [error, kind, code, retryable] of errors) {
      expect(error).toBeInstanceOf(PrivacyError);
      expect(error).toBeInstanceOf(Error);
      expect(error.kind).toBe(kind);
      expect((error as { code?: string }).code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.name).toBe(error.constructor.name);
    }
    const foreign = Object.assign(Object.create(Error.prototype) as object, {
      [Symbol.for('@estela/nest.PrivacyError')]: true,
      kind: 'seal-broken',
    });
    expect(foreign).toBeInstanceOf(PrivacyError);
    expect(foreign).toBeInstanceOf(SealBrokenError);
    expect(foreign).not.toBeInstanceOf(SealKeyUnavailableError);
    expect({}).not.toBeInstanceOf(PrivacyError);
  });
});
