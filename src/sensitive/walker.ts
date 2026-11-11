import { DeliveryCopyError } from './privacy-errors';
import { PROTECTED_TRACE_FIELDS, Show } from './privacy.types';
import {
  CIRCULAR,
  GETTER,
  hiddenToken,
  isToken,
  OMIT,
  showValue,
  strength,
  TRUNCATED,
  type Fingerprinter,
  type ShowSpec,
} from './masking';
import type {
  CompiledExemption,
  CompiledFieldRule,
  CompiledPatternRule,
  FrozenPlan,
  PlanTerminal,
} from './policy-resolver';
import type { PathStep, TrieState } from './selector';
import { privateEntriesOf, type PrivateFieldOptions } from './private.decorator';

/**
 * The walker (6.2): field rules, then pattern rules on every remaining string, within the walk
 * limits (SD-21, SD-22). Copy-on-write: unchanged subtrees are returned as they are; a changed node
 * is a new object. The input is never mutated (SD-02).
 */
export interface WalkLimits {
  readonly maxScanBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export interface WalkEnv extends WalkLimits {
  readonly plan: FrozenPlan;
  readonly fingerprinter: Fingerprinter | undefined;
  /** Delivery copies fail instead of writing placeholders (SD-51). */
  readonly faithful: boolean;
  readonly subject: string;
  /** Called once per hidden value, with the rule name. */
  readonly onHide: (rule: string) => void;
}

/** Where a node sits relative to a message-shaped root (SD-10). */
type Role = 'root' | 'root-headers' | 'other';

/** The state of one node of the walk. */
interface At {
  readonly state: TrieState<PlanTerminal>;
  readonly depth: number;
  readonly role: Role;
  /** A field rule from decorator metadata of the parent instance (SD-06). */
  readonly marked: CompiledFieldRule | undefined;
}

const PROTECTED = new Set(PROTECTED_TRACE_FIELDS);
const TAIL_GUARD_BYTES = 512;
const DECORATOR_LEVEL = 0;

class Walk {
  private nodes = 0;
  private readonly ancestors = new Set<object>();

  constructor(private readonly env: WalkEnv) {}

  fail(why: string): never {
    throw new DeliveryCopyError(this.env.subject, why);
  }

  placeholder(text: string, why: string): string {
    if (this.env.faithful) this.fail(why);
    return text;
  }

  node(value: unknown, at: At): unknown {
    this.nodes++;
    if (this.nodes > this.env.maxNodes) return this.placeholder(TRUNCATED, 'node limit');
    const decision = decide(this.env.plan.trie.terminals(at.state), at.marked);
    if (decision.rule !== undefined) return this.hide(value, decision.rule, decision.ruleName);
    return this.content(value, at, decision.exemptLevel, decision.skips);
  }

  private hide(value: unknown, spec: ShowSpec, rule: string | undefined): unknown {
    if (rule !== undefined) this.env.onHide(rule);
    return showValue(value, spec, rule, this.env.fingerprinter);
  }

  private content(
    value: unknown,
    at: At,
    exemptLevel: number,
    skips: ReadonlySet<CompiledPatternRule>,
  ): unknown {
    if (typeof value === 'string') return this.text(value, exemptLevel, skips);
    if (typeof value !== 'object' || value === null) return value;
    if (at.depth >= this.env.maxDepth) return this.placeholder(TRUNCATED, 'depth limit');
    return this.object(value, at);
  }

  /** Pattern rules (6.2 step 3) on one string, after the `maxScanBytes` cut (SD-21). */
  text(value: string, exemptLevel: number, skips: ReadonlySet<CompiledPatternRule>): string {
    const rules = this.env.plan.patterns.filter(
      (rule) => rule.level > exemptLevel && !skips.has(rule),
    );
    if (rules.length === 0) return value;
    const bytes = byteLength(value);
    if (bytes <= this.env.maxScanBytes) return this.scan(value, rules);
    if (this.env.faithful) this.fail('string above maxScanBytes');
    const window = value.slice(0, charsWithinBytes(value, this.env.maxScanBytes));
    const scanned = this.scan(window, rules);
    const kept = cutAtWhitespace(scanned, byteLength(scanned) - TAIL_GUARD_BYTES);
    return `${kept}[truncated ${bytes - byteLength(kept)} bytes]`;
  }

  private scan(value: string, rules: readonly CompiledPatternRule[]): string {
    let out = value;
    for (const rule of rules) out = this.applyPattern(out, rule);
    return out;
  }

  private applyPattern(input: string, rule: CompiledPatternRule): string {
    return rule.pattern.replaceAll(input, (match, groups, offset, spans) => {
      if (rule.confirm !== undefined && !rule.confirm(match, input, offset)) return match;
      const span = targetSpan(rule.group, match, groups, spans);
      if (span === undefined) return match;
      const [start, end] = span;
      const target = match.slice(start, end);
      if (target === '' || isToken(target)) return match;
      const shown = this.hide(target, rule.show, rule.name);
      const replacement = shown === OMIT ? '' : String(shown);
      return `${match.slice(0, start)}${replacement}${match.slice(end)}`;
    });
  }

  private object(value: object, at: At): unknown {
    if (value instanceof Date) {
      if (this.env.faithful) return value;
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    const binary = binaryLength(value);
    if (binary !== undefined) return this.env.faithful ? value : `[Binary len=${binary}]`;
    if (this.ancestors.has(value)) return this.placeholder(CIRCULAR, 'cycle');
    this.ancestors.add(value);
    try {
      if (value instanceof Error) {
        if (this.env.faithful) return this.entries(value, at);
        return this.entries(errorShape(value), at);
      }
      if (Array.isArray(value)) return this.array(value, at);
      if (value instanceof Map) return this.map(value, at);
      if (value instanceof Set) return this.set(value, at);
      return this.entries(value, at);
    } finally {
      this.ancestors.delete(value);
    }
  }

  private child(at: At, step: PathStep, value: unknown, marked?: CompiledFieldRule): unknown {
    const role = childRole(at.role, step);
    const next: At = {
      state: this.env.plan.trie.step(at.state, step),
      depth: at.depth + 1,
      role,
      marked,
    };
    if (isProtected(at.role, step)) return value;
    return this.node(value, next);
  }

  private array(value: readonly unknown[], at: At): unknown {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i];
      const shown = this.child(at, i, item);
      if (shown === item && out === undefined) continue;
      out ??= value.slice(0, i);
      if (shown !== OMIT) out.push(shown);
    }
    return out ?? value;
  }

  private map(value: Map<unknown, unknown>, at: At): unknown {
    let changed = false;
    const out = new Map<unknown, unknown>();
    for (const [key, item] of value) {
      const shown = this.child(at, String(key), item);
      if (shown !== item) changed = true;
      if (shown !== OMIT) out.set(key, shown);
    }
    if (!changed) return value;
    return this.env.faithful ? this.fail('Map on a changed path') : out;
  }

  private set(value: Set<unknown>, at: At): unknown {
    let changed = false;
    const out = new Set<unknown>();
    let index = 0;
    for (const item of value) {
      const shown = this.child(at, index++, item);
      if (shown !== item) changed = true;
      if (shown !== OMIT) out.add(shown);
    }
    if (!changed) return value;
    return this.env.faithful ? this.fail('Set on a changed path') : out;
  }

  private entries(value: object, at: At): unknown {
    const marks = markedRules(value);
    // A sink serializer would call toJSON on the input; the trail copy never carries it (SD-22).
    const forceCopy =
      !this.env.faithful && typeof (value as { toJSON?: unknown }).toJSON === 'function';
    let out: Record<string, unknown> | undefined = forceCopy ? {} : undefined;
    const keys = Object.keys(value);
    for (const [index, key] of keys.entries()) {
      const [item, shown] = this.entry(value, key, at, marks, forceCopy);
      if (shown === item && out === undefined) continue;
      out ??= this.copyHead(value, keys, index);
      if (shown !== OMIT) out[key] = shown;
    }
    return out ?? value;
  }

  /** The input and the shown value of one own key; a getter is never invoked. */
  private entry(
    value: object,
    key: string,
    at: At,
    marks: ReadonlyMap<string, CompiledFieldRule> | undefined,
    forceCopy: boolean,
  ): [unknown, unknown] {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !('value' in descriptor)) {
      return [GETTER_MARK, this.placeholder(GETTER, 'getter')];
    }
    const item: unknown = descriptor?.value;
    if (forceCopy && key === 'toJSON') return [item, OMIT];
    return [item, this.child(at, key, item, marks?.get(key))];
  }

  /** A new object holding the keys before `index`; delivery copies refuse non-plain objects. */
  private copyHead(value: object, keys: readonly string[], index: number): Record<string, unknown> {
    if (this.env.faithful && !isPlainObject(value)) this.fail('non-plain object on a changed path');
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, index)) out[key] = (value as Record<string, unknown>)[key];
    return out;
  }
}

/** Decision for one node from its terminals (6.2 step 2, SD-17, SD-18). */
interface Decision {
  rule: ShowSpec | undefined;
  ruleName: string | undefined;
  /** Pattern rules at this level or outer skip the node (-Infinity: no exemption). */
  exemptLevel: number;
  skips: ReadonlySet<CompiledPatternRule>;
}

const NO_SKIPS: ReadonlySet<CompiledPatternRule> = new Set();

/** Stands for a getter's input value, which is never read; it differs from any shown value. */
const GETTER_MARK = Symbol('getter');

/** The [start, end) of the hidden part inside a match: the whole match or one capture group. */
function targetSpan(
  group: number,
  match: string,
  groups: readonly (string | undefined)[],
  spans: readonly (readonly [number, number] | undefined)[] | undefined,
): readonly [number, number] | undefined {
  if (group === 0) return [0, match.length];
  const target = groups[group - 1];
  if (target === undefined) return undefined;
  const span = spans?.[group - 1];
  if (span !== undefined) return span;
  const start = match.lastIndexOf(target);
  return [start, start + target.length];
}

interface Candidate {
  spec: ShowSpec;
  level: number;
  order: number;
  name: string | undefined;
}

function pickStricter(current: Candidate | undefined, next: Candidate): Candidate {
  if (current === undefined) return next;
  const diff = strength(next.spec.show) - strength(current.spec.show);
  if (diff !== 0) return diff > 0 ? next : current;
  if (next.level !== current.level) return next.level < current.level ? next : current;
  return next.order < current.order ? next : current;
}

function split(terminals: readonly PlanTerminal[], marked: CompiledFieldRule | undefined) {
  const fields: CompiledFieldRule[] = marked === undefined ? [] : [marked];
  const exemptions: CompiledExemption[] = [];
  const skips = new Set<CompiledPatternRule>();
  for (const terminal of terminals) {
    if (terminal.kind === 'field') fields.push(terminal);
    else if (terminal.kind === 'exempt') exemptions.push(terminal);
    else skips.add(terminal.rule);
  }
  return { fields, exemptions, skips };
}

function decide(
  terminals: readonly PlanTerminal[],
  marked: CompiledFieldRule | undefined,
): Decision {
  if (terminals.length === 0 && marked === undefined) {
    return { rule: undefined, ruleName: undefined, exemptLevel: -Infinity, skips: NO_SKIPS };
  }
  const { fields, exemptions, skips } = split(terminals, marked);
  const exemptLevel = exemptions.reduce((max, e) => Math.max(max, e.level), -Infinity);
  let best: Candidate | undefined;
  for (const exemption of exemptions) {
    if (exemption.level !== exemptLevel || exemption.show === undefined) continue;
    best = pickStricter(best, {
      spec: exemption.show,
      level: exemptLevel,
      order: -1,
      name: undefined,
    });
  }
  for (const field of fields) {
    if (field.level <= exemptLevel) continue;
    const order = field.order ?? Number.MAX_SAFE_INTEGER;
    best = pickStricter(best, { spec: field.show, level: field.level, order, name: field.name });
  }
  return { rule: best?.spec, ruleName: best?.name, exemptLevel, skips };
}

function childRole(role: Role, step: PathStep): Role {
  return role === 'root' && step === 'headers' ? 'root-headers' : 'other';
}

/** SD-10: trace fields of a message-shaped root and of its headers are never touched. */
function isProtected(role: Role, step: PathStep): boolean {
  if (typeof step !== 'string' || !PROTECTED.has(step)) return false;
  return role === 'root-headers';
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function binaryLength(value: object): number | undefined {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return undefined;
}

const markCache = new WeakMap<object, ReadonlyMap<string, CompiledFieldRule> | null>();

/**
 * Decorators are not seen at boot, so an explicit fingerprint there cannot fail boot: without a
 * secret it falls back to hidden (fingerprint-or-hide).
 */
function decoratorRule(options: PrivateFieldOptions): CompiledFieldRule {
  const name = options.name ?? 'field';
  const show: ShowSpec = {
    show: options.show ?? Show.Hidden,
    showFirst: options.showFirst ?? 0,
    showLast: options.showLast ?? 4,
    text: options.text ?? hiddenToken(name),
  };
  return { kind: 'field', name, show, level: DECORATOR_LEVEL };
}

/** Field rules from `@Private` metadata of a class instance (SD-06). */
function markedRules(value: object): ReadonlyMap<string, CompiledFieldRule> | undefined {
  const ctor = (value as { constructor?: unknown }).constructor;
  if (typeof ctor !== 'function' || ctor === Object) return undefined;
  const cached = markCache.get(ctor);
  if (cached !== undefined) return cached ?? undefined;
  const out = new Map<string, CompiledFieldRule>();
  for (const [key, options] of privateEntriesOf(ctor)) out.set(key, decoratorRule(options));
  markCache.set(ctor, out.size === 0 ? null : out);
  return out.size === 0 ? undefined : out;
}

/** Name, message, stack, own enumerable properties and cause of an error, as a plain object. */
export function errorShape(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  if (typeof error.stack === 'string') out.stack = error.stack;
  for (const key of Object.keys(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    out[key] = descriptor !== undefined && 'value' in descriptor ? descriptor.value : GETTER;
  }
  const cause = Object.getOwnPropertyDescriptor(error, 'cause');
  if (cause !== undefined && 'value' in cause && cause.value !== undefined) out.cause = cause.value;
  return out;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function utf8Size(point: number): number {
  if (point < 0x80) return 1;
  if (point < 0x800) return 2;
  return point < 0x10000 ? 3 : 4;
}

/** Number of UTF-16 units of the longest prefix within `maxBytes`, on a code point boundary. */
export function charsWithinBytes(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const point = text.codePointAt(index) ?? 0;
    const size = utf8Size(point);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += point >= 0x10000 ? 2 : 1;
  }
  return index;
}

/**
 * SD-21: keeps at most `keepBytes` of `text`, then backs off to the last whitespace, so the run of
 * non-whitespace characters that reaches the cut is dropped; no whitespace drops everything.
 */
export function cutAtWhitespace(text: string, keepBytes: number): string {
  const limit = keepBytes <= 0 ? 0 : charsWithinBytes(text, keepBytes);
  for (let i = limit - 1; i >= 0; i--) {
    if (/\s/.test(text[i]!)) return text.slice(0, i + 1);
  }
  return '';
}

/** Walks one value with a plan; returns the copy, OMIT when the root itself is omitted. */
export function walk(value: unknown, env: WalkEnv): unknown {
  const message = isMessageShaped(value);
  const at: At = {
    state: env.plan.trie.start(),
    depth: 0,
    role: message ? 'root' : 'other',
    marked: undefined,
  };
  return new Walk(env).node(value, at);
}

function isMessageShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const headers = (value as { headers?: unknown }).headers;
  return 'payload' in value && typeof headers === 'object' && headers !== null;
}
