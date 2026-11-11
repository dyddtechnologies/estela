import type { FingerprintSecretProvider } from './fingerprint-secret';
import type { SealKeyProvider } from './seal-key';
import type { RegexEngine } from './regex-engine';

/** How a value is shown in the trail (6.3). Strength: Omitted > Hidden = Text > Length > Fingerprint > Ends. */
export enum Show {
  /** `[HIDDEN:<rule>]`; an object or array gets the same token. */
  Hidden = 'hidden',
  /** The key or array element is left out. */
  Omitted = 'omitted',
  /** `+502***427`; hidden under 8 characters and for objects. */
  Ends = 'ends',
  /** `fp:<secretId>:<hex>`; hidden for objects. */
  Fingerprint = 'fingerprint',
  /** `[HIDDEN:<rule> len=<n>]`. */
  Length = 'length',
  /** The literal `text`. */
  Text = 'text',
}

export interface ShowOptions {
  /** Default `Show.Hidden`. */
  show?: Show;
  /** `Show.Ends`; default 0. */
  showFirst?: number;
  /** `Show.Ends`; default 4. */
  showLast?: number;
  /** `Show.Text`; literal output. */
  text?: string;
}

export interface FieldRule extends ShowOptions {
  /** Selector (section 6.1). */
  path: string;
  /** Rule name used in hidden tokens; default 'field'. */
  name?: string;
}

export interface PatternRule extends ShowOptions {
  /** `^[a-z0-9][a-z0-9._-]{0,63}$` */
  name: string;
  regex: RegExp;
  /** Capture group to hide; default 0 (the whole match). */
  group?: number;
  /** Selectors whose values this rule never scans. */
  skipKeys?: readonly string[];
  /** Runs after a regex match; false leaves the match as it is (context and checksum checks, SD-24). */
  confirm?: (match: string, input: string, offset: number) => boolean;
}

export enum Pack {
  Secrets = 'secrets',
  SecretsV1 = 'secrets@1',
  Personal = 'personal',
  PersonalV1 = 'personal@1',
}

export type PackName = Pack | `secrets@${number}` | `personal@${number}`;

export interface Exemption {
  path: string;
  /** How this path is shown at this level; undefined means the path is shown as it is. */
  show?: Show;
  /** 1..200 chars, logged at boot. */
  reason: string;
}

/** What durable scopes keep (8.2). */
export enum Remember {
  /** Needs `rememberReason` under explicit privacy. */
  Everything = 'everything',
  AsShown = 'as-shown',
  /** Needs `sealKeys`. */
  Sealed = 'sealed',
  OutcomeOnly = 'outcome-only',
}

export enum KeyCase {
  Ignore = 'ignore',
  Match = 'match',
}

/** Where the rules of a reference apply (SD-50). */
export enum Reach {
  Trail = 'trail',
  Delivery = 'delivery',
}

/** The rules a channel, endpoint, binding, activator, saga or call declares. */
export interface Privacy {
  /** A string is `{ path, show: defaultShow }`. */
  fields?: readonly (string | FieldRule)[];
  /** Added to DEFAULT_HIDDEN_HEADERS. */
  headers?: readonly string[];
  patterns?: readonly PatternRule[];
  packs?: readonly PackName[];
  exempt?: readonly Exemption[];
  /** Durable scopes only (inbound, activator, saga). */
  remember?: Remember;
  /** Required when remember is Remember.Everything under explicit privacy; logged at boot. */
  rememberReason?: string;
  /** Default `Show.Hidden`. */
  defaultShow?: Show;
  /** Default `KeyCase.Ignore`. */
  keyCase?: KeyCase;
}

/**
 * Profile names: `^[a-z0-9][a-z0-9._-]{0,63}$` (the grammar of PatternRule.name). The public name
 * is the `ProfileName` SPI-445 already exports; this local alias keeps the privacy engine a leaf.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- names the profile grammar
type ProfileName = string;

export interface PrivacyProfile extends Privacy {
  extends?: ProfileName | readonly ProfileName[];
}

/** What L2..L5 accept wherever privacy rules are accepted. */
export type PrivacyRef =
  | ProfileName
  | readonly ProfileName[]
  | (Privacy & {
      use?: ProfileName | readonly ProfileName[];
      /** `Reach.Trail` (default) or `Reach.Delivery` (L4 flow steps only, SD-50). */
      reach?: Reach;
      /** Required with `Reach.Delivery`, logged at boot. */
      reachReason?: string;
    });

/** Module-wide options: `forRoot({ privacy })`. `false` disables the baseline (section 2), L1 only. */
export interface PrivacyModuleOptions extends Privacy {
  profiles?: Readonly<Record<ProfileName, PrivacyProfile>>;
  fingerprintSecret?: FingerprintSecretProvider;
  /** Default 16, range 12..64. */
  fingerprintChars?: number;
  sealKeys?: SealKeyProvider;
  regexEngine?: RegexEngine;
  /** Default 65536, range 1024..16777216 (provisional, revisited in SPI-444). */
  maxScanBytes?: number;
  /** Default 32. */
  maxDepth?: number;
  /** Default 10000. */
  maxNodes?: number;
}

/** The headers the baseline always hides (SD-09). */
export const DEFAULT_HIDDEN_HEADERS: readonly string[] = Object.freeze([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
]);

/** Headers that carry an idempotency key: fingerprint-or-hide (SD-09). */
export const IDEMPOTENCY_KEY_HEADERS: readonly string[] = Object.freeze([
  'idempotencyKey',
  'idempotency-key',
  'x-idempotency-key',
]);

/** Message trace fields that are never scanned or hidden (SD-10). */
export const PROTECTED_TRACE_FIELDS: readonly string[] = Object.freeze([
  'id',
  'traceId',
  'spanId',
  'parentSpanId',
  'correlationId',
  'causationId',
  'timestamp',
  'history',
]);

/** Rule and profile names (SD-26, SD-48). */
export const RULE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const DEFAULT_FINGERPRINT_CHARS = 16;
export const DEFAULT_MAX_SCAN_BYTES = 65_536;
export const DEFAULT_MAX_DEPTH = 32;
export const DEFAULT_MAX_NODES = 10_000;
