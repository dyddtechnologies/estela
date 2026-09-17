/**
 * @acme/nest-integration/testing — subpath público de testing (spec §14).
 * Regla (enforzada por dependency-cruiser): NUNCA importa de src/inbound
 * ni src/adapters.
 */
import { awaitFirstMessage } from '../channels/one-shot';
import type { Unsubscribe } from '../channel';
import { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { FlowDefinition } from '../flow/integration-flow';
import { FlowExecutor, type FlowDeps, type FlowIdempotencyPort } from '../flow/flow-executor';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';

export { MemoryIdempotencyStore };

/** Alias semántico del spec §14 — mismas invariantes que `createMessage`. */
export function createTestMessage<T>(payload: T, headers?: MessageHeadersInit): IntegrationMessage<T> {
  return createMessage(payload, headers);
}

export interface BindFlowOptions {
  trace?: FlowDeps['trace'];
  idempotency?: FlowIdempotencyPort;
  idempotencyTtlMs?: number;
  errorChannel?: string;
}

/**
 * `bindFlow(flow, registry)` (spec §14): asegura error.channel y canal fuente,
 * construye el executor con defaults y lo suscribe al canal fuente.
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
  const built = definition.build().build();
  if (registry.tryGet(built.source) === undefined) {
    registry.create({ name: built.source, type: 'direct' });
  }
  const executor = new FlowExecutor(definition.name, built, {
    registry,
    trace: options.trace ?? registry.trace,
    errorChannel,
    ...(options.idempotency !== undefined ? { idempotency: options.idempotency } : {}),
    ...(options.idempotencyTtlMs !== undefined ? { idempotencyTtlMs: options.idempotencyTtlMs } : {}),
  });
  executor.attachTo(registry);
  return executor;
}

/** `waitFor(channel, timeout)` (spec §14): primer mensaje del canal o throw. */
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

/** Helper extra: suscripción de colección para asserts deterministas. */
export function collect<T = unknown>(
  registry: ChannelRegistry,
  channel: string,
  pick: (msg: IntegrationMessage) => T = (msg) => msg.payload as T,
): { received: T[]; unsubscribe: Unsubscribe } {
  const received: T[] = [];
  const unsubscribe = registry.get(channel).subscribe(async (msg) => {
    received.push(pick(msg));
  });
  return { received, unsubscribe };
}
