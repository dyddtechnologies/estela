import { createHmac } from 'node:crypto';
import { Show } from './privacy.types';

/** A resolved `ShowOptions`: every member set. */
export interface ShowSpec {
  readonly show: Show;
  readonly showFirst: number;
  readonly showLast: number;
  readonly text: string;
}

/** The HMAC side of `Show.Fingerprint`, holding the current secret. */
export interface Fingerprinter {
  readonly id: string;
  fingerprint(text: string): string;
}

/** Strictest first: Omitted > Hidden = Text > Length > Fingerprint > Ends (SD-17). */
const STRENGTH: Readonly<Record<Show, number>> = {
  [Show.Omitted]: 5,
  [Show.Hidden]: 4,
  [Show.Text]: 4,
  [Show.Length]: 3,
  [Show.Fingerprint]: 2,
  [Show.Ends]: 1,
};

export function strength(show: Show): number {
  return STRENGTH[show];
}

export const SHOW_VALUES: readonly Show[] = Object.values(Show);

export function isShow(value: unknown): value is Show {
  return SHOW_VALUES.includes(value as Show);
}

export const HIDE_FAILED = '[HIDE_FAILED]';
export const TRUNCATED = '[TRUNCATED]';
export const CIRCULAR = '[Circular]';
export const GETTER = '[Getter]';

/** `[HIDDEN:<rule>]`, or bare `[HIDDEN]` for an exemption (it names no rule). */
export function hiddenToken(rule: string | undefined, extra = ''): string {
  const name = rule === undefined ? '' : `:${rule}`;
  return `[HIDDEN${name}${extra}]`;
}

const FINGERPRINT_TOKEN = /^fp:[A-Za-z0-9_-]{1,16}:[0-9a-f]{12,64}$/;

/** True for a value the engine already wrote; it is never hidden again. */
export function isToken(text: string): boolean {
  return text.startsWith('[HIDDEN') || text === HIDE_FAILED || FINGERPRINT_TOKEN.test(text);
}

export function hmacFingerprinter(id: string, secret: Uint8Array, chars: number): Fingerprinter {
  const key = Buffer.from(secret);
  return {
    id,
    fingerprint(text: string): string {
      const hex = createHmac('sha256', key).update(text, 'utf8').digest('hex');
      return `fp:${id}:${hex.slice(0, chars)}`;
    },
  };
}

/** Marker for a value that is left out (`Show.Omitted`). */
export const OMIT: unique symbol = Symbol('omit');

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function entryCount(value: object): number {
  if (Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  return Object.keys(value).length;
}

/**
 * `Show.Ends` (6.3): `showFirst`, `***`, `showLast`; never more than half the value. When the
 * sum exceeds half, both shrink in proportion; values under 8 chars are hidden.
 */
export function showEnds(text: string, first: number, last: number): string | undefined {
  if (text.length < 8) return undefined;
  const half = Math.floor(text.length / 2);
  let head = first;
  let tail = last;
  if (head + tail > half) {
    head = Math.floor((first * half) / (first + last));
    tail = half - head;
  }
  return `${text.slice(0, head)}***${tail === 0 ? '' : text.slice(text.length - tail)}`;
}

/** UTF-16 length of a scalar, or the entry count of an object (6.3 `Show.Length`). */
function sizeOf(value: unknown, text: string | undefined): number {
  if (text !== undefined) return text.length;
  return typeof value === 'object' && value !== null ? entryCount(value) : 0;
}

/** The output of one rule for one value (6.3), or OMIT. */
export function showValue(
  value: unknown,
  spec: ShowSpec,
  rule: string | undefined,
  fingerprinter: Fingerprinter | undefined,
): unknown {
  const text = scalarText(value);
  switch (spec.show) {
    case Show.Omitted:
      return OMIT;
    case Show.Text:
      return spec.text;
    case Show.Length:
      return hiddenToken(rule, ` len=${sizeOf(value, text)}`);
    case Show.Fingerprint:
      if (text === undefined || fingerprinter === undefined) return hiddenToken(rule);
      return fingerprinter.fingerprint(text);
    case Show.Ends: {
      const ends = text === undefined ? undefined : showEnds(text, spec.showFirst, spec.showLast);
      return ends ?? hiddenToken(rule);
    }
    default:
      return hiddenToken(rule);
  }
}
