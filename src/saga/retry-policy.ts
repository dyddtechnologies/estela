import { SagaUsageError, type ConcurrencyErrorKind } from './concurrency-errors';

export type JitterMode = 'full' | 'equal' | 'none';

/**
 * Saga-level retry policy. Only a failed unit of work is re-run: it is atomic, so re-running it
 * is safe. Outbound steps are never retried by this policy.
 */
export interface RetryPolicy<Ctx> {
  /** Kinds that trigger a retry; non-empty, no duplicates. */
  on: readonly ConcurrencyErrorKind[];
  /** TOTAL attempts including the first; integer 1..20. */
  attempts: number;
  /** Integer >= 0; base of the exponential backoff. */
  backoffMs: number;
  /** Integer >= backoffMs; default backoffMs * 32. */
  maxBackoffMs?: number;
  /** Default 'full'. */
  jitter?: JitterMode;
  /** 'clone' (default) or a function that snapshots ctx and returns a restore thunk.
   *  The thunk MUST mutate ctx in place: ctx identity is kept across attempts. */
  checkpoint?: 'clone' | ((ctx: Ctx) => () => void);
}

export const MAX_RETRY_ATTEMPTS = 20;
/** setTimeout fires immediately above int32, so no single backoff may exceed it. */
export const MAX_BACKOFF_MS = 2_147_483_647;
const DEFAULT_MAX_BACKOFF_FACTOR = 32;

/** Backoff before attempt `attempt + 1`, after `attempt` failed (attempt is 1-based). */
export function delayFor(
  policy: Pick<RetryPolicy<unknown>, 'backoffMs' | 'maxBackoffMs' | 'jitter'>,
  attempt: number,
  random: (maxExclusive: number) => number,
): number {
  const cap = Math.min(
    policy.maxBackoffMs ?? policy.backoffMs * DEFAULT_MAX_BACKOFF_FACTOR,
    MAX_BACKOFF_MS,
  );
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

/** Root-realm prototype check, so objects restored by structuredClone (another realm under
 *  some test runners) still count as plain. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

const BUILTINS = new Set(['Date', 'RegExp', 'Map', 'Set']);

/** Name of a cloneable built-in (not a subclass of it), by tag rather than instanceof. */
function builtinOf(value: object): string | undefined {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  return BUILTINS.has(tag) && proto?.constructor?.name === tag ? tag : undefined;
}

function childrenOf(value: object, builtin: string | undefined): [string, unknown][] {
  if (builtin === 'Map') {
    return [...(value as Map<unknown, unknown>).entries()].flatMap(
      ([k, v], i): [string, unknown][] => [
        [`<key ${i}>`, k],
        [`<value ${i}>`, v],
      ],
    );
  }
  if (builtin === 'Set') {
    return [...(value as Set<unknown>).values()].map((v, i) => [`<item ${i}>`, v]);
  }
  return Object.entries(value);
}

const PROVIDE_CHECKPOINT = 'provide retry.checkpoint';

/**
 * structuredClone and the root copy only see own enumerable string-keyed properties. State kept
 * under a symbol key or in a non-enumerable property would be left out of the snapshot silently,
 * so it is rejected instead. An array's own `length` is the one expected exception.
 */
function assertVisibleKeys(value: object, path: string): void {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') {
      throw new SagaUsageError(
        `ctx has a symbol-keyed property at ${path}[${String(key)}] that a clone would drop; ${PROVIDE_CHECKPOINT}`,
      );
    }
    if (Array.isArray(value) && key === 'length') continue;
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new SagaUsageError(
        `ctx has a non-enumerable property at ${path}.${key} that a clone would drop; ${PROVIDE_CHECKPOINT}`,
      );
    }
  }
}

/** Cloneable values that hold no nested ctx values to check. */
function isLeafBuiltin(value: object, builtin: string | undefined): boolean {
  return builtin === 'Date' || builtin === 'RegExp' || ArrayBuffer.isView(value);
}

function isPrimitive(value: unknown): boolean {
  return (
    value === null || ['string', 'number', 'boolean', 'bigint', 'undefined'].includes(typeof value)
  );
}

/** Nested values must be structured-cloneable WITHOUT losing a prototype. */
function assertPlainValue(value: unknown, path: string, seen: Set<object>): void {
  if (isPrimitive(value)) return;
  if (typeof value !== 'object' || value === null) {
    throw new SagaUsageError(`ctx is not cloneable at ${path}; ${PROVIDE_CHECKPOINT}`);
  }
  if (seen.has(value)) return;
  seen.add(value);
  const builtin = builtinOf(value);
  if (isLeafBuiltin(value, builtin)) return;
  if (builtin === undefined && !Array.isArray(value) && !isPlainObject(value)) {
    throw new SagaUsageError(`ctx is not cloneable at ${path}; ${PROVIDE_CHECKPOINT}`);
  }
  if (builtin === undefined) assertVisibleKeys(value, path);
  for (const [name, child] of childrenOf(value, builtin)) {
    assertPlainValue(child, `${path}.${name}`, seen);
  }
}

/**
 * The root may be any object (it keeps its identity and prototype); its fields are checked. A
 * class instance that keeps state in `#private` fields cannot be inspected and needs a custom
 * checkpoint.
 */
function assertPlainGraph(ctx: object): void {
  assertVisibleKeys(ctx, 'ctx');
  const seen = new Set<object>([ctx]);
  for (const [name, child] of Object.entries(ctx)) assertPlainValue(child, `ctx.${name}`, seen);
}

/**
 * Path of the first value under a frozen root that a step could still mutate, or undefined when
 * the whole graph is immutable. Object.freeze is shallow, and Date, Map, Set and typed arrays keep
 * mutable internal state even when frozen.
 */
function mutablePathOf(value: unknown, path: string, seen: Set<object>): string | undefined {
  if (typeof value !== 'object' || value === null || seen.has(value)) return undefined;
  seen.add(value);
  if (!Object.isFrozen(value) || builtinOf(value) !== undefined || ArrayBuffer.isView(value)) {
    return path;
  }
  for (const [name, child] of Object.entries(value)) {
    const found = mutablePathOf(child, `${path}.${name}`, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

function cloneCheckpoint<Ctx>(ctx: Ctx): () => void {
  if (typeof ctx !== 'object' || !ctx) return () => undefined;
  assertPlainGraph(ctx);
  if (Object.isFrozen(ctx)) {
    const seen = new Set<object>([ctx]);
    for (const [name, child] of Object.entries(ctx)) {
      const mutable = mutablePathOf(child, `ctx.${name}`, seen);
      if (mutable !== undefined) {
        throw new SagaUsageError(
          `ctx is frozen but ${mutable} is mutable, so it cannot be restored in place; ${PROVIDE_CHECKPOINT}`,
        );
      }
    }
    return () => undefined;
  }
  const target = ctx as Record<string, unknown>;
  const snapshot = structuredClone({ ...target });
  return () => {
    const fresh = structuredClone(snapshot);
    for (const key of Object.keys(target)) {
      if (!Object.hasOwn(fresh, key)) Reflect.deleteProperty(target, key);
    }
    Object.assign(target, fresh);
  };
}

/** Snapshots ctx before attempt 1 and returns the thunk that restores it before a retry. */
export function checkpointOf<Ctx>(policy: RetryPolicy<Ctx>, ctx: Ctx): () => void {
  const checkpoint = policy.checkpoint ?? 'clone';
  return checkpoint === 'clone' ? cloneCheckpoint(ctx) : checkpoint(ctx);
}
