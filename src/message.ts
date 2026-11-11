import { randomUUID } from 'node:crypto';

/**
 * Pure message domain (spec sec.4).
 * Rules of plan sec.9.1: helpers never mutate the input message;
 * they always return copies (Prototype, GoF).
 */

/** One hop the message went through (spec sec.4). */
export interface HistoryHop {
  channel: string;
  component?: string;
  adapter?: string;
  at: number;
}

/** Hop descriptor; `at` is generated when missing. */
export interface HistoryHopInput {
  channel: string;
  component?: string;
  adapter?: string;
  at?: number;
}

export interface MessageHeaders {
  id: string;
  timestamp: number;
  correlationId: string;
  causationId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  replyChannel?: string;
  errorChannel?: string;
  routingKey?: string;
  contentType?: string;
  source?: string;
  idempotencyKey?: string;
  history: HistoryHop[];
  jumpReplies?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IntegrationMessage<T = unknown> {
  payload: T;
  headers: MessageHeaders;
}

/** Partial init for `createMessage`; unknown keys pass through as custom headers. */
export interface MessageHeadersInit {
  id?: string;
  timestamp?: number;
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  replyChannel?: string;
  errorChannel?: string;
  routingKey?: string;
  contentType?: string;
  source?: string;
  idempotencyKey?: string;
  history?: HistoryHop[];
  jumpReplies?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * `replyChannel` precedence of the hop (plan sec.8.1, mandatory):
 * - `'inherit'`: copy the parent's (to/route: the target activator may close the inbound).
 * - `'none'`: no reply (wireTap/fanout/publish: never closes the inbound).
 * - `string`: its own ephemeral channel (jump -> `reply.<uuid>`).
 */
export type ReplyHopOption = 'inherit' | 'none' | (string & {});

/** Internal marker of the ephemeral jump hop (ADR-014); informational, not public. */
export const JUMP_REPLY_HEADER = 'x-integration-jump-reply';

export interface NextHopOptions {
  reply?: ReplyHopOption;
}

/** Unique id; `crypto.randomUUID` with a simple fallback for degraded environments. */
export function newId(): string {
  try {
    return randomUUID();
  } catch {
    // eslint-disable-next-line sonarjs/pseudo-random -- fallback only when crypto is missing
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function setIfDefined(headers: MessageHeaders, key: string, value: unknown): void {
  if (value !== undefined) (headers as Record<string, unknown>)[key] = value;
}

function makeHop(hop: HistoryHopInput): HistoryHop {
  const made: HistoryHop = { channel: hop.channel, at: hop.at ?? Date.now() };
  if (hop.component !== undefined) made.component = hop.component;
  if (hop.adapter !== undefined) made.adapter = hop.adapter;
  return made;
}

/**
 * Generates `id`, `traceId` (fallback = id), `spanId`, `correlationId` (fallback = id)
 * and `history: []` (spec sec.4). Given headers take precedence; unknown keys are
 * copied as custom headers.
 */
export function createMessage<T>(payload: T, init?: MessageHeadersInit): IntegrationMessage<T> {
  const h: MessageHeadersInit = init ?? {};
  const id = h.id ?? newId();
  const headers: MessageHeaders = {
    id,
    timestamp: h.timestamp ?? Date.now(),
    correlationId: h.correlationId ?? id,
    traceId: h.traceId ?? id,
    spanId: h.spanId ?? newId(),
    history: h.history ?? [],
  };
  setIfDefined(headers, 'causationId', h.causationId);
  setIfDefined(headers, 'parentSpanId', h.parentSpanId);
  setIfDefined(headers, 'replyChannel', h.replyChannel);
  setIfDefined(headers, 'errorChannel', h.errorChannel);
  setIfDefined(headers, 'routingKey', h.routingKey);
  setIfDefined(headers, 'contentType', h.contentType);
  setIfDefined(headers, 'source', h.source);
  setIfDefined(headers, 'idempotencyKey', h.idempotencyKey);
  setIfDefined(headers, 'jumpReplies', h.jumpReplies);
  for (const [key, value] of Object.entries(h)) {
    if (!(key in headers) && value !== undefined) {
      (headers as Record<string, unknown>)[key] = value;
    }
  }
  return { payload, headers };
}

/** WireTap: same id; history copied a un array new. */
export function copyMessage<T>(msg: IntegrationMessage<T>): IntegrationMessage<T> {
  return { payload: msg.payload, headers: { ...msg.headers, history: [...msg.headers.history] } };
}

/** Appends a hop and keeps the id (used by the dispatcher when passing a channel). */
export function recordHop<T>(
  msg: IntegrationMessage<T>,
  hop: HistoryHopInput,
): IntegrationMessage<T> {
  return {
    payload: msg.payload,
    headers: { ...msg.headers, history: [...msg.headers.history, makeHop(hop)] },
  };
}

/**
 * New pipeline hop: keeps `traceId`, `correlationId`, `idempotencyKey`,
 * `jumpReplies` (and extras); new `id`/`spanId`; `causationId = prev.id`;
 * `parentSpanId = prev.spanId`; appends to history (spec sec.4).
 * `options.reply` decides the `replyChannel` (plan sec.8.1).
 */
export function nextHop<T>(
  msg: IntegrationMessage<T>,
  hop: Omit<HistoryHopInput, 'at'>,
  options?: NextHopOptions,
): IntegrationMessage<T> {
  const prev = msg.headers;
  const mode: ReplyHopOption = options?.reply ?? 'inherit';
  const headers: MessageHeaders = {
    ...prev,
    id: newId(),
    timestamp: Date.now(),
    spanId: newId(),
    causationId: prev.id,
    parentSpanId: prev.spanId,
    history: [...prev.history, makeHop(hop)],
  };
  if (mode === 'inherit') {
    if (prev.replyChannel !== undefined) headers.replyChannel = prev.replyChannel;
    else delete headers.replyChannel;
  } else if (mode === 'none') {
    delete headers.replyChannel;
  } else {
    headers.replyChannel = mode;
  }
  return { payload: msg.payload, headers };
}
