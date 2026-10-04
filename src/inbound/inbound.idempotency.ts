import { normalizeHeaderValue } from '../adapters/header-mapper';
import type { IdempotencyRecord, IdempotencyStore } from '../idempotency/idempotency-store';
import type { MessageHeadersInit } from '../message';
import {
  decideFailureAction,
  InboundIdempotencyInFlightError,
  readStoredFailure,
  wrapStoredFailure,
  type InboundFailurePolicy,
} from './inbound.failure';
import {
  InboundError,
  type InboundClientKeyFn,
  type InboundFailureCodec,
  type InboundIdempotencyOptions,
  type InboundInFlightErrorFactory,
  type InboundKey,
  type InboundKeyContext,
  type InboundKeyParts,
  type InboundKeyResolverFn,
} from './inbound.types';

/** Narrow store port of the inbound claim; `release` is present only when the store has it. */
export interface InboundStorePort {
  begin(scope: string, key: string, ttlMs: number): Promise<boolean>;
  complete(scope: string, key: string, result: Record<string, unknown>): Promise<void>;
  fail(scope: string, key: string, error: unknown): Promise<void>;
  get(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  release?: (scope: string, key: string) => Promise<unknown>;
}

/** An `IdempotencyStore`, or the module `IdempotencyService` (which reports `supportsRelease`). */
export type InboundStoreSource = Pick<IdempotencyStore, 'begin' | 'complete' | 'fail' | 'get'> & {
  release?(scope: string, key: string): Promise<unknown>;
  readonly supportsRelease?: boolean;
};

export function toStorePort(source: InboundStoreSource): InboundStorePort {
  const port: InboundStorePort = {
    begin: (scope, key, ttlMs) => source.begin(scope, key, ttlMs),
    complete: (scope, key, result) => source.complete(scope, key, result),
    fail: (scope, key, error) => source.fail(scope, key, error),
    get: (scope, key) => source.get(scope, key),
  };
  const canRelease = source.supportsRelease ?? typeof source.release === 'function';
  if (canRelease) port.release = async (scope, key) => source.release?.(scope, key);
  return port;
}

/** Resolved idempotency rules of one endpoint. */
export interface InboundIdempotencyPlan {
  store: InboundStorePort;
  ttlMs: number;
  scope: string;
  key?: InboundKeyResolverFn;
  onDuplicate: 'envelope' | 'replay';
  onInFlight: 'duplicate' | 'reject' | InboundInFlightErrorFactory;
  failure: InboundFailurePolicy;
  codec: InboundFailureCodec;
}

export interface InboundStorageKey {
  scope: string;
  key: string;
}

export type InboundClaim =
  | { status: 'skipped' }
  | { status: 'acquired'; plan: InboundIdempotencyPlan; at: InboundStorageKey }
  | { status: 'repeat'; repeat: InboundRepeat };

/** How a repeated key is answered (see the repeat matrix in the README). */
export type InboundRepeat =
  | { kind: 'reply'; result: unknown }
  | { kind: 'accepted'; acceptedId: string }
  | { kind: 'duplicate'; duplicateOf: 'in-flight' | 'completed' | 'failed'; result: unknown };

function encodeKeyPart(part: unknown): string {
  if (typeof part === 'string' && part.length > 0) {
    return part.replace(/%/g, '%25').replace(/:/g, '%3A');
  }
  if (typeof part === 'number' && Number.isFinite(part)) return String(part);
  // A missing part would merge every caller that lacks it into one key.
  throw new InboundError('inbound key parts must be non-empty strings or finite numbers');
}

/**
 * Storage key of a resolver result: a string is used verbatim; array parts are escaped
 * (`%` and `:`) and joined with `:`, so no part can forge the boundary of another.
 * Throws `InboundError` on an empty key or a part that is not a non-empty string or a
 * finite number (undefined, null, '', objects).
 */
export function encodeInboundKey(parts: InboundKeyParts): string {
  const key: unknown = parts;
  if (typeof key === 'string' && key.length > 0) return key;
  if (Array.isArray(key) && key.length > 0) return key.map(encodeKeyPart).join(':');
  throw new InboundError('inbound key must be a non-empty string or a non-empty array of parts');
}

function toInboundKey(resolved: unknown): InboundKey {
  if (typeof resolved === 'string' || Array.isArray(resolved)) {
    return { key: resolved as InboundKeyParts };
  }
  if (typeof resolved === 'object' && resolved !== null && 'key' in resolved) {
    return resolved as InboundKey;
  }
  throw new InboundError('inbound key must be a string, an array of parts or { key }');
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Builds the client-key reader of an endpoint; undefined keeps the header-mapper default. */
export function clientKeyReader(
  option: InboundIdempotencyOptions['clientKey'],
): InboundClientKeyFn | undefined {
  if (option === undefined) return undefined;
  if (typeof option === 'function') return (ctx) => nonEmpty(option(ctx));
  const names = (typeof option === 'string' ? [option] : option).map((name) => name.toLowerCase());
  return ({ rawHeaders }) => {
    const lowered = new Map(
      Object.entries(rawHeaders).map(([name, value]) => [name.toLowerCase(), value]),
    );
    for (const name of names) {
      const value = normalizeHeaderValue(lowered.get(name));
      if (value !== undefined) return value;
    }
    return undefined;
  };
}

/** Headers of the dispatched message, with `idempotencyKey` set per the `forward` option. */
export function forwardedHeaders(
  rule: { forward: 'raw' | 'resolved' | 'none'; customClientKey: boolean },
  headersInit: MessageHeadersInit,
  clientKey: string | undefined,
  storageKey: string | undefined,
): MessageHeadersInit {
  if (rule.forward === 'raw' && !rule.customClientKey) return headersInit;
  const forwarded = { raw: clientKey, resolved: storageKey, none: undefined }[rule.forward];
  const headers: MessageHeadersInit = { ...headersInit };
  if (forwarded === undefined) delete headers.idempotencyKey;
  else headers.idempotencyKey = forwarded;
  return headers;
}

async function resolveStorageKey(
  plan: InboundIdempotencyPlan,
  ctx: InboundKeyContext,
): Promise<InboundStorageKey | undefined> {
  if (plan.key === undefined) {
    return ctx.clientKey === undefined ? undefined : { scope: plan.scope, key: ctx.clientKey };
  }
  const resolved: unknown = await plan.key(ctx);
  if (resolved === undefined || resolved === null) return undefined;
  try {
    const target = toInboundKey(resolved);
    return { scope: target.scope ?? plan.scope, key: encodeInboundKey(target.key) };
  } catch (error) {
    if (!(error instanceof InboundError)) throw error;
    throw new InboundError(`key resolver of inbound '${ctx.spec.channel}': ${error.message}`);
  }
}

function cachedResultOf(record: IdempotencyRecord | undefined): unknown {
  return record?.result !== undefined && 'cachedResult' in record.result
    ? record.result.cachedResult
    : null;
}

function completedRepeat(plan: InboundIdempotencyPlan, record: IdempotencyRecord): InboundRepeat {
  const result = record.result ?? {};
  const failure = readStoredFailure(result);
  if (failure !== undefined) throw plan.codec.deserialize(failure.data);
  if (plan.onDuplicate === 'replay') {
    if (result.accepted === true && typeof result.id === 'string') {
      return { kind: 'accepted', acceptedId: result.id };
    }
    // A store that serializes records drops `cachedResult: undefined`; it is still a reply.
    return { kind: 'reply', result: result.cachedResult };
  }
  return { kind: 'duplicate', duplicateOf: 'completed', result: cachedResultOf(record) };
}

function resolveRepeat(
  plan: InboundIdempotencyPlan,
  record: IdempotencyRecord | undefined,
  ctx: InboundKeyContext,
  scope: string,
): InboundRepeat {
  if (record?.status === 'completed') return completedRepeat(plan, record);
  if (record?.status === 'failed') {
    return { kind: 'duplicate', duplicateOf: 'failed', result: cachedResultOf(record) };
  }
  // In flight, or gone between begin() and get().
  if (plan.onInFlight === 'duplicate') {
    return { kind: 'duplicate', duplicateOf: 'in-flight', result: cachedResultOf(record) };
  }
  if (plan.onInFlight === 'reject') {
    throw new InboundIdempotencyInFlightError(ctx.spec.channel, scope, ctx.clientKey);
  }
  throw plan.onInFlight(ctx);
}

/**
 * Claim lifecycle of one inbound request: `claim` before the dispatch, then `succeed` or
 * `failed`. Stateless apart from the once-per-scope warning.
 */
export class InboundIdempotencyGate {
  private readonly warnedScopes = new Set<string>();

  constructor(private readonly warn: (message: string) => void = () => undefined) {}

  /** A resolver throw propagates and nothing is claimed. */
  async claim(
    plan: InboundIdempotencyPlan | undefined,
    ctx: InboundKeyContext,
  ): Promise<InboundClaim> {
    if (plan === undefined) return { status: 'skipped' };
    const at = await resolveStorageKey(plan, ctx);
    if (at === undefined) return { status: 'skipped' };
    if (await plan.store.begin(at.scope, at.key, plan.ttlMs)) {
      return { status: 'acquired', plan, at };
    }
    const record = await plan.store.get(at.scope, at.key);
    return { status: 'repeat', repeat: resolveRepeat(plan, record, ctx, at.scope) };
  }

  /** The work is committed: a failing `complete` keeps the key blocked, never releases it. */
  async succeed(claim: InboundClaim, record: Record<string, unknown>): Promise<void> {
    if (claim.status !== 'acquired') return;
    const { plan, at } = claim;
    try {
      await plan.store.complete(at.scope, at.key, record);
    } catch (error) {
      await plan.store.fail(at.scope, at.key, error).catch(() => undefined);
      throw error;
    }
  }

  /** Applies the failure policy; any policy error degrades to `keep` and is swallowed. */
  async failed(claim: InboundClaim, error: unknown, ctx: InboundKeyContext): Promise<void> {
    if (claim.status !== 'acquired') return;
    const { plan, at } = claim;
    try {
      if (await this.settle(plan, at, error, ctx)) return;
    } catch {
      // Policy errors must not mask the business error.
    }
    await plan.store.fail(at.scope, at.key, error).catch(() => undefined);
  }

  /** True when the key was released or the failure stored; false means `keep`. */
  private async settle(
    plan: InboundIdempotencyPlan,
    at: InboundStorageKey,
    error: unknown,
    ctx: InboundKeyContext,
  ): Promise<boolean> {
    const action = await decideFailureAction(plan.failure, error, ctx);
    if (action === 'store') {
      const record = wrapStoredFailure(plan.codec.serialize(error));
      await plan.store.complete(at.scope, at.key, record);
      return true;
    }
    if (action !== 'release') return false;
    if (plan.store.release === undefined) {
      this.warnNoRelease(at.scope);
      return false;
    }
    await plan.store.release(at.scope, at.key);
    return true;
  }

  private warnNoRelease(scope: string): void {
    if (this.warnedScopes.has(scope)) return;
    this.warnedScopes.add(scope);
    this.warn(
      `idempotency store has no release(): scope '${scope}' keeps failed keys blocked until TTL`,
    );
  }
}
