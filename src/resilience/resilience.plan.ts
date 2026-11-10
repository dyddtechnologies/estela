import {
  backoffDelay,
  MAX_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  type BackoffSettings,
  type JitterMode,
} from './backoff';
import { CareConfigError } from './resilience.errors';
import type {
  Care,
  CareClassifierFn,
  CareContext,
  CareEdge,
  CareKeyFn,
  CareProfile,
  CareRefOf,
  CareStatePort,
  FailureClass,
  Lanes,
  Pace,
  Patience,
  PlanB,
  PlanBTrigger,
  SpreadMode,
  Tries,
  Valve,
} from './resilience.types';

type MaybePromise<T> = T | Promise<T>;

/**
 * Marks options built from a 0.9.0 spelling (outbound REST `retry` / `timeoutMs`, section 1). The
 * part then keeps the 0.9.0 semantics and validation instead of the rules of section 5.6.
 */
export const LEGACY_ALIAS = Symbol('estela.care.legacy');

export interface LegacyTriesMark {
  /** 0.9.0 boolean classifier (possibly async), called only when tries are left. */
  tryAgainOn: (error: unknown, ctx: CareContext) => MaybePromise<boolean>;
  /** 0.9.0 gap, clamped to >= 0. */
  gap: (tryNumber: number, error: unknown) => number;
}

export type LegacyTries = Tries & { [LEGACY_ALIAS]?: LegacyTriesMark };
export type LegacyPatience = Patience & { [LEGACY_ALIAS]?: true };

export interface TriesPlan {
  max: number;
  /** Gap before the next try; `random` is injected by the executor. */
  delay(tryNumber: number, error: unknown, random: (maxExclusive: number) => number): number;
  on: ReadonlySet<FailureClass>;
  heedServerWait: boolean;
  maxServerWaitMs: number;
  idempotent: boolean;
  triesLeft: 'keep' | 'forward';
  requireIdempotencyKey: boolean;
  /** Present when the effective tries come from the 0.9.0 spelling: no tries left, boolean classifier. */
  legacy?: LegacyTriesMark;
}

export interface ValvePlan {
  key?: CareKeyFn;
  failPercent: number;
  minCalls: number;
  lookBack: { lastCalls: number } | { lastMs: number };
  shutMs: number;
  probes: number;
  countOn: ReadonlySet<FailureClass>;
  quotaShutMs: number | 'until-resumed';
  maxKeys: number;
  state?: CareStatePort;
  syncMs: number;
}

export interface LanesPlan {
  count: number;
  waitlist: number;
  waitlistMs?: number;
}

export interface PacePlan {
  perSecond: number;
  burst: number;
  key?: CareKeyFn;
  waitMs: number;
  state?: CareStatePort;
  soloPerSecond: number;
  soloBurst: number;
  maxKeys: number;
  replicas: number;
}

export interface PlanBPlan {
  value?: (error: unknown, ctx: CareContext) => unknown;
  channel?: string;
  on: ReadonlySet<PlanBTrigger>;
  cacheable: boolean;
}

/** Resolved, frozen care for one binding: every part validated and defaulted. */
export interface CarePlan {
  readonly binding: string;
  readonly edge: CareEdge;
  readonly classify: readonly CareClassifierFn[];
  /** Longest wait for one try; 0 = no limit. */
  readonly eachTryMs: number;
  /** True when a level set `eachTryMs` (shown in the graph summary). */
  readonly patienceExplicit: boolean;
  readonly totalMs?: number;
  readonly tries?: TriesPlan;
  readonly valve?: ValvePlan;
  readonly lanes?: LanesPlan;
  readonly pace?: PacePlan;
  readonly planB?: PlanBPlan;
  /** No part at all: the executor runs the call once, directly (RS-01). */
  readonly empty: boolean;
  /** Boot warnings that are not errors (section 5.6). */
  readonly warnings: readonly string[];
}

export type CarePartName = 'patience' | 'tries' | 'valve' | 'lanes' | 'pace' | 'planB';

export const CARE_PARTS: readonly CarePartName[] = [
  'patience',
  'tries',
  'valve',
  'lanes',
  'pace',
  'planB',
];

export interface ResolvePlanOptions {
  /** Parts allowed on this edge (section 5.5); default all. */
  allowed?: readonly CarePartName[];
  /** Named profiles (RS-51). */
  profiles?: Readonly<Record<string, Care>>;
  /** `eachTryMs` when no level sets one (REST: 30000, jump: 10000). Not shown. */
  defaultEachTryMs?: number;
}

export const FAILURE_CLASSES: readonly FailureClass[] = [
  'transient',
  'busy',
  'rejected',
  'quota',
  'unknown',
];
const TRIGGERS: readonly PlanBTrigger[] = [
  ...FAILURE_CLASSES,
  'valve-shut',
  'lanes-full',
  'over-pace',
  'out-of-time',
];
const DEFAULT_PLAN_B_ON: readonly PlanBTrigger[] = [
  'transient',
  'busy',
  'valve-shut',
  'lanes-full',
  'over-pace',
  'out-of-time',
];
const SPREADS: Readonly<Record<SpreadMode, JitterMode>> = {
  full: 'full',
  half: 'equal',
  none: 'none',
};
const STATE_METHODS = ['takeTurn', 'markShut', 'shutUntil', 'claimProbe', 'clearShut'];
const DEFAULT_SPACING = { firstMs: 200, growth: 2, capMs: 10_000, spread: 'full' as SpreadMode };

// ---------- Layering ----------

type Layerable = Record<string, unknown> & { enabled?: boolean };

interface Layered {
  options: Layerable;
  enabled: boolean;
  /** True when any level configured the part. */
  explicit: boolean;
  /** Options object of the highest level that set the part (legacy marks live there). */
  top?: Layerable;
}

function defined(options: object): Layerable {
  const entries = Object.entries(options).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries);
}

/**
 * RS-04 (amended): across levels (highest first) the highest level that sets a part owns it
 * whole; there is no field merge across levels. `false` turns the part off.
 */
function layerPart(values: readonly unknown[]): Layered {
  for (const value of values) {
    if (value === undefined) continue;
    if (value === false) return { options: { enabled: false }, enabled: false, explicit: true };
    const layer = value as Layerable;
    return { options: defined(layer), enabled: layer.enabled ?? true, explicit: true, top: layer };
  }
  return { options: {}, enabled: true, explicit: false };
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_EXTENDS_HOPS = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Deep merge used once inside a reference (`use`, `extends`): arrays, functions and `false` replace. */
export function deepMergeCare<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined) out[key] = deepMergeCare(base[key], value);
  }
  return out as T;
}

function configError(binding: string, path: string, rule: string, code: string): CareConfigError {
  return new CareConfigError(binding, path, rule, code);
}

/** RS-53: a named profile with its `extends` chain applied (parent first, child over it). */
export function resolveProfile(
  binding: string,
  name: unknown,
  profiles: Readonly<Record<string, CareProfile>> | undefined,
): Care {
  const chain: string[] = [];
  let current: unknown = name;
  while (current !== undefined) {
    if (typeof current !== 'string' || !PROFILE_NAME.test(current)) {
      throw configError(binding, 'use', 'must be a profile name', 'UNKNOWN_PROFILE');
    }
    if (chain.includes(current)) {
      throw configError(
        binding,
        'use',
        `profiles ${describeChain([...chain, current])} form a cycle`,
        'PROFILE_CYCLE',
      );
    }
    const profile =
      profiles !== undefined && Object.hasOwn(profiles, current) ? profiles[current] : undefined;
    if (profile === undefined) {
      throw configError(binding, 'use', `unknown profile '${current}'`, 'UNKNOWN_PROFILE');
    }
    if (Object.hasOwn(profile, 'use')) {
      throw configError(
        binding,
        'use',
        `profile '${current}' must not itself use another`,
        'UNKNOWN_PROFILE',
      );
    }
    chain.push(current);
    if (chain.length - 1 > MAX_EXTENDS_HOPS) {
      throw configError(
        binding,
        'use',
        `profile '${String(name)}' extends more than ${MAX_EXTENDS_HOPS} hops`,
        'PROFILE_DEPTH',
      );
    }
    current = profile.extends;
  }
  let merged: Record<string, unknown> = {};
  for (const name of [...chain].reverse()) {
    const own: Record<string, unknown> = { ...profiles?.[name] };
    delete own.extends;
    merged = deepMergeCare(merged, own);
  }
  return merged;
}

function describeChain(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(' -> ');
}

/** RS-51, RS-52: expands one reference; `false` means nothing at this level and below. */
// eslint-disable-next-line sonarjs/function-return-type -- a reference expands to care, false (cut) or nothing
export function expandCareRef<C extends object = Care>(
  binding: string,
  ref: CareRefOf<C> | undefined,
  profiles: Readonly<Record<string, CareProfile>> | undefined,
): Care | false | undefined {
  if (ref === undefined || ref === false) return ref;
  if (typeof ref === 'string') return resolveProfile(binding, ref, profiles);
  const raw: unknown = ref;
  if (typeof raw !== 'object' || raw === null) {
    throw new CareConfigError(binding, 'use', 'must be a profile name or a care object');
  }
  if (!Object.hasOwn(ref, 'use')) return ref;
  const { use, ...inline } = ref as C & { use?: string };
  return deepMergeCare(resolveProfile(binding, use, profiles), inline);
}

/** Expanded layers, cut at the first `false` (highest first). */
export function expandLayers(
  binding: string,
  layers: readonly (CareRefOf | undefined)[],
  profiles: Readonly<Record<string, CareProfile>> | undefined,
): Care[] {
  const out: Care[] = [];
  for (const layer of layers) {
    const expanded = expandCareRef(binding, layer, profiles);
    if (expanded === false) break;
    if (expanded !== undefined) out.push(expanded);
  }
  return out;
}

/** RS-53: validates every profile name and `extends` chain. */
export function validateProfiles(
  profiles: Readonly<Record<string, CareProfile>> | undefined,
): void {
  for (const name of Object.keys(profiles ?? {})) {
    if (!PROFILE_NAME.test(name)) {
      throw configError(
        'care',
        `profiles.${name}`,
        'is not a valid profile name',
        'UNKNOWN_PROFILE',
      );
    }
    resolveProfile(`profile '${name}'`, name, profiles);
  }
}

// ---------- Validation helpers ----------

class Checker {
  constructor(readonly binding: string) {}

  fail(path: string, rule: string): never {
    throw new CareConfigError(this.binding, path, rule);
  }

  int(path: string, value: unknown, min: number, max = MAX_BACKOFF_MS): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      const range = max === MAX_BACKOFF_MS ? `>= ${min}` : `${min}..${max}`;
      this.fail(path, `must be an integer ${range}`);
    }
    return value;
  }

  positive(path: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      this.fail(path, 'must be a finite number > 0');
    }
    return value;
  }

  classes<T extends string>(path: string, value: unknown, known: readonly T[]): ReadonlySet<T> {
    if (!Array.isArray(value) || value.length === 0) this.fail(path, 'must be a non-empty list');
    const list = value as unknown[];
    for (const item of list) {
      if (!known.includes(item as T)) this.fail(path, `has an unknown value '${String(item)}'`);
    }
    if (new Set(list).size !== list.length) this.fail(path, 'has duplicates');
    return new Set(list as T[]);
  }

  fn<F>(path: string, value: unknown): F | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'function') this.fail(path, 'must be a function');
    return value as F;
  }

  state(path: string, value: unknown): CareStatePort | undefined {
    if (value === undefined || value === 'local') return undefined;
    const port = value as Record<string, unknown> | null;
    if (typeof port !== 'object' || port === null)
      this.fail(path, "must be 'local' or a state port");
    for (const method of STATE_METHODS) {
      if (typeof port[method] !== 'function') this.fail(path, `state port has no ${method}()`);
    }
    return value as CareStatePort;
  }
}

// ---------- Part resolution ----------

function resolvePatience(
  c: Checker,
  layered: Layered,
  defaultEachTryMs: number,
): Pick<CarePlan, 'eachTryMs' | 'totalMs' | 'patienceExplicit'> {
  if (!layered.explicit || !layered.enabled) {
    return { eachTryMs: defaultEachTryMs, patienceExplicit: false };
  }
  const { eachTryMs, totalMs } = layered.options as Patience;
  const legacy = (layered.top as LegacyPatience | undefined)?.[LEGACY_ALIAS] === true;
  const out: { eachTryMs: number; totalMs?: number; patienceExplicit: boolean } = {
    eachTryMs: defaultEachTryMs,
    patienceExplicit: eachTryMs !== undefined,
  };
  // The 0.9.0 spelling keeps the 0.9.0 rule (any finite number >= 0), validated by its edge.
  if (eachTryMs !== undefined) {
    out.eachTryMs = legacy ? eachTryMs : c.int('patience.eachTryMs', eachTryMs, 0, MAX_BACKOFF_MS);
  }
  if (totalMs !== undefined) {
    out.totalMs = c.int('patience.totalMs', totalMs, 1, MAX_BACKOFF_MS);
  }
  return out;
}

interface DelaySource {
  delay: TriesPlan['delay'];
  capMs: number;
}

function resolveSpacing(c: Checker, option: Tries['spacing']): DelaySource {
  if (typeof option === 'function') {
    const fn = option;
    return {
      delay: (tryNumber, error) => Math.min(MAX_BACKOFF_MS, Math.max(0, fn(tryNumber, error))),
      capMs: DEFAULT_SPACING.capMs,
    };
  }
  if (typeof option === 'number') {
    const ms = c.int('tries.spacing', option, 0, MAX_BACKOFF_MS);
    return { delay: () => ms, capMs: ms };
  }
  const raw: unknown = option;
  if (raw !== undefined && (typeof raw !== 'object' || raw === null)) {
    c.fail('tries.spacing', 'must be a number, an object or a function');
  }
  const settings = { ...DEFAULT_SPACING, ...defined(option ?? {}) };
  const firstMs = c.int('tries.spacing.firstMs', settings.firstMs, 0, MAX_BACKOFF_MS);
  if (
    typeof settings.growth !== 'number' ||
    !Number.isFinite(settings.growth) ||
    settings.growth < 1
  ) {
    c.fail('tries.spacing.growth', 'must be a number >= 1');
  }
  const capMs = c.int('tries.spacing.capMs', settings.capMs, firstMs, MAX_BACKOFF_MS);
  if (!Object.hasOwn(SPREADS, settings.spread))
    c.fail('tries.spacing.spread', 'must be full, half or none');
  const resolved: BackoffSettings = {
    initialMs: firstMs,
    factor: settings.growth,
    maxMs: capMs,
    jitter: SPREADS[settings.spread],
  };
  return {
    delay: (tryNumber, _error, random) => backoffDelay(resolved, tryNumber, random),
    capMs,
  };
}

function resolveTries(c: Checker, layered: Layered): TriesPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as LegacyTries;
  const legacy = (layered.top as LegacyTries | undefined)?.[LEGACY_ALIAS];
  if (legacy !== undefined) return legacyTriesPlan(options, legacy);
  const max = c.int('tries.max', options.max ?? 3, 1, MAX_RETRY_ATTEMPTS);
  const spacing = resolveSpacing(c, options.spacing);
  const on = c.classes('tries.on', options.on ?? ['transient', 'busy'], FAILURE_CLASSES);
  if (on.has('quota')) c.fail('tries.on', "must not list 'quota' (quota is never tried again)");
  return {
    max,
    delay: spacing.delay,
    on,
    heedServerWait: options.heedServerWait ?? true,
    maxServerWaitMs: serverWaitCap(c, options, spacing.capMs),
    idempotent: options.idempotent === true,
    triesLeft: triesLeftMode(c, options),
    requireIdempotencyKey: options.requireIdempotencyKey === true,
  };
}

function serverWaitCap(c: Checker, options: Tries, capMs: number): number {
  if (options.maxServerWaitMs === undefined) return capMs;
  return c.int('tries.maxServerWaitMs', options.maxServerWaitMs, 0, MAX_BACKOFF_MS);
}

function triesLeftMode(c: Checker, options: Tries): 'keep' | 'forward' {
  const mode: unknown = options.triesLeft ?? 'keep';
  if (mode !== 'keep' && mode !== 'forward') c.fail('tries.triesLeft', 'must be keep or forward');
  return mode;
}

/** The 0.9.0 spelling: no spread, no server wait, no tries left, boolean classifier (section 1). */
function legacyTriesPlan(options: Tries, legacy: LegacyTriesMark): TriesPlan {
  return {
    max: options.max ?? 3,
    delay: (tryNumber, error) => legacy.gap(tryNumber, error),
    on: new Set(),
    heedServerWait: false,
    maxServerWaitMs: 0,
    idempotent: false,
    triesLeft: 'forward',
    requireIdempotencyKey: false,
    legacy,
  };
}

/** Optional key function and shared state of the valve and the pace. */
function keyAndState(
  c: Checker,
  prefix: 'valve' | 'pace',
  options: { key?: unknown; state?: unknown },
): { key?: CareKeyFn; state?: CareStatePort } {
  const out: { key?: CareKeyFn; state?: CareStatePort } = {};
  const key = c.fn<CareKeyFn>(`${prefix}.key`, options.key);
  if (key !== undefined) out.key = key;
  const state = c.state(`${prefix}.state`, options.state);
  if (state !== undefined) out.state = state;
  return out;
}

function resolveLookBack(c: Checker, options: Valve, minCalls: number): ValvePlan['lookBack'] {
  const lookBack: unknown = options.lookBack ?? { lastCalls: 20 };
  if (typeof lookBack !== 'object' || lookBack === null) {
    c.fail('valve.lookBack', 'must be { lastCalls } or { lastMs }');
  }
  const hasCalls = Object.hasOwn(lookBack, 'lastCalls');
  const hasMs = Object.hasOwn(lookBack, 'lastMs');
  if (hasCalls === hasMs) c.fail('valve.lookBack', 'must set exactly one of lastCalls or lastMs');
  if (hasCalls) {
    const { lastCalls } = lookBack as { lastCalls: unknown };
    return { lastCalls: c.int('valve.lookBack.lastCalls', lastCalls, minCalls) };
  }
  const { lastMs } = lookBack as { lastMs: unknown };
  return { lastMs: c.int('valve.lookBack.lastMs', lastMs, 1) };
}

function resolveValve(c: Checker, layered: Layered): ValvePlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as Valve;
  const minCalls = c.int('valve.minCalls', options.minCalls ?? 10, 1);
  const shutMs = c.int('valve.shutMs', options.shutMs ?? 30_000, 1);
  const plan: ValvePlan = {
    failPercent: c.int('valve.failPercent', options.failPercent ?? 50, 1, 100),
    minCalls,
    lookBack: resolveLookBack(c, options, minCalls),
    shutMs,
    probes: c.int('valve.probes', options.probes ?? 1, 1),
    countOn: c.classes('valve.countOn', options.countOn ?? ['transient'], FAILURE_CLASSES),
    quotaShutMs: quotaShut(c, options.quotaShutMs, shutMs),
    maxKeys: c.int('valve.maxKeys', options.maxKeys ?? 1000, 1),
    syncMs: c.int('valve.syncMs', options.syncMs ?? 1000, 1),
    ...keyAndState(c, 'valve', options),
  };
  return plan;
}

function quotaShut(
  c: Checker,
  quota: number | 'until-resumed' | undefined,
  shutMs: number,
): number | 'until-resumed' {
  return quota === 'until-resumed'
    ? 'until-resumed'
    : c.int('valve.quotaShutMs', quota ?? shutMs, 1);
}

function resolveLanes(c: Checker, layered: Layered): LanesPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as Partial<Lanes>;
  const plan: LanesPlan = {
    count: c.int('lanes.count', options.count, 1),
    waitlist: c.int('lanes.waitlist', options.waitlist ?? 0, 0),
  };
  if (options.waitlistMs !== undefined) {
    plan.waitlistMs = c.int('lanes.waitlistMs', options.waitlistMs, 1);
  }
  return plan;
}

function resolvePace(c: Checker, layered: Layered): PacePlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as Partial<Pace>;
  const perSecond = c.positive('pace.perSecond', options.perSecond);
  const burst = c.int('pace.burst', options.burst ?? Math.ceil(perSecond), 1);
  const replicas = c.int('pace.replicas', options.replicas ?? 1, 1);
  const plan: PacePlan = {
    perSecond,
    burst,
    waitMs: c.int('pace.waitMs', options.waitMs ?? 0, 0),
    soloPerSecond: c.positive('pace.soloPerSecond', options.soloPerSecond ?? perSecond / replicas),
    soloBurst: Math.max(1, Math.floor(burst / replicas)),
    maxKeys: c.int('pace.maxKeys', options.maxKeys ?? 1000, 1),
    replicas,
  };
  return { ...plan, ...keyAndState(c, 'pace', options) };
}

function resolvePlanB(c: Checker, layered: Layered): PlanBPlan | undefined {
  if (!layered.explicit || !layered.enabled) return undefined;
  const options = layered.options as PlanB;
  const hasValue = options.value !== undefined;
  const hasChannel = options.channel !== undefined;
  if (hasValue === hasChannel) c.fail('planB', 'must set exactly one of value or channel');
  const plan: PlanBPlan = {
    on: c.classes('planB.on', options.on ?? DEFAULT_PLAN_B_ON, TRIGGERS),
    cacheable: options.cacheable === true,
  };
  const value = c.fn<PlanBPlan['value']>('planB.value', options.value);
  if (value !== undefined) plan.value = value;
  if (hasChannel) {
    if (typeof options.channel !== 'string' || options.channel.length === 0) {
      c.fail('planB.channel', 'must be a non-empty channel name');
    }
    plan.channel = options.channel;
  }
  return plan;
}

function resolveClassify(c: Checker, layers: readonly Care[]): readonly CareClassifierFn[] {
  const option = layers.find((layer) => layer.classify !== undefined)?.classify;
  if (option === undefined) return [];
  const list = (Array.isArray(option) ? option : [option]) as unknown[];
  list.forEach((fn, index) => c.fn(`classify[${index}]`, fn));
  return list as CareClassifierFn[];
}

function assertAllowed(
  c: Checker,
  layers: readonly Care[],
  allowed: readonly CarePartName[],
): void {
  for (const layer of layers) {
    for (const name of CARE_PARTS) {
      const value = layer[name];
      if (value !== undefined && value !== false && !allowed.includes(name)) {
        c.fail(name, 'is not allowed on this edge');
      }
    }
  }
}

function warningsOf(plan: Omit<CarePlan, 'warnings' | 'empty'>): string[] {
  const warnings: string[] = [];
  if (plan.totalMs !== undefined && plan.eachTryMs > plan.totalMs) {
    warnings.push(
      `${plan.binding}: care.patience.totalMs is shorter than eachTryMs; each try is capped by totalMs`,
    );
  }
  return warnings;
}

/**
 * Merges `layers` (highest first: call, binding, module default), validates every part
 * (section 5.6) and applies the defaults. Throws `CareConfigError` naming the binding and the
 * option path (RS-03).
 */
export function resolveCarePlan(
  binding: string,
  layers: readonly (CareRefOf | undefined)[],
  edge: CareEdge,
  options: ResolvePlanOptions = {},
): CarePlan {
  const checker = new Checker(binding);
  const expanded = expandLayers(binding, layers, options.profiles);
  assertAllowed(checker, expanded, options.allowed ?? CARE_PARTS);
  const of = (name: CarePartName): Layered => layerPart(expanded.map((layer) => layer[name]));
  const base = {
    binding,
    edge,
    classify: resolveClassify(checker, expanded),
    ...resolvePatience(checker, of('patience'), options.defaultEachTryMs ?? 0),
  };
  const plan: Omit<CarePlan, 'warnings' | 'empty'> = { ...base };
  const assign = <K extends keyof CarePlan>(key: K, value: CarePlan[K] | undefined): void => {
    if (value !== undefined) (plan as Record<string, unknown>)[key] = value;
  };
  assign('tries', resolveTries(checker, of('tries')));
  assign('valve', resolveValve(checker, of('valve')));
  assign('lanes', resolveLanes(checker, of('lanes')));
  assign('pace', resolvePace(checker, of('pace')));
  assign('planB', resolvePlanB(checker, of('planB')));
  return Object.freeze({ ...plan, empty: isEmpty(plan), warnings: warningsOf(plan) });
}

function isEmpty(plan: Omit<CarePlan, 'warnings' | 'empty'>): boolean {
  const parts = [plan.tries, plan.valve, plan.lanes, plan.pace, plan.planB];
  return plan.eachTryMs === 0 && plan.totalMs === undefined && parts.every((p) => p === undefined);
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** Compact summary for the graph and boot logs (RS-42): part names, waits and tries only. */
export function describeCare(plan: CarePlan): string | undefined {
  const parts: string[] = [];
  if (plan.patienceExplicit && plan.eachTryMs > 0)
    parts.push(`patience ${formatMs(plan.eachTryMs)}`);
  if (plan.totalMs !== undefined) parts.push(`total ${formatMs(plan.totalMs)}`);
  if (plan.tries !== undefined && plan.tries.max > 1) parts.push(`tries x${plan.tries.max}`);
  if (plan.valve !== undefined) parts.push('valve');
  if (plan.lanes !== undefined) parts.push('lanes');
  if (plan.pace !== undefined) parts.push('pace');
  if (plan.planB !== undefined) parts.push('plan-b');
  return parts.length === 0 ? undefined : parts.join(' · ');
}
