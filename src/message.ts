import { randomUUID } from 'node:crypto';

/**
 * Dominio puro del mensaje (spec §4).
 * Reglas del plan §9.1: los helpers NUNCA mutan el mensaje de entrada —
 * siempre devuelven copias (Prototype, GoF).
 */

/** Un salto recorrido por el mensaje (spec §4). */
export interface HistoryHop {
  channel: string;
  component?: string;
  adapter?: string;
  at: number;
}

/** Descriptor de hop; `at` se genera si falta. */
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

/** Init parcial para `createMessage`; claves desconocidas pasan como headers custom. */
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
 * Precedencia del `replyChannel` del hop (plan §8.1 — obligatoria):
 * - `'inherit'`: copia el del padre (to/route — el activator destino puede cerrar el inbound).
 * - `'none'`: sin reply (wireTap/fanout/publish — nunca cierra el inbound).
 * - `string`: canal efímero propio (jump → `reply.<uuid>`).
 */
export type ReplyHopOption = 'inherit' | 'none' | (string & {});

/** Marcador interno del hop efímero de jump (ADR-014) — informativo, no público. */
export const JUMP_REPLY_HEADER = 'x-integration-jump-reply';

export interface NextHopOptions {
  reply?: ReplyHopOption;
}

/** ID único; `crypto.randomUUID` con fallback simple para entornos degradados. */
export function newId(): string {
  try {
    return randomUUID();
  } catch {
    // eslint-disable-next-line sonarjs/pseudo-random -- fallback solo si no hay crypto
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
 * Genera `id`, `traceId` (fallback = id), `spanId`, `correlationId` (fallback = id)
 * e `history: []` (spec §4). Headers provistos tienen precedencia; las claves
 * desconocidas se copian como headers custom.
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

/** WireTap: misma id; history copiado a un array nuevo. */
export function copyMessage<T>(msg: IntegrationMessage<T>): IntegrationMessage<T> {
  return { payload: msg.payload, headers: { ...msg.headers, history: [...msg.headers.history] } };
}

/** Anexa un hop conservando la id (uso del dispatcher al pasar por un canal). */
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
 * Nuevo hop del pipeline: conserva `traceId`, `correlationId`, `idempotencyKey`,
 * `jumpReplies` (y extras); nuevo `id`/`spanId`; `causationId = prev.id`;
 * `parentSpanId = prev.spanId`; append a history (spec §4).
 * El `replyChannel` se decide por `options.reply` (plan §8.1).
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
