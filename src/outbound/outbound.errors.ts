import { ChannelError } from '../channel';

/** Misconfiguration or misuse of an outbound adapter. */
export class OutboundError extends ChannelError {}

export type OutboundFailureKind = 'http' | 'network' | 'timeout';

/** What every failed call knows about the request it belongs to. */
export interface OutboundFailureInfo {
  /** Binding name. */
  binding: string;
  /** Full url as sent; it may carry query secrets, so it is never part of `message`. */
  url: string;
  method: string;
  /** Attempts made when the failure happened. */
  attempts: number;
}

/** Url safe to print: no query string, no fragment, no credentials. */
export function redactUrl(url: string): string {
  const end = url.search(/[?#]/);
  const bare = end === -1 ? url : url.slice(0, end);
  return bare.replace(/\/\/[^/@]*@/, '//');
}

function describe(info: OutboundFailureInfo, outcome: string): string {
  return `outbound rest '${info.binding}' ${info.method} ${redactUrl(info.url)} -> ${outcome}`;
}

/** A failed outbound REST call: `OutboundHttpError`, `OutboundNetworkError` or `OutboundTimeoutError`. */
export abstract class OutboundRestError extends OutboundError {
  abstract readonly kind: OutboundFailureKind;
  readonly binding: string;
  readonly url: string;
  readonly method: string;
  readonly attempts: number;

  constructor(info: OutboundFailureInfo, outcome: string) {
    super(describe(info, outcome));
    this.binding = info.binding;
    this.url = info.url;
    this.method = info.method;
    this.attempts = info.attempts;
  }
}

/** The upstream answered with a non-2xx status. */
export class OutboundHttpError extends OutboundRestError {
  readonly kind = 'http' as const;

  constructor(
    info: OutboundFailureInfo,
    readonly status: number,
    readonly statusText: string,
    /** Header names in lower case. */
    readonly headers: Record<string, string>,
    /** JSON when the response is JSON, the text otherwise, `null` when empty. */
    readonly body: unknown,
  ) {
    super(info, `HTTP ${status}`);
  }
}

function codeOf(value: unknown): string | undefined {
  const code = (value as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

/** Code of the error, else of its direct cause (fetch wraps the system error in `cause`). */
function causeCode(error: unknown): string | undefined {
  return codeOf(error) ?? codeOf((error as { cause?: unknown } | null | undefined)?.cause);
}

/** No response arrived: DNS, refused or reset connection, TLS, aborted request. */
export class OutboundNetworkError extends OutboundRestError {
  readonly kind = 'network' as const;
  /** System or fetch error code (`ECONNREFUSED`, `ENOTFOUND`, ...), when the cause has one. */
  readonly code: string | undefined;
  override readonly cause: unknown;

  constructor(info: OutboundFailureInfo, cause: unknown) {
    const code = causeCode(cause);
    super(info, code === undefined ? 'network error' : `network error (${code})`);
    this.code = code;
    this.cause = cause;
  }
}

/** The attempt did not finish within `timeoutMs`; the request was aborted. */
export class OutboundTimeoutError extends OutboundRestError {
  readonly kind = 'timeout' as const;

  constructor(
    info: OutboundFailureInfo,
    readonly timeoutMs: number,
  ) {
    super(info, `timeout after ${timeoutMs}ms`);
  }
}
