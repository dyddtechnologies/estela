import type { IntegrationMessage } from '../message';
import { ChannelError } from '../channel';

/** Transportes inbound (spec §7.2 + extensión GraphQL ADR-015). */
export type InboundTransport = 'rest' | 'grpc' | 'rabbit' | 'graphql';

export type GraphqlOperation = 'query' | 'mutation' | 'subscription';

export interface InboundSpec {
  channel: string;
  transport: InboundTransport;
  /** default false — true requiere ReplyGateway (Fase 8). */
  requestReply?: boolean;
  timeoutMs?: number;
  /** default 'return' con fallback a body (spec §7.2). */
  payload?: 'return' | 'body';
  /** default true en REST (swagger helpers, Parte B). */
  swagger?: boolean;
  /** Solo GraphQL (ADR-017). */
  operation?: GraphqlOperation;
}

export const INBOUND_SPEC_METADATA = 'integration:inbound-spec';

export function readInboundSpec(handler: object): InboundSpec | undefined {
  return Reflect.getMetadata(INBOUND_SPEC_METADATA, handler) as InboundSpec | undefined;
}

// ---------- Shapes de respuesta (spec §7.2) ----------

export interface InboundAcceptedResponse {
  status: 'accepted';
  id: string;
  traceId: string;
  correlationId: string;
}

export interface InboundReplyResponse {
  status: 'ok';
  result: unknown;
  id: string;
  traceId: string;
  correlationId: string;
  headers: Record<string, string>;
}

export interface InboundDuplicateResponse {
  status: 'duplicate';
  idempotencyKey: string;
  replayed: boolean;
  result: unknown;
  traceId: string;
}

export type InboundResponse = InboundAcceptedResponse | InboundReplyResponse | InboundDuplicateResponse;

export class InboundError extends ChannelError {}

export function acceptedResponse(
  msg: IntegrationMessage,
  merge?: Record<string, unknown>,
): InboundAcceptedResponse {
  const base: InboundAcceptedResponse = {
    status: 'accepted',
    id: msg.headers.id,
    traceId: msg.headers.traceId,
    correlationId: msg.headers.correlationId,
  };
  if (merge === undefined) return base;
  return Object.assign({}, merge, base); // canónicos ganan (spec: "+ merge")
}

export function replyResponse(msg: IntegrationMessage, result: unknown): InboundReplyResponse {
  const headers: Record<string, string> = {};
  const set = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) headers[key] = value;
  };
  set('traceId', msg.headers.traceId);
  set('correlationId', msg.headers.correlationId);
  set('causationId', msg.headers.id);
  set('parentSpanId', msg.headers.spanId);
  return {
    status: 'ok',
    result,
    id: msg.headers.id,
    traceId: msg.headers.traceId,
    correlationId: msg.headers.correlationId,
    headers,
  };
}

export function duplicateResponse(
  idempotencyKey: string,
  opts: { result?: unknown; traceId?: string; replayed?: boolean } = {},
): InboundDuplicateResponse {
  return {
    status: 'duplicate',
    idempotencyKey,
    replayed: opts.replayed ?? true,
    result: opts.result ?? null,
    traceId: opts.traceId ?? '',
  };
}
