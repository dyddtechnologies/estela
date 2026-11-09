import {
  BulkheadFullError,
  CircuitOpenError,
  DeadlineExceededError,
  RateLimitedError,
} from './resilience.errors';
import type { Classification, ResilienceClassifierFn } from './resilience.types';

const MAX_DELAY_MS = 2_147_483_647;

/**
 * `Retry-After` as delta-seconds or HTTP-date, in ms (RS-11). Negative, non-numeric or
 * unparseable values give undefined, so the call behaves as if the header were absent.
 */
export function parseRetryAfter(value: string | undefined, nowWallMs: number): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (/^\d+$/.test(text)) return Math.min(MAX_DELAY_MS, Number(text) * 1000);
  if (/^[+-]?\d/.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.min(MAX_DELAY_MS, Math.max(0, at - nowWallMs));
}

interface RestErrorShape {
  kind?: unknown;
  status?: unknown;
  headers?: unknown;
}

function restShape(error: unknown): RestErrorShape | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const shape = error as RestErrorShape;
  const kinds = ['http', 'network', 'timeout'];
  return typeof shape.kind === 'string' && kinds.includes(shape.kind) && 'binding' in error
    ? shape
    : undefined;
}

function retryAfterOf(shape: RestErrorShape): number | undefined {
  const headers = shape.headers as Record<string, unknown> | undefined;
  const raw = headers?.['retry-after'];
  return parseRetryAfter(typeof raw === 'string' ? raw : undefined, Date.now());
}

function withRetryAfter(cls: Classification['class'], shape: RestErrorShape): Classification {
  const retryAfterMs = retryAfterOf(shape);
  return retryAfterMs === undefined ? { class: cls } : { class: cls, retryAfterMs };
}

function classifyStatus(status: number, shape: RestErrorShape): Classification {
  if (status === 408 || status === 425 || status === 503) return withRetryAfter('transient', shape);
  if (status === 429) return withRetryAfter('throttled', shape);
  if (status === 501 || status === 505 || status === 511) return { class: 'rejected' };
  if (status >= 500) return { class: 'transient' };
  return { class: 'rejected' };
}

/**
 * RS-14. Reads an `OutboundRestError`-like value structurally (`kind`, `status`, `headers`):
 * network errors and timeouts are transient, 429 throttled, and statuses per section 5.2.
 * Never returns 'quota'.
 */
export function defaultRestClassifier(error: unknown): Classification {
  const shape = restShape(error);
  if (shape === undefined) return { class: 'unknown' };
  if (shape.kind !== 'http') return { class: 'transient' };
  return typeof shape.status === 'number'
    ? classifyStatus(shape.status, shape)
    : { class: 'unknown' };
}

const GRPC_REJECTED = new Set([3, 5, 6, 7, 9, 10, 11, 12, 16]);
const GRPC_UNKNOWN = new Set([1, 2, 13, 15]);

/**
 * RS-15. Pure function of the numeric gRPC status code and the raw `grpc-retry-pushback-ms`
 * value. A negative or non-integer pushback means "do not retry" (gRFC A6). Never returns 'quota'.
 */
export function defaultGrpcClassifier(code: number, pushback?: string): Classification {
  if (code === 14 || code === 4) return { class: 'transient' };
  if (code === 8) {
    if (pushback === undefined) return { class: 'throttled' };
    if (!/^\d+$/.test(pushback.trim())) return { class: 'rejected' };
    return { class: 'throttled', retryAfterMs: Math.min(MAX_DELAY_MS, Number(pushback.trim())) };
  }
  if (GRPC_REJECTED.has(code)) return { class: 'rejected' };
  if (GRPC_UNKNOWN.has(code)) return { class: 'unknown' };
  return { class: 'unknown' };
}

/**
 * RS-17a. Structural classifier of activators, saga outbound steps and flow edges: a REST-like
 * error by the REST table, `retryable` flags, inner engine rejections, anything else unknown.
 */
export function defaultInProcessClassifier(error: unknown): Classification {
  if (restShape(error) !== undefined) return defaultRestClassifier(error);
  if (error instanceof RateLimitedError) {
    return { class: 'throttled', retryAfterMs: error.retryAfterMs };
  }
  if (error instanceof BulkheadFullError) return { class: 'throttled' };
  if (error instanceof CircuitOpenError || error instanceof DeadlineExceededError) {
    return { class: 'rejected' };
  }
  const retryable = (error as { retryable?: unknown } | null | undefined)?.retryable;
  if (retryable === true) return { class: 'transient' };
  if (retryable === false) return { class: 'rejected' };
  return { class: 'unknown' };
}

/** Legacy alias (section 1): boolean retryOn mapped to transient | rejected. */
export function fromBooleanClassifier(
  fn: (error: unknown, ctx: unknown) => boolean | Promise<boolean>,
): ResilienceClassifierFn {
  return (error, ctx) => {
    const verdict = fn(error, ctx);
    if (typeof verdict !== 'boolean') return undefined;
    return verdict ? 'transient' : 'rejected';
  };
}
