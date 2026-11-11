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

const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAVAILABLE = 14;
const GRPC_CODE_NAMES: Readonly<Record<string, number>> = {
  DEADLINE_EXCEEDED: GRPC_DEADLINE_EXCEEDED,
  RESOURCE_EXHAUSTED: GRPC_RESOURCE_EXHAUSTED,
  UNAVAILABLE: GRPC_UNAVAILABLE,
};
const QUOTA_DETAIL = /quota/i;
const QUOTA_FAILURE_TYPE = 'google.rpc.QuotaFailure';

interface GrpcErrorShape {
  code?: unknown;
  status?: unknown;
  details?: unknown;
  message?: unknown;
  metadata?: unknown;
}

function grpcNameIn(value: unknown): number | undefined {
  return typeof value === 'string' ? GRPC_CODE_NAMES[value] : undefined;
}

function grpcCodeIn(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 16
    ? (value as number)
    : undefined;
}

/** The grpc-js message format `<code> <NAME>: <details>`. */
const GRPC_MESSAGE = /^\d+ [A-Z_]+: /;

/**
 * A numeric code alone is not proof of gRPC: MongoDB, KafkaJS and others use 4, 8 and 14 for errors
 * a retry never fixes. A gRPC error also has string `details` (grpc-js, nice-grpc), a `metadata`
 * object (grpc-js, connect) or the grpc-js message format.
 */
function looksLikeGrpc(shape: GrpcErrorShape): boolean {
  if (typeof shape.details === 'string') return true;
  if (typeof shape.metadata === 'object' && shape.metadata !== null) return true;
  return typeof shape.message === 'string' && GRPC_MESSAGE.test(shape.message);
}

/**
 * The gRPC status code of an error read structurally (no `@grpc/grpc-js` import): the name of a code
 * this classifier maps, or a numeric `code` (grpc-js `ServiceError`, nice-grpc, connect) or `status`
 * when the error also looks like gRPC. A `DOMException` is never read: its legacy numeric `code`
 * overlaps the gRPC range.
 */
function grpcCodeOf(error: object): number | undefined {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return undefined;
  const shape = error as GrpcErrorShape;
  const byName = grpcNameIn(shape.code) ?? grpcNameIn(shape.status);
  if (byName !== undefined) return byName;
  if (!looksLikeGrpc(shape)) return undefined;
  return grpcCodeIn(shape.code) ?? grpcCodeIn(shape.status);
}

/** Every value of a metadata key: grpc-js `Metadata.get`, or a plain record of values. */
function metadataValues(metadata: unknown, key: string): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  try {
    const getter = (metadata as { get?: unknown }).get;
    const raw: unknown =
      typeof getter === 'function'
        ? (getter as (k: string) => unknown).call(metadata, key)
        : (metadata as Record<string, unknown>)[key];
    const values: unknown[] = Array.isArray(raw) ? raw : [raw];
    return values.flatMap((value) => {
      if (typeof value === 'string') return [value];
      return value instanceof Uint8Array ? [new TextDecoder().decode(value)] : [];
    });
  } catch {
    return [];
  }
}

/** A quota detail: the status text names a quota, or a `google.rpc.QuotaFailure` detail is attached. */
function hasQuotaDetail(shape: GrpcErrorShape): boolean {
  const texts = [shape.details, shape.message].filter((t): t is string => typeof t === 'string');
  if (texts.some((text) => QUOTA_DETAIL.test(text))) return true;
  return metadataValues(shape.metadata, 'grpc-status-details-bin').some((value) =>
    value.includes(QUOTA_FAILURE_TYPE),
  );
}

/**
 * SPI-448 gap grpc-transient: a gRPC error thrown in process. UNAVAILABLE and DEADLINE_EXCEEDED are
 * transient (an extra try still needs the idempotency gate, RS-36 and RS-60); RESOURCE_EXHAUSTED is
 * busy, with `grpc-retry-pushback-ms` as by RS-15, unless it carries a quota detail: then it is
 * unknown, so only the app's classifier can call it quota. Other codes are left to the caller.
 */
function classifyGrpcError(error: object): Classification | undefined {
  const code = grpcCodeOf(error);
  if (code === GRPC_UNAVAILABLE || code === GRPC_DEADLINE_EXCEEDED) return { class: 'transient' };
  if (code !== GRPC_RESOURCE_EXHAUSTED) return undefined;
  const shape = error as GrpcErrorShape;
  if (hasQuotaDetail(shape)) return { class: 'unknown' };
  const pushback = metadataValues(shape.metadata, 'grpc-retry-pushback-ms')[0];
  return defaultGrpcClassifier(code, pushback);
}

/**
 * RS-17a. Structural classifier of activators, saga outbound steps and flow edges: a REST-like
 * error by the REST table, boolean `transient` flags on the error (RS-17a), inner turned-away
 * calls, a gRPC UNAVAILABLE, DEADLINE_EXCEEDED or RESOURCE_EXHAUSTED status (SPI-448), anything
 * else unknown. Never returns 'quota'.
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
  return classifyFlags(error) ?? classifyGrpcIfObject(error) ?? { class: 'unknown' };
}

/** RS-17a flags set by the app on the error: they win over a transport status. */
function classifyFlags(error: unknown): Classification | undefined {
  const flags = error as { retryable?: unknown; transient?: unknown } | null | undefined;
  if (flags?.transient === true) return { class: 'transient' };
  const retryable = flags?.retryable;
  if (retryable === true) return { class: 'transient' };
  if (retryable === false) return { class: 'rejected' };
  return undefined;
}

function classifyGrpcIfObject(error: unknown): Classification | undefined {
  return typeof error === 'object' && error !== null ? classifyGrpcError(error) : undefined;
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
