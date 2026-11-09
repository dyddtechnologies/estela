import { backoffDelay, delayFor } from './backoff';

/** delayFor as shipped in 0.9.0 (saga/retry-policy.ts), kept here as the reference. */
function delayFor090(
  policy: { backoffMs: number; maxBackoffMs?: number; jitter?: 'full' | 'equal' | 'none' },
  attempt: number,
  random: (max: number) => number,
): number {
  const cap = Math.min(policy.maxBackoffMs ?? policy.backoffMs * 32, 2_147_483_647);
  const d = Math.min(cap, policy.backoffMs * 2 ** (attempt - 1));
  switch (policy.jitter ?? 'full') {
    case 'full':
      return random(d + 1);
    case 'equal':
      return Math.floor(d / 2) + random(Math.ceil(d / 2) + 1);
    default:
      return d;
  }
}

describe('backoff', () => {
  it('RU-10 computes exponential backoff with full jitter from the injected random', () => {
    const base = { initialMs: 200, factor: 2, maxMs: 10_000 };
    expect(backoffDelay({ ...base, jitter: 'full' }, 1, () => 0)).toBe(0);
    expect([1, 2].map((n) => backoffDelay({ ...base, jitter: 'none' }, n, () => 0))).toEqual([
      200, 400,
    ]);
    expect(
      [1, 2].map((n) => backoffDelay({ ...base, factor: 3, jitter: 'none' }, n, () => 0)),
    ).toEqual([200, 600]);
    expect(backoffDelay({ ...base, jitter: 'none' }, 20, () => 0)).toBe(10_000);
    const randoms = [(max: number) => max - 1, () => 0, (max: number) => Math.floor(max / 3)];
    for (const jitter of ['full', 'equal', 'none'] as const) {
      for (const random of randoms) {
        for (let attempt = 1; attempt <= 12; attempt += 1) {
          for (const policy of [
            { backoffMs: 20, jitter },
            { backoffMs: 5, maxBackoffMs: 70, jitter },
            { backoffMs: 0, jitter },
          ]) {
            expect(delayFor(policy, attempt, random)).toBe(delayFor090(policy, attempt, random));
          }
        }
      }
    }
  });
});
