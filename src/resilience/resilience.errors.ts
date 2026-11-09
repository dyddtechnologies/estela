import { ChannelError } from '../channel';
import type { RejectionKind, ResilienceEdgeKind } from './resilience.types';

export type ResilienceErrorKind = RejectionKind | 'fallback-failed' | 'key' | 'definition';

/** Registry-wide symbol: identical in every copy of this module (bundle, entry point or realm). */
const BRAND = Symbol.for('@estela/nest.ResilienceError');

export interface ResilienceErrorMeta {
  binding: string;
  edge?: ResilienceEdgeKind;
  attempts?: number;
  cause?: unknown;
}

function brandedKind(value: unknown): ResilienceErrorKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const branded = value as { [BRAND]?: unknown; kind?: unknown };
  return branded[BRAND] === true ? (branded.kind as ResilienceErrorKind) : undefined;
}

/** `outbound-rest` -> `outbound rest`, for messages. */
function edgeWords(edge: ResilienceEdgeKind | undefined): string {
  return edge === undefined ? 'binding' : edge.replace(/-/g, ' ');
}

/** Message built only from the binding, the edge and the attempt count (RS-44). */
export function resilienceMessage(what: string, meta: ResilienceErrorMeta): string {
  const attempts =
    meta.attempts === undefined || meta.attempts === 0 ? '' : ` after ${meta.attempts} attempt(s)`;
  return `${what} for ${edgeWords(meta.edge)} '${meta.binding}'${attempts}`;
}

/**
 * Base of the errors the resilience engine produces. `instanceof` works across the CJS bundles of
 * `@estela/nest` and `@estela/nest/testing` through a `Symbol.for` brand (RS-46), with the same
 * rule as `ConcurrencyError`: the brand fallback applies to this base and to classes that declare
 * their own static `errorKind`, so a consumer subclass keeps the plain prototype check.
 */
export abstract class ResilienceError extends ChannelError {
  static readonly errorKind?: ResilienceErrorKind;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    const kind = brandedKind(value);
    if (kind === undefined) return false;
    if (this === ResilienceError) return true;
    if (!Object.hasOwn(this, 'errorKind')) return false;
    return (this as { errorKind?: ResilienceErrorKind }).errorKind === kind;
  }

  abstract readonly kind: ResilienceErrorKind;
  readonly binding: string;
  readonly edge: ResilienceEdgeKind | undefined;
  readonly attempts: number;
  declare readonly cause: unknown;

  constructor(message: string, meta: ResilienceErrorMeta) {
    super(message);
    Object.defineProperty(this, BRAND, { value: true });
    // ChannelError takes no cause option; keep it non-enumerable like the native one.
    Object.defineProperty(this, 'cause', {
      value: meta.cause,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    this.binding = meta.binding;
    this.edge = meta.edge;
    this.attempts = meta.attempts ?? 0;
  }
}

export class CircuitOpenError extends ResilienceError {
  static override readonly errorKind = 'circuit-open';
  readonly kind = 'circuit-open';
  readonly retryAfterMs: number | undefined;
  readonly forcedBy: 'quota' | undefined;

  constructor(meta: ResilienceErrorMeta & { retryAfterMs?: number; forcedBy?: 'quota' }) {
    super(resilienceMessage('circuit open', meta), meta);
    this.retryAfterMs = meta.retryAfterMs;
    this.forcedBy = meta.forcedBy;
  }
}

export class BulkheadFullError extends ResilienceError {
  static override readonly errorKind = 'bulkhead-full';
  readonly kind = 'bulkhead-full';
  readonly reason: 'full' | 'queue-timeout';

  constructor(meta: ResilienceErrorMeta & { reason: 'full' | 'queue-timeout' }) {
    super(resilienceMessage(`bulkhead ${meta.reason}`, meta), meta);
    this.reason = meta.reason;
  }
}

export class RateLimitedError extends ResilienceError {
  static override readonly errorKind = 'rate-limited';
  readonly kind = 'rate-limited';
  readonly retryAfterMs: number;

  constructor(meta: ResilienceErrorMeta & { retryAfterMs: number }) {
    super(resilienceMessage('rate limited', meta), meta);
    this.retryAfterMs = meta.retryAfterMs;
  }
}

export class DeadlineExceededError extends ResilienceError {
  static override readonly errorKind = 'deadline';
  readonly kind = 'deadline';
  readonly deadlineMs: number;

  constructor(meta: ResilienceErrorMeta & { deadlineMs: number }) {
    super(resilienceMessage('deadline exceeded', meta), meta);
    this.deadlineMs = meta.deadlineMs;
  }
}

export class FallbackFailedError extends ResilienceError {
  static override readonly errorKind = 'fallback-failed';
  readonly kind = 'fallback-failed';
  readonly original: unknown;

  constructor(meta: ResilienceErrorMeta & { original: unknown }) {
    super(resilienceMessage('fallback failed', meta), meta);
    this.original = meta.original;
  }
}

export type ResilienceKeyErrorReason =
  'key-fn' | 'invalid-key' | 'hasher' | 'idempotency-key-required';

export class ResilienceKeyError extends ResilienceError {
  static override readonly errorKind = 'key';
  readonly kind = 'key';
  readonly reason: ResilienceKeyErrorReason;

  constructor(meta: ResilienceErrorMeta & { reason: ResilienceKeyErrorReason }) {
    super(resilienceMessage(`resilience key error (${meta.reason})`, meta), meta);
    this.reason = meta.reason;
  }
}

/** One finding of the boot resolver, shared by every concern (RS-67). Names only, never values. */
export interface FlowParameterFinding {
  readonly concern: 'flow' | 'resilience' | 'sensitive' | 'idempotency';
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  /** For example "flow 'loan' step 'credit'". */
  readonly subject: string;
  /** Option path, for example "resilience.use". */
  readonly path: string;
  readonly message: string;
}

/** Boot-time misconfiguration; message = `<binding>: resilience.<path> <rule>`. */
export class ResilienceDefinitionError extends ResilienceError {
  static override readonly errorKind = 'definition';
  readonly kind = 'definition';
  readonly path: string;
  /** Finding code, for example `UNKNOWN_PROFILE`; `INVALID_OPTION` for a value rule. */
  readonly code: string;
  /** Every finding of the boot pass (RS-67); one entry when thrown on its own. */
  readonly findings: readonly FlowParameterFinding[];

  constructor(
    binding: string,
    path: string,
    rule: string,
    code = 'INVALID_OPTION',
    findings?: readonly FlowParameterFinding[],
  ) {
    super(`${binding}: resilience.${path} ${rule}`, { binding });
    this.path = path;
    this.code = code;
    this.findings = findings ?? [
      {
        concern: 'resilience',
        code,
        severity: 'error',
        subject: binding,
        path: `resilience.${path}`,
        message: this.message,
      },
    ];
  }
}

/** Trigger of the fallback for an engine rejection; undefined for key and definition errors. */
export function rejectionTrigger(error: unknown): RejectionKind | 'quota' | 'none' | undefined {
  if (!(error instanceof ResilienceError)) return undefined;
  if (error instanceof CircuitOpenError)
    return error.forcedBy === 'quota' ? 'quota' : 'circuit-open';
  if (error.kind === 'key' || error.kind === 'definition' || error.kind === 'fallback-failed') {
    return 'none';
  }
  return error.kind;
}
