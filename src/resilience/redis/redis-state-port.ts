import type { ResilienceStatePort } from '../resilience.types';
import {
  CLEAR_OPEN_SCRIPT,
  MARK_OPEN_SCRIPT,
  OPEN_UNTIL_SCRIPT,
  PROBE_LEASE_SCRIPT,
  TAKE_TOKEN_SCRIPT,
} from './scripts';

/** Script runner from the app (ioredis / node-redis snippets in the README). */
export type RedisEvalFn = (
  script: string,
  keys: readonly string[],
  args: readonly string[],
) => Promise<unknown>;

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Reference `ResilienceStatePort` over Redis (RS-23). It imports no Redis client: the app passes a
 * function that evaluates a Lua script. Buckets refill on Redis server time.
 */
export function redisResilienceStatePort(
  evalScript: RedisEvalFn,
  options: { prefix?: string } = {},
): ResilienceStatePort {
  const prefix = options.prefix ?? '';
  const key = (name: string): string => `${prefix}${name}`;
  return {
    async takeToken(name, limitPerSec, burst) {
      const answer = await evalScript(
        TAKE_TOKEN_SCRIPT,
        [key(name)],
        [String(limitPerSec), String(burst)],
      );
      const [granted, wait] = Array.isArray(answer) ? (answer as unknown[]) : [];
      return { granted: toNumber(granted) === 1, retryAfterMs: toNumber(wait) ?? 0 };
    },
    async markOpen(name, untilMs) {
      await evalScript(MARK_OPEN_SCRIPT, [key(name)], [String(untilMs), String(Date.now())]);
    },
    async openUntil(name) {
      return toNumber(await evalScript(OPEN_UNTIL_SCRIPT, [key(name)], []));
    },
    async tryProbeLease(name, leaseMs) {
      return (
        toNumber(
          await evalScript(PROBE_LEASE_SCRIPT, [key(`${name}:lease`)], [String(leaseMs)]),
        ) === 1
      );
    },
    async clearOpen(name) {
      await evalScript(CLEAR_OPEN_SCRIPT, [key(name), key(`${name}:lease`)], []);
    },
  };
}
