import type { ChannelRegistry } from '../channel-registry';
import { defaultRestClassifier } from '../resilience/classifiers';
import { planBLeaveRunner, type ChannelSendFn } from '../resilience/fallback';
import type { CareEdgeAdapter, CareExecutor } from '../resilience/executor';
import { CareConfigError } from '../resilience/resilience.errors';
import {
  describeCare,
  expandCareRef,
  LEGACY_ALIAS,
  type LegacyTriesMark,
  type CarePlan,
} from '../resilience/resilience.plan';
import type { CareContext, Care } from '../resilience/resilience.types';
import { CareEngine } from '../resilience/runtime';
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

/** One expanded level: care, `false` (no care here and below) or nothing. */
type CareLayer = Care | false | undefined;

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATEFUL = ['valve', 'lanes', 'pace'] as const;

/** Per-call data the REST adapter reads from `CareContext.data`. */
export interface RestAttemptData {
  ctx: OutboundCallContext;
  request: OutboundRestRequest;
  startedAt: number;
}

export interface OutboundCarePlan {
  plan: CarePlan;
  executor: CareExecutor<unknown>;
  summary?: string;
  /** Header that carries the tries left downstream. */
  triesLeftHeader: string;
}

/** 0.9.0 `retry` plan resolved by `outbound.plan.ts`, used to build the legacy mark. */
export interface LegacyTriesSource {
  maxAttempts: number;
  backoff: OutboundBackoffFn;
  retryOn: OutboundRetryClassifierFn;
  methods: ReadonlySet<string>;
}

export interface OutboundCareInput {
  binding: OutboundRestBinding;
  defaults: OutboundRestDefaults | undefined;
  runtime: CareEngine;
  legacyTries: LegacyTriesSource | undefined;
  idempotencyEnabled: boolean;
  adHoc: boolean;
  /** Where a plan B with `PlanBMode.Leave` leaves its message. */
  registry?: ChannelRegistry | undefined;
}

export function dataOf(ctx: CareContext): RestAttemptData {
  return ctx.data as RestAttemptData;
}

function exchangeOf(data: RestAttemptData, attempts: number): OutboundExchangeContext {
  return { ...data.ctx, request: data.request, attempts, durationMs: Date.now() - data.startedAt };
}

/** True when a binding or its module default opts into the care engine. */
export function usesCare(
  binding: OutboundRestOptions,
  defaults: OutboundRestDefaults | undefined,
  runtime?: CareEngine,
): boolean {
  return (
    usesOwnCare(binding, defaults) || runtime?.options.defaults?.['outbound-rest'] !== undefined
  );
}

function usesOwnCare(
  binding: OutboundRestOptions,
  defaults: OutboundRestDefaults | undefined,
): boolean {
  return binding.care !== undefined || defaults?.care !== undefined;
}

function legacyMark(source: LegacyTriesSource): LegacyTriesMark {
  return {
    tryAgainOn: (error, ctx) =>
      source.retryOn(error as never, exchangeOf(dataOf(ctx), ctx.tryNumber)),
    gap: (tryNumber, error) => Math.max(0, source.backoff(tryNumber, error as never)),
  };
}

/**
 * One layer of the plan: `care` plus the 0.9.0 `retry` / `timeoutMs` of the same options as
 * their 0.9.0 spellings. The same part in both spellings on one layer is refused (RS-35).
 */
// eslint-disable-next-line sonarjs/function-return-type -- a reference expands to care, false (cut) or nothing
function layerOf(
  name: string,
  options: OutboundRestOptions,
  input: OutboundCareInput,
  moduleDefault?: OutboundRestOptions['care'],
): CareLayer {
  if (options.care !== undefined && moduleDefault !== undefined) {
    throw new CareConfigError(
      name,
      'defaults.outbound-rest',
      'is set both as care.defaults and as outbound.rest.defaults.care',
      'LEGACY_AND_NEW_SAME_LAYER',
    );
  }
  const care = expandCareRef(name, options.care ?? moduleDefault, input.runtime.options.profiles);
  if (care === false) return false;
  const layer: Record<string, unknown> = { ...care };
  if (options.retry !== undefined) layer.tries = legacyTries(name, options.retry, care, input);
  if (options.timeoutMs !== undefined)
    layer.patience = legacyPatience(name, options.timeoutMs, care);
  return Object.keys(layer).length === 0 && care === undefined ? undefined : layer;
}

function legacyTries(
  name: string,
  retry: NonNullable<OutboundRestOptions['retry']>,
  care: Care | undefined,
  input: OutboundCareInput,
): unknown {
  if (care?.tries !== undefined) {
    throw new CareConfigError(
      name,
      'tries',
      'is set both as the 0.9.0 retry and as care.tries',
      'LEGACY_AND_NEW_SAME_LAYER',
    );
  }
  if (retry === false) return false;
  // The 0.9.0 spelling keeps its field-by-field merge across binding and module (section 1).
  const legacy = input.legacyTries;
  if (legacy !== undefined) {
    return { enabled: true, max: legacy.maxAttempts, [LEGACY_ALIAS]: legacyMark(legacy) };
  }
  return { enabled: true, max: retry.maxAttempts };
}

function legacyPatience(name: string, timeoutMs: number, care: Care | undefined): unknown {
  const patience = care?.patience === false ? undefined : care?.patience;
  if (patience?.eachTryMs !== undefined) {
    throw new CareConfigError(
      name,
      'patience.eachTryMs',
      'is set both as the 0.9.0 timeoutMs and as care.patience.eachTryMs',
      'LEGACY_AND_NEW_SAME_LAYER',
    );
  }
  return { ...patience, eachTryMs: timeoutMs, [LEGACY_ALIAS]: true };
}

/** RS-33: ad-hoc options cannot hold state; module stateful parts are skipped with a warn. */
function adHocLayers(
  name: string,
  own: CareLayer,
  moduleLayer: CareLayer,
  runtime: CareEngine,
): CareLayer[] {
  for (const part of STATEFUL) {
    const value = own === false ? undefined : own?.[part];
    if (value !== undefined && value !== false) {
      throw new CareConfigError(name, part, 'is not allowed on ad-hoc request options');
    }
  }
  if (moduleLayer === undefined || moduleLayer === false || own === false) return [own];
  const stripped: Record<string, unknown> = { ...moduleLayer };
  const skipped = STATEFUL.filter(
    (part) => stripped[part] !== undefined && stripped[part] !== false,
  );
  for (const part of skipped) delete stripped[part];
  if (skipped.length > 0 && runtime.observer.allowed(`adhoc:${name}`)) {
    runtime.observer.logger.warn(
      `outbound rest '${name}': module ${skipped.join(', ')} not applied to ad-hoc request options`,
    );
  }
  return [own, stripped];
}

function methodsOf(
  layers: readonly CareLayer[],
  legacy: LegacyTriesSource | undefined,
): ReadonlySet<string> {
  for (const layer of layers) {
    if (layer === false) break;
    const tries = layer?.tries as { methods?: readonly string[] } | false | undefined;
    if (tries !== undefined && tries !== false && tries.methods !== undefined)
      return new Set(tries.methods);
  }
  return legacy?.methods ?? new Set();
}

function restAdapter(methods: ReadonlySet<string>): CareEdgeAdapter {
  return {
    kind: 'outbound-rest',
    classify: (error) => defaultRestClassifier(error),
    repeatable: (ctx) => {
      const { method, idempotencyKey } = dataOf(ctx).request;
      return SAFE_METHODS.has(method) || idempotencyKey !== undefined || methods.has(method);
    },
    safe: (ctx) => SAFE_METHODS.has(dataOf(ctx).request.method),
    idempotencyKey: (ctx) => dataOf(ctx).request.idempotencyKey,
    overdueError: (ctx, eachTryMs) => {
      const { request } = dataOf(ctx);
      const info = {
        binding: request.name,
        url: request.url,
        method: request.method,
        attempts: ctx.tryNumber,
      };
      return new OutboundTimeoutError(info, eachTryMs);
    },
  };
}

function assertBinding(name: string, plan: CarePlan, input: OutboundCareInput): void {
  if (plan.tries?.requireIdempotencyKey === true && !input.idempotencyEnabled) {
    throw new CareConfigError(
      name,
      'tries.requireIdempotencyKey',
      'needs idempotency enabled on the binding',
    );
  }
}

function sendOn(registry: ChannelRegistry | undefined): ChannelSendFn | undefined {
  return registry === undefined
    ? undefined
    : (channel, payload, headers) => registry.send(channel, payload, headers);
}

/** Resolves the care plan and executor of an outbound REST binding (RS-33..RS-35). */
export function resolveOutboundCare(name: string, input: OutboundCareInput): OutboundCarePlan {
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
  const plan = input.runtime.plan(name, layers, 'outbound-rest', { defaultEachTryMs: 30_000 });
  assertBinding(name, plan, input);
  const executor = input.runtime.executor<unknown>(
    plan,
    restAdapter(methodsOf(layers, input.legacyTries)),
    {
      planBChannel: input.runtime.channelPlanB(),
      planBLeave: planBLeaveRunner(sendOn(input.registry)),
    },
  );
  const resolved: OutboundCarePlan = {
    plan,
    executor,
    triesLeftHeader: input.runtime.triesLeftHeader,
  };
  const summary = describeCare(plan);
  if (summary !== undefined) resolved.summary = summary;
  return resolved;
}

export { CareEngine };
