import {
  DEFAULT_HIDDEN_HEADERS,
  IDEMPOTENCY_KEY_HEADERS,
  KeyCase,
  PROTECTED_TRACE_FIELDS,
  Reach,
  Remember,
  RULE_NAME_PATTERN,
  Show,
  type Exemption,
  type FieldRule,
  type PatternRule,
  type Privacy,
  type PrivacyModuleOptions,
  type PrivacyProfile,
  type PrivacyRef,
} from './privacy.types';
import { PRIVACY_FINDING_CODES as CODE, type PrivacyFinding } from './privacy-errors';
import { isShow, type ShowSpec } from './masking';
import { BASELINE_PACK, resolvePack, type PackDefinition } from './packs';
import { analyzeRegex } from './regex-safety';
import { nativeRegexEngine, type CompiledPattern, type RegexEngine } from './regex-engine';
import { parseSelector, selectorMatches, SelectorTrie, type SelectorToken } from './selector';

// ---------- Scopes the module collects at boot ----------

/** Where a reference was written; decides which options it may hold (18.2). */
export type PrivacyLevelKind =
  | 'defaults'
  | 'channel'
  | 'endpoint'
  | 'activator'
  | 'binding'
  | 'saga'
  | 'flow'
  | 'step'
  | 'target'
  | 'call';

export interface PrivacyLevel {
  /** Subject used in findings and boot lines, for example "channel 'payments.charge'". */
  readonly subject: string;
  readonly kind: PrivacyLevelKind;
  readonly ref: PrivacyRef | false | undefined;
  /** DSL step kind of a step or target level (`filter`, `wireTap`, `route`, ...). */
  readonly stepKind?: string;
}

/** One scope (6.6): its levels inside the module, outer to inner. */
export interface PrivacyScope {
  readonly levels: readonly PrivacyLevel[];
  /** Inbound endpoints, activators and sagas keep records and resolve `remember`. */
  readonly durable?: boolean;
  /** Request/reply inbound with `onDuplicate: 'replay'` (SD-30). */
  readonly replays?: boolean;
  /**
   * Boot summary of the scope (SD-37, SD-60): absent logs it always, `'explicit'` only when an
   * explicit privacy reaches it, `'none'` never (an internal scope, its notes included).
   */
  readonly summary?: 'explicit' | 'none';
}

/** The per-scope references the module collects at boot, keyed by scope name. */
export type PrivacyScopes = Readonly<Record<string, PrivacyScope>>;

// ---------- Compiled rules ----------

export interface CompiledFieldRule {
  readonly kind: 'field';
  readonly name: string;
  readonly show: ShowSpec;
  /** -1 baseline, 0 module, then one per scope level. */
  readonly level: number;
  /** Insertion order: between equal strength and level, the earlier rule wins. */
  readonly order?: number;
}

export interface CompiledExemption {
  readonly kind: 'exempt';
  readonly show: ShowSpec | undefined;
  readonly level: number;
}

export interface CompiledPatternRule {
  readonly name: string;
  readonly pattern: CompiledPattern;
  readonly group: number;
  readonly show: ShowSpec;
  readonly level: number;
  readonly confirm: PatternRule['confirm'];
}

export interface CompiledSkip {
  readonly kind: 'skip';
  readonly rule: CompiledPatternRule;
}

export type PlanTerminal = CompiledFieldRule | CompiledExemption | CompiledSkip;

/** One subject's compiled privacy, frozen at boot. */
export interface FrozenPlan {
  readonly trie: SelectorTrie<PlanTerminal>;
  readonly patterns: readonly CompiledPatternRule[];
  /** An explicit privacy reaches the subject (SD-57); the baseline does not count. */
  readonly explicit: boolean;
  /** Resolved for durable scopes only. */
  readonly remember: Remember | undefined;
  readonly rememberDefaulted: boolean;
  /** Profile names, pack names with version and 'inline', for the graph and boot lines (SD-59). */
  readonly names: readonly string[];
  readonly fieldCount: number;
  /** Rules of a `Reach.Delivery` reference only (D19); undefined when the subject has none. */
  readonly delivery: FrozenPlan | undefined;
  readonly deliveryReason: string | undefined;
}

// ---------- Findings ----------

export class Findings {
  readonly list: PrivacyFinding[] = [];
  readonly problems: string[] = [];
  private readonly seen = new Set<string>();

  add(code: string, subject: string, path: string, rule: string): void {
    const id = `${code}|${subject}|${path}|${rule}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.list.push({ code, severity: 'error', subject, path });
    this.problems.push(`${subject}: ${path} ${rule}`);
  }

  get count(): number {
    return this.list.length;
  }
}

/** Material the compiler reads besides the rules. */
export interface CompileEnv {
  readonly findings: Findings;
  readonly hasFingerprintSecret: boolean;
  readonly hasSealKeys: boolean;
  readonly engine: RegexEngine;
  readonly profiles: Readonly<Record<string, PrivacyProfile>>;
  /** Compiled patterns, once per rule object. */
  readonly patternCache: WeakMap<PatternRule, CompiledPattern | false>;
  /** Exemptions to log at boot. */
  readonly exemptions: { subject: string; path: string; show: string; reason: string }[];
}

const MAX_EXTENDS_HOPS = 8;
const REASON_MAX = 200;

const isReason = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= REASON_MAX;

function asList<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

const quoted = (name: string): string => `'${name}'`;

function showSpec(
  options: {
    show?: Show | undefined;
    showFirst?: number | undefined;
    showLast?: number | undefined;
    text?: string | undefined;
  },
  fallback: Show,
): ShowSpec {
  return {
    show: options.show ?? fallback,
    showFirst: options.showFirst ?? 0,
    showLast: options.showLast ?? 4,
    text: options.text ?? '',
  };
}

/** Built-in rules use fingerprint-or-hide (SD-15). */
function builtinSpec(spec: ShowSpec, env: CompileEnv): ShowSpec {
  return spec.show === Show.Fingerprint && !env.hasFingerprintSecret
    ? { ...spec, show: Show.Hidden }
    : spec;
}

// ---------- Profiles (SD-48) ----------

/** Validates names and `extends` chains of every declared profile. */
export function validateProfiles(env: CompileEnv): void {
  for (const name of Object.keys(env.profiles)) {
    const subject = `profile '${name}'`;
    if (!RULE_NAME_PATTERN.test(name)) {
      env.findings.add(
        CODE.PROFILE_NAME,
        subject,
        `privacy.profiles.${name}`,
        'is not a valid profile name',
      );
      continue;
    }
    profileDepth(name, [], env, subject);
  }
}

/** Longest `extends` chain from `name`, reporting cycles, unknown names and depth. */
function profileDepth(
  name: string,
  chain: readonly string[],
  env: CompileEnv,
  subject: string,
): number {
  const path = `privacy.profiles.${chain[0] ?? name}.extends`;
  if (chain.includes(name)) {
    env.findings.add(
      CODE.PROFILE_CYCLE,
      subject,
      path,
      `profiles ${[...chain, name].map(quoted).join(' -> ')} form a cycle`,
    );
    return Infinity;
  }
  const profile = Object.hasOwn(env.profiles, name) ? env.profiles[name] : undefined;
  if (profile === undefined) {
    env.findings.add(CODE.UNKNOWN_PROFILE, subject, path, `unknown profile '${name}'`);
    return 0;
  }
  let depth = 0;
  for (const parent of asList(profile.extends)) {
    const below = profileDepth(String(parent), [...chain, name], env, subject);
    if (below === Infinity) return Infinity;
    depth = Math.max(depth, below + 1);
  }
  if (chain.length === 0 && depth > MAX_EXTENDS_HOPS) {
    env.findings.add(
      CODE.PROFILE_DEPTH,
      subject,
      path,
      `extends more than ${MAX_EXTENDS_HOPS} hops`,
    );
  }
  return depth;
}

/** The privacy objects of a profile, parents first; stops on a broken chain (already reported). */
function expandProfile(name: string, env: CompileEnv, seen: Set<string>): Privacy[] {
  if (seen.has(name) || !Object.hasOwn(env.profiles, name)) return [];
  seen.add(name);
  const profile = env.profiles[name]!;
  const out: Privacy[] = [];
  for (const parent of asList(profile.extends))
    out.push(...expandProfile(String(parent), env, seen));
  out.push(profile);
  return out;
}

// ---------- Reference expansion ----------

/** A reference expanded at one level: the privacy objects unioned there, plus its own options. */
export interface ExpandedRef {
  readonly parts: readonly Privacy[];
  readonly names: readonly string[];
  readonly reach: Reach | undefined;
  readonly reachReason: string | undefined;
}

function useNames(
  names: readonly unknown[],
  subject: string,
  path: string,
  env: CompileEnv,
): { parts: Privacy[]; names: string[] } {
  const parts: Privacy[] = [];
  const found: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !Object.hasOwn(env.profiles, name)) {
      env.findings.add(CODE.UNKNOWN_PROFILE, subject, path, `unknown profile '${String(name)}'`);
      continue;
    }
    parts.push(...expandProfile(name, env, new Set()));
    found.push(name);
  }
  return { parts, names: found };
}

export function expandRef(ref: PrivacyRef, subject: string, env: CompileEnv): ExpandedRef {
  if (typeof ref === 'string' || Array.isArray(ref)) {
    const used = useNames(
      asList<string>(ref as string | readonly string[]),
      subject,
      'privacy',
      env,
    );
    return { ...used, reach: undefined, reachReason: undefined };
  }
  if (typeof ref !== 'object') {
    env.findings.add(
      CODE.INVALID_OPTION,
      subject,
      'privacy',
      'must be a profile name, a list of names or an object',
    );
    return { parts: [], names: [], reach: undefined, reachReason: undefined };
  }
  const inline = ref as Privacy & {
    use?: string | readonly string[];
    reach?: Reach;
    reachReason?: string;
  };
  const used = useNames(asList(inline.use), subject, 'privacy.use', env);
  const own = hasRules(inline) || inline.remember !== undefined;
  return {
    parts: [...used.parts, inline],
    names: own ? [...used.names, 'inline'] : used.names,
    reach: inline.reach,
    reachReason: inline.reachReason,
  };
}

/** SD-57: a privacy object holds a rule. */
export function hasRules(privacy: Privacy): boolean {
  const lists = [privacy.fields, privacy.headers, privacy.patterns, privacy.packs, privacy.exempt];
  return lists.some((list) => list !== undefined && list.length > 0);
}

// ---------- Plan builder ----------

const PROTECTED_PATHS: readonly (readonly (string | number)[])[] = PROTECTED_TRACE_FIELDS.flatMap(
  (field) => (field === 'history' ? [['headers', field, 0]] : [['headers', field]]),
);

function isProtected(tokens: readonly SelectorToken[]): boolean {
  return PROTECTED_PATHS.some((path) => selectorMatches(tokens, path));
}

const HEADER_PATH = (name: string): SelectorToken[] => [
  { kind: 'globstar' },
  { kind: 'key', key: 'headers' },
  { kind: 'key', key: name },
];

/** Accumulates the rules of every level of one subject. */
export class PlanBuilder {
  readonly trie = new SelectorTrie<PlanTerminal>();
  readonly patterns: CompiledPatternRule[] = [];
  readonly names: string[] = [];
  private readonly pendingSkips: {
    tokens: SelectorToken[];
    fold: boolean;
    rule: CompiledPatternRule;
  }[] = [];
  fieldCount = 0;

  constructor(private readonly env: CompileEnv) {}

  private readonly packs = new Set<string>();

  addField(tokens: readonly SelectorToken[], fold: boolean, rule: CompiledFieldRule): void {
    this.trie.insert(tokens, fold, { ...rule, order: this.fieldCount });
    this.fieldCount++;
  }

  /** L0: DEFAULT_HIDDEN_HEADERS, the idempotency key headers and `secrets@1` (D3). */
  addBaseline(): void {
    const hidden = showSpec({}, Show.Hidden);
    for (const header of DEFAULT_HIDDEN_HEADERS) {
      this.addField(HEADER_PATH(header), true, {
        kind: 'field',
        name: 'header',
        show: hidden,
        level: -1,
      });
    }
    const key = builtinSpec(showSpec({}, Show.Fingerprint), this.env);
    for (const header of IDEMPOTENCY_KEY_HEADERS) {
      this.addField(HEADER_PATH(header), true, {
        kind: 'field',
        name: 'header',
        show: key,
        level: -1,
      });
    }
    this.addPack(BASELINE_PACK, -1, 'baseline', 'privacy.packs');
  }

  addPack(pack: PackDefinition, level: number, subject: string, path: string): void {
    // A pack already added at an outer level adds nothing: same rules, outer wins ties.
    const id = `${pack.name}@${pack.version}`;
    if (this.packs.has(id)) return;
    this.packs.add(id);
    for (const field of pack.fields) {
      const show = builtinSpec(showSpec(field, Show.Hidden), this.env);
      this.addField(parseSelector(field.path), true, {
        kind: 'field',
        name: field.name ?? 'field',
        show,
        level,
      });
    }
    for (const rule of pack.patterns) this.addPattern(rule, level, subject, path, true);
  }

  addPattern(
    rule: PatternRule,
    level: number,
    subject: string,
    path: string,
    builtin: boolean,
  ): void {
    const pattern = compilePattern(rule, subject, path, this.env);
    if (pattern === undefined) return;
    const spec = showSpec(rule, Show.Hidden);
    const compiled: CompiledPatternRule = {
      name: rule.name,
      pattern,
      group: rule.group ?? 0,
      show: builtin ? builtinSpec(spec, this.env) : spec,
      level,
      confirm: rule.confirm,
    };
    this.patterns.push(compiled);
    for (const [index, skip] of (rule.skipKeys ?? []).entries()) {
      const tokens = selectorTokens(skip, subject, `${path}.skipKeys[${index}]`, this.env);
      if (tokens !== undefined) this.pendingSkips.push({ tokens, fold: true, rule: compiled });
    }
  }

  addExemption(
    tokens: readonly SelectorToken[],
    fold: boolean,
    exemption: CompiledExemption,
  ): void {
    this.trie.insert(tokens, fold, exemption);
  }

  /** Adds one privacy object at `level` (validated by `checkPrivacy`). */
  addPrivacy(privacy: Privacy, level: number, subject: string, base: string): void {
    const fold = privacy.keyCase !== KeyCase.Match;
    this.addFields(privacy, fold, level, subject, base);
    for (const [index, name] of (privacy.packs ?? []).entries()) {
      const pack = resolvePack(name);
      if (pack === undefined) continue;
      this.names.push(`${pack.name}@${pack.version}`);
      this.addPack(pack, level, subject, `${base}.packs[${index}]`);
    }
    for (const [index, rule] of (privacy.patterns ?? []).entries()) {
      this.addPattern(rule, level, subject, `${base}.patterns[${index}]`, false);
    }
    for (const [index, exemption] of (privacy.exempt ?? []).entries()) {
      this.exempt(exemption, fold, level, subject, `${base}.exempt[${index}]`);
    }
  }

  private addFields(
    privacy: Privacy,
    fold: boolean,
    level: number,
    subject: string,
    base: string,
  ): void {
    const fallback = privacy.defaultShow ?? Show.Hidden;
    for (const [index, field] of (privacy.fields ?? []).entries()) {
      const rule: FieldRule = typeof field === 'string' ? { path: field } : field;
      const tokens = fieldTokens(rule, subject, `${base}.fields[${index}]`, this.env);
      if (tokens === undefined) continue;
      const show = showSpec(rule, fallback);
      this.addField(tokens, fold, { kind: 'field', name: rule.name ?? 'field', show, level });
    }
    const hidden = showSpec({}, Show.Hidden);
    for (const header of privacy.headers ?? []) {
      if (typeof header !== 'string' || header === '') continue;
      this.addField(HEADER_PATH(header), true, {
        kind: 'field',
        name: 'header',
        show: hidden,
        level,
      });
    }
  }

  private exempt(
    exemption: Exemption,
    fold: boolean,
    level: number,
    subject: string,
    path: string,
  ): void {
    const tokens = selectorTokens(exemption.path, subject, `${path}.path`, this.env);
    if (tokens === undefined || !isReason(exemption.reason)) return;
    const show = exemption.show === undefined ? undefined : showSpec(exemption, exemption.show);
    this.addExemption(tokens, fold, { kind: 'exempt', show, level });
    this.env.exemptions.push({
      subject,
      path: exemption.path,
      show: exemption.show ?? 'as-is',
      reason: exemption.reason,
    });
  }

  /** Inserts `skipKeys` terminals; called once every pattern is known. */
  finish(): void {
    for (const skip of this.pendingSkips)
      this.trie.insert(skip.tokens, skip.fold, { kind: 'skip', rule: skip.rule });
    this.pendingSkips.length = 0;
  }
}

function selectorTokens(
  source: unknown,
  subject: string,
  path: string,
  env: CompileEnv,
): SelectorToken[] | undefined {
  try {
    return parseSelector(source as string);
  } catch {
    env.findings.add(
      CODE.INVALID_SELECTOR,
      subject,
      path,
      `selector '${String(source)}' does not parse`,
    );
    return undefined;
  }
}

function fieldTokens(
  rule: FieldRule,
  subject: string,
  path: string,
  env: CompileEnv,
): SelectorToken[] | undefined {
  const tokens = selectorTokens(rule.path, subject, `${path}.path`, env);
  if (tokens !== undefined && isProtected(tokens)) {
    env.findings.add(
      CODE.PROTECTED_TRACE_FIELD,
      subject,
      `${path}.path`,
      `selector '${rule.path}' selects a protected trace field`,
    );
    return undefined;
  }
  return tokens;
}

function compilePattern(
  rule: PatternRule,
  subject: string,
  path: string,
  env: CompileEnv,
): CompiledPattern | undefined {
  const cached = env.patternCache.get(rule);
  if (cached !== undefined) return cached === false ? undefined : cached;
  const regex: unknown = rule.regex;
  if (!(regex instanceof RegExp)) {
    env.findings.add(CODE.INVALID_OPTION, subject, `${path}.regex`, 'must be a RegExp');
    return undefined;
  }
  let compiled: CompiledPattern | false = false;
  if (env.engine === nativeRegexEngine) {
    const reason = analyzeRegex(regex);
    if (reason === undefined) compiled = nativeRegexEngine.compile(regex.source, regex.flags);
    else
      env.findings.add(
        CODE.UNSAFE_PATTERN,
        subject,
        `${path}.regex`,
        `rule '${String(rule.name)}' is unsafe: ${reason}`,
      );
  } else {
    try {
      compiled = env.engine.compile(regex.source, regex.flags.replace(/[gy]/g, '') + 'g');
    } catch {
      env.findings.add(
        CODE.UNSAFE_PATTERN,
        subject,
        `${path}.regex`,
        `rule '${String(rule.name)}' is refused by regex engine '${env.engine.name}'`,
      );
    }
  }
  env.patternCache.set(rule, compiled);
  return compiled === false ? undefined : compiled;
}

// ---------- Validation of one privacy object (7.1) ----------

function checkShow(
  options: { show?: unknown; showFirst?: unknown; showLast?: unknown; text?: unknown },
  subject: string,
  path: string,
  env: CompileEnv,
): void {
  const { show } = options;
  if (show !== undefined && !isShow(show)) {
    env.findings.add(CODE.INVALID_OPTION, subject, `${path}.show`, 'is not a Show value');
  }
  if (show === Show.Fingerprint && !env.hasFingerprintSecret) {
    env.findings.add(
      CODE.FINGERPRINT_WITHOUT_SECRET,
      subject,
      `${path}.show`,
      'Show.Fingerprint needs privacy.fingerprintSecret',
    );
  }
  if (show === Show.Text && typeof options.text !== 'string') {
    env.findings.add(CODE.INVALID_OPTION, subject, `${path}.text`, 'is required with Show.Text');
  }
  for (const key of ['showFirst', 'showLast'] as const) {
    const value = options[key];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) {
      env.findings.add(
        CODE.INVALID_OPTION,
        subject,
        `${path}.${key}`,
        'must be a non-negative integer',
      );
    }
  }
}

function checkName(name: unknown, subject: string, path: string, env: CompileEnv): void {
  if (typeof name !== 'string' || !RULE_NAME_PATTERN.test(name)) {
    env.findings.add(
      CODE.RULE_NAME,
      subject,
      path,
      `rule name '${String(name)}' must match ${RULE_NAME_PATTERN.source}`,
    );
  }
}

function checkFields(privacy: Privacy, subject: string, base: string, env: CompileEnv): void {
  for (const [index, field] of (privacy.fields ?? []).entries()) {
    const path = `${base}.fields[${index}]`;
    if (typeof field === 'string') {
      if (privacy.defaultShow === Show.Fingerprint)
        checkShow({ show: Show.Fingerprint }, subject, path, env);
      continue;
    }
    if (field.name !== undefined) checkName(field.name, subject, `${path}.name`, env);
    checkShow(field, subject, path, env);
  }
}

function checkPatterns(privacy: Privacy, subject: string, base: string, env: CompileEnv): void {
  for (const [index, rule] of (privacy.patterns ?? []).entries()) {
    const path = `${base}.patterns[${index}]`;
    checkName(rule.name, subject, `${path}.name`, env);
    checkShow(rule, subject, path, env);
    if (rule.group !== undefined && !(Number.isInteger(rule.group) && rule.group >= 0)) {
      env.findings.add(
        CODE.INVALID_OPTION,
        subject,
        `${path}.group`,
        'must be a non-negative integer',
      );
    }
    if (rule.confirm !== undefined && typeof rule.confirm !== 'function') {
      env.findings.add(CODE.INVALID_OPTION, subject, `${path}.confirm`, 'must be a function');
    }
  }
}

function checkPacksAndExempt(
  privacy: Privacy,
  subject: string,
  base: string,
  env: CompileEnv,
): void {
  for (const [index, name] of (privacy.packs ?? []).entries()) {
    if (resolvePack(name) === undefined) {
      env.findings.add(
        CODE.UNKNOWN_PACK,
        subject,
        `${base}.packs[${index}]`,
        `unknown pack '${String(name)}'`,
      );
    }
  }
  for (const [index, exemption] of (privacy.exempt ?? []).entries()) {
    const path = `${base}.exempt[${index}]`;
    if (!isReason(exemption.reason)) {
      env.findings.add(
        CODE.EXEMPT_REASON_MISSING,
        subject,
        `${path}.reason`,
        `needs a reason of 1..${REASON_MAX} chars`,
      );
    }
    checkShow({ show: exemption.show }, subject, path, env);
  }
  for (const [index, header] of (privacy.headers ?? []).entries()) {
    if (typeof header !== 'string' || header === '') {
      env.findings.add(
        CODE.INVALID_OPTION,
        subject,
        `${base}.headers[${index}]`,
        'must be a header name',
      );
    }
  }
}

function checkRemember(privacy: Privacy, subject: string, base: string, env: CompileEnv): void {
  const { remember } = privacy;
  if (remember === undefined) return;
  if (!Object.values(Remember).includes(remember)) {
    env.findings.add(CODE.INVALID_OPTION, subject, `${base}.remember`, 'is not a Remember value');
  }
  if (remember === Remember.Everything && !isReason(privacy.rememberReason)) {
    env.findings.add(
      CODE.REMEMBER_REASON_MISSING,
      subject,
      `${base}.rememberReason`,
      `Remember.Everything needs a reason of 1..${REASON_MAX} chars`,
    );
  }
  if (remember === Remember.Sealed && !env.hasSealKeys) {
    env.findings.add(
      CODE.SEALED_WITHOUT_KEYS,
      subject,
      `${base}.remember`,
      'Remember.Sealed needs privacy.sealKeys',
    );
  }
}

/** Every finding one privacy object can raise on its own. */
export function checkPrivacy(
  privacy: Privacy,
  subject: string,
  base: string,
  env: CompileEnv,
): void {
  if (privacy.defaultShow !== undefined)
    checkShow({ show: privacy.defaultShow }, subject, `${base}.defaultShow`, env);
  if (privacy.keyCase !== undefined && !Object.values(KeyCase).includes(privacy.keyCase)) {
    env.findings.add(CODE.INVALID_OPTION, subject, `${base}.keyCase`, 'is not a KeyCase value');
  }
  checkFields(privacy, subject, base, env);
  checkPatterns(privacy, subject, base, env);
  checkPacksAndExempt(privacy, subject, base, env);
  checkRemember(privacy, subject, base, env);
}

// ---------- Scope resolution (6.6, 18.2) ----------

const DELIVERY_KINDS: ReadonlySet<PrivacyLevelKind> = new Set(['step', 'target']);
/** Step kinds whose output or hop copy a `Reach.Delivery` reference hides (18.3). */
const DELIVERY_STEPS: ReadonlySet<string> = new Set([
  'transform',
  'handle',
  'publish',
  'to',
  'fanout',
  'jump',
]);
const NO_REMEMBER_KINDS: ReadonlySet<PrivacyLevelKind> = new Set(['flow', 'step', 'target']);

function checkLevel(level: PrivacyLevel, expanded: ExpandedRef, env: CompileEnv): void {
  const { subject } = level;
  if (expanded.reach !== undefined && !Object.values(Reach).includes(expanded.reach)) {
    env.findings.add(CODE.INVALID_OPTION, subject, 'privacy.reach', 'is not a Reach value');
  }
  if (expanded.reach === Reach.Delivery) {
    const allowed = DELIVERY_KINDS.has(level.kind) && DELIVERY_STEPS.has(level.stepKind ?? '');
    if (!allowed) {
      env.findings.add(
        CODE.DELIVERY_REACH_LEVEL,
        subject,
        'privacy.reach',
        'Reach.Delivery is accepted only on a flow step or target',
      );
    } else if (!isReason(expanded.reachReason)) {
      env.findings.add(
        CODE.DELIVERY_REACH_LEVEL,
        subject,
        'privacy.reachReason',
        `Reach.Delivery needs a reason of 1..${REASON_MAX} chars`,
      );
    }
  }
  if (
    NO_REMEMBER_KINDS.has(level.kind) &&
    expanded.parts.some((part) => part.remember !== undefined)
  ) {
    env.findings.add(
      CODE.REMEMBER_LEVEL,
      subject,
      'privacy.remember',
      'remember is accepted only on durable scopes',
    );
  }
  for (const part of expanded.parts) checkPrivacy(part, subject, 'privacy', env);
}

export interface ResolvedScope {
  readonly plan: FrozenPlan;
  /** Delivery-reach and defaulted-remember notes for the boot lines. */
  readonly notes: readonly string[];
}

/** Module-level material shared by every scope. */
export interface ModuleLevel {
  readonly options: PrivacyModuleOptions | undefined;
  /** `forRoot({ privacy: false })`. */
  readonly off: boolean;
}

function moduleParts(module: ModuleLevel): Privacy[] {
  return module.options === undefined ? [] : [module.options];
}

/** The remember a durable scope resolves: most specific level first, then SD-29. */
function resolveRemember(
  layers: readonly (readonly Privacy[])[],
  explicit: boolean,
): [Remember, boolean] {
  for (let i = layers.length - 1; i >= 0; i--) {
    const parts = layers[i]!;
    for (let j = parts.length - 1; j >= 0; j--) {
      const remember = parts[j]!.remember;
      if (remember !== undefined) return [remember, false];
    }
  }
  return explicit ? [Remember.OutcomeOnly, true] : [Remember.Everything, false];
}

/** Resolves one scope: findings go to env; the plan is usable only when env has no finding. */
export function resolveScope(
  name: string,
  scope: PrivacyScope,
  module: ModuleLevel,
  env: CompileEnv,
): ResolvedScope {
  const builder = new PlanBuilder(env);
  const layers: (readonly Privacy[])[] = [moduleParts(module)];
  const notes: string[] = [];
  // A send target's scope holds its step's reference and its own: both reach its hop copy.
  const deliveries: ExpandedRef[] = [];
  for (const level of scope.levels) {
    const expanded = expandLevel(level, module, env);
    if (expanded === undefined) {
      layers.push([]);
      continue;
    }
    builder.names.push(...expanded.names);
    if (expanded.reach === Reach.Delivery) deliveries.push(expanded);
    layers.push(expanded.parts);
  }
  const subjects = ['module', ...scope.levels.map((level) => level.subject)];
  const plan = buildPlan(builder, layers, subjects, module, scope, env, deliveries);
  if (plan.rememberDefaulted)
    notes.push(`privacy scope '${name}': remember defaulted to ${Remember.OutcomeOnly}`);
  if (scope.replays === true && plan.remember === Remember.OutcomeOnly) {
    env.findings.add(
      CODE.OUTCOME_ONLY_REPLAY,
      name,
      'privacy.remember',
      "Remember.OutcomeOnly cannot replay a request/reply endpoint (onDuplicate: 'replay')",
    );
  }
  if (deliveries.length > 0 && scope.summary !== 'none')
    notes.push(`privacy delivery-reach ${name}: ${plan.deliveryReason ?? ''}`);
  return { plan, notes };
}

function expandLevel(
  level: PrivacyLevel,
  module: ModuleLevel,
  env: CompileEnv,
): ExpandedRef | undefined {
  if (level.ref === undefined) return undefined;
  if (level.ref === false) {
    env.findings.add(
      CODE.PRIVACY_FALSE_BELOW_MODULE,
      level.subject,
      'privacy',
      'false is accepted only at forRoot',
    );
    return undefined;
  }
  if (module.off) {
    env.findings.add(
      CODE.PRIVACY_OFF_WITH_REFS,
      level.subject,
      'privacy',
      'is set while forRoot({ privacy: false }) turns privacy off',
    );
    return undefined;
  }
  const expanded = expandRef(level.ref, level.subject, env);
  checkLevel(level, expanded, env);
  return expanded;
}

function buildPlan(
  builder: PlanBuilder,
  layers: readonly (readonly Privacy[])[],
  subjects: readonly string[],
  module: ModuleLevel,
  scope: PrivacyScope,
  env: CompileEnv,
  deliveries: readonly ExpandedRef[],
): FrozenPlan {
  if (!module.off) builder.addBaseline();
  for (const [index, parts] of layers.entries()) {
    for (const part of parts)
      builder.addPrivacy(part, index, subjects[index] ?? 'module', 'privacy');
  }
  builder.finish();
  const explicit = layers.some((parts) =>
    parts.some((part) => hasRules(part) || part.remember !== undefined),
  );
  // Flow and step scopes have no remember: an inherited one is ignored (SD-58).
  const [remember, defaulted] =
    scope.durable === true ? resolveRemember(layers, explicit) : [undefined, false];
  return {
    trie: builder.trie,
    patterns: builder.patterns,
    explicit,
    remember,
    rememberDefaulted: defaulted,
    names: [...new Set(builder.names)],
    fieldCount: builder.fieldCount,
    delivery: deliveries.length === 0 ? undefined : deliveryPlan(deliveries, env),
    deliveryReason:
      deliveries.length === 0
        ? undefined
        : deliveries.map((expanded) => expanded.reachReason ?? '').join('; '),
  };
}

/**
 * D19: a delivery copy uses only the delivery-reach references of the step and its target, never
 * the baseline or L1..L3.
 */
function deliveryPlan(deliveries: readonly ExpandedRef[], env: CompileEnv): FrozenPlan {
  const builder = new PlanBuilder(env);
  for (const expanded of deliveries) {
    for (const part of expanded.parts) builder.addPrivacy(part, 0, 'delivery', 'privacy');
  }
  builder.finish();
  return {
    trie: builder.trie,
    patterns: builder.patterns,
    explicit: true,
    remember: undefined,
    rememberDefaulted: false,
    names: [...new Set(deliveries.flatMap((expanded) => expanded.names))],
    fieldCount: builder.fieldCount,
    delivery: undefined,
    deliveryReason: undefined,
  };
}

/** The module subject: baseline plus module rules. */
export function resolveModule(module: ModuleLevel, env: CompileEnv): FrozenPlan {
  const builder = new PlanBuilder(env);
  return buildPlan(
    builder,
    [moduleParts(module)],
    ['module'],
    module,
    { levels: [], durable: true },
    env,
    [],
  );
}

/** Every declared profile is compiled and validated, referenced or not (SD-48). */
export function checkProfiles(env: CompileEnv): void {
  validateProfiles(env);
  for (const [name, profile] of Object.entries(env.profiles)) {
    if (!RULE_NAME_PATTERN.test(name)) continue;
    const subject = `profile '${name}'`;
    checkPrivacy(profile, subject, `privacy.profiles.${name}`, env);
    const builder = new PlanBuilder(env);
    builder.addPrivacy(profile, 0, subject, `privacy.profiles.${name}`);
  }
}
