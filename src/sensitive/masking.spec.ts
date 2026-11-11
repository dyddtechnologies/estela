import { Show } from './privacy.types';
import { hmacFingerprinter, OMIT, showEnds, showValue, type ShowSpec } from './masking';
import { createHmac } from 'node:crypto';

const spec = (show: Show, extra: Partial<ShowSpec> = {}): ShowSpec => ({
  show,
  showFirst: 0,
  showLast: 4,
  text: '',
  ...extra,
});

describe('how a value is shown (6.3)', () => {
  const secret = Buffer.alloc(32, 7);
  const fp = hmacFingerprinter('k1', secret, 16);

  it('SD-14 show values: one case per Show member', () => {
    expect(showValue('abc', spec(Show.Hidden), 'r', fp)).toBe('[HIDDEN:r]');
    expect(showValue({ a: 1 }, spec(Show.Hidden), 'r', fp)).toBe('[HIDDEN:r]');
    expect(showValue('abc', spec(Show.Omitted), 'r', fp)).toBe(OMIT);
    expect(showValue('+50212345427', spec(Show.Ends, { showFirst: 4, showLast: 2 }), 'r', fp)).toBe(
      '+502***27',
    );
    expect(showValue('hello', spec(Show.Length), 'r', fp)).toBe('[HIDDEN:r len=5]');
    expect(showValue([1, 2, 3], spec(Show.Length), 'r', fp)).toBe('[HIDDEN:r len=3]');
    expect(showValue({ a: 1, b: 2 }, spec(Show.Length), 'r', fp)).toBe('[HIDDEN:r len=2]');
    expect(showValue('x', spec(Show.Text, { text: 'redacted' }), 'r', fp)).toBe('redacted');
    expect(showValue('v', spec(Show.Fingerprint), 'r', fp)).toMatch(/^fp:k1:[0-9a-f]{16}$/);
    expect(showValue(12345678, spec(Show.Fingerprint), 'r', fp)).toBe(
      showValue('12345678', spec(Show.Fingerprint), 'r', fp),
    );
    expect(showValue({ a: 1 }, spec(Show.Fingerprint), 'r', fp)).toBe('[HIDDEN:r]');
    expect(showValue('v', spec(Show.Hidden), undefined, fp)).toBe('[HIDDEN]');
  });

  it('SD-14 Show.Ends never reveals more than half and hides short values', () => {
    expect(showValue('123456', spec(Show.Ends), 'r', fp)).toBe('[HIDDEN:r]');
    expect(showValue({ pan: '4111111111111111' }, spec(Show.Ends), 'r', fp)).toBe('[HIDDEN:r]');
    expect(showEnds('4111111111111111', 0, 4)).toBe('***1111');
    expect(showEnds('12345678', 4, 4)).toBe('12***78');
    for (let length = 8; length < 30; length++) {
      const value = 'x'.repeat(length);
      const shown = showEnds(value, 10, 10)!;
      expect(shown.replace('***', '').length).toBeLessThanOrEqual(Math.floor(length / 2));
    }
  });

  it('SD-15 fingerprint token is a keyed HMAC with the secret id', () => {
    const expected = createHmac('sha256', secret).update('+50212345678', 'utf8').digest('hex');
    expect(fp.fingerprint('+50212345678')).toBe(`fp:k1:${expected.slice(0, 16)}`);
    expect(hmacFingerprinter('k1', secret, 64).fingerprint('a')).toHaveLength('fp:k1:'.length + 64);
    expect(hmacFingerprinter('k1', Buffer.alloc(32, 8), 16).fingerprint('a')).not.toBe(
      fp.fingerprint('a'),
    );
  });
});
