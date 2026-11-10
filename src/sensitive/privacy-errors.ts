/** Registry-wide symbol: identical in every copy of this module (bundle, entry point or realm). */
const BRAND = Symbol.for('@estela/nest.PrivacyError');

export type PrivacyErrorKind = 'config' | 'seal-key' | 'replay' | 'seal-broken' | 'delivery-copy';

/** Finding codes of the privacy concern (4.7). Every one is an error unless a finding says otherwise. */
export const PRIVACY_FINDING_CODES = Object.freeze({
  UNKNOWN_PROFILE: 'UNKNOWN_PROFILE',
  PROFILE_CYCLE: 'PROFILE_CYCLE',
  PROFILE_DEPTH: 'PROFILE_DEPTH',
  PROFILE_NAME: 'PROFILE_NAME',
  PRIVACY_FALSE_BELOW_MODULE: 'PRIVACY_FALSE_BELOW_MODULE',
  PRIVACY_OFF_WITH_REFS: 'PRIVACY_OFF_WITH_REFS',
  DELIVERY_REACH_LEVEL: 'DELIVERY_REACH_LEVEL',
  REMEMBER_LEVEL: 'REMEMBER_LEVEL',
  EXEMPT_REASON_MISSING: 'EXEMPT_REASON_MISSING',
  REMEMBER_REASON_MISSING: 'REMEMBER_REASON_MISSING',
  COPY_REASON_MISSING: 'COPY_REASON_MISSING',
  FINGERPRINT_WITHOUT_SECRET: 'FINGERPRINT_WITHOUT_SECRET',
  FINGERPRINT_SECRET_SHORT: 'FINGERPRINT_SECRET_SHORT',
  SEALED_WITHOUT_KEYS: 'SEALED_WITHOUT_KEYS',
  OUTCOME_ONLY_REPLAY: 'OUTCOME_ONLY_REPLAY',
  INVALID_SELECTOR: 'INVALID_SELECTOR',
  PROTECTED_TRACE_FIELD: 'PROTECTED_TRACE_FIELD',
  UNKNOWN_PACK: 'UNKNOWN_PACK',
  RULE_NAME: 'RULE_NAME',
  UNSAFE_PATTERN: 'UNSAFE_PATTERN',
  INVALID_OPTION: 'INVALID_OPTION',
} as const);

export type PrivacyFindingCode = (typeof PRIVACY_FINDING_CODES)[keyof typeof PRIVACY_FINDING_CODES];

export interface PrivacyFinding {
  /** One of PRIVACY_FINDING_CODES. */
  code: string;
  severity: 'error' | 'warning';
  /** For example "flow 'loan' step 'credit'", "channel 'payments.charge'". */
  subject: string;
  /** Option path, always under privacy, for example "privacy.use". */
  path: string;
}

function brandedKind(value: unknown): PrivacyErrorKind | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const branded = value as { [BRAND]?: unknown; kind?: unknown };
  return branded[BRAND] === true ? (branded.kind as PrivacyErrorKind) : undefined;
}

/**
 * Base of the privacy errors. `instanceof` works across the ESM and CJS copies of the package
 * through a `Symbol.for` brand, with the rule of `CareError`: the brand check applies to this base and
 * to classes that declare their own static `errorKind`.
 */
export abstract class PrivacyError extends Error {
  static readonly errorKind?: PrivacyErrorKind;

  static override [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    const kind = brandedKind(value);
    if (kind === undefined) return false;
    if (this === PrivacyError) return true;
    if (!Object.hasOwn(this, 'errorKind')) return false;
    return (this as { errorKind?: PrivacyErrorKind }).errorKind === kind;
  }

  abstract readonly kind: PrivacyErrorKind;
  abstract readonly retryable: boolean;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    Object.defineProperty(this, BRAND, { value: true });
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', {
        value: cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
}

/** Boot-time misconfiguration: every problem at once, names and option paths only (SD-37, SD-42). */
export class PrivacyConfigError extends PrivacyError {
  static override readonly errorKind = 'config';
  readonly kind = 'config';
  readonly retryable = false;
  readonly problems: readonly string[];
  readonly findings: readonly PrivacyFinding[];

  constructor(problems: readonly string[], findings: readonly PrivacyFinding[] = []) {
    super(`privacy configuration is invalid: ${problems.join('; ')}`);
    this.problems = Object.freeze([...problems]);
    this.findings = Object.freeze([...findings]);
  }
}

/** `SealKeyProvider` failed before the claim or on a repeat (SD-32). Retryable. */
export class SealKeyUnavailableError extends PrivacyError {
  static override readonly errorKind = 'seal-key';
  readonly kind = 'seal-key';
  readonly retryable = true;
  readonly code = 'SEAL_KEY_UNAVAILABLE';

  constructor(scope: string, cause?: unknown) {
    super(`SEAL_KEY_UNAVAILABLE: ${scope}`, cause);
  }
}

/** A repeat cannot be answered: retired seal key or an outcome-only record (SD-32, SD-33). */
export class ReplayUnavailableError extends PrivacyError {
  static override readonly errorKind = 'replay';
  readonly kind = 'replay';
  readonly retryable = false;
  readonly code = 'REPLAY_UNAVAILABLE';

  constructor(scope: string, why: string) {
    super(`REPLAY_UNAVAILABLE: ${scope} (${why})`);
  }
}

/** A sealed record failed authentication: tampered, or copied under another key (SD-31). */
export class SealBrokenError extends PrivacyError {
  static override readonly errorKind = 'seal-broken';
  readonly kind = 'seal-broken';
  readonly retryable = false;
  readonly code = 'SEAL_BROKEN';

  constructor(scope: string) {
    super(`SEAL_BROKEN: ${scope}`);
  }
}

/** A delivery-reach copy could not be faithful; nothing was sent (SD-51). */
export class DeliveryCopyError extends PrivacyError {
  static override readonly errorKind = 'delivery-copy';
  readonly kind = 'delivery-copy';
  readonly retryable = false;
  readonly code = 'DELIVERY_COPY_FAILED';

  constructor(subject: string, why: string) {
    super(`DELIVERY_COPY_FAILED: ${subject} (${why})`);
  }
}
