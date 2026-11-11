import { ChannelError } from '../channel';
import type { TurnedAwayKind, CareEdge } from './resilience.types';

export type CareErrorKind = TurnedAwayKind | 'plan-b-failed' | 'key' | 'config';

/** Registry-wide symbol: identical in every copy of this module (bundle, entry point or realm). */
const BRAND = Symbol.for('@estela/nest.CareError');

export interface CareErrorMeta {
  binding: string;
  edge?: CareEdge;
  tries?: number;
  cause?: unknown;
}

function brandedKind(value: unknown): CareErrorKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const branded = value as { [BRAND]?: unknown; kind?: unknown };
  return branded[BRAND] === true ? (branded.kind as CareErrorKind) : undefined;
}

/** `outbound-rest` -> `outbound rest`, for messages. */
function edgeWords(edge: CareEdge | undefined): string {
  return edge === undefined ? 'binding' : edge.replace(/-/g, ' ');
}

/** Message built only from the binding, the edge and the try count (RS-44). */
export function careMessage(what: string, meta: CareErrorMeta): string {
  const tries = meta.tries === undefined || meta.tries === 0 ? '' : ` after ${meta.tries} try(ies)`;
  return `${what} for ${edgeWords(meta.edge)} '${meta.binding}'${tries}`;
}

/**
 * Base of the errors the care engine produces. `instanceof` works across the CJS bundles of
 * `@estela/nest` and `@estela/nest/testing` through a `Symbol.for` brand (RS-46), with the same
 * rule as `ConcurrencyError`: the brand check applies to this base and to classes that declare
 * their own static `errorKind`, so a consumer subclass keeps the plain prototype check.
 */
export abstract class CareError extends ChannelError {
  static readonly errorKind?: CareErrorKind;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    const kind = brandedKind(value);
    if (kind === undefined) return false;
    if (this === CareError) return true;
    if (!Object.hasOwn(this, 'errorKind')) return false;
    return (this as { errorKind?: CareErrorKind }).errorKind === kind;
  }

  abstract readonly kind: CareErrorKind;
  readonly binding: string;
  readonly edge: CareEdge | undefined;
  readonly tries: number;
  declare readonly cause: unknown;

  constructor(message: string, meta: CareErrorMeta) {
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
    this.tries = meta.tries ?? 0;
  }
}

export class ValveShutError extends CareError {
  static override readonly errorKind = 'valve-shut';
  readonly kind = 'valve-shut';
  /** When the valve lets calls through again, in ms; undefined while it waits for `resume`. */
  readonly readyInMs: number | undefined;
  readonly forcedBy: 'quota' | undefined;

  constructor(meta: CareErrorMeta & { readyInMs?: number; forcedBy?: 'quota' }) {
    super(careMessage('valve shut', meta), meta);
    this.readyInMs = meta.readyInMs;
    this.forcedBy = meta.forcedBy;
  }
}

export class LanesFullError extends CareError {
  static override readonly errorKind = 'lanes-full';
  readonly kind = 'lanes-full';
  readonly reason: 'full' | 'waitlist-expired';

  constructor(meta: CareErrorMeta & { reason: 'full' | 'waitlist-expired' }) {
    super(
      careMessage(meta.reason === 'full' ? 'lanes full' : 'lanes waitlist expired', meta),
      meta,
    );
    this.reason = meta.reason;
  }
}

export class OverPaceError extends CareError {
  static override readonly errorKind = 'over-pace';
  readonly kind = 'over-pace';
  readonly readyInMs: number;

  constructor(meta: CareErrorMeta & { readyInMs: number }) {
    super(careMessage('over pace', meta), meta);
    this.readyInMs = meta.readyInMs;
  }
}

export class OutOfTimeError extends CareError {
  static override readonly errorKind = 'out-of-time';
  readonly kind = 'out-of-time';
  readonly totalMs: number;

  constructor(meta: CareErrorMeta & { totalMs: number }) {
    super(careMessage('out of time', meta), meta);
    this.totalMs = meta.totalMs;
  }
}

export class PlanBFailedError extends CareError {
  static override readonly errorKind = 'plan-b-failed';
  readonly kind = 'plan-b-failed';
  readonly original: unknown;

  constructor(meta: CareErrorMeta & { original: unknown }) {
    super(careMessage('plan B failed', meta), meta);
    this.original = meta.original;
  }
}

export type CareKeyErrorReason = 'key-fn' | 'invalid-key' | 'hasher' | 'idempotency-key-required';

export class CareKeyError extends CareError {
  static override readonly errorKind = 'key';
  readonly kind = 'key';
  readonly reason: CareKeyErrorReason;

  constructor(meta: CareErrorMeta & { reason: CareKeyErrorReason }) {
    super(careMessage(`care key error (${meta.reason})`, meta), meta);
    this.reason = meta.reason;
  }
}

/** One finding of the boot resolver, shared by every concern (RS-67). Names only, never values. */
export interface FlowParameterFinding {
  readonly concern: 'flow' | 'care' | 'privacy' | 'idempotency';
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  /** For example "flow 'loan' step 'credit'". */
  readonly subject: string;
  /** Option path, for example "care.use". */
  readonly path: string;
  readonly message: string;
}

/** Boot-time misconfiguration; message = `<binding>: care.<path> <rule>`. */
export class CareConfigError extends CareError {
  static override readonly errorKind = 'config';
  readonly kind = 'config';
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
    super(`${binding}: care.${path} ${rule}`, { binding });
    this.path = path;
    this.code = code;
    this.findings = findings ?? [
      {
        concern: 'care',
        code,
        severity: 'error',
        subject: binding,
        path: `care.${path}`,
        message: this.message,
      },
    ];
  }
}

/** Plan B trigger of a turned-away call; undefined for errors the engine did not raise. */
export function turnedAwayTrigger(error: unknown): TurnedAwayKind | 'quota' | 'none' | undefined {
  if (!(error instanceof CareError)) return undefined;
  if (error instanceof ValveShutError) return error.forcedBy === 'quota' ? 'quota' : 'valve-shut';
  if (error.kind === 'key' || error.kind === 'config' || error.kind === 'plan-b-failed') {
    return 'none';
  }
  return error.kind;
}
