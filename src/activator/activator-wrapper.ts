import type { SubscribeOptions, Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { ACTIVATOR_METADATA, type ActivatorMetadata } from '../decorators';
import { createMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from '../message';
import { serializeError } from '../flow/flow-step';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import type { TraceContext } from '../trace/trace-context';
import type { HopLogger } from '../trace/hop-logger';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import type { CareEdgeAdapter, CareExecutor } from '../resilience/executor';
import { describeCare } from '../resilience/resilience.plan';
import {
  CareScope,
  parseTriesLeft,
  PLAN_B_HEADER,
  TRIES_LEFT_MESSAGE_HEADER,
} from '../resilience/retry-budget';
import type { CareEngine } from '../resilience/runtime';
import { TryOverdueError } from '../resilience/timeout';

export interface ActivatorDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  errorChannel: string;
  idempotency?: IdempotencyService;
  idempotencyTtlMs?: number;
  logger?: HopLogger;
  /** Care engine: message scopes, the plan B mark and `@ServiceActivator({ care })`. */
  care?: CareEngine;
}

interface ActivatorCare {
  executor?: CareExecutor<unknown>;
  summary?: string;
}

/** Per runtime, then per decorated method: two modules never share an executor. */
const resolved = new WeakMap<object, WeakMap<ActivatorMetadata, ActivatorCare>>();
const NO_RUNTIME = {};

function activatorAdapter(scope: string): CareEdgeAdapter {
  const keyOf = (msg: IntegrationMessage | undefined): string | undefined =>
    typeof msg?.headers.idempotencyKey === 'string' ? msg.headers.idempotencyKey : undefined;
  return {
    kind: 'activator',
    classify: (error) => defaultInProcessClassifier(error),
    repeatable: (ctx) => keyOf(ctx.message) !== undefined,
    safe: () => false,
    idempotencyKey: (ctx) => keyOf(ctx.message),
    overdueError: (_ctx, eachTryMs) => new TryOverdueError(scope, eachTryMs),
  };
}

/**
 * Resolves (once per decorated method) the care of an activator: its own
 * `@ServiceActivator({ care })` (L4), the `care` of its channel (L2, RS-56) and
 * `defaults.activator` (L1). Invalid care or unknown profiles throw `CareConfigError` when
 * the activator is subscribed (RS-03).
 */
export function activatorCare(binding: ActivatorBinding, deps: ActivatorDeps): ActivatorCare {
  const runtime = deps.care;
  const perRuntime =
    resolved.get(runtime ?? NO_RUNTIME) ?? new WeakMap<ActivatorMetadata, ActivatorCare>();
  resolved.set(runtime ?? NO_RUNTIME, perRuntime);
  const cached = perRuntime.get(binding.metadata);
  if (cached !== undefined) return cached;
  const result = runtime === undefined ? {} : resolveActivator(binding, runtime);
  perRuntime.set(binding.metadata, result);
  return result;
}

function resolveActivator(binding: ActivatorBinding, runtime: CareEngine): ActivatorCare {
  const layers = [
    binding.metadata.care,
    runtime.channelCareRef(binding.metadata.channel),
    runtime.options.defaults?.activator,
  ];
  const result: ActivatorCare = {};
  if (layers.every((layer) => layer === undefined)) return result;
  const scope = activatorScope(binding);
  const plan = runtime.plan(scope, layers, 'activator');
  if (plan.tries !== undefined && plan.tries.max > 1 && !plan.tries.idempotent) {
    runtime.observer.logger.warn(
      `${scope}: care.tries.max > 1 without idempotent: true; only messages with an idempotencyKey get extra tries`,
    );
  }
  result.executor = runtime.executor(plan, activatorAdapter(scope), {
    planBChannel: runtime.channelPlanB(),
  });
  const summary = describeCare(plan);
  if (summary !== undefined) result.summary = summary;
  return result;
}

function activatorScope(binding: ActivatorBinding): string {
  return `activator:${binding.instance.constructor.name}.${binding.methodName}`;
}

export interface ActivatorBinding {
  instance: object;
  methodName: string;
  metadata: ActivatorMetadata;
}

/** Reads the decorated bindings of a prototype chain (Discovery). */
// Reflection over prototypes: any/unknown false positives here.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */
export function discoverActivators(instances: readonly object[]): ActivatorBinding[] {
  const bindings: ActivatorBinding[] = [];
  for (const instance of instances) {
    let proto: object | null = Object.getPrototypeOf(instance);
    while (proto !== null && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name) as
          PropertyDescriptor | undefined;
        if (descriptor === undefined || typeof descriptor.value !== 'function') continue;
        const metadata = Reflect.getMetadata(ACTIVATOR_METADATA, proto, name) as
          ActivatorMetadata | undefined;
        if (metadata !== undefined) bindings.push({ instance, methodName: name, metadata });
      }
      proto = Object.getPrototypeOf(proto);
    }
  }
  return bindings;
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */

export function subscribeActivators(
  bindings: readonly ActivatorBinding[],
  deps: ActivatorDeps,
): Unsubscribe[] {
  return bindings.map((binding) => subscribeActivator(binding, deps));
}

/** Subscribes one binding: the channel decides group/routingKey (spec sec.7.1). */
export function subscribeActivator(binding: ActivatorBinding, deps: ActivatorDeps): Unsubscribe {
  const channel = deps.registry.get(binding.metadata.channel);
  const scope = activatorScope(binding);
  activatorCare(binding, deps);
  const options: SubscribeOptions = {};
  if (binding.metadata.group !== undefined) options.group = binding.metadata.group;
  if (binding.metadata.routingKey !== undefined) options.routingKey = binding.metadata.routingKey;
  return channel.subscribe(
    (msg) => invokeActivator(binding, scope, msg, deps).then(() => undefined),
    options,
  );
}

/**
 * Template Method (spec sec.7.1): trace.run -> idem.begin(activator scope) -> method ->
 * `return !== undefined` + `replyChannel` -> reply (ephemeral jump replies included, see the
 * jump protocol in plan sec.9.5). Duplicate + cachedResult -> forward the cached result.
 * Error -> idem.fail + error.channel + rethrow (sec.8.2 awaited).
 */
export async function invokeActivator(
  binding: ActivatorBinding,
  scope: string,
  msg: IntegrationMessage,
  deps: ActivatorDeps,
): Promise<void> {
  const runtime = deps.care;
  if (runtime === undefined) return invokeInScope(binding, scope, msg, deps, undefined);
  // RS-27, RS-29: one message scope per dispatch, rebuilt from the headers (invariant 7).
  const triesLeft = runtime.enabled
    ? parseTriesLeft(msg.headers[TRIES_LEFT_MESSAGE_HEADER])
    : undefined;
  const value = {
    traceId: msg.headers.traceId,
    fromEventsChannel: binding.metadata.channel === runtime.eventsChannel,
    ...(triesLeft === undefined ? {} : { triesLeft }),
  };
  return CareScope.runMessage(value, (frame) => invokeInScope(binding, scope, msg, deps, frame));
}

async function invokeInScope(
  binding: ActivatorBinding,
  scope: string,
  msg: IntegrationMessage,
  deps: ActivatorDeps,
  frame: { planB(): boolean } | undefined,
): Promise<void> {
  const { registry } = deps;
  const idem = deps.idempotency;
  const key =
    typeof msg.headers.idempotencyKey === 'string' ? msg.headers.idempotencyKey : undefined;
  if (idem !== undefined && key !== undefined) {
    const acquired = await idem.begin(scope, key, deps.idempotencyTtlMs);
    if (!acquired) {
      await resendCachedResult(scope, key, msg, deps);
      return; // duplicate silent (spec sec.7.1 step 6)
    }
  }
  const method = (
    binding.instance as Record<string, ((...args: unknown[]) => unknown) | undefined>
  )[binding.methodName];
  if (method === undefined) {
    throw new Error(`activator: método '${binding.methodName}' no encontrado`);
  }
  try {
    const result = await runActivatorMethod(binding, scope, msg, deps, method);
    const planB = frame?.planB() === true;
    if (idem !== undefined && key !== undefined) await settleClaim(idem, scope, key, result, planB);
    await replyToCaller(result, msg, registry, planB);
  } catch (error) {
    if (idem !== undefined && key !== undefined) {
      await idem.fail(scope, key, error).catch(() => undefined);
    }
    await reportActivatorError(scope, msg, error, deps).catch(() => undefined);
    throw error;
  }
}

/** Invokes the activator method under the message trace, bracketed by the optional hop logger. */
async function runActivatorMethod(
  binding: ActivatorBinding,
  scope: string,
  msg: IntegrationMessage,
  deps: ActivatorDeps,
  method: (...args: unknown[]) => unknown,
): Promise<unknown> {
  const executor = deps.care === undefined ? undefined : activatorCare(binding, deps).executor;
  const direct = (): unknown => method.call(binding.instance, msg.payload, msg);
  const call =
    executor === undefined
      ? direct
      : async (): Promise<unknown> => {
          const context = {
            edge: 'activator' as const,
            binding: scope,
            channel: binding.metadata.channel,
            message: msg,
          };
          return (await executor.execute(context, () => Promise.resolve(direct()))).value;
        };
  const log = deps.logger;
  if (log === undefined) return deps.trace.runWithMessage(msg, call);
  const channel = binding.metadata.channel;
  const startedAt = Date.now();
  log.hopStart(channel, scope, msg.headers);
  try {
    const result = await deps.trace.runWithMessage(msg, call);
    log.hopEnd(channel, scope, msg.headers, true, Date.now() - startedAt);
    return result;
  } catch (error) {
    log.hopEnd(channel, scope, msg.headers, false, Date.now() - startedAt);
    throw error;
  }
}

function isJumpEphemeral(msg: IntegrationMessage): boolean {
  return msg.headers[JUMP_REPLY_HEADER] === '1'; // ADR-014 metadata (informational)
}

async function replyToCaller(
  result: unknown,
  msg: IntegrationMessage,
  registry: ChannelRegistry,
  planB = false,
): Promise<void> {
  const replyChannel = msg.headers.replyChannel;
  if (result === undefined || typeof replyChannel !== 'string' || replyChannel.length === 0) return;
  await registry.send(replyChannel, result, {
    correlationId: msg.headers.correlationId,
    traceId: msg.headers.traceId,
    causationId: msg.headers.id,
    parentSpanId: msg.headers.spanId,
    ...(planB ? { [PLAN_B_HEADER]: true } : {}),
  });
}

async function settleClaim(
  idem: IdempotencyService,
  scope: string,
  key: string,
  result: unknown,
  planB: boolean,
): Promise<void> {
  if (planB) {
    await settleWithoutStoring(idem, scope, key);
    return;
  }
  await idem.complete(
    scope,
    key,
    result !== undefined ? { cachedResult: result } : { completed: true },
  );
}

/** RS-27: a plan B result is never stored; the claim is released, else marked failed. */
async function settleWithoutStoring(
  idem: IdempotencyService,
  scope: string,
  key: string,
): Promise<void> {
  if (idem.supportsRelease) await idem.release(scope, key);
  else await idem.fail(scope, key, new Error('plan B result not stored'));
}

async function resendCachedResult(
  scope: string,
  key: string,
  msg: IntegrationMessage,
  deps: ActivatorDeps,
): Promise<void> {
  const idem = deps.idempotency;
  const record = idem !== undefined ? await idem.get(scope, key) : undefined;
  const cached =
    record?.result !== undefined && 'cachedResult' in record.result
      ? record.result.cachedResult
      : undefined;
  if (cached === undefined) return; // no cached result -> silence (spec sec.7.1)
  await replyToCaller(cached, msg, deps.registry);
}

async function reportActivatorError(
  scope: string,
  msg: IntegrationMessage,
  error: unknown,
  deps: ActivatorDeps,
): Promise<void> {
  const envelope = createMessage(
    {
      activator: scope,
      jumpEphemeral: isJumpEphemeral(msg),
      error: serializeError(error),
      causedBy: msg.headers.id,
    },
    {
      traceId: msg.headers.traceId,
      correlationId: msg.headers.correlationId,
      causationId: msg.headers.id,
      parentSpanId: msg.headers.spanId,
    },
  );
  await deps.registry.sendMessage(deps.errorChannel, envelope);
}
