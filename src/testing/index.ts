/**
 * @estela/nest/testing: public testing subpath (spec sec.14).
 * Rule (enforced by dependency-cruiser): never imports from src/inbound or src/adapters.
 */
import { awaitFirstMessage } from '../channels/one-shot';
import type { Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { FlowDefinition } from '../flow/integration-flow';
import { FlowExecutor, type FlowDeps, type FlowIdempotencyPort } from '../flow/flow-executor';
import { FlowParameterResolver, type ResolvedFlow } from '../flow/flow-parameter-resolver';
import type { ResilienceRuntime } from '../resilience/runtime';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';

export { MemoryIdempotencyStore };
export { MemoryLockPort } from './memory-lock-port';
export { MemoryTransitionPort } from './memory-transition-port';
export { testUnitOfWork, type TestUnitOfWork } from './test-unit-of-work';
export { manualResilienceClock, type ManualResilienceClock } from './manual-resilience-clock';
export { MemoryResilienceStatePort } from './memory-resilience-state-port';
export { collectResilienceEvents } from './resilience-events';

/** Semantic alias from spec sec.14: same invariants as `createMessage`. */
export function createTestMessage<T>(
  payload: T,
  headers?: MessageHeadersInit,
): IntegrationMessage<T> {
  return createMessage(payload, headers);
}

export interface BindFlowOptions {
  trace?: FlowDeps['trace'];
  idempotency?: FlowIdempotencyPort;
  idempotencyTtlMs?: number;
  errorChannel?: string;
  /**
   * Resilience runtime (SPI-445): the flow's parameters are resolved like at module boot
   * (`FlowParameterResolver`), so policies, budget and degraded marks run without Nest.
   * Declare channel policies with `runtime.declareChannels(specs)` before binding.
   */
  resilience?: ResilienceRuntime;
}

function resolveOne(
  definition: FlowDefinition,
  registry: ChannelRegistry,
  runtime: ResilienceRuntime | undefined,
): ResolvedFlow | undefined {
  if (runtime === undefined) return undefined;
  return new FlowParameterResolver(runtime, registry).resolve([definition]).flows[0];
}

/**
 * `bindFlow(flow, registry)` (spec sec.14): ensures error.channel and the source channel,
 * builds the executor with defaults and subscribes it to the source channel.
 */
export function bindFlow(
  definition: FlowDefinition,
  registry: ChannelRegistry,
  options: BindFlowOptions = {},
): FlowExecutor {
  const errorChannel = options.errorChannel ?? 'error.channel';
  if (registry.tryGet(errorChannel) === undefined) {
    registry.create({ name: errorChannel, type: 'pubsub' });
  }
  const runtime = options.resilience;
  const resolved = resolveOne(definition, registry, runtime);
  const built = resolved?.built ?? definition.build().build();
  if (registry.tryGet(built.source) === undefined) {
    registry.create({ name: built.source, type: 'direct' });
  }
  const deps: FlowDeps = { registry, trace: options.trace ?? registry.trace, errorChannel };
  if (options.idempotency !== undefined) deps.idempotency = options.idempotency;
  if (options.idempotencyTtlMs !== undefined) deps.idempotencyTtlMs = options.idempotencyTtlMs;
  if (runtime !== undefined) deps.resilience = runtime;
  if (resolved !== undefined) deps.policies = resolved.policies;
  const executor = new FlowExecutor(definition.name, built, deps);
  executor.attachTo(registry);
  return executor;
}

/** `waitFor(channel, timeout)` (spec sec.14): first message of the channel, or throw. */
export async function waitFor(
  registry: ChannelRegistry,
  channel: string,
  timeoutMs = 2_000,
): Promise<IntegrationMessage> {
  return awaitFirstMessage(registry.get(channel), {
    timeoutMs,
    name: channel,
    timeoutError: () => new Error(`waitFor('${channel}') timeout ${timeoutMs}ms`),
  });
}

/** Extra helper: collecting subscription for deterministic asserts. */
export function collect<T = unknown>(
  registry: ChannelRegistry,
  channel: string,
  pick: (msg: IntegrationMessage) => T = (msg) => msg.payload as T,
): { received: T[]; unsubscribe: Unsubscribe } {
  const received: T[] = [];
  const unsubscribe = registry.get(channel).subscribe((msg) => {
    received.push(pick(msg));
  });
  return { received, unsubscribe };
}
