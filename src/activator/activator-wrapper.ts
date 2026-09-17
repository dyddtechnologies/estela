import type { SubscribeOptions, Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { ACTIVATOR_METADATA, type ActivatorMetadata } from '../decorators';
import { createMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from '../message';
import { serializeError } from '../flow/flow-step';
import type { IdempotencyService } from '../idempotency/idempotency.service';
import type { TraceContext } from '../trace/trace-context';

export interface ActivatorDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  errorChannel: string;
  idempotency?: IdempotencyService;
  idempotencyTtlMs?: number;
}

export interface ActivatorBinding {
  instance: object;
  methodName: string;
  metadata: ActivatorMetadata;
}

/** Lee los bindings decorados de una jerarquía de prototipos (Discovery, Fase 10). */
// Reflexión sobre prototipos — falsos positivos de any/unknown aquí.
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

/** Suscribe un binding: el canal define group/routingKey (spec §7.1). */
export function subscribeActivator(binding: ActivatorBinding, deps: ActivatorDeps): Unsubscribe {
  const channel = deps.registry.get(binding.metadata.channel);
  const className = binding.instance.constructor.name;
  const scope = `activator:${className}.${binding.methodName}`;
  const options: SubscribeOptions = {};
  if (binding.metadata.group !== undefined) options.group = binding.metadata.group;
  if (binding.metadata.routingKey !== undefined) options.routingKey = binding.metadata.routingKey;
  return channel.subscribe(
    (msg) => invokeActivator(binding, scope, msg, deps).then(() => undefined),
    options,
  );
}

/**
 * Template Method (spec §7.1): trace.run → idem.begin(scope activator) → método →
 * `return !== undefined` + `replyChannel` → responder (jump efímero incluido —
 * protocolo jump; ver plan §9.5 corregido). Duplicado + cachedResult → reenvía
 * cache. Error → idem.fail + error.channel + rethrow (§8.2 awaited).
 */
export async function invokeActivator(
  binding: ActivatorBinding,
  scope: string,
  msg: IntegrationMessage,
  deps: ActivatorDeps,
): Promise<void> {
  const { registry, trace } = deps;
  const idem = deps.idempotency;
  const key =
    typeof msg.headers.idempotencyKey === 'string' ? msg.headers.idempotencyKey : undefined;
  if (idem !== undefined && key !== undefined) {
    const acquired = await idem.begin(scope, key, deps.idempotencyTtlMs);
    if (!acquired) {
      await resendCachedResult(scope, key, msg, deps);
      return; // duplicado silencioso (spec §7.1 paso 6)
    }
  }
  const method = (
    binding.instance as Record<string, ((...args: unknown[]) => unknown) | undefined>
  )[binding.methodName];
  if (method === undefined) {
    throw new Error(`activator: método '${binding.methodName}' no encontrado`);
  }
  try {
    const result = await trace.runWithMessage(msg, () =>
      method.call(binding.instance, msg.payload, msg),
    );
    if (idem !== undefined && key !== undefined) {
      await idem.complete(
        scope,
        key,
        result !== undefined ? { cachedResult: result } : { completed: true },
      );
    }
    await replyToCaller(result, msg, registry);
  } catch (error) {
    if (idem !== undefined && key !== undefined) {
      await idem.fail(scope, key, error).catch(() => undefined);
    }
    await reportActivatorError(scope, msg, error, deps).catch(() => undefined);
    throw error;
  }
}

function isJumpEphemeral(msg: IntegrationMessage): boolean {
  return msg.headers[JUMP_REPLY_HEADER] === '1'; // metadato ADR-014 (informativo)
}

async function replyToCaller(
  result: unknown,
  msg: IntegrationMessage,
  registry: ChannelRegistry,
): Promise<void> {
  const replyChannel = msg.headers.replyChannel;
  if (result === undefined || typeof replyChannel !== 'string' || replyChannel.length === 0) return;
  await registry.send(replyChannel, result, {
    correlationId: msg.headers.correlationId,
    traceId: msg.headers.traceId,
    causationId: msg.headers.id,
    parentSpanId: msg.headers.spanId,
  });
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
  if (cached === undefined) return; // sin cache → silencio (spec §7.1)
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
