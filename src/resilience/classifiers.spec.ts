import {
  OutboundHttpError,
  OutboundNetworkError,
  OutboundTimeoutError,
} from '../outbound/outbound.errors';
import {
  defaultGrpcClassifier,
  defaultInProcessClassifier,
  defaultRestClassifier,
  fromBooleanClassifier,
  parseRetryAfter,
} from './classifiers';
import {
  BulkheadFullError,
  CircuitOpenError,
  DeadlineExceededError,
  RateLimitedError,
} from './resilience.errors';
import { parseRetryBudget, parseRetryBudgetValue } from './retry-budget';

const info = { binding: 'b', url: 'https://x/y?token=1', method: 'POST', attempts: 1 };
const http = (status: number, headers: Record<string, string> = {}) =>
  new OutboundHttpError(info, status, '', headers, null);

describe('classifiers', () => {
  it('RU-14 maps REST failures per the default table', () => {
    const rows: [unknown, string, number?][] = [
      [new OutboundNetworkError(info, new Error('refused')), 'transient'],
      [new OutboundTimeoutError(info, 10), 'transient'],
      [http(408, { 'retry-after': '1' }), 'transient', 1000],
      [http(425), 'transient'],
      [http(429, { 'retry-after': '2' }), 'throttled', 2000],
      [http(500), 'transient'],
      [http(502), 'transient'],
      [http(503, { 'retry-after': '3' }), 'transient', 3000],
      [http(504), 'transient'],
      [http(501), 'rejected'],
      [http(505), 'rejected'],
      [http(511), 'rejected'],
      [http(599), 'transient'],
      [http(400), 'rejected'],
      [http(404), 'rejected'],
      [http(302), 'rejected'],
      [new Error('mapper'), 'unknown'],
    ];
    for (const [error, cls, retryAfterMs] of rows) {
      const expected = retryAfterMs === undefined ? { class: cls } : { class: cls, retryAfterMs };
      expect(defaultRestClassifier(error)).toEqual(expected);
    }
  });

  it('RU-11c ignores invalid Retry-After values', () => {
    const now = Date.parse('2026-11-09T10:00:00Z');
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('Mon, 09 Nov 2026 10:00:05 GMT', now)).toBe(5000);
    for (const bad of ['soon', '-1', '1.5', '', undefined])
      expect(parseRetryAfter(bad, now)).toBeUndefined();
    expect(defaultRestClassifier(http(429, { 'retry-after': 'soon' }))).toEqual({
      class: 'throttled',
    });
  });

  it('RU-15 maps every gRPC status code per the default table', () => {
    const expected: Record<number, string> = {
      1: 'unknown',
      2: 'unknown',
      3: 'rejected',
      4: 'transient',
      5: 'rejected',
      6: 'rejected',
      7: 'rejected',
      8: 'throttled',
      9: 'rejected',
      10: 'rejected',
      11: 'rejected',
      12: 'rejected',
      13: 'unknown',
      14: 'transient',
      15: 'unknown',
      16: 'rejected',
    };
    for (const [code, cls] of Object.entries(expected))
      expect(defaultGrpcClassifier(Number(code)).class).toBe(cls);
    expect(defaultGrpcClassifier(8, '250')).toEqual({ class: 'throttled', retryAfterMs: 250 });
    expect(defaultGrpcClassifier(8, '-1')).toEqual({ class: 'rejected' });
    expect(defaultGrpcClassifier(8, 'x')).toEqual({ class: 'rejected' });
  });

  it('RU-16b default classifiers never return quota', () => {
    for (let status = 100; status < 600; status += 1)
      expect(defaultRestClassifier(http(status)).class).not.toBe('quota');
    for (let code = 0; code < 17; code += 1)
      expect(defaultGrpcClassifier(code, '5').class).not.toBe('quota');
    expect(defaultInProcessClassifier({ reason: 'quota' }).class).not.toBe('quota');
  });

  it('RU-17a in-process classifier maps outbound, retryable and inner resilience errors per the table', () => {
    const meta = { binding: 'x' };
    expect(defaultInProcessClassifier(http(503))).toEqual({ class: 'transient' });
    expect(defaultInProcessClassifier({ retryable: true })).toEqual({ class: 'transient' });
    expect(defaultInProcessClassifier({ retryable: false })).toEqual({ class: 'rejected' });
    expect(defaultInProcessClassifier(new RateLimitedError({ ...meta, retryAfterMs: 40 }))).toEqual(
      { class: 'throttled', retryAfterMs: 40 },
    );
    expect(defaultInProcessClassifier(new BulkheadFullError({ ...meta, reason: 'full' }))).toEqual({
      class: 'throttled',
    });
    expect(defaultInProcessClassifier(new CircuitOpenError(meta))).toEqual({ class: 'rejected' });
    expect(
      defaultInProcessClassifier(new DeadlineExceededError({ ...meta, deadlineMs: 1 })),
    ).toEqual({ class: 'rejected' });
    expect(defaultInProcessClassifier(new Error('?'))).toEqual({ class: 'unknown' });
  });

  it('maps a boolean legacy classifier to transient or rejected', () => {
    expect(fromBooleanClassifier(() => true)(1, undefined as never)).toBe('transient');
    expect(fromBooleanClassifier(() => false)(1, undefined as never)).toBe('rejected');
  });

  it('RU-31 treats invalid budgets as absent and caps at 20', () => {
    expect(parseRetryBudgetValue('abc')).toEqual({ invalid: true });
    for (const bad of ['-1', '1.5', '', -1, 1.5]) expect(parseRetryBudget(bad)).toBeUndefined();
    expect(parseRetryBudget('999')).toBe(20);
    expect(parseRetryBudget('2')).toBe(2);
    expect(parseRetryBudget(0)).toBe(0);
    expect(parseRetryBudgetValue(undefined)).toEqual({ invalid: false });
  });
});
