import { SagaDefinitionError, type ConcurrencyErrorKind } from './concurrency-errors';
import { isLockTimeoutMs } from './lock-port';
import { MAX_BACKOFF_MS, MAX_RETRY_ATTEMPTS, type RetryPolicy } from './retry-policy';

const KINDS: readonly ConcurrencyErrorKind[] = [
  'lock-timeout',
  'deadlock',
  'serialization',
  'stale-state',
];
const JITTERS = ['full', 'equal', 'none'];
const MODES = ['shared', 'exclusive'];
const MAX_NAMESPACE_LENGTH = 200;

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function validateKinds(saga: string, on: unknown): readonly ConcurrencyErrorKind[] {
  if (!Array.isArray(on) || on.length === 0) {
    throw new SagaDefinitionError(`retry of saga "${saga}": "on" must list at least one kind`);
  }
  const kinds = on as unknown[];
  for (const kind of kinds) {
    if (!KINDS.includes(kind as ConcurrencyErrorKind)) {
      throw new SagaDefinitionError(`retry of saga "${saga}": unknown kind ${String(kind)}`);
    }
  }
  if (new Set(kinds).size !== kinds.length) {
    throw new SagaDefinitionError(`retry of saga "${saga}": "on" has duplicate kinds`);
  }
  return Object.freeze([...(kinds as ConcurrencyErrorKind[])]);
}

function validateBackoff<Ctx>(saga: string, policy: RetryPolicy<Ctx>): void {
  if (!isIntegerIn(policy.attempts, 1, MAX_RETRY_ATTEMPTS)) {
    throw new SagaDefinitionError(
      `retry of saga "${saga}": attempts must be an integer 1..${MAX_RETRY_ATTEMPTS}`,
    );
  }
  if (!isIntegerIn(policy.backoffMs, 0, MAX_BACKOFF_MS)) {
    throw new SagaDefinitionError(`retry of saga "${saga}": backoffMs must be an integer >= 0`);
  }
  const max = policy.maxBackoffMs;
  if (max !== undefined && !isIntegerIn(max, policy.backoffMs, MAX_BACKOFF_MS)) {
    throw new SagaDefinitionError(
      `retry of saga "${saga}": maxBackoffMs must be an integer >= backoffMs`,
    );
  }
  if (policy.jitter !== undefined && !JITTERS.includes(policy.jitter)) {
    throw new SagaDefinitionError(`retry of saga "${saga}": unknown jitter ${policy.jitter}`);
  }
  const checkpoint = policy.checkpoint;
  if (checkpoint !== undefined && checkpoint !== 'clone' && typeof checkpoint !== 'function') {
    throw new SagaDefinitionError(
      `retry of saga "${saga}": checkpoint must be 'clone' or a function`,
    );
  }
}

/** Validates a retry policy eagerly and returns a frozen copy. */
export function validateRetryPolicy<Ctx>(
  saga: string,
  policy: RetryPolicy<Ctx>,
): Readonly<RetryPolicy<Ctx>> {
  const on = validateKinds(saga, policy.on);
  validateBackoff(saga, policy);
  return Object.freeze({ ...policy, on });
}

/** Validates the static part of a lock declaration (the key is resolved at run time). */
export function validateLockDeclaration(
  saga: string,
  namespace: unknown,
  keyOf: unknown,
  mode: unknown,
  timeoutMs: unknown,
): void {
  if (typeof namespace !== 'string' || namespace === '') {
    throw new SagaDefinitionError(`lock in saga "${saga}" needs a non-empty namespace`);
  }
  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    throw new SagaDefinitionError(
      `lock "${namespace.slice(0, 40)}..." in saga "${saga}" exceeds ${MAX_NAMESPACE_LENGTH} chars`,
    );
  }
  if (typeof keyOf !== 'function') {
    throw new SagaDefinitionError(`lock "${namespace}" in saga "${saga}" needs a keyOf function`);
  }
  if (!MODES.includes(mode as string)) {
    throw new SagaDefinitionError(
      `lock "${namespace}" in saga "${saga}" needs mode 'shared' or 'exclusive'`,
    );
  }
  if (timeoutMs !== undefined && !isLockTimeoutMs(timeoutMs)) {
    throw new SagaDefinitionError(
      `lock "${namespace}" in saga "${saga}": timeoutMs must be an integer 1..2147483647`,
    );
  }
}
