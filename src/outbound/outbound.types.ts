import type {
  InboundProviderRef,
  InboundProviderResolver,
  InboundProviderToken,
} from '../inbound/inbound.types';
import type { IntegrationMessage, MessageHeadersInit } from '../message';
import type { OutboundRestError } from './outbound.errors';

/** DI token of a singleton provider (same contract as the inbound adapters). */
export type OutboundProviderToken<T = unknown> = InboundProviderToken<T>;

/** Strategy resolved from the Nest container when the binding is declared. */
export type OutboundProviderRef<T> = InboundProviderRef<T>;

/** Port used to resolve `{ useExisting }` refs (wired to ModuleRef by the module). */
export type OutboundProviderResolver = InboundProviderResolver;

export const OUTBOUND_REST_METHODS = [
  'GET',
  'HEAD',
  'DELETE',
  'POST',
  'PUT',
  'PATCH',
  'OPTIONS',
] as const;

export type OutboundRestMethod = (typeof OUTBOUND_REST_METHODS)[number];

/** A method coming from data (a table row, a config file): validated when the call is built. */
export type OutboundRestMethodInput = OutboundRestMethod | (string & {});

export type OutboundQueryScalar = string | number | boolean;

/** `undefined` and `null` entries are skipped; an array repeats the parameter. */
export type OutboundQueryValue =
  OutboundQueryScalar | readonly OutboundQueryScalar[] | null | undefined;

export type OutboundQuery = Record<string, OutboundQueryValue>;

/** A string is sent verbatim; array parts are escaped (`%`, `:`) and joined with `:`. */
export type OutboundKeyParts = string | readonly (string | number)[];

// ---------- fetch port ----------

/** Structural response of the injected fetch; `headers` accepts a `Headers` or a plain record. */
export interface OutboundFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?:
    { forEach(callback: (value: string, name: string) => void): void } | Record<string, string>;
  text: () => Promise<string>;
}

export interface OutboundFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Injectable fetch; default `globalThis.fetch`. */
export type OutboundFetch = (
  url: string,
  init: OutboundFetchInit,
) => Promise<OutboundFetchResponse>;

// ---------- Request, response and strategy contexts ----------

/** What a caller hands to the gateway: a full message, or a payload with optional headers. */
export interface OutboundMessageInput<P = unknown> {
  payload: P;
  headers?: MessageHeadersInit;
}

/** Per-message target; every field overrides the static configuration of the binding. */
export interface OutboundRestTarget {
  url?: string;
  method?: OutboundRestMethodInput;
  /** Merged over the static and trace headers; `undefined` values are skipped. */
  headers?: Record<string, string | undefined>;
  /** Merged over the static query, key by key. */
  query?: OutboundQuery;
  /**
   * Body to serialize. Leave the property out to send the message payload; when the property
   * is present its value is used, and `undefined` sends no body. Never sent for GET or HEAD.
   */
  body?: unknown;
  timeoutMs?: number;
  /** Idempotency key of this call; wins over the key resolver. */
  idempotencyKey?: OutboundKeyParts;
  /**
   * Free-form data for the later strategies of the same call (header mapper, key resolver,
   * response and error mappers read it as `ctx.target.data`). Never sent.
   */
  data?: unknown;
}

/** Options of one `OutboundRestGateway.request` call; they win over target and binding. */
export interface OutboundRestCallOptions {
  timeoutMs?: number;
  idempotencyKey?: OutboundKeyParts;
  headers?: Record<string, string | undefined>;
}

/** What every outbound strategy receives about the message being delivered. */
export interface OutboundRequestContext<P = unknown> {
  /** Binding name: `name`, else the channel. */
  name: string;
  /** Channel the message arrived on; undefined for a direct gateway call. */
  channel?: string;
  message: IntegrationMessage<P>;
  payload: P;
}

/** Request context once the target is known. */
export interface OutboundCallContext<P = unknown> extends OutboundRequestContext<P> {
  /** What the target resolver returned for this message; `{}` for a static binding. */
  target: OutboundRestTarget;
  /** Final url, query string included. */
  url: string;
  method: OutboundRestMethod;
}

/** The HTTP request as sent. */
export interface OutboundRestRequest {
  name: string;
  url: string;
  method: OutboundRestMethod;
  headers: Record<string, string>;
  body?: string;
  /** 0 means no timeout. */
  timeoutMs: number;
  /** Key sent in the idempotency header, the same on every attempt. */
  idempotencyKey?: string;
}

/** Context of a finished attempt. */
export interface OutboundExchangeContext<P = unknown> extends OutboundCallContext<P> {
  request: OutboundRestRequest;
  /** Attempts made so far, the failed or answered one included. */
  attempts: number;
  /** Milliseconds since the first attempt started. */
  durationMs: number;
}

/** Default reply of a request/reply outbound call. */
export interface OutboundRestResponse<B = unknown> {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  /** JSON when the response is JSON, the text otherwise, `null` when empty. */
  body: B;
}

export interface OutboundResponseContext<
  P = unknown,
  B = unknown,
> extends OutboundExchangeContext<P> {
  response: OutboundRestResponse<B>;
}

// ---------- Strategies: a function, an instance, or `{ useExisting: token }` ----------

type MaybePromise<T> = T | Promise<T>;

export type OutboundTargetResolverFn<P = unknown> = {
  bivarianceHack(ctx: OutboundRequestContext<P>): MaybePromise<OutboundRestTarget>;
}['bivarianceHack'];

/** Resolves url, method, headers, query and body of each message. */
export interface OutboundTargetResolver<P = unknown> {
  resolveTarget(ctx: OutboundRequestContext<P>): MaybePromise<OutboundRestTarget>;
}

export type OutboundHeaderMapperFn<P = unknown> = {
  bivarianceHack(
    ctx: OutboundCallContext<P>,
  ): MaybePromise<Record<string, string | undefined> | undefined>;
}['bivarianceHack'];

/** Adds auth or propagated headers taken from the message. */
export interface OutboundHeaderMapper<P = unknown> {
  mapHeaders(
    ctx: OutboundCallContext<P>,
  ): MaybePromise<Record<string, string | undefined> | undefined>;
}

export interface OutboundSerializedBody {
  body?: string;
  /** Used unless a header of the call already sets `content-type`. */
  contentType?: string;
}

export type OutboundSerialized = OutboundSerializedBody | string | undefined;

export type OutboundBodySerializerFn<P = unknown> = {
  bivarianceHack(body: unknown, ctx: OutboundCallContext<P>): MaybePromise<OutboundSerialized>;
}['bivarianceHack'];

export interface OutboundBodySerializer<P = unknown> {
  serialize(body: unknown, ctx: OutboundCallContext<P>): MaybePromise<OutboundSerialized>;
}

export type OutboundResponseMapperFn<P = unknown, B = unknown> = {
  bivarianceHack(ctx: OutboundResponseContext<P, B>): unknown;
}['bivarianceHack'];

/** Turns the HTTP response into the reply of the call. */
export interface OutboundResponseMapper<P = unknown, B = unknown> {
  mapResponse(ctx: OutboundResponseContext<P, B>): unknown;
}

export type OutboundErrorMapperFn<P = unknown> = {
  bivarianceHack(error: OutboundRestError, ctx: OutboundExchangeContext<P>): unknown;
}['bivarianceHack'];

/**
 * Translates a failed call into the error of the service. The returned value is thrown;
 * returning `undefined` keeps the typed error.
 */
export interface OutboundErrorMapper<P = unknown> {
  mapError(error: OutboundRestError, ctx: OutboundExchangeContext<P>): unknown;
}

export type OutboundResolvedKey = OutboundKeyParts | null | undefined;

export type OutboundKeyResolverFn<P = unknown> = {
  bivarianceHack(ctx: OutboundCallContext<P>): MaybePromise<OutboundResolvedKey>;
}['bivarianceHack'];

/** Derives the idempotency key from the message; `undefined` sends no resolved key. */
export interface OutboundKeyResolver<P = unknown> {
  resolveKey(ctx: OutboundCallContext<P>): MaybePromise<OutboundResolvedKey>;
}

export type OutboundRetryClassifierFn<P = unknown> = {
  bivarianceHack(error: OutboundRestError, ctx: OutboundExchangeContext<P>): MaybePromise<boolean>;
}['bivarianceHack'];

/** Says whether a failed attempt may be retried. */
export interface OutboundRetryClassifier<P = unknown> {
  isRetryable(error: OutboundRestError, ctx: OutboundExchangeContext<P>): MaybePromise<boolean>;
}

// ---------- Options ----------

export interface OutboundIdempotencyOptions {
  /** Default true. Not inherited from the module default when a binding passes an object. */
  enabled?: boolean;
  /** Header that carries the key. Default `Idempotency-Key`. */
  header?: string;
  /** Key resolver; a stable key derived from the business ids of the message. */
  key?: OutboundKeyResolverFn | OutboundKeyResolver | OutboundProviderRef<OutboundKeyResolver>;
  /**
   * Send `headers.idempotencyKey` of the message when no other key applies. Default true, or
   * false once `key` is configured. A key is never generated.
   */
  forward?: boolean;
}

export interface OutboundBackoffOptions {
  /** Delay before the second attempt. Default 200. */
  initialMs?: number;
  /** Multiplier applied per attempt. Default 2. */
  factor?: number;
  /** Upper bound of a delay. Default 10000. */
  maxMs?: number;
}

/** Delay in milliseconds before the next attempt; `attempt` is the one that just failed (from 1). */
export type OutboundBackoffFn = (attempt: number, error: OutboundRestError) => number;

export interface OutboundRetryOptions {
  /** Default true. Not inherited from the module default when a binding passes an object. */
  enabled?: boolean;
  /** Total attempts, the first one included. Default 3. */
  maxAttempts?: number;
  /** A fixed delay, exponential settings or a function. Default exponential from 200 ms. */
  backoff?: number | OutboundBackoffOptions | OutboundBackoffFn;
  /** Default: network errors, timeouts and HTTP 408, 429 and 5xx. */
  retryOn?:
    | OutboundRetryClassifierFn
    | OutboundRetryClassifier
    | OutboundProviderRef<OutboundRetryClassifier>;
  /**
   * Methods retried even without an idempotency key. GET, HEAD and OPTIONS always qualify, and
   * any method does while an idempotency key is being sent.
   */
  methods?: readonly OutboundRestMethod[];
}

export interface OutboundRestOptions {
  /** Static url; optional when `target` resolves it. */
  url?: string;
  /** Default `POST`. */
  method?: OutboundRestMethod;
  /** Static headers, merged over the module defaults. */
  headers?: Record<string, string>;
  /** Static query parameters, merged over the module defaults. */
  query?: OutboundQuery;
  /** Per-message target. */
  target?:
    OutboundTargetResolverFn | OutboundTargetResolver | OutboundProviderRef<OutboundTargetResolver>;
  /** Hook that adds headers taken from the message (auth, tenant, propagated headers). */
  mapHeaders?:
    OutboundHeaderMapperFn | OutboundHeaderMapper | OutboundProviderRef<OutboundHeaderMapper>;
  /** Send the trace headers of the message (`x-trace-id`, `x-correlation-id`, ...). Default true. */
  traceHeaders?: boolean;
  /** Body serialization. Default `'json'`. */
  serializer?:
    | 'json'
    | 'text'
    | 'form'
    | OutboundBodySerializerFn
    | OutboundBodySerializer
    | OutboundProviderRef<OutboundBodySerializer>;
  /** Reply of the call: `'full'` (default, `{ status, headers, body }`), `'body'` or a mapper. */
  response?:
    | 'full'
    | 'body'
    | OutboundResponseMapperFn
    | OutboundResponseMapper
    | OutboundProviderRef<OutboundResponseMapper>;
  /** Per attempt. Default 30000; 0 disables the timeout. */
  timeoutMs?: number;
  /** Idempotency header rules; `false` sends no key at all. */
  idempotency?: false | OutboundIdempotencyOptions;
  /** Off unless configured; `false` turns a module default off. */
  retry?: false | OutboundRetryOptions;
  /** Translates `OutboundRestError` failures into the error contract of the service. */
  mapError?: OutboundErrorMapperFn | OutboundErrorMapper | OutboundProviderRef<OutboundErrorMapper>;
  /** Injectable for tests. Default: the module `fetchFn`, else `globalThis.fetch`. */
  fetchFn?: OutboundFetch;
}

/** Module-wide defaults (`forRoot({ outbound: { rest: { defaults } } })`); bindings override them. */
export type OutboundRestDefaults = Omit<OutboundRestOptions, 'url' | 'target'>;

/** Ad-hoc options of `OutboundRestGateway.request`. */
export interface OutboundRestRequestOptions extends OutboundRestOptions {
  /** Label used in errors, logs and strategy contexts. Default `rest`. */
  name?: string;
}

/**
 * A declared outbound. With `channel`, messages sent to it are delivered as HTTP calls and the
 * response is replied on `headers.replyChannel`. `name` (default: the channel) is what
 * `OutboundRestGateway.request(name, ...)` uses.
 */
export interface OutboundRestBinding extends OutboundRestRequestOptions {
  channel?: string;
}

/** `IntegrationModule.forRoot({ outbound })`. */
export interface OutboundModuleOptions {
  rest?: {
    defaults?: OutboundRestDefaults;
    bindings?: readonly OutboundRestBinding[];
  };
}

/** A declared binding as shown in the boot log and the channel graph. */
export interface OutboundRestBindingInfo {
  name: string;
  channel?: string;
  /** `POST https://host/path` (no query, no credentials) or `dynamic`. */
  target: string;
  /** Boot log line, e.g. `outbound rest: orders.http -> POST https://erp.example/orders`. */
  line: string;
}
