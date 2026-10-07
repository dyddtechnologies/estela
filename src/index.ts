/**
 * @estela/nest: public barrel.
 *
 * Exports are grouped by the build phase that introduced them (PLAN-arquitectura.md sec.10):
 * phase 1 message/trace, 2 channels, 3 registry/dispatcher, 4 flow, 5 idempotency,
 * 6 decorators, 7 inbound, 8 gateway/adapters, 9 graph, 10 IntegrationModule, then sagas.
 *
 * Rule (enforced by dependency-cruiser): this file never imports amqplib or @grpc/grpc-js,
 * directly or transitively. The saga Postgres adapters have zero npm imports, so they are safe here.
 */
import { version } from '../package.json';

export const INTEGRATION_LIBRARY_VERSION: string = version;

// ---------- Phase 1: message kernel + trace ----------
export * from './message';
export * from './trace/trace-context';
export * from './trace/hop-logger';
export { ESTELA_BANNER, ESTELA_BANNER_ENV, printEstelaBanner } from './trace/banner';

// ---------- Phase 2: channels ----------
export * from './channel';
export * from './channels/channel-deps';
export * from './channels/glob';
export * from './channels/direct.channel';
export * from './channels/queue.channel';
export * from './channels/pubsub.channel';
export * from './channels/fanout.channel';

// ---------- Phase 3: factory + registry + dispatcher ----------
export * from './channel-factory';
export * from './message-dispatcher';
export * from './channel-registry';

// ---------- Phase 4: flow engine ----------
export * from './flow/flow-step';
export * from './flow/integration-flow';
export * from './flow/flow-executor';

// ---------- Phase 5: idempotency ----------
export * from './idempotency/idempotency-store';
export * from './idempotency/memory-idempotency.store';
export * from './idempotency/noop-idempotency.store';
export * from './idempotency/idempotency.service';

// ---------- Phase 6: decorators + activator wrapper ----------
export * from './decorators';
export * from './activator/activator-wrapper';

// ---------- Phase 7: inbound ----------
export * from './inbound/inbound.types';
export * from './inbound/inbound.transport';
export * from './inbound/inbound.decorators';
export * from './inbound/inbound.interceptor';
export * from './inbound/inbound.explorer';
export * from './inbound/inbound.swagger';
export {
  HttpExceptionFailureCodec,
  INBOUND_STORED_FAILURE_KEY,
  InboundIdempotencyInFlightError,
  InboundReplayedFailureError,
  markInboundFailure,
  readInboundFailureMark,
} from './inbound/inbound.failure';
export { encodeInboundKey } from './inbound/inbound.idempotency';
export { envelopeReplyMapper, rawReplyMapper } from './inbound/inbound.reply';

// ---------- Phase 8: gateway + outbound adapters ----------
export * from './channels/one-shot';
export * from './gateway/reply-gateway';
export * from './adapters/rest.adapter';
export * from './adapters/grpc.adapter';
export * from './adapters/rabbit.adapter';

// ---------- Outbound: adaptable request/reply REST ----------
export * from './outbound/outbound.types';
export * from './outbound/outbound.errors';
export * from './outbound/outbound.decorators';
export * from './outbound/outbound-rest.gateway';
export {
  DEFAULT_OUTBOUND_IDEMPOTENCY_HEADER,
  DEFAULT_OUTBOUND_MAX_ATTEMPTS,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
} from './outbound/outbound.plan';
export { formSerializer, jsonSerializer, textSerializer } from './outbound/outbound.serializers';

// ---------- Phase 9: graph ----------
export * from './graph/channel-graph';
export * from './graph/channel-graph.controller';

// ---------- Phase 10: root module ----------
export * from './integration.module';

// ---------- Saga: units of work, outbound boundaries, transactional idempotency ----------
export * from './saga/transaction-port';
export * from './saga/idempotency-ledger';
export * from './saga/saga';
export * from './saga/saga-runner';
export * from './saga/concurrency-errors';
export * from './saga/lock-port';
export * from './saga/state-machine';
export * from './saga/transition';
export * from './saga/postgres/index';
