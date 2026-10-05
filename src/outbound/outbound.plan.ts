import { OutboundError, OutboundHttpError, redactUrl } from './outbound.errors';
import { formSerializer, jsonSerializer, textSerializer } from './outbound.serializers';
import {
  OUTBOUND_REST_METHODS,
  type OutboundBackoffFn,
  type OutboundBodySerializerFn,
  type OutboundErrorMapperFn,
  type OutboundFetch,
  type OutboundHeaderMapperFn,
  type OutboundKeyResolverFn,
  type OutboundProviderRef,
  type OutboundProviderResolver,
  type OutboundQuery,
  type OutboundResponseMapperFn,
  type OutboundRestBinding,
  type OutboundRestDefaults,
  type OutboundRestMethod,
  type OutboundRestMethodInput,
  type OutboundRestOptions,
  type OutboundRetryClassifierFn,
  type OutboundRetryOptions,
  type OutboundTargetResolverFn,
} from './outbound.types';

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTBOUND_IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const DEFAULT_OUTBOUND_MAX_ATTEMPTS = 3;

const DEFAULT_BACKOFF = { initialMs: 200, factor: 2, maxMs: 10_000 } as const;

/** What plan resolution needs from the gateway. */
export interface OutboundPlanDeps {
  defaults?: OutboundRestDefaults;
  resolver?: OutboundProviderResolver;
}

export interface OutboundIdempotencyPlan {
  header: string;
  key?: OutboundKeyResolverFn;
  forward: boolean;
}

export interface OutboundRetryPlan {
  maxAttempts: number;
  backoff: OutboundBackoffFn;
  retryOn: OutboundRetryClassifierFn;
  /** Methods retried without an idempotency key. */
  methods: ReadonlySet<string>;
}

/** Binding options merged with the module defaults, with every strategy resolved. */
export interface OutboundRestPlan {
  name: string;
  channel?: string;
  url?: string;
  /** Target shown in the boot log and the graph: `POST https://host/path` or `dynamic`. */
  description: string;
  method: OutboundRestMethod;
  headers: Record<string, string>;
  query: OutboundQuery;
  target?: OutboundTargetResolverFn;
  mapHeaders?: OutboundHeaderMapperFn;
  traceHeaders: boolean;
  serialize: OutboundBodySerializerFn;
  response: OutboundResponseMapperFn;
  timeoutMs: number;
  /** Undefined: no idempotency header is sent. */
  idempotency?: OutboundIdempotencyPlan;
  /** Undefined: a failed call is never retried. */
  retry?: OutboundRetryPlan;
  mapError?: OutboundErrorMapperFn;
  fetchFn?: OutboundFetch;
}

type AnyFn = (...args: never[]) => unknown;

function fromContainer(
  ref: OutboundProviderRef<unknown>,
  what: string,
  resolver: OutboundProviderResolver | undefined,
): unknown {
  const token = ref.useExisting;
  const name = typeof token === 'function' ? token.name : String(token);
  if (resolver === undefined) {
    throw new OutboundError(`outbound ${what} '${name}' needs a provider resolver`);
  }
  try {
    return resolver.resolve(token);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'unknown provider';
    throw new OutboundError(`outbound ${what} '${name}' could not be resolved: ${reason}`);
  }
}

/**
 * Normalizes a strategy slot to a function: a function is used as-is, `{ useExisting }` is
 * resolved from DI and an instance is bound to its port method. A class is rejected instead
 * of being called without `new`.
 */
export function resolveOutboundStrategy<F extends AnyFn>(
  slot: unknown,
  method: string,
  what: string,
  resolver: OutboundProviderResolver | undefined,
): F {
  if (typeof slot === 'function') {
    const proto = slot.prototype as Record<string, unknown> | undefined;
    if (typeof proto?.[method] !== 'function') return slot as F;
    throw new OutboundError(
      `outbound ${what} '${slot.name}' is a class; pass { useExisting: ${slot.name} }`,
    );
  }
  const isRef = typeof slot === 'object' && slot !== null && Object.hasOwn(slot, 'useExisting');
  const instance = isRef
    ? fromContainer(slot as OutboundProviderRef<unknown>, what, resolver)
    : slot;
  const member = (instance as Record<string, unknown> | null | undefined)?.[method];
  if (typeof member !== 'function') {
    throw new OutboundError(`outbound ${what} has no '${method}' method`);
  }
  return ((...args: never[]) => (member as AnyFn).apply(instance, args)) as F;
}

/** An option present with value `undefined` inherits instead of erasing the lower layer. */
function defined<T extends object>(options: T | undefined): Partial<T> {
  const entries = Object.entries(options ?? {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

interface Layered<T> {
  options: Partial<T>;
  enabled: boolean;
  /** True when the binding or the module configured the feature at all. */
  explicit: boolean;
}

function layer<T extends { enabled?: boolean }>(
  own: false | T | undefined,
  moduleDefault: false | T | undefined,
): Layered<T> {
  const off = { enabled: false } as T;
  const binding = own === false ? off : own;
  const fallback = moduleDefault === false ? off : moduleDefault;
  // `enabled` is not inherited once the binding passes its own options object.
  const enabled = (binding === undefined ? fallback?.enabled : binding.enabled) ?? true;
  return {
    options: { ...defined(fallback), ...defined(binding) },
    enabled,
    explicit: binding !== undefined || fallback !== undefined,
  };
}

/** Upper-cases and validates a method that may come from data. */
export function normalizeOutboundMethod(method: OutboundRestMethodInput): OutboundRestMethod {
  const upper = String(method).toUpperCase();
  const known = OUTBOUND_REST_METHODS.find((candidate) => candidate === upper);
  if (known === undefined) {
    throw new OutboundError(`outbound rest method '${String(method)}' is not supported`);
  }
  return known;
}

/** A timeout must be a finite number of milliseconds; 0 disables it. */
export function assertOutboundTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
    return timeoutMs;
  }
  throw new OutboundError(`outbound rest timeoutMs '${String(timeoutMs)}' is not a valid timeout`);
}

const fullResponse: OutboundResponseMapperFn = (ctx) => ctx.response;
const bodyResponse: OutboundResponseMapperFn = (ctx) => ctx.response.body;

function resolveResponse(
  option: OutboundRestOptions['response'],
  resolver: OutboundProviderResolver | undefined,
): OutboundResponseMapperFn {
  if (option === undefined || option === 'full') return fullResponse;
  if (option === 'body') return bodyResponse;
  if (typeof option === 'string') {
    throw new OutboundError(`outbound response '${String(option)}' is not a known mapper`);
  }
  return resolveOutboundStrategy(option, 'mapResponse', 'response mapper', resolver);
}

const SERIALIZERS: Record<string, OutboundBodySerializerFn | undefined> = {
  json: jsonSerializer,
  text: textSerializer,
  form: formSerializer,
};

function resolveSerializer(
  option: OutboundRestOptions['serializer'],
  resolver: OutboundProviderResolver | undefined,
): OutboundBodySerializerFn {
  if (option === undefined) return jsonSerializer;
  if (typeof option !== 'string') {
    return resolveOutboundStrategy(option, 'serialize', 'serializer', resolver);
  }
  const builtIn = SERIALIZERS[option];
  if (builtIn === undefined) {
    throw new OutboundError(`outbound serializer '${String(option)}' is not a known serializer`);
  }
  return builtIn;
}

function resolveIdempotency(
  options: OutboundRestOptions,
  deps: OutboundPlanDeps,
): OutboundIdempotencyPlan | undefined {
  const merged = layer(options.idempotency, deps.defaults?.idempotency);
  if (!merged.enabled) return undefined;
  const { header = DEFAULT_OUTBOUND_IDEMPOTENCY_HEADER, key, forward } = merged.options;
  if (typeof header !== 'string' || header.length === 0) {
    throw new OutboundError('outbound idempotency header must be a non-empty string');
  }
  const plan: OutboundIdempotencyPlan = { header, forward: forward ?? key === undefined };
  if (key !== undefined) {
    plan.key = resolveOutboundStrategy(key, 'resolveKey', 'key resolver', deps.resolver);
  }
  return plan;
}

/** HTTP statuses a retry may fix: request timeout, rate limit and server errors. */
const defaultRetryOn: OutboundRetryClassifierFn = (error) => {
  if (!(error instanceof OutboundHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
};

function resolveBackoff(option: OutboundRetryOptions['backoff']): OutboundBackoffFn {
  if (typeof option === 'function') return option;
  if (typeof option === 'number') return () => option;
  const { initialMs, factor, maxMs } = { ...DEFAULT_BACKOFF, ...defined(option) };
  return (attempt) => Math.min(maxMs, initialMs * factor ** (attempt - 1));
}

function resolveRetry(
  options: OutboundRestOptions,
  deps: OutboundPlanDeps,
): OutboundRetryPlan | undefined {
  const merged = layer(options.retry, deps.defaults?.retry);
  if (!merged.explicit || !merged.enabled) return undefined;
  const { maxAttempts = DEFAULT_OUTBOUND_MAX_ATTEMPTS, backoff, retryOn, methods } = merged.options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new OutboundError('outbound retry maxAttempts must be an integer of at least 1');
  }
  return {
    maxAttempts,
    backoff: resolveBackoff(backoff),
    retryOn:
      retryOn === undefined
        ? defaultRetryOn
        : resolveOutboundStrategy(retryOn, 'isRetryable', 'retry classifier', deps.resolver),
    methods: new Set((methods ?? []).map(normalizeOutboundMethod)),
  };
}

function resolveHooks(
  options: OutboundRestOptions,
  merged: OutboundRestOptions,
  resolver: OutboundProviderResolver | undefined,
): Pick<OutboundRestPlan, 'target' | 'mapHeaders' | 'mapError' | 'fetchFn'> {
  const hooks: Pick<OutboundRestPlan, 'target' | 'mapHeaders' | 'mapError' | 'fetchFn'> = {};
  if (options.target !== undefined) {
    hooks.target = resolveOutboundStrategy(options.target, 'resolveTarget', 'target', resolver);
  }
  if (merged.mapHeaders !== undefined) {
    hooks.mapHeaders = resolveOutboundStrategy(
      merged.mapHeaders,
      'mapHeaders',
      'header mapper',
      resolver,
    );
  }
  if (merged.mapError !== undefined) {
    hooks.mapError = resolveOutboundStrategy(merged.mapError, 'mapError', 'error mapper', resolver);
  }
  if (merged.fetchFn !== undefined) hooks.fetchFn = merged.fetchFn;
  return hooks;
}

interface OutboundIdentity {
  name: string;
  channel?: string;
  url?: string;
}

function identify(binding: OutboundRestBinding): OutboundIdentity {
  const name = binding.name ?? binding.channel;
  if (typeof name !== 'string' || name.length === 0) {
    throw new OutboundError('an outbound rest binding needs a channel or a name');
  }
  if (binding.url === undefined && binding.target === undefined) {
    throw new OutboundError(`outbound rest '${name}' needs a url or a target resolver`);
  }
  const identity: OutboundIdentity = { name };
  if (binding.channel !== undefined) identity.channel = binding.channel;
  if (binding.url !== undefined) identity.url = binding.url;
  return identity;
}

/** Target shown in the boot log and the graph: never a query string or credentials. */
function describeTarget(binding: OutboundRestBinding, method: OutboundRestMethod): string {
  if (binding.target !== undefined || binding.url === undefined) return 'dynamic';
  return `${method} ${redactUrl(binding.url)}`;
}

function resolveFeatures(
  binding: OutboundRestBinding,
  deps: OutboundPlanDeps,
): Pick<OutboundRestPlan, 'idempotency' | 'retry'> {
  const features: Pick<OutboundRestPlan, 'idempotency' | 'retry'> = {};
  const idempotency = resolveIdempotency(binding, deps);
  if (idempotency !== undefined) features.idempotency = idempotency;
  const retry = resolveRetry(binding, deps);
  if (retry !== undefined) features.retry = retry;
  return features;
}

/**
 * Merges the binding over the module defaults over the built-ins, resolves every strategy
 * and validates the combination. Throws `OutboundError` on a misconfiguration.
 */
export function resolveOutboundRestPlan(
  binding: OutboundRestBinding,
  deps: OutboundPlanDeps,
): OutboundRestPlan {
  const identity = identify(binding);
  const merged: OutboundRestOptions = { ...defined(deps.defaults), ...defined(binding) };
  const method = normalizeOutboundMethod(merged.method ?? 'POST');
  return {
    ...identity,
    description: describeTarget(binding, method),
    method,
    headers: { ...deps.defaults?.headers, ...binding.headers },
    query: { ...deps.defaults?.query, ...binding.query },
    traceHeaders: merged.traceHeaders ?? true,
    serialize: resolveSerializer(merged.serializer, deps.resolver),
    response: resolveResponse(merged.response, deps.resolver),
    timeoutMs: assertOutboundTimeout(merged.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS),
    ...resolveFeatures(binding, deps),
    ...resolveHooks(binding, merged, deps.resolver),
  };
}
