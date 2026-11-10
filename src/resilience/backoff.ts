/** Random spread of an exponential delay; the 0.9.0 saga `RetryPolicy.jitter` values. */
export type JitterMode = 'full' | 'equal' | 'none';

/** Upper bound of total attempts, shared by the saga retry policy and resilience retries. */
export const MAX_RETRY_ATTEMPTS = 20;
/** setTimeout fires immediately above int32, so no single backoff may exceed it. */
export const MAX_BACKOFF_MS = 2_147_483_647;
const DEFAULT_MAX_BACKOFF_FACTOR = 32;

export interface BackoffSettings {
  initialMs: number;
  factor: number;
  maxMs: number;
  jitter: JitterMode;
}

/**
 * Delay before attempt `attempt + 1`, after `attempt` failed (1-based): `initialMs * factor^(n-1)`
 * capped at `maxMs`, then jittered. Full and equal jitter draw from `random`, which must return an
 * integer in `0..maxExclusive-1`.
 */
export function backoffDelay(
  policy: BackoffSettings,
  attempt: number,
  random: (maxExclusive: number) => number,
): number {
  const cap = Math.min(policy.maxMs, MAX_BACKOFF_MS);
  const d = Math.min(cap, policy.initialMs * policy.factor ** (attempt - 1));
  switch (policy.jitter) {
    case 'full':
      return random(Math.floor(d) + 1);
    case 'equal':
      return Math.floor(d / 2) + random(Math.ceil(d / 2) + 1);
    default:
      return d;
  }
}

/** Saga backoff: factor 2 and a default cap of `backoffMs * 32`. Output unchanged since 0.9.0. */
export function delayFor(
  policy: { backoffMs: number; maxBackoffMs?: number; jitter?: JitterMode },
  attempt: number,
  random: (maxExclusive: number) => number,
): number {
  return backoffDelay(
    {
      initialMs: policy.backoffMs,
      factor: 2,
      maxMs: policy.maxBackoffMs ?? policy.backoffMs * DEFAULT_MAX_BACKOFF_FACTOR,
      jitter: policy.jitter ?? 'full',
    },
    attempt,
    random,
  );
}
