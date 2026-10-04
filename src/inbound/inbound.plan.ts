import { HttpExceptionFailureCodec, type InboundFailurePolicy } from './inbound.failure';
import {
  clientKeyReader,
  toStorePort,
  type InboundIdempotencyPlan,
  type InboundStoreSource,
} from './inbound.idempotency';
import { envelopeReplyMapper, rawReplyMapper } from './inbound.reply';
import {
  InboundError,
  type InboundClientKeyFn,
  type InboundDefaults,
  type InboundFailureClassifierFn,
  type InboundFailureCodec,
  type InboundIdempotencyOptions,
  type InboundKeyResolverFn,
  type InboundProviderRef,
  type InboundProviderResolver,
  type InboundProviderToken,
  type InboundReplyMapperFn,
  type InboundReplyOption,
  type InboundSpec,
} from './inbound.types';

const DEFAULT_TTL_MS = 3_600_000;

/** What plan resolution needs from the interceptor deps. */
export interface InboundPlanDeps {
  idempotency?: InboundStoreSource & { readonly ttlMs?: number };
  defaults?: InboundDefaults;
  resolver?: InboundProviderResolver;
}

/** Endpoint options merged with the module defaults, with every strategy resolved. */
export interface InboundPlan {
  reply: InboundReplyMapperFn;
  /** Undefined keeps the header-mapper default (idempotency-key, x-idempotency-key). */
  clientKey?: InboundClientKeyFn;
  forward: 'raw' | 'resolved' | 'none';
  /** Undefined: no inbound claim for this endpoint. */
  idempotency?: InboundIdempotencyPlan;
}

type AnyFn = (...args: never[]) => unknown;

function tokenName(token: InboundProviderToken): string {
  return typeof token === 'function' ? token.name : String(token);
}

function isProviderRef(slot: unknown): slot is InboundProviderRef<unknown> {
  return typeof slot === 'object' && slot !== null && Object.hasOwn(slot, 'useExisting');
}

function classError(slot: { name: string }): InboundError {
  const name = slot.name.length > 0 ? slot.name : 'anonymous';
  return new InboundError(`inbound strategy '${name}' is a class; pass { useExisting: ${name} }`);
}

function resolveRef(slot: unknown, resolver: InboundProviderResolver | undefined): unknown {
  if (!isProviderRef(slot)) return slot;
  const name = tokenName(slot.useExisting);
  if (resolver === undefined) {
    throw new InboundError(`inbound strategy '${name}' needs a provider resolver`);
  }
  try {
    return resolver.resolve(slot.useExisting);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'unknown provider';
    throw new InboundError(`inbound strategy '${name}' could not be resolved: ${reason}`);
  }
}

/** Resolves an instance slot (store, codec): a ref or an object having all `methods`. */
function resolveInstance<T>(
  slot: unknown,
  methods: readonly string[],
  resolver: InboundProviderResolver | undefined,
): T {
  if (typeof slot === 'function') throw classError(slot);
  const instance = resolveRef(slot, resolver) as Record<string, unknown> | null | undefined;
  for (const method of methods) {
    if (typeof instance?.[method] !== 'function') {
      throw new InboundError(`inbound strategy has no '${method}' method`);
    }
  }
  return instance as T;
}

/**
 * Normalizes a strategy slot to a function: `{ useExisting }` is resolved from DI, an
 * instance is bound to its port method, a function is used as-is. A class passed where a
 * function is expected is rejected instead of being called without `new`.
 */
export function resolveStrategy<F extends AnyFn>(
  slot: unknown,
  method: string,
  resolver: InboundProviderResolver | undefined,
): F {
  if (typeof slot === 'function') {
    const proto = slot.prototype as Record<string, unknown> | undefined;
    if (typeof proto?.[method] === 'function') throw classError(slot);
    return slot as F;
  }
  const instance = resolveInstance<Record<string, AnyFn>>(slot, [method], resolver);
  return ((...args: never[]) => instance[method]?.(...args)) as F;
}

function resolveReply(
  option: InboundReplyOption,
  resolver: InboundProviderResolver | undefined,
): InboundReplyMapperFn {
  if (option === 'envelope') return envelopeReplyMapper;
  if (option === 'raw') return rawReplyMapper;
  if (typeof option === 'string') {
    throw new InboundError(`inbound reply '${String(option)}' is not a known mapper`);
  }
  return resolveStrategy<InboundReplyMapperFn>(option, 'mapReply', resolver);
}

function resolveFailure(
  option: InboundIdempotencyOptions['onFailure'],
  resolver: InboundProviderResolver | undefined,
): InboundFailurePolicy {
  if (option === undefined || option === 'keep') return { mode: 'keep' };
  if (option === 'marker') return { mode: 'marker' };
  if (option === 'release' || option === 'store') return { mode: 'static', action: option };
  if (typeof option === 'string') {
    throw new InboundError(`inbound onFailure '${String(option)}' is not a known policy`);
  }
  const classify = resolveStrategy<InboundFailureClassifierFn>(option, 'classify', resolver);
  return { mode: 'classifier', classify };
}

function assertInFlight(option: InboundIdempotencyOptions['onInFlight']): void {
  if (option === undefined || typeof option === 'function') return;
  if (option === 'duplicate' || option === 'reject') return;
  throw new InboundError(`inbound onInFlight '${String(option)}' is not a known policy`);
}

function normalize(
  option: false | InboundIdempotencyOptions | undefined,
): InboundIdempotencyOptions | undefined {
  return option === false ? { enabled: false } : option;
}

interface MergedIdempotency {
  options: InboundIdempotencyOptions;
  enabled: boolean;
  /** True when an endpoint or the module configured idempotency at all. */
  explicit: boolean;
}

/** An option present with value `undefined` inherits instead of erasing the lower layer. */
function defined<T extends object>(options: T | undefined): Partial<T> {
  const entries = Object.entries(options ?? {}).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as Partial<T>;
}

function mergeIdempotency(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
): MergedIdempotency {
  const endpoint = normalize(spec.idempotency);
  const moduleDefault = normalize(defaults?.idempotency);
  // `enabled` is not inherited once the endpoint passes its own options object.
  const enabled = (endpoint === undefined ? moduleDefault?.enabled : endpoint.enabled) ?? true;
  return {
    options: { ...defined(moduleDefault), ...defined(endpoint) },
    enabled,
    explicit: endpoint !== undefined || moduleDefault !== undefined,
  };
}

function resolveForward(
  spec: InboundSpec,
  merged: MergedIdempotency,
  failureActive: boolean,
): InboundPlan['forward'] {
  const { forward, key } = merged.options;
  if (!merged.enabled) {
    if (forward !== undefined) return forward === 'none' ? 'none' : 'raw';
    // No inbound claim answers a repeat here: a forwarded key would make the flow scope drop
    // it (a reply timeout), and a raw key would undo the tenant binding of a key resolver.
    return spec.requestReply === true || key !== undefined ? 'none' : 'raw';
  }
  if (failureActive && forward !== undefined && forward !== 'none') {
    throw new InboundError(
      `inbound '${spec.channel}': forward '${forward}' cannot be combined with an onFailure ` +
        `policy (a released or stored key would still be claimed downstream); use 'none'`,
    );
  }
  return forward ?? (key === undefined && !failureActive ? 'raw' : 'none');
}

const STORE_METHODS = ['begin', 'complete', 'fail', 'get'] as const;
const CODEC_METHODS = ['serialize', 'deserialize'] as const;

function resolveCodec(
  option: InboundIdempotencyOptions['failureCodec'],
  resolver: InboundProviderResolver | undefined,
): InboundFailureCodec {
  if (option === undefined) return new HttpExceptionFailureCodec();
  return resolveInstance<InboundFailureCodec>(option, CODEC_METHODS, resolver);
}

function resolveStoreSource(
  spec: InboundSpec,
  merged: MergedIdempotency,
  deps: InboundPlanDeps,
): InboundStoreSource | undefined {
  const { store } = merged.options;
  if (store !== undefined) {
    return resolveInstance<InboundStoreSource>(store, STORE_METHODS, deps.resolver);
  }
  if (deps.idempotency === undefined && merged.explicit) {
    throw new InboundError(`inbound '${spec.channel}': idempotency is configured but has no store`);
  }
  return deps.idempotency;
}

function resolveIdempotency(
  spec: InboundSpec,
  merged: MergedIdempotency,
  failure: InboundFailurePolicy,
  deps: InboundPlanDeps,
): InboundIdempotencyPlan | undefined {
  const source = resolveStoreSource(spec, merged, deps);
  if (source === undefined) return undefined;
  const store = toStorePort(source);
  if (failure.mode === 'static' && failure.action === 'release' && store.release === undefined) {
    throw new InboundError(
      `inbound '${spec.channel}': onFailure 'release' needs a store that implements release()`,
    );
  }
  const { options } = merged;
  assertInFlight(options.onInFlight);
  const plan: InboundIdempotencyPlan = {
    store,
    ttlMs: options.ttlMs ?? deps.idempotency?.ttlMs ?? DEFAULT_TTL_MS,
    scope: options.scope ?? `inbound:${spec.channel}`,
    onDuplicate: options.onDuplicate ?? 'envelope',
    onInFlight: options.onInFlight ?? 'duplicate',
    failure,
    codec: resolveCodec(options.failureCodec, deps.resolver),
  };
  if (options.key !== undefined) {
    plan.key = resolveStrategy<InboundKeyResolverFn>(options.key, 'resolveKey', deps.resolver);
  }
  return plan;
}

/**
 * Merges the endpoint spec over the module defaults over the built-ins, resolves every
 * strategy and validates the combination. Throws `InboundError` on a misconfiguration.
 */
export function resolveInboundPlan(spec: InboundSpec, deps: InboundPlanDeps): InboundPlan {
  const merged = mergeIdempotency(spec, deps.defaults);
  const failure = resolveFailure(merged.options.onFailure, deps.resolver);
  const plan: InboundPlan = {
    reply: resolveReply(spec.reply ?? deps.defaults?.reply ?? 'envelope', deps.resolver),
    forward: resolveForward(spec, merged, failure.mode !== 'keep'),
  };
  const clientKey = clientKeyReader(merged.options.clientKey);
  if (clientKey !== undefined) plan.clientKey = clientKey;
  if (merged.enabled) {
    const idempotency = resolveIdempotency(spec, merged, failure, deps);
    if (idempotency !== undefined) plan.idempotency = idempotency;
  }
  return plan;
}

/** Plan resolution cached per spec object: strategies resolve once, on the first request. */
export function createInboundPlanner(deps: InboundPlanDeps): (spec: InboundSpec) => InboundPlan {
  const cache = new WeakMap<InboundSpec, InboundPlan>();
  return (spec) => {
    let plan = cache.get(spec);
    if (plan === undefined) {
      plan = resolveInboundPlan(spec, deps);
      cache.set(spec, plan);
    }
    return plan;
  };
}
