import { SagaUsageError } from './concurrency-errors';
import { canonicalLocks, compareCodeUnits, type LockRequest } from './lock-port';
import { saga } from './saga';
import { resolveLocks, segmentsOf } from './segments';

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

describe('canonicalLocks (U2)', () => {
  const requests: LockRequest[] = [
    { namespace: 'user', key: 'u2', mode: 'shared' },
    { namespace: 'flow', key: 'f1', mode: 'shared', timeoutMs: 500 },
    { namespace: 'user', key: 'u1', mode: 'exclusive' },
    { namespace: 'flow', key: 'f1', mode: 'exclusive', timeoutMs: 200 },
    { namespace: 'flow', key: 'f10', mode: 'shared' },
    { namespace: 'flow', key: 'F1', mode: 'shared' },
    { namespace: 'user', key: 'u2', mode: 'shared', timeoutMs: 900 },
  ];

  it('is the same for 200 random permutations of the input', () => {
    const expected = canonicalLocks(requests);
    for (let seed = 1; seed <= 200; seed += 1) {
      expect(canonicalLocks(shuffle(requests, seed))).toEqual(expected);
    }
    expect(expected).toEqual([
      { namespace: 'flow', key: 'F1', mode: 'shared' },
      { namespace: 'flow', key: 'f1', mode: 'exclusive', timeoutMs: 200 },
      { namespace: 'flow', key: 'f10', mode: 'shared' },
      { namespace: 'user', key: 'u1', mode: 'exclusive' },
      { namespace: 'user', key: 'u2', mode: 'shared', timeoutMs: 900 },
    ]);
  });

  it('lets exclusive beat shared and the smallest timeout win', () => {
    expect(
      canonicalLocks([
        { namespace: 'n', key: 'k', mode: 'shared', timeoutMs: 10 },
        { namespace: 'n', key: 'k', mode: 'exclusive' },
        { namespace: 'n', key: 'k', mode: 'shared', timeoutMs: 30 },
      ]),
    ).toEqual([{ namespace: 'n', key: 'k', mode: 'exclusive', timeoutMs: 10 }]);
  });

  it('sorts non-ASCII keys by UTF-16 code units, never by locale', () => {
    const keys = ['é', 'z', 'e', '😀', 'ｚ', 'Z'];
    const sorted = canonicalLocks(
      keys.map((key) => ({ namespace: 'n', key, mode: 'shared' as const })),
    ).map((r) => r.key);
    expect(sorted).toEqual(['Z', 'e', 'z', 'é', '😀', 'ｚ']);
    expect(compareCodeUnits('a', 'a')).toBe(0);
  });

  it('keeps namespace and key apart when building the identity', () => {
    const out = canonicalLocks([
      { namespace: 'a:b', key: 'c', mode: 'shared' },
      { namespace: 'a', key: 'b:c', mode: 'shared' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('resolveLocks (U2)', () => {
  interface C {
    one?: string;
    many?: string[];
  }
  const segment = (optional = false) => {
    const definition = saga<C>('s')
      .lock('one', (c) => c.one, 'exclusive', { optional })
      .lock('many', (c) => c.many, 'shared', { optional, timeoutMs: 40 })
      .transaction('t', () => undefined)
      .reply((c) => c);
    const first = segmentsOf(definition.steps)[0];
    if (first?.kind !== 'transaction') throw new Error('expected a transaction segment');
    return first.locks;
  };

  it('expands array keys and canonicalizes the result', () => {
    expect(resolveLocks('s', segment(), { one: 'x', many: ['b', 'a', 'b'] })).toEqual([
      { namespace: 'many', key: 'a', mode: 'shared', timeoutMs: 40 },
      { namespace: 'many', key: 'b', mode: 'shared', timeoutMs: 40 },
      { namespace: 'one', key: 'x', mode: 'exclusive' },
    ]);
  });

  it('throws on undefined unless optional, and always on an empty string', () => {
    expect(() => resolveLocks('s', segment(), { many: ['a'] })).toThrow(SagaUsageError);
    expect(() => resolveLocks('s', segment(), { one: 'x', many: [] })).toThrow(SagaUsageError);
    expect(resolveLocks('s', segment(true), {})).toEqual([]);
    expect(() => resolveLocks('s', segment(true), { one: '' })).toThrow(SagaUsageError);
    expect(() => resolveLocks('s', segment(), { one: 'x', many: [''] })).toThrow(SagaUsageError);
  });
});
