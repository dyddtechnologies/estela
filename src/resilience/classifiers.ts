import { LanesFullError, ValveShutError, OutOfTimeError, OverPaceError } from './resilience.errors';
import type { Classification, CareClassifierFn } from './resilience.types';

const MAX_DELAY_MS = 2_147_483_647;

/**
 * Server wait (`Retry-After` as delta-seconds or HTTP-date) in ms (RS-11). Negative, non-numeric or
 * unparseable values give undefined, so the call behaves as if the header were absent.
 */
export function parseServerWait(value: string | undefined, nowWallMs: number): number | undefined {
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

function serverWaitOf(shape: RestErrorShape): number | undefined {
  const headers = shape.headers as Record<string, unknown> | undefined;
  const raw = headers?.['retry-after'];
  return parseServerWait(typeof raw === 'string' ? raw : undefined, Date.now());
}

function withServerWait(cls: Classification['class'], shape: RestErrorShape): Classification {
  const readyInMs = serverWaitOf(shape);
  return readyInMs === undefined ? { class: cls } : { class: cls, readyInMs };
}

function classifyStatus(status: number, shape: RestErrorShape): Classification {
  if (status === 408 || status === 425 || status === 503) return withServerWait('transient', shape);
  if (status === 429) return withServerWait('busy', shape);
  if (status === 501 || status === 505 || status === 511) return { class: 'rejected' };
  if (status >= 500) return { class: 'transient' };
  return { class: 'rejected' };
}

/**
 * RS-14. Reads an `OutboundRestError`-like value structurally (`kind`, `status`, `headers`):
 * network errors and overdue calls are transient, 429 busy, and statuses per section 5.2.
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
 * value. A negative or non-integer pushback means "do not try again" (gRFC A6). Never returns 'quota'.
 */
export function defaultGrpcClassifier(code: number, pushback?: string): Classification {
  if (code === 14 || code === 4) return { class: 'transient' };
  if (code === 8) {
    if (pushback === undefined) return { class: 'busy' };
    if (!/^\d+$/.test(pushback.trim())) return { class: 'rejected' };
    return { class: 'busy', readyInMs: Math.min(MAX_DELAY_MS, Number(pushback.trim())) };
  }
  if (GRPC_REJECTED.has(code)) return { class: 'rejected' };
  if (GRPC_UNKNOWN.has(code)) return { class: 'unknown' };
  return { class: 'unknown' };
}

/**
 * RS-17a. Structural classifier of activators, saga outbound steps and flow edges: a REST-like
 * error by the REST table, boolean `transient` flags on the error (RS-17a), inner turned-away
 * calls, anything else unknown.
 */
export function defaultInProcessClassifier(error: unknown): Classification {
  if (restShape(error) !== undefined) return defaultRestClassifier(error);
  if (error instanceof OverPaceError) {
    return { class: 'busy', readyInMs: error.readyInMs };
  }
  if (error instanceof LanesFullError) return { class: 'busy' };
  if (error instanceof ValveShutError || error instanceof OutOfTimeError) {
    return { class: 'rejected' };
  }
  const flags = error as { retryable?: unknown; transient?: unknown } | null | undefined;
  if (flags?.transient === true) return { class: 'transient' };
  const retryable = flags?.retryable;
  if (retryable === true) return { class: 'transient' };
  if (retryable === false) return { class: 'rejected' };
  return { class: 'unknown' };
}

/** 0.9.0 spelling (section 1): a boolean classifier mapped to transient | rejected. */
export function fromBooleanClassifier(
  fn: (error: unknown, ctx: unknown) => boolean | Promise<boolean>,
): CareClassifierFn {
  return (error, ctx) => {
    const verdict = fn(error, ctx);
    if (typeof verdict !== 'boolean') return undefined;
    return verdict ? 'transient' : 'rejected';
  };
}
