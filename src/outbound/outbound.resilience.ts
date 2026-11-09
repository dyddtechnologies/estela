import { defaultRestClassifier } from '../resilience/classifiers';
import type { ResilienceEdgeAdapter, ResilienceExecutor } from '../resilience/executor';
import { ResilienceDefinitionError } from '../resilience/resilience.errors';
import {
  describePolicy,
  expandPolicyRef,
  LEGACY_ALIAS,
  type LegacyRetryMark,
  type ResiliencePlan,
} from '../resilience/resilience.plan';
import type { ResilienceContext, ResiliencePolicy } from '../resilience/resilience.types';
import { ResilienceRuntime } from '../resilience/runtime';
import { OutboundTimeoutError } from './outbound.errors';
import type {
  OutboundCallContext,
  OutboundExchangeContext,
  OutboundRestBinding,
  OutboundRestDefaults,
  OutboundRestOptions,
  OutboundRestRequest,
  OutboundRetryClassifierFn,
  OutboundBackoffFn,
} from './outbound.types';

/** One expanded level: a policy, `false` (no policy here and below) or nothing. */
type PolicyLayer = ResiliencePolicy | false | undefined;

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATEFUL = ['circuitBreaker', 'bulkhead', 'rateLimit'] as const;

/** Per-call data the REST adapter reads from `ResilienceContext.data`. */
export interface RestAttemptData {
  ctx: OutboundCallContext;
  request: OutboundRestRequest;
  startedAt: number;
}

export interface OutboundResiliencePlan {
  plan: ResiliencePlan;
  executor: ResilienceExecutor<unknown>;
  summary?: string;
  /** Header that carries the retry budget downstream. */
  budgetHeader: string;
}

/** 0.9.0 retry plan resolved by `outbound.plan.ts`, used to build the legacy alias mark. */
export interface LegacyRetrySource {
  maxAttempts: number;
  backoff: OutboundBackoffFn;
  retryOn: OutboundRetryClassifierFn;
  methods: ReadonlySet<string>;
}

export interface OutboundResilienceInput {
  binding: OutboundRestBinding;
  defaults: OutboundRestDefaults | undefined;
  runtime: ResilienceRuntime;
  legacyRetry: LegacyRetrySource | undefined;
  idempotencyEnabled: boolean;
  adHoc: boolean;
}

export function dataOf(ctx: ResilienceContext): RestAttemptData {
  return ctx.data as RestAttemptData;
}

function exchangeOf(data: RestAttemptData, attempts: number): OutboundExchangeContext {
  return { ...data.ctx, request: data.request, attempts, durationMs: Date.now() - data.startedAt };
}

/** True when a binding or its module default opts into the resilience executor. */
export function usesResilience(
  binding: OutboundRestOptions,
  defaults: OutboundRestDefaults | undefined,
  runtime?: ResilienceRuntime,
): boolean {
  return (
    usesOwnResilience(binding, defaults) ||
    runtime?.options.defaults?.['outbound-rest'] !== undefined
  );
}

function usesOwnResilience(
  binding: OutboundRestOptions,
  defaults: OutboundRestDefaults | undefined,
): boolean {
  return binding.resilience !== undefined || defaults?.resilience !== undefined;
}

function legacyMark(source: LegacyRetrySource): LegacyRetryMark {
  return {
    retryOn: (error, ctx) => source.retryOn(error as never, exchangeOf(dataOf(ctx), ctx.attempt)),
    backoff: (attempt, error) => Math.max(0, source.backoff(attempt, error as never)),
  };
}

/**
 * One layer of the plan: the `resilience` policy plus the legacy `retry` / `timeoutMs` of the same
 * options as aliases. The same primitive in both spellings on one layer is refused (RS-35).
 */
// eslint-disable-next-line sonarjs/function-return-type -- a reference expands to a policy, false (cut) or nothing
function layerOf(
  name: string,
  options: OutboundRestOptions,
  input: OutboundResilienceInput,
  moduleDefault?: OutboundRestOptions['resilience'],
): PolicyLayer {
  if (options.resilience !== undefined && moduleDefault !== undefined) {
    throw new ResilienceDefinitionError(
      name,
      'defaults.outbound-rest',
      'is set both as resilience.defaults and as outbound.rest.defaults.resilience',
      'LEGACY_AND_NEW_SAME_LAYER',
    );
  }
  const policy = expandPolicyRef(
    name,
    options.resilience ?? moduleDefault,
    input.runtime.options.policies,
  );
  if (policy === false) return false;
  const layer: Record<string, unknown> = { ...policy };
  if (options.retry !== undefined) layer.retry = retryAlias(name, options.retry, policy, input);
  if (options.timeoutMs !== undefined)
    layer.timeout = timeoutAlias(name, options.timeoutMs, policy);
  return Object.keys(layer).length === 0 && policy === undefined ? undefined : layer;
}

function retryAlias(
  name: string,
  retry: NonNullable<OutboundRestOptions['retry']>,
  policy: ResiliencePolicy | undefined,
  input: OutboundResilienceInput,
): unknown {
  if (policy?.retry !== undefined) {
    throw new ResilienceDefinitionError(
      name,
      'retry',
      'is set both as retry and as resilience.retry',
    );
  }
  if (retry === false) return false;
  // The 0.9.0 alias keeps its field-by-field merge across binding and module (section 1).
  const legacy = input.legacyRetry;
  if (legacy !== undefined) {
    return { enabled: true, maxAttempts: legacy.maxAttempts, [LEGACY_ALIAS]: legacyMark(legacy) };
  }
  const mark =
    input.legacyRetry === undefined ? {} : { [LEGACY_ALIAS]: legacyMark(input.legacyRetry) };
  return { ...retry, ...mark };
}

function timeoutAlias(
  name: string,
  timeoutMs: number,
  policy: ResiliencePolicy | undefined,
): unknown {
  const timeout = policy?.timeout === false ? undefined : policy?.timeout;
  if (timeout?.perAttemptMs !== undefined) {
    throw new ResilienceDefinitionError(
      name,
      'timeout.perAttemptMs',
      'is set both as timeoutMs and as resilience.timeout.perAttemptMs',
    );
  }
  return { ...timeout, perAttemptMs: timeoutMs, [LEGACY_ALIAS]: true };
}

/** RS-33: ad-hoc options cannot hold state; module stateful primitives are skipped with a warn. */
function adHocLayers(
  name: string,
  own: PolicyLayer,
  moduleLayer: PolicyLayer,
  runtime: ResilienceRuntime,
): PolicyLayer[] {
  for (const primitive of STATEFUL) {
    const value = own === false ? undefined : own?.[primitive];
    if (value !== undefined && value !== false) {
      throw new ResilienceDefinitionError(
        name,
        primitive,
        'is not allowed on ad-hoc request options',
      );
    }
  }
  if (moduleLayer === undefined || moduleLayer === false || own === false) return [own];
  const stripped: Record<string, unknown> = { ...moduleLayer };
  const skipped = STATEFUL.filter(
    (primitive) => stripped[primitive] !== undefined && stripped[primitive] !== false,
  );
  for (const primitive of skipped) delete stripped[primitive];
  if (skipped.length > 0 && runtime.observer.allowed(`adhoc:${name}`)) {
    runtime.observer.logger.warn(
      `outbound rest '${name}': module ${skipped.join(', ')} not applied to ad-hoc request options`,
    );
  }
  return [own, stripped];
}

function methodsOf(
  layers: readonly PolicyLayer[],
  legacy: LegacyRetrySource | undefined,
): ReadonlySet<string> {
  for (const layer of layers) {
    if (layer === false) break;
    const retry = layer?.retry as { methods?: readonly string[] } | false | undefined;
    if (retry !== undefined && retry !== false && retry.methods !== undefined)
      return new Set(retry.methods);
  }
  return legacy?.methods ?? new Set();
}

function restAdapter(methods: ReadonlySet<string>): ResilienceEdgeAdapter {
  return {
    kind: 'outbound-rest',
    classify: (error) => defaultRestClassifier(error),
    repeatable: (ctx) => {
      const { method, idempotencyKey } = dataOf(ctx).request;
      return SAFE_METHODS.has(method) || idempotencyKey !== undefined || methods.has(method);
    },
    safe: (ctx) => SAFE_METHODS.has(dataOf(ctx).request.method),
    idempotencyKey: (ctx) => dataOf(ctx).request.idempotencyKey,
    timeoutError: (ctx, timeoutMs) => {
      const { request } = dataOf(ctx);
      const info = {
        binding: request.name,
        url: request.url,
        method: request.method,
        attempts: ctx.attempt,
      };
      return new OutboundTimeoutError(info, timeoutMs);
    },
  };
}

function assertBinding(name: string, plan: ResiliencePlan, input: OutboundResilienceInput): void {
  if (plan.retry?.requireIdempotencyKey === true && !input.idempotencyEnabled) {
    throw new ResilienceDefinitionError(
      name,
      'retry.requireIdempotencyKey',
      'needs idempotency enabled on the binding',
    );
  }
}

/** Resolves the resilience plan and executor of an outbound REST binding (RS-33..RS-35). */
export function resolveOutboundResilience(
  name: string,
  input: OutboundResilienceInput,
): OutboundResiliencePlan {
  const own = layerOf(name, input.binding, input);
  const moduleLayer = layerOf(
    name,
    input.defaults ?? {},
    input,
    input.runtime.options.defaults?.['outbound-rest'],
  );
  const layers = input.adHoc
    ? adHocLayers(name, own, moduleLayer, input.runtime)
    : [own, moduleLayer];
  const plan = input.runtime.plan(name, layers, 'outbound-rest', { defaultPerAttemptMs: 30_000 });
  assertBinding(name, plan, input);
  const executor = input.runtime.executor<unknown>(
    plan,
    restAdapter(methodsOf(layers, input.legacyRetry)),
    {
      fallbackChannel: input.runtime.channelFallback(),
    },
  );
  const resolved: OutboundResiliencePlan = {
    plan,
    executor,
    budgetHeader: input.runtime.budgetHeader,
  };
  const summary = describePolicy(plan);
  if (summary !== undefined) resolved.summary = summary;
  return resolved;
}

export { ResilienceRuntime };
