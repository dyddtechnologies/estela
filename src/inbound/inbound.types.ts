import type { ExecutionContext, Type } from '@nestjs/common';
import type { IntegrationMessage } from '../message';
import { ChannelError } from '../channel';
import type { IdempotencyStore } from '../idempotency/idempotency-store';

/** Transportes inbound (spec sec.7.2 + extension GraphQL ADR-015). */
export type InboundTransport = 'rest' | 'grpc' | 'rabbit' | 'graphql';

export type GraphqlOperation = 'query' | 'mutation' | 'subscription';

export interface InboundSpec {
  channel: string;
  transport: InboundTransport;
  /** default false — true requires ReplyGateway (Fase 8). */
  requestReply?: boolean;
  timeoutMs?: number;
  /** default 'return' con fallback a body (spec sec.7.2). */
  payload?: 'return' | 'body';
  /** default true en REST (swagger helpers, Parte B). */
  swagger?: boolean;
  /** Solo GraphQL (ADR-017). */
  operation?: GraphqlOperation;
  /** Reply contract of this endpoint. Default: module default, else `'envelope'`. */
  reply?: InboundReplyOption;
  /** Idempotency rules of this endpoint; `false` turns the inbound claim off. */
  idempotency?: false | InboundIdempotencyOptions;
}

export const INBOUND_SPEC_METADATA = 'integration:inbound-spec';

export function readInboundSpec(handler: object): InboundSpec | undefined {
  return Reflect.getMetadata(INBOUND_SPEC_METADATA, handler) as InboundSpec | undefined;
}

// ---------- Shapes de respuesta (spec sec.7.2) ----------

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

export type InboundResponse =
  InboundAcceptedResponse | InboundReplyResponse | InboundDuplicateResponse;

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
  return Object.assign({}, merge, base); // canonical win (spec: "+ merge")
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

// ---------- Adaptable reply and idempotency (0.6.0) ----------

/** DI token of a singleton provider. */
export type InboundProviderToken<T = unknown> = Type<T> | string | symbol;

/** Strategy resolved from the Nest container on the first request of the endpoint. */
export interface InboundProviderRef<T> {
  useExisting: InboundProviderToken<T>;
}

/** Port the interceptor uses to resolve `{ useExisting }` refs (wired to ModuleRef by the module). */
export interface InboundProviderResolver {
  resolve<T>(token: InboundProviderToken<T>): T;
}

/** What every inbound strategy receives about the request being dispatched. */
export interface InboundRequestContext<P = unknown> {
  spec: InboundSpec;
  /** Payload extracted by the transport strategy (handler return value or body). */
  payload: P;
  rawHeaders: Record<string, unknown>;
  handlerResult: unknown;
  /** Passed through untouched; estela never calls methods on it. */
  context: ExecutionContext;
  /** `Date.now()` taken when the interceptor was entered, before the handler ran. */
  receivedAt: number;
}

export interface InboundKeyContext<P = unknown> extends InboundRequestContext<P> {
  /** Key sent by the client, when present. */
  clientKey: string | undefined;
}

export type InboundReplyKind = 'reply' | 'accepted' | 'duplicate';

export interface InboundReplyContext<P = unknown, R = unknown> extends InboundRequestContext<P> {
  kind: InboundReplyKind;
  /** Flow reply (`reply`), handler result (`accepted`), cached result or null (`duplicate`). */
  result: R;
  /** True when the answer is served from an idempotency record. */
  replayed: boolean;
  /** Exactly what the default estela envelope answers for this kind. */
  envelope: InboundResponse;
  message: IntegrationMessage;
  /** Key sent by the client, never the composite storage key. */
  idempotencyKey?: string;
  /** Only when `kind === 'duplicate'`: state of the record that caused it. */
  duplicateOf?: 'in-flight' | 'completed' | 'failed';
  /** Stored message id when an accepted reply is replayed. */
  acceptedId?: string;
}

/** Function form of a reply mapper; may return a Promise. */
export type InboundReplyMapperFn<P = unknown, R = unknown> = {
  bivarianceHack(ctx: InboundReplyContext<P, R>): unknown;
}['bivarianceHack'];

/** Strategy that turns a dispatch outcome into the response of the endpoint. */
export interface InboundReplyMapper<P = unknown, R = unknown> {
  mapReply(ctx: InboundReplyContext<P, R>): unknown;
}

export type InboundReplyOption =
  | 'envelope'
  | 'raw'
  | InboundReplyMapperFn
  | InboundReplyMapper
  | InboundProviderRef<InboundReplyMapper>;

/** A string is stored verbatim; an array is escaped part by part and joined with `:`. */
export type InboundKeyParts = string | readonly (string | number)[];

export interface InboundKey {
  /** Overrides the scope of the endpoint for this request. */
  scope?: string;
  key: InboundKeyParts;
}

export type InboundResolvedKey = InboundKeyParts | InboundKey | undefined;

/**
 * Resolves the storage key; may throw (no claim is made) or return undefined (claim skipped).
 * Empty keys and empty or missing parts are rejected with an `InboundError`.
 */
export type InboundKeyResolverFn<P = unknown> = {
  bivarianceHack(ctx: InboundKeyContext<P>): InboundResolvedKey | Promise<InboundResolvedKey>;
}['bivarianceHack'];

export interface InboundKeyResolver<P = unknown> {
  resolveKey(ctx: InboundKeyContext<P>): InboundResolvedKey | Promise<InboundResolvedKey>;
}

/** Reads the client key from the request when a header name is not enough. */
export type InboundClientKeyFn<P = unknown> = {
  bivarianceHack(ctx: InboundRequestContext<P>): string | undefined;
}['bivarianceHack'];

/** What happens to a claimed key when the dispatch fails. */
export type InboundFailureAction = 'keep' | 'release' | 'store';

export type InboundFailureClassifierFn<P = unknown> = {
  bivarianceHack(
    error: unknown,
    ctx: InboundKeyContext<P>,
  ): InboundFailureAction | Promise<InboundFailureAction>;
}['bivarianceHack'];

export interface InboundFailureClassifier<P = unknown> {
  classify(
    error: unknown,
    ctx: InboundKeyContext<P>,
  ): InboundFailureAction | Promise<InboundFailureAction>;
}

/** (De)serialization of a failure stored for replay. */
export interface InboundFailureCodec {
  /** Must return JSON-safe data. */
  serialize(error: unknown): unknown;
  /** Returns the value thrown when the stored failure is replayed. */
  deserialize(stored: unknown): unknown;
}

/** Builds the value thrown when a repeat arrives while the first request is still running. */
export type InboundInFlightErrorFactory<P = unknown> = {
  bivarianceHack(ctx: InboundKeyContext<P>): unknown;
}['bivarianceHack'];

export interface InboundIdempotencyOptions {
  /** Default true. Not inherited from the module default when an endpoint passes an object. */
  enabled?: boolean;
  /** Header name(s), case-insensitive, or a function. Default: idempotency-key, x-idempotency-key. */
  clientKey?: string | readonly string[] | InboundClientKeyFn;
  /** Storage key resolver. Default: the client key alone. */
  key?: InboundKeyResolverFn | InboundKeyResolver | InboundProviderRef<InboundKeyResolver>;
  /** Default `inbound:<channel>`. */
  scope?: string;
  /** Default: the module idempotency ttl, else one hour. */
  ttlMs?: number;
  /** Default: the module IdempotencyService. */
  store?: IdempotencyStore | InboundProviderRef<IdempotencyStore>;
  /** `'envelope'` (default) answers the duplicate envelope; `'replay'` answers like the first time. */
  onDuplicate?: 'envelope' | 'replay';
  /** `'duplicate'` (default), `'reject'` (typed error) or a factory of the error to throw. */
  onInFlight?: 'duplicate' | 'reject' | InboundInFlightErrorFactory;
  /** Default `'keep'`. `'marker'` obeys only errors marked with `markInboundFailure`. */
  onFailure?:
    | InboundFailureAction
    | 'marker'
    | InboundFailureClassifierFn
    | InboundFailureClassifier
    | InboundProviderRef<InboundFailureClassifier>;
  /** Default: HttpExceptionFailureCodec. */
  failureCodec?: InboundFailureCodec | InboundProviderRef<InboundFailureCodec>;
  /**
   * What downstream flow and activator scopes see in `headers.idempotencyKey`: the client key
   * (`'raw'`), the storage key (`'resolved'`) or nothing (`'none'`). Default `'raw'`, or `'none'`
   * once `key` or an active failure policy is configured, and on a disabled `requestReply`
   * endpoint.
   */
  forward?: 'raw' | 'resolved' | 'none';
}

/** Module-wide defaults (`IntegrationModule.forRoot({ inbound })`); endpoints override them. */
export interface InboundDefaults {
  reply?: InboundReplyOption;
  idempotency?: false | InboundIdempotencyOptions;
}
