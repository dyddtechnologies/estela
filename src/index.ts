/**
 * @dyddtechnologies/estela — barrel publico.
 *
 * Fase 0 (scaffolding): placeholder compilable.
 * Los exports reales llegan por fase (PLAN-arquitectura.md sec.10):
 * Fase 1 -> message/trace · Fase 2 -> channels · Fase 3 -> registry/dispatcher ·
 * Fase 4 -> flow · Fase 5 -> idempotency · Fase 6 -> decoradores ·
 * Fase 7 -> inbound · Fase 8 -> gateway/adapters · Fase 9 -> graph ·
 * Fase 10 -> IntegrationModule.
 *
 * Rule (enforzada por dependency-cruiser): este archivo Never importa
 * amqplib ni @grpc/grpc-js, ni directa ni transitivamente.
 */
export const INTEGRATION_LIBRARY_VERSION = '0.1.0' as const;

// ---------- Fase 1: kernel de message + trace ----------
export * from './message';
export * from './trace/trace-context';

// ---------- Fase 2: channels ----------
export * from './channel';
export * from './channels/channel-deps';
export * from './channels/glob';
export * from './channels/direct.channel';
export * from './channels/queue.channel';
export * from './channels/pubsub.channel';
export * from './channels/fanout.channel';

// ---------- Fase 3: factory + registry + dispatcher ----------
export * from './channel-factory';
export * from './message-dispatcher';
export * from './channel-registry';

// ---------- Fase 4: flow engine ----------
export * from './flow/flow-step';
export * from './flow/integration-flow';
export * from './flow/flow-executor';

// ---------- Fase 5: idempotency ----------
export * from './idempotency/idempotency-store';
export * from './idempotency/memory-idempotency.store';
export * from './idempotency/noop-idempotency.store';
export * from './idempotency/idempotency.service';

// ---------- Fase 6: decoradores + activator wrapper ----------
export * from './decorators';
export * from './activator/activator-wrapper';

// ---------- Fase 7: inbound ----------
export * from './inbound/inbound.types';
export * from './inbound/inbound.transport';
export * from './inbound/inbound.decorators';
export * from './inbound/inbound.interceptor';
export * from './inbound/inbound.explorer';
export * from './inbound/inbound.swagger';

// ---------- Fase 8: gateway + outbound adapters ----------
export * from './channels/one-shot';
export * from './gateway/reply-gateway';
export * from './adapters/rest.adapter';
export * from './adapters/grpc.adapter';
export * from './adapters/rabbit.adapter';

// ---------- Fase 9: graph ----------
export * from './graph/channel-graph';
export * from './graph/channel-graph.controller';

// ---------- Fase 10: modulo root ----------
export * from './integration.module';
