/* eslint-disable sonarjs/super-linear-regex, sonarjs/duplicates-in-character-class, sonarjs/single-character-alternation, security/detect-unsafe-regex -- every pattern here is a fixture for the analysis */
import { analyzeRegex, re2SyntaxProblem } from './regex-safety';
import { nativeRegexEngine } from './regex-engine';

describe('regex safety analysis (6.5)', () => {
  it('SD-19 regex safety rejects catastrophic and zero-length patterns', () => {
    const cases: [RegExp, string][] = [
      [/(a+)+/, 'nested unbounded quantifiers'],
      [/(\w+\s?)*/, 'nested unbounded quantifiers'],
      [/(a|ab)*/, 'quantified alternation with overlapping branches'],
      [/\d+\d+/, 'adjacent unbounded quantifiers over overlapping sets'],
      [/\s*\s*x/, 'adjacent unbounded quantifiers over overlapping sets'],
      [/\d+\s?\d+/, 'adjacent unbounded quantifiers over overlapping sets'],
      [/(\w+)\1/, 'backreference'],
      [/(?<n>x)\k<n>/, 'backreference'],
      [/x/y, 'sticky flag'],
      [/a*/, 'can match an empty string'],
      [/\b/, 'can match an empty string'],
      [/(?=x)/, 'can match an empty string'],
      [/^$/, 'can match an empty string'],
      [/(a|b?)/, 'can match an empty string'],
    ];
    for (const [regex, reason] of cases) {
      expect([regex.source, analyzeRegex(regex)]).toEqual([regex.source, reason]);
    }
  });

  it('SD-19 accepts linear patterns', () => {
    for (const regex of [
      /AKIA[0-9A-Z]{16}/,
      /\+[1-9]\d{7,14}/,
      /\bbearer\s+([A-Za-z0-9._~+/=-]+)/i,
      /(a|b)*c/,
      /[^\]\\]+x/,
      /\d{2,}-\w+/,
      /\u{1F600}+/u,
      /\x41\cJ\p{L}/u,
    ]) {
      expect([regex.source, analyzeRegex(regex)]).toEqual([regex.source, undefined]);
    }
  });

  it('SD-19 reports a syntax problem without echoing the pattern', () => {
    expect(analyzeRegex({ source: '(ab', flags: '' })).toBe('syntax: unterminated group');
    expect(analyzeRegex({ source: '[ab', flags: '' })).toBe('syntax: unterminated class');
    expect(analyzeRegex({ source: 'a)', flags: '' })).toBe('syntax: unbalanced parenthesis');
    expect(analyzeRegex({ source: '*a', flags: '' })).toBe('syntax: nothing to repeat');
  });

  it('SD-13 the RE2 checker refuses lookaround and backreferences only', () => {
    expect(re2SyntaxProblem(/(?<=a)b/)).toBe('lookaround');
    expect(re2SyntaxProblem(/a(?!b)/)).toBe('lookaround');
    expect(re2SyntaxProblem(/(a)\1/)).toBe('backreference');
    expect(re2SyntaxProblem(/(?<name>a)b+/)).toBeUndefined();
    expect(re2SyntaxProblem({ source: '(', flags: '' })).toBe('syntax');
  });

  it('native engine replaces every match and reports group spans', () => {
    const pattern = nativeRegexEngine.compile('k=(\\w+)', 'i');
    const seen: unknown[] = [];
    const out = pattern.replaceAll('K=ab, k=cd', (match, groups, offset, spans) => {
      seen.push([match, groups, offset, spans]);
      return 'x';
    });
    expect(out).toBe('x, x');
    expect(seen).toEqual([
      ['K=ab', ['ab'], 0, [[2, 4]]],
      ['k=cd', ['cd'], 6, [[2, 4]]],
    ]);
    expect(nativeRegexEngine.compile('a', '').replaceAll('aa', () => 'b')).toBe('bb');
  });
});
