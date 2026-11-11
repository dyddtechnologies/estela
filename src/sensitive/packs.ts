import { Show, type FieldRule, type PatternRule } from './privacy.types';

/**
 * Built-in packs, version 1 (6.4). Every regex uses RE2-compatible syntax only (SD-13): context is
 * checked in `confirm`, never consumed or looked around. Changing what a rule matches bumps the
 * pack version; the baseline (D3) is pinned to `secrets@1`.
 */
export interface PackDefinition {
  readonly name: string;
  readonly version: number;
  /** Key-name rules; always case-insensitive. */
  readonly fields: readonly FieldRule[];
  readonly patterns: readonly PatternRule[];
}

const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';

/** True when no digit touches the match on either side (SD-24). */
export function noAdjacentDigit(match: string, input: string, offset: number): boolean {
  return !isDigit(input[offset - 1]) && !isDigit(input[offset + match.length]);
}

/** Luhn checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function prefixIn(digits: string, length: number, from: number, to: number): boolean {
  const prefix = Number(digits.slice(0, length));
  return prefix >= from && prefix <= to;
}

/** Visa, Mastercard, Amex and Discover prefixes and lengths (6.4); Maestro and UATP are left out. */
export function cardIssuerMatches(digits: string): boolean {
  const n = digits.length;
  if (digits.startsWith('4')) return n === 13 || n === 16 || n === 19;
  if (prefixIn(digits, 2, 51, 55) || prefixIn(digits, 4, 2221, 2720)) return n === 16;
  if (digits.startsWith('34') || digits.startsWith('37')) return n === 15;
  const discover =
    digits.startsWith('6011') || prefixIn(digits, 3, 644, 649) || digits.startsWith('65');
  return discover && (n === 16 || n === 19);
}

/** `personal.card` confirm: issuer prefix and length, Luhn and no adjacent digit (SD-24). */
export function confirmCard(match: string, input: string, offset: number): boolean {
  if (!noAdjacentDigit(match, input, offset)) return false;
  const digits = match.replace(/[ -]/g, '');
  return cardIssuerMatches(digits) && luhnValid(digits);
}

const SECRET_KEYS = [
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'accessToken',
  'refresh_token',
  'refreshToken',
  'api_key',
  'apiKey',
  'api-key',
  'client_secret',
  'clientSecret',
  'private_key',
  'privateKey',
  'authorization',
];

const SECRETS_V1: PackDefinition = {
  name: 'secrets',
  version: 1,
  fields: SECRET_KEYS.map((key) => ({ path: `**.${key}`, name: 'secrets.keys' })),
  // Bounded scheme: an unbounded one is quadratic on long letter runs (base64 blobs).
  patterns: [
    { name: 'secrets.jwt', regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
    { name: 'secrets.bearer', regex: /\bbearer\s+([A-Z0-9._~+/=-]+)/i, group: 1 },
    {
      name: 'secrets.basic-url',
      regex: /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([^\s/:@]+:[^\s/@]*)@/,
      group: 1,
    },
    { name: 'secrets.aws-key-id', regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/ },
    {
      name: 'secrets.query',
      regex:
        /\b(?:api_key|apikey|api-key|access_token|token|secret|password|sig|signature)=([^&\s#"']+)/i,
      group: 1,
    },
    {
      name: 'secrets.assignment',
      regex:
        /\b(?:password|passwd|secret|api_key|token)\\?["']?\s*[:=]\s*\\?["']?([^\s"'\\,;&}]{4,})/i,
      group: 1,
    },
    {
      name: 'secrets.pem',
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
    },
  ],
};

const PERSONAL_V1: PackDefinition = {
  name: 'personal',
  version: 1,
  fields: [],
  patterns: [
    {
      name: 'personal.email',
      regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/,
      show: Show.Fingerprint,
    },
    {
      name: 'personal.phone-e164',
      regex: /\+[1-9]\d{7,14}/,
      show: Show.Fingerprint,
      confirm: noAdjacentDigit,
    },
    {
      name: 'personal.card',
      // eslint-disable-next-line sonarjs/regex-complexity -- three grouping forms; Luhn and issuer checks run in confirm
      regex: /\d{4}[ -]\d{6}[ -]\d{5}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}|\d{13,19}/,
      show: Show.Ends,
      showLast: 4,
      confirm: confirmCard,
    },
  ],
};

const PACKS: Readonly<Record<string, readonly PackDefinition[]>> = {
  secrets: [SECRETS_V1],
  personal: [PERSONAL_V1],
};

/** `secrets` means the latest version; `secrets@1` pins it; undefined for an unknown name or version. */
export function resolvePack(name: string): PackDefinition | undefined {
  const [base, version, extra] = String(name).split('@');
  if (base === undefined || extra !== undefined || !Object.hasOwn(PACKS, base)) return undefined;
  const versions = PACKS[base] ?? [];
  if (version === undefined) return versions[versions.length - 1];
  if (!/^[1-9]\d*$/.test(version)) return undefined;
  return versions.find((pack) => pack.version === Number(version));
}

/** Every built-in pack, for the RE2 syntax check (SD-13). */
export function builtInPacks(): readonly PackDefinition[] {
  return Object.values(PACKS).flat();
}

/** The baseline is pinned to `secrets@1` (D3). */
export const BASELINE_PACK = SECRETS_V1;
