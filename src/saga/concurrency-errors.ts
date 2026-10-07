/**
 * Concurrency failures a saga can meet, typed so callers can map them (409 for a stale state,
 * 503 with Retry-After for contention) without knowing the database. The database adapter only
 * classifies its own errors into these kinds; Estela decides whether to retry.
 */
export type ConcurrencyErrorKind = 'lock-timeout' | 'deadlock' | 'serialization' | 'stale-state';

/** Kinds a database classifier may return. 'stale-state' only comes from transition(). */
export type DatabaseErrorKind = Exclude<ConcurrencyErrorKind, 'stale-state'>;

/** Maps a driver error to a concurrency kind; undefined means "not a concurrency failure". */
export type ErrorClassifier = (error: unknown) => DatabaseErrorKind | undefined;

export interface ConcurrencyErrorMeta {
  cause?: unknown;
  saga?: string;
  unit?: string;
  attempts?: number;
}

/** Registry-wide symbol: identical in every copy of this module (bundle, entry point or realm). */
const BRAND = Symbol.for('@estela/nest.ConcurrencyError');

function brandedKind(value: unknown): ConcurrencyErrorKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const branded = value as { [BRAND]?: unknown; kind?: unknown };
  return branded[BRAND] === true ? (branded.kind as ConcurrencyErrorKind) : undefined;
}

/**
 * `instanceof` works across copies of these classes. The CJS build bundles each entry point on its
 * own, so `@estela/nest/testing` (MemoryLockPort) carries its own LockTimeoutError: without this,
 * it would not be an `instanceof` the class the runner and the app import from `@estela/nest`, and
 * a retry on 'lock-timeout' would never fire. A foreign copy matches by brand and `kind`.
 *
 * The brand fallback applies only to this base and to a class that declares its own static
 * `errorKind` (Estela's concrete errors). A consumer subclass such as
 * `class FlowBusy extends LockTimeoutError {}` inherits `errorKind`, so it gets the plain prototype
 * check: otherwise every LockTimeoutError would pass `instanceof FlowBusy`.
 */
export abstract class ConcurrencyError extends Error {
  /** Kind of every instance of a concrete subclass; undefined on this abstract base. */
  static readonly errorKind?: ConcurrencyErrorKind;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    const kind = brandedKind(value);
    if (kind === undefined) return false;
    if (this === ConcurrencyError) return true;
    if (!Object.hasOwn(this, 'errorKind')) return false;
    return (this as { errorKind?: ConcurrencyErrorKind }).errorKind === kind;
  }

  abstract readonly kind: ConcurrencyErrorKind;
  readonly saga?: string;
  readonly unit?: string;
  readonly attempts?: number;

  constructor(message: string, meta: ConcurrencyErrorMeta = {}) {
    super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
    Object.defineProperty(this, BRAND, { value: true });
    this.name = new.target.name;
    if (meta.saga !== undefined) this.saga = meta.saga;
    if (meta.unit !== undefined) this.unit = meta.unit;
    if (meta.attempts !== undefined) this.attempts = meta.attempts;
  }
}

export class LockTimeoutError extends ConcurrencyError {
  static override readonly errorKind = 'lock-timeout';
  readonly kind = 'lock-timeout';
}

export class DeadlockError extends ConcurrencyError {
  static override readonly errorKind = 'deadlock';
  readonly kind = 'deadlock';
}

export class SerializationError extends ConcurrencyError {
  static override readonly errorKind = 'serialization';
  readonly kind = 'serialization';
}

const FACTORIES: Readonly<
  Record<DatabaseErrorKind, new (message: string, meta: ConcurrencyErrorMeta) => ConcurrencyError>
> = {
  'lock-timeout': LockTimeoutError,
  deadlock: DeadlockError,
  serialization: SerializationError,
};

/** Narrows a classifier's result to a kind it may return. A classifier is user code, so its
 *  typing is only a compile-time contract: anything else (a typo such as 'lock_timeout', or
 *  'stale-state', which only transition() produces) means "not a concurrency failure". */
export function isDatabaseErrorKind(kind: unknown): kind is DatabaseErrorKind {
  return typeof kind === 'string' && Object.hasOwn(FACTORIES, kind);
}

/**
 * Wraps a classified driver error into its typed error, keeping the driver error as `cause`. The
 * message is built only from the kind, saga, unit and attempts, never from the driver message:
 * apps map these errors to HTTP responses, and driver text names tables, constraints and values.
 */
export function toConcurrencyError(
  kind: DatabaseErrorKind,
  cause: unknown,
  meta: Omit<ConcurrencyErrorMeta, 'cause'>,
): ConcurrencyError {
  if (!isDatabaseErrorKind(kind)) {
    throw new TypeError(`toConcurrencyError: unknown kind ${String(kind)}`);
  }
  const where = meta.saga === undefined ? '' : ` in saga "${meta.saga}"`;
  const unit = meta.unit === undefined ? '' : ` unit ${meta.unit}`;
  const attempts = meta.attempts === undefined ? '' : ` after ${meta.attempts} attempt(s)`;
  return new FACTORIES[kind](`${kind}${where}${unit}${attempts}`, { ...meta, cause });
}

/** Build-time misuse of the saga DSL, thrown by the builder. */
export class SagaDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagaDefinitionError';
  }
}

/** Run-time misuse: missing port, nested saga, late afterCommit, uncloneable ctx. */
export class SagaUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagaUsageError';
  }
}
