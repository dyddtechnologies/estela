import { delayFor, MAX_BACKOFF_MS } from './retry-policy';

const noRandom = (): number => 0;

describe('delayFor caps', () => {
  it('stops growing at 32 x backoffMs when maxBackoffMs is omitted', () => {
    const delays = Array.from({ length: 10 }, (_, i) =>
      delayFor({ backoffMs: 10, jitter: 'none' }, i + 1, noRandom),
    );
    expect(delays).toEqual([10, 20, 40, 80, 160, 320, 320, 320, 320, 320]);
  });

  it('gives the default cap to the jitter as its upper bound', () => {
    const bounds: number[] = [];
    delayFor({ backoffMs: 100 }, 19, (max) => {
      bounds.push(max);
      return 0;
    });
    expect(bounds).toEqual([3_201]);
  });

  it.each([
    ['none', undefined],
    ['full', undefined],
    ['equal', undefined],
    ['none', MAX_BACKOFF_MS],
  ] as const)(
    'never exceeds the setTimeout limit (jitter %s, maxBackoffMs %p)',
    (jitter, maxBackoffMs) => {
      const policy = {
        backoffMs: MAX_BACKOFF_MS,
        jitter,
        ...(maxBackoffMs === undefined ? {} : { maxBackoffMs }),
      };
      const top = (max: number): number => max - 1;
      for (const attempt of [1, 2, 19, 20]) {
        expect(delayFor(policy, attempt, top)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      }
      expect(delayFor({ ...policy, jitter: 'none' }, 20, top)).toBe(MAX_BACKOFF_MS);
    },
  );
});
