import { createMessage, type IntegrationMessage, type MessageHeadersInit } from '../message';
import type { InboundRepeat } from './inbound.idempotency';
import {
  acceptedResponse,
  duplicateResponse,
  replyResponse,
  type InboundKeyContext,
  type InboundReplyContext,
  type InboundReplyMapperFn,
  type InboundRequestContext,
  type InboundResponse,
} from './inbound.types';

/** Built-in `'envelope'` mapper: the estela envelope, unchanged. */
export const envelopeReplyMapper: InboundReplyMapperFn = (ctx) => ctx.envelope;

/**
 * Built-in `'raw'` mapper: the flow result for a reply, the handler result for an accepted
 * dispatch. A duplicate still answers the envelope; use `onDuplicate: 'replay'` to get the
 * raw result on repeats.
 */
export const rawReplyMapper: InboundReplyMapperFn = (ctx) => {
  if (ctx.kind === 'reply') return ctx.result;
  if (ctx.kind === 'accepted') return ctx.handlerResult;
  return ctx.envelope;
};

/** Outcome-specific fields of a reply context. */
export type InboundReplyOutcome = Pick<
  InboundReplyContext,
  'kind' | 'result' | 'replayed' | 'envelope' | 'message' | 'duplicateOf' | 'acceptedId'
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptedEnvelope(msg: IntegrationMessage, handlerResult: unknown): InboundResponse {
  // "+ merge" (spec sec.7.2): the canonical accepted fields win over the handler result.
  const accepted = acceptedResponse(msg);
  if (isPlainObject(handlerResult)) return Object.assign({}, handlerResult, accepted);
  return accepted;
}

export function replyOutcome(msg: IntegrationMessage, result: unknown): InboundReplyOutcome {
  return {
    kind: 'reply',
    result,
    replayed: false,
    envelope: replyResponse(msg, result),
    message: msg,
  };
}

export function acceptedOutcome(
  msg: IntegrationMessage,
  handlerResult: unknown,
): InboundReplyOutcome {
  return {
    kind: 'accepted',
    result: handlerResult,
    replayed: false,
    envelope: acceptedEnvelope(msg, handlerResult),
    message: msg,
  };
}

/** Outcome of a repeated key: a replay of the first answer or the duplicate envelope. */
export function repeatOutcome(
  repeat: InboundRepeat,
  ctx: InboundKeyContext,
  headersInit: MessageHeadersInit,
): InboundReplyOutcome {
  if (repeat.kind === 'reply') {
    const outcome = replyOutcome(createMessage(ctx.payload, headersInit), repeat.result);
    return { ...outcome, replayed: true };
  }
  if (repeat.kind === 'accepted') {
    // Rebuilt around the stored id, so the envelope repeats the id of the first answer.
    const message = createMessage(ctx.payload, { ...headersInit, id: repeat.acceptedId });
    const outcome = acceptedOutcome(message, ctx.handlerResult);
    return { ...outcome, replayed: true, acceptedId: repeat.acceptedId };
  }
  const opts: { result: unknown; traceId?: string } = { result: repeat.result };
  if (typeof headersInit.traceId === 'string') opts.traceId = headersInit.traceId;
  return {
    kind: 'duplicate',
    result: repeat.result ?? null,
    replayed: true,
    envelope: duplicateResponse(ctx.clientKey ?? '', opts),
    message: createMessage(ctx.payload, headersInit),
    duplicateOf: repeat.duplicateOf,
  };
}

/** Joins the request context, the client key and the outcome into what a mapper receives. */
export function buildReplyContext(
  request: InboundRequestContext,
  clientKey: string | undefined,
  outcome: InboundReplyOutcome,
): InboundReplyContext {
  return {
    ...request,
    ...outcome,
    ...(clientKey !== undefined ? { idempotencyKey: clientKey } : {}),
  };
}
