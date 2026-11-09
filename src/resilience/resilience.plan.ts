import { backoffDelay, MAX_BACKOFF_MS, MAX_RETRY_ATTEMPTS, type JitterMode } from './backoff';
import { ResilienceDefinitionError } from './resilience.errors';
import type {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  FailureClass,
  FallbackPolicy,
  FallbackTrigger,
  RateLimitPolicy,
  ResilienceClassifierFn,
  ResilienceContext,
  ResilienceEdgeKind,
  ResilienceKeyFn,
  ResiliencePolicy,
  ResiliencePolicyRef,
  ResilienceStatePort,
  RetryPolicyOptions,
  TimeoutPolicy,
} from './resilience.types';

type MaybePromise<T> = T | Promise<T>;

/**
 * Marks options built by a legacy alias (outbound REST `retry` / `timeoutMs`, section 1). The
 * primitive then keeps the 0.9.0 semantics and validation instead of the rules of section 5.6.
 */
export const LEGACY_ALIAS = Symbol('estela.resilience.legacy');

export interface LegacyRetryMark {
  /** 0.9.0 boolean classifier (possibly async), called only when attempts are left. */
  retryOn: (error: unknown, ctx: ResilienceContext) => MaybePromise<boolean>;
  /** 0.9.0 backoff, clamped to >= 0. */
  backoff: (attempt: number, error: unknown) => number;
}

export type LegacyRetryOptions = RetryPolicyOptions & { [LEGACY_ALIAS]?: LegacyRetryMark };
export type LegacyTimeoutPolicy = TimeoutPolicy & { [LEGACY_ALIAS]?: true };

export interface RetryPlan {
  maxAttempts: number;
  /** Delay before the next attempt; `random` is injected by the executor. */
  delay(attempt: number, error: unknown, random: (maxExclusive: number) => number): number;
  retryOn: ReadonlySet<FailureClass>;
  honorRetryAfter: boolean;
  maxRetryAfterMs: number;
  idempotent: boolean;
  propagate: 'claim' | 'forward';
  requireIdempotencyKey: boolean;
  /** Present when the effective retry is the 0.9.0 alias: no budget, boolean classifier. */
  legacy?: LegacyRetryMark;
}

export interface BreakerPlan {
  key?: ResilienceKeyFn;
  failureRateThreshold: number;
  minimumCalls: number;
  window: { type: 'count'; size: number } | { type: 'time'; sizeMs: number };
  openMs: number;
  halfOpenCalls: number;
  recordOn: ReadonlySet<FailureClass>;
  quotaOpenMs: number | 'manual';
  maxKeys: number;
  state?: ResilienceStatePort;
  syncMs: number;
}

export interface BulkheadPlan {
  maxConcurrent: number;
  maxQueue: number;
  queueTimeoutMs?: number;
}

export interface RateLimitPlan {
  limitPerSec: number;
  burst: number;
  key?: ResilienceKeyFn;
  maxWaitMs: number;
  state?: ResilienceStatePort;
  degradedLimitPerSec: number;
  degradedBurst: number;
  maxKeys: number;
  replicasHint: number;
}

export interface FallbackPlan {
  value?: (error: unknown, ctx: ResilienceContext) => unknown;
  channel?: string;
  on: ReadonlySet<FallbackTrigger>;
  cacheable: boolean;
}

/** Every primitive validated and defaulted; frozen. */
export interface ResiliencePlan {
  readonly binding: string;
  readonly edge: ResilienceEdgeKind;
  readonly classify: readonly ResilienceClassifierFn[];
  /** 0 = no per-attempt timeout. */
  readonly perAttemptMs: number;
  /** True when a layer configured the per-attempt timeout (shown in the graph summary). */
  readonly timeoutExplicit: boolean;
  readonly deadlineMs?: number;
  readonly retry?: RetryPlan;
  readonly circuitBreaker?: BreakerPlan;
  readonly bulkhead?: BulkheadPlan;
  readonly rateLimit?: RateLimitPlan;
  readonly fallback?: FallbackPlan;
  /** No primitive at all: the executor runs the call once, directly (RS-01). */
  readonly empty: boolean;
  /** Boot warnings that are not errors (section 5.6). */
  readonly warnings: readonly string[];
}

export type PrimitiveName =
  'timeout' | 'retry' | 'circuitBreaker' | 'bulkhead' | 'rateLimit' | 'fallback';

export const PRIMITIVES: readonly PrimitiveName[] = [
  'timeout',
  'retry',
  'circuitBreaker',
  'bulkhead',
  'rateLimit',
  'fallback',
];

export interface ResolvePlanOptions {
  /** Primitives allowed on this edge (section 5.5); default all. */
  allowed?: readonly PrimitiveName[];
  /** Named policies (RS-51). */
  policies?: Readonly<Record<string, ResiliencePolicy>>;
  /** Per-attempt timeout when no layer sets one (REST: 30000, jump: 10000). Not shown. */
  defaultPerAttemptMs?: number;
}

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'transient',
  'throttled',
  'rejected',
  'quota',
  'unknown',
];
const TRIGGERS: readonly FallbackTrigger[] = [
  ...FAILURE_CLASSES,
  'circuit-open',
  'bulkhead-full',
  'rate-limited',
  'deadline',
];
const DEFAULT_FALLBACK_ON: readonly FallbackTrigger[] = [
  'transient',
  'throttled',
  'circuit-open',
  'bulkhead-full',
  'rate-limited',
  'deadline',
];
const JITTERS: readonly JitterMode[] = ['full', 'equal', 'none'];
const STATE_METHODS = ['takeToken', 'markOpen', 'openUntil', 'tryProbeLease', 'clearOpen'];
const DEFAULT_BACKOFF = { initialMs: 200, factor: 2, maxMs: 10_000, jitter: 'full' as JitterMode };

// ---------- Layering ----------

type Layerable = Record<string, unknown> & { enabled?: boolean };

interface Layered {
  options: Layerable;
  enabled: boolean;
  /** True when any layer configured the primitive. */
  explicit: boolean;
  /** Options object of the highest layer that set the primitive (legacy marks live there). */
  top?: Layerable;
}

function defined(options: object): Layerable {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

/**
 * Field-by-field merge of one primitive over layers given highest first (RS-04): `enabled` comes
 * from the highest layer that sets the primitive, `false` turns it off.
 */
function layerPrimitive(values: readonly unknown[]): Layered {
  let options: Layerable = {};
  let enabled: boolean | undefined;
  let explicit = false;
  let top: Layerable | undefined;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === undefined) continue;
    explicit = true;
    const layer: Layerable = value === false ? { enabled: false } : (value as Layerable);
    options = { ...options, ...defined(layer) };
    enabled = layer.enabled ?? true;
    top = layer;
  }
  const layered: Layered = { options, enabled: enabled ?? true, explicit };
  if (top !== undefined) layered.top = top;
  return layered;
}

/** Merged policy of `layers` (highest first), still unvalidated; used to expand `use`. */
export function layerPolicies(
  layers: readonly (ResiliencePolicy | undefined)[],
): ResiliencePolicy | undefined {
  const present = layers.filter((layer): layer is ResiliencePolicy => layer !== undefined);
  if (present.length === 0) return undefined;
  const merged: Record<string, unknown> = {};
  for (const name of PRIMITIVES) {
    const layered = layerPrimitive(present.map((layer) => layer[name]));
    if (!layered.explicit) continue;
    merged[name] = layered.enabled ? { ...layered.options, enabled: true } : false;
  }
  const classify = present.find((layer) => layer.classify !== undefined)?.classify;
  if (classify !== undefined) merged.classify = classify;
  return merged;
}

/** RS-51: expands a policy reference against the named policies. */
export function expandPolicyRef<P extends object = ResiliencePolicy>(
  binding: string,
  ref: ResiliencePolicyRef<P> | undefined,
  policies: Readonly<Record<string, ResiliencePolicy>> | undefined,
): ResiliencePolicy | undefined {
  if (ref === undefined) return undefined;
  const named = (name: unknown): ResiliencePolicy => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ResilienceDefinitionError(binding, 'use', 'must be a policy name');
    }
    const policy =
      policies !== undefined && Object.hasOwn(policies, name) ? policies[name] : undefined;
    if (policy === undefined) {
      throw new ResilienceDefinitionError(binding, 'use', `names an unknown policy '${name}'`);
    }
    if (Object.hasOwn(policy, 'use')) {
      throw new ResilienceDefinitionError(
        binding,
        'use',
        `policy '${name}' must not itself use another`,
      );
    }
    return policy;
  };
  if (typeof ref === 'string') return named(ref);
  const raw: unknown = ref;
  if (typeof raw !== 'object' || raw === null) {
    throw new ResilienceDefinitionError(binding, 'use', 'must be a policy name or a policy object');
  }
  if (!Object.hasOwn(ref, 'use')) return ref;
  const { use, ...overrides } = ref as P & { use?: string };
  return layerPolicies([overrides, named(use)]);
}

// ---------- Validation helpers ----------

class Checker {
  constructor(readonly binding: string) {}

  fail(path: string, rule: string): never {
    throw new ResilienceDefinitionError(this.binding, path, rule);
  }

  int(path: string, value: unknown, min: number, max = MAX_BACKOFF_MS): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      const range = max === MAX_BACKOFF_MS ? `>= ${min}` : `${min}..${max}`;
      this.fail(path, `must be an integer ${range}`);
    }
    return value;
  }

  positive(path: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      this.fail(path, 'must be a finite number > 0');
    }
    return value;
  }

  classes<T extends string>(path: string, value: unknown, known: readonly T[]): ReadonlySet<T> {
    if (!Array.isArray(value) || value.length === 0) this.fail(path, 'must be a non-empty list');
    const list = value as unknown[];
    for (const item of list) {
      if (!known.includes(item as T)) this.fail(path, `has an unknown value '${String(item)}'`);
    }
    if (new Set(list).size !== list.length) this.fail(path, 'has duplicates');
    return new Set(list as T[]);
  }

  fn<F>(path: string, value: unknown): F | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'function') this.fail(path, 'must be a function');
    return value as F;
  }

  state(path: string, value: unknown): ResilienceStatePort | undefined {
    if (value === undefined || value === 'local') return undefined;
    const port = value as Record<string, unknown> | null;
    if (typeof port !== 'object' || port === null)
      this.fail(path, "must be 'local' or a state port");
    for (const method of STATE_METHODS) {
      if (typeof port[method] !== 'function') this.fail(path, `state port has no ${method}()`);
    }
    return value as ResilienceStatePort;
  }
}

// ---------- Primitive resolution ----------

function resolveTimeout(
  c: Checker,
  layered: Layered,
  defaultPerAttemptMs: number,
): Pick<ResiliencePlan, 'perAttemptMs' | 'deadlineMs' | 'timeoutExplicit'> {
  if (!layered.explicit || !layered.enabled) {
    return { perAttemptMs: defaultPerAttemptMs, timeoutExplicit: false };
  }
  const { perAttemptMs, deadlineMs } = layered.options as TimeoutPolicy;
  const legacy = (layered.top as LegacyTimeoutPolicy | undefined)?.[LEGACY_ALIAS] === true;
  const out: { perAttemptMs: number; deadlineMs?: number; timeoutExplicit: boolean } = {
    perAttemptMs: defaultPerAttemptMs,
    timeoutExplicit: perAttemptMs !== undefined,
  };
  // The legacy alias keeps the 0.9.0 rule (any finite number >= 0), validated by its edge.
  if (perAttemptMs !== undefined) {
    out.perAttemptMs = legacy
      ? perAttemptMs
      : c.int('timeout.perAttemptMs', perAttemptMs, 0, MAX_BACKOFF_MS);
  }
  if (deadlineMs !== undefined) {
    out.deadlineMs = c.int('timeout.deadlineMs', deadlineMs, 1, MAX_BACKOFF_MS);
  }
  return out;
}

interface DelaySource {
  delay: RetryPlan['delay'];
  maxMs: number;
}

function resolveBackoff(c: Checker, option: RetryPolicyOptions['backoff']): DelaySource {
  if (typeof option === 'function') {
    const fn = option;
    return {
      delay: (attempt, error) => Math.min(MAX_BACKOFF_MS, Math.max(0, fn(attempt, error))),
      maxMs: DEFAULT_BACKOFF.maxMs,
    };
  }
  if (typeof option === 'number') {
    const ms = c.int('retry.backoff', option, 0, MAX_BACKOFF_MS);
    return { delay: () => ms, maxMs: ms };
  }
  const raw: unknown = option;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null)) {
    c.fail('retry.backoff', 'must be a number, an object or a function');
  }
  const settings = { ...DEFAULT_BACKOFF, ...defined(option ?? {}) };
  const initialMs = c.int('retry.backoff.initialMs', settings.initialMs, 0, MAX_BACKOFF_MS);
  if (
    typeof settings.factor !== 'number' ||
    !Number.isFinite(settings.factor) ||
    settings.factor < 1
  ) {
    c.fail('retry.backoff.factor', 'must be a number >= 1');
  }
  const maxMs = c.int('retry.backoff.maxMs', settings.maxMs, initialMs, MAX_BACKOFF_MS);
  if (!JITTERS.includes(settings.jitter))
    c.fail('retry.backoff.jitter', 'must be full, equal or none');
  const resolved = { ...settings, initialMs, maxMs };
  return { delay: (attempt, _error, random) => backoffDelay(resolved, attempt, random), maxMs };
}

function resolveRetry(c: Checker, layered: Layered): RetryPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as LegacyRetryOptions;
  const legacy = (layered.top as LegacyRetryOptions | undefined)?.[LEGACY_ALIAS];
  if (legacy !== undefined) return legacyRetryPlan(options, legacy);
  const maxAttempts = c.int('retry.maxAttempts', options.maxAttempts ?? 3, 1, MAX_RETRY_ATTEMPTS);
  const backoff = resolveBackoff(c, options.backoff);
  const retryOn = c.classes(
    'retry.retryOn',
    options.retryOn ?? ['transient', 'throttled'],
    FAILURE_CLASSES,
  );
  if (retryOn.has('quota'))
    c.fail('retry.retryOn', "must not list 'quota' (quota is never retried)");
  return {
    maxAttempts,
    delay: backoff.delay,
    retryOn,
    honorRetryAfter: options.honorRetryAfter ?? true,
    maxRetryAfterMs: retryAfterCap(c, options, backoff.maxMs),
    idempotent: options.idempotent === true,
    propagate: retryPropagation(c, options),
    requireIdempotencyKey: options.requireIdempotencyKey === true,
  };
}

function retryAfterCap(c: Checker, options: RetryPolicyOptions, backoffMaxMs: number): number {
  if (options.maxRetryAfterMs === undefined) return backoffMaxMs;
  return c.int('retry.maxRetryAfterMs', options.maxRetryAfterMs, 0, MAX_BACKOFF_MS);
}

function retryPropagation(c: Checker, options: RetryPolicyOptions): 'claim' | 'forward' {
  const propagate: unknown = options.propagate ?? 'claim';
  if (propagate !== 'claim' && propagate !== 'forward')
    c.fail('retry.propagate', 'must be claim or forward');
  return propagate;
}

/** The 0.9.0 alias: no jitter, no Retry-After, no budget, boolean classifier (section 1). */
function legacyRetryPlan(options: RetryPolicyOptions, legacy: LegacyRetryMark): RetryPlan {
  return {
    maxAttempts: options.maxAttempts ?? 3,
    delay: (attempt, error) => legacy.backoff(attempt, error),
    retryOn: new Set(),
    honorRetryAfter: false,
    maxRetryAfterMs: 0,
    idempotent: false,
    propagate: 'forward',
    requireIdempotencyKey: false,
    legacy,
  };
}

/** Optional key function and shared state of the breaker and the rate limiter. */
function keyAndState(
  c: Checker,
  prefix: 'circuitBreaker' | 'rateLimit',
  options: { key?: unknown; state?: unknown },
): { key?: ResilienceKeyFn; state?: ResilienceStatePort } {
  const out: { key?: ResilienceKeyFn; state?: ResilienceStatePort } = {};
  const key = c.fn<ResilienceKeyFn>(`${prefix}.key`, options.key);
  if (key !== undefined) out.key = key;
  const state = c.state(`${prefix}.state`, options.state);
  if (state !== undefined) out.state = state;
  return out;
}

function resolveWindow(
  c: Checker,
  options: CircuitBreakerPolicy,
  minimumCalls: number,
): BreakerPlan['window'] {
  const window = options.window ?? { type: 'count', size: 20 };
  if (window.type === 'count') {
    return { type: 'count', size: c.int('circuitBreaker.window.size', window.size, minimumCalls) };
  }
  if ((window as { type: unknown }).type !== 'time')
    c.fail('circuitBreaker.window.type', 'must be count or time');
  return { type: 'time', sizeMs: c.int('circuitBreaker.window.sizeMs', window.sizeMs, 1) };
}

function resolveBreaker(c: Checker, layered: Layered): BreakerPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as CircuitBreakerPolicy;
  const minimumCalls = c.int('circuitBreaker.minimumCalls', options.minimumCalls ?? 10, 1);
  const openMs = c.int('circuitBreaker.openMs', options.openMs ?? 30_000, 1);
  const plan: BreakerPlan = {
    failureRateThreshold: c.int(
      'circuitBreaker.failureRateThreshold',
      options.failureRateThreshold ?? 50,
      1,
      100,
    ),
    minimumCalls,
    window: resolveWindow(c, options, minimumCalls),
    openMs,
    halfOpenCalls: c.int('circuitBreaker.halfOpenCalls', options.halfOpenCalls ?? 1, 1),
    recordOn: c.classes(
      'circuitBreaker.recordOn',
      options.recordOn ?? ['transient'],
      FAILURE_CLASSES,
    ),
    quotaOpenMs: quotaOpening(c, options.quotaOpenMs, openMs),
    maxKeys: c.int('circuitBreaker.maxKeys', options.maxKeys ?? 1000, 1),
    syncMs: c.int('circuitBreaker.syncMs', options.syncMs ?? 1000, 1),
    ...keyAndState(c, 'circuitBreaker', options),
  };
  return plan;
}

function quotaOpening(
  c: Checker,
  quota: number | 'manual' | undefined,
  openMs: number,
): number | 'manual' {
  return quota === 'manual' ? 'manual' : c.int('circuitBreaker.quotaOpenMs', quota ?? openMs, 1);
}

function resolveBulkhead(c: Checker, layered: Layered): BulkheadPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as Partial<BulkheadPolicy>;
  const plan: BulkheadPlan = {
    maxConcurrent: c.int('bulkhead.maxConcurrent', options.maxConcurrent, 1),
    maxQueue: c.int('bulkhead.maxQueue', options.maxQueue ?? 0, 0),
  };
  if (options.queueTimeoutMs !== undefined) {
    plan.queueTimeoutMs = c.int('bulkhead.queueTimeoutMs', options.queueTimeoutMs, 1);
  }
  return plan;
}

function resolveRateLimit(c: Checker, layered: Layered): RateLimitPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as Partial<RateLimitPolicy>;
  const limitPerSec = c.positive('rateLimit.limitPerSec', options.limitPerSec);
  const burst = c.int('rateLimit.burst', options.burst ?? Math.ceil(limitPerSec), 1);
  const replicasHint = c.int('rateLimit.replicasHint', options.replicasHint ?? 1, 1);
  const plan: RateLimitPlan = {
    limitPerSec,
    burst,
    maxWaitMs: c.int('rateLimit.maxWaitMs', options.maxWaitMs ?? 0, 0),
    degradedLimitPerSec: c.positive(
      'rateLimit.degradedLimitPerSec',
      options.degradedLimitPerSec ?? limitPerSec / replicasHint,
    ),
    degradedBurst: Math.max(1, Math.floor(burst / replicasHint)),
    maxKeys: c.int('rateLimit.maxKeys', options.maxKeys ?? 1000, 1),
    replicasHint,
  };
  return { ...plan, ...keyAndState(c, 'rateLimit', options) };
}

function resolveFallback(c: Checker, layered: Layered): FallbackPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as FallbackPolicy;
  const hasValue = options.value !== undefined;
  const hasChannel = options.channel !== undefined;
  if (hasValue === hasChannel) c.fail('fallback', 'must set exactly one of value or channel');
  const plan: FallbackPlan = {
    on: c.classes('fallback.on', options.on ?? DEFAULT_FALLBACK_ON, TRIGGERS),
    cacheable: options.cacheable === true,
  };
  const value = c.fn<FallbackPlan['value']>('fallback.value', options.value);
  if (value !== undefined) plan.value = value;
  if (hasChannel) {
    if (typeof options.channel !== 'string' || options.channel.length === 0) {
      c.fail('fallback.channel', 'must be a non-empty channel name');
    }
    plan.channel = options.channel;
  }
  return plan;
}

function resolveClassify(
  c: Checker,
  layers: readonly ResiliencePolicy[],
): readonly ResilienceClassifierFn[] {
  const option = layers.find((layer) => layer.classify !== undefined)?.classify;
  if (option === undefined) return [];
  const list = (Array.isArray(option) ? option : [option]) as unknown[];
  list.forEach((fn, index) => c.fn(`classify[${index}]`, fn));
  return list as ResilienceClassifierFn[];
}

function assertAllowed(
  c: Checker,
  layers: readonly ResiliencePolicy[],
  allowed: readonly PrimitiveName[],
): void {
  for (const layer of layers) {
    for (const name of PRIMITIVES) {
      const value = layer[name];
      if (value !== undefined && value !== false && !allowed.includes(name)) {
        c.fail(name, 'is not allowed on this edge');
      }
    }
  }
}

function warningsOf(plan: Omit<ResiliencePlan, 'warnings' | 'empty'>): string[] {
  const warnings: string[] = [];
  if (plan.deadlineMs !== undefined && plan.perAttemptMs > plan.deadlineMs) {
    warnings.push(
      `${plan.binding}: resilience.timeout.deadlineMs is shorter than perAttemptMs; attempts are capped by the deadline`,
    );
  }
  return warnings;
}

/**
 * Merges `layers` (highest first: call, binding, module default), validates every primitive
 * (section 5.6) and applies the defaults. Throws `ResilienceDefinitionError` naming the binding
 * and the option path (RS-03).
 */
export function resolveResiliencePlan(
  binding: string,
  layers: readonly (ResiliencePolicyRef | undefined)[],
  edge: ResilienceEdgeKind,
  options: ResolvePlanOptions = {},
): ResiliencePlan {
  const checker = new Checker(binding);
  const expanded = layers
    .map((layer) => expandPolicyRef(binding, layer, options.policies))
    .filter((layer): layer is ResiliencePolicy => layer !== undefined);
  assertAllowed(checker, expanded, options.allowed ?? PRIMITIVES);
  const of = (name: PrimitiveName): Layered => layerPrimitive(expanded.map((layer) => layer[name]));
  const base = {
    binding,
    edge,
    classify: resolveClassify(checker, expanded),
    ...resolveTimeout(checker, of('timeout'), options.defaultPerAttemptMs ?? 0),
  };
  const plan: Omit<ResiliencePlan, 'warnings' | 'empty'> = { ...base };
  const assign = <K extends keyof ResiliencePlan>(
    key: K,
    value: ResiliencePlan[K] | undefined,
  ): void => {
    if (value !== undefined) (plan as Record<string, unknown>)[key] = value;
  };
  assign('retry', resolveRetry(checker, of('retry')));
  assign('circuitBreaker', resolveBreaker(checker, of('circuitBreaker')));
  assign('bulkhead', resolveBulkhead(checker, of('bulkhead')));
  assign('rateLimit', resolveRateLimit(checker, of('rateLimit')));
  assign('fallback', resolveFallback(checker, of('fallback')));
  return Object.freeze({ ...plan, empty: isEmpty(plan), warnings: warningsOf(plan) });
}

function isEmpty(plan: Omit<ResiliencePlan, 'warnings' | 'empty'>): boolean {
  const primitives = [
    plan.retry,
    plan.circuitBreaker,
    plan.bulkhead,
    plan.rateLimit,
    plan.fallback,
  ];
  return (
    plan.perAttemptMs === 0 &&
    plan.deadlineMs === undefined &&
    primitives.every((p) => p === undefined)
  );
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** Compact summary for the graph and boot logs (RS-42): kinds, timeouts and attempts only. */
export function describePolicy(plan: ResiliencePlan): string | undefined {
  const parts: string[] = [];
  if (plan.timeoutExplicit && plan.perAttemptMs > 0)
    parts.push(`timeout ${formatMs(plan.perAttemptMs)}`);
  if (plan.deadlineMs !== undefined) parts.push(`deadline ${formatMs(plan.deadlineMs)}`);
  if (plan.retry !== undefined && plan.retry.maxAttempts > 1)
    parts.push(`retry x${plan.retry.maxAttempts}`);
  if (plan.circuitBreaker !== undefined) parts.push('breaker');
  if (plan.bulkhead !== undefined) parts.push('bulkhead');
  if (plan.rateLimit !== undefined) parts.push('ratelimit');
  if (plan.fallback !== undefined) parts.push('fallback');
  return parts.length === 0 ? undefined : parts.join(' · ');
}
