import {
  DEFAULT_FINGERPRINT_CHARS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_SCAN_BYTES,
  Reach,
  Remember,
  type PrivacyModuleOptions,
} from './privacy.types';
import {
  PRIVACY_FINDING_CODES as CODE,
  DeliveryCopyError,
  PrivacyConfigError,
  type PrivacyFinding,
} from './privacy-errors';
import { fingerprintSecretProblem, type FingerprintSecret } from './fingerprint-secret';
import { HIDE_FAILED, hiddenToken, hmacFingerprinter, OMIT, type Fingerprinter } from './masking';
import {
  checkPrivacy,
  checkProfiles,
  Findings,
  resolveModule,
  resolveScope,
  type CompileEnv,
  type FrozenPlan,
  type ModuleLevel,
  type PrivacyScopes,
} from './policy-resolver';
import { nativeRegexEngine } from './regex-engine';
import { createRecordCodec, type RecordCodec } from './sealed-record';
import type { SealKeyProvider } from './seal-key';
import { errorShape, walk, type WalkLimits } from './walker';

/** What `forRoot({ privacy })` accepts: options, `false` (off) or nothing (the baseline). */
type PrivacyOption = PrivacyModuleOptions | false | undefined;

/** The kind of trail place a value is written to. */
export enum TrailOutput {
  Log = 'log',
  Store = 'store',
  Ledger = 'ledger',
  WireTap = 'wiretap',
  ErrorEnvelope = 'error-envelope',
  Capture = 'capture',
}

export interface TrailContext {
  output: TrailOutput;
  channel?: string;
  scope?: string;
}

/** Engine log sink; the module wires Nest `Logger('EstelaPrivacy')`. Lines never hold values. */
export interface PrivacyLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const ignore = (): void => undefined;
const noopLogger: PrivacyLogger = { log: ignore, warn: ignore, error: ignore };

export interface TrailError {
  name: string;
  message: string;
  stack?: string;
  [k: string]: unknown;
}

export interface PrivacyStats {
  byRule: Record<string, number>;
  byOutput: Record<string, number>;
  bySubject: Record<string, number>;
  hideFailed: number;
  deliveryCopyFailed: number;
}

/** Drops userinfo, the query string and the fragment (SD-04, SD-05). */
export function urlForTrail(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const text = String(url);
    const noQuery = text.split(/[?#]/, 1)[0] ?? '';
    // Userinfo ends at the LAST '@' of the authority: a password may hold a raw '@'.
    return noQuery.replace(/\/\/[^/]*@/, '//');
  }
}

/** Key-bearing own properties of Estela's own errors (SD-43), by error name. */
const KEY_PROPERTIES: Readonly<Record<string, string>> = {
  IdempotencyInProgressError: 'key',
  InboundIdempotencyInFlightError: 'clientKey',
};

const FAILURE_LOG_INTERVAL_MS = 60_000;

const LIMITS = {
  maxScanBytes: [1024, 16_777_216],
  maxDepth: [1, 1000],
  maxNodes: [1, 10_000_000],
  fingerprintChars: [12, 64],
} as const;

function inRange(value: unknown, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** A compile result with every finding; `engine` is undefined when there is an error finding. */
export interface PrivacyCompileResult {
  readonly engine: PrivacyEngine | undefined;
  readonly findings: readonly PrivacyFinding[];
  readonly problems: readonly string[];
}

interface EngineParts {
  readonly disabled: boolean;
  readonly options: PrivacyModuleOptions | undefined;
  readonly moduleLevel: ModuleLevel;
  readonly module: FrozenPlan | undefined;
  /** Grows only at boot, through `addScopes`. */
  readonly scopes: Map<string, FrozenPlan>;
  readonly secret: FingerprintSecret | undefined;
  readonly limits: WalkLimits;
  readonly logger: PrivacyLogger;
  /** Findings of the module compile, held for the boot resolver (`forBoot`, SD-55). */
  readonly pending: Pick<PrivacyCompileResult, 'findings' | 'problems'> | undefined;
}

/** Options of `addScopes`. */
export interface AddScopesOptions {
  /** The writer of these scopes has its own `SealKeyProvider`. */
  sealKeys?: boolean;
  /** Logger of these scopes' boot lines; the engine logger by default. */
  logger?: PrivacyLogger;
}

/**
 * Compiled privacy of one module (4.5). A Nest provider of the module; there is no process-global
 * instance (SD-39). Values are hidden lazily, only when a trail output is about to write (SD-36).
 */
export class PrivacyEngine {
  private fingerprinter: Fingerprinter | undefined;
  private secretId: string | undefined;
  private readonly counters: PrivacyStats = {
    byRule: {},
    byOutput: {},
    bySubject: {},
    hideFailed: 0,
    deliveryCopyFailed: 0,
  };
  private readonly lastFailureLog = new Map<string, number>();

  private constructor(private readonly parts: EngineParts) {
    this.useSecret(parts.secret);
  }

  /** Compiles at module init; throws one PrivacyConfigError with every problem (7.1, SD-37). */
  static async compile(
    options: PrivacyOption,
    scopes: PrivacyScopes = {},
    logger?: PrivacyLogger,
  ): Promise<PrivacyEngine> {
    const result = await PrivacyEngine.inspect(options, scopes, logger);
    if (result.engine === undefined) {
      throw new PrivacyConfigError(result.problems, result.findings);
    }
    return result.engine;
  }

  /** Like `compile`, but returns the findings for the boot resolver instead of throwing (SD-55). */
  static async inspect(
    options: PrivacyOption,
    scopes: PrivacyScopes = {},
    logger: PrivacyLogger = noopLogger,
  ): Promise<PrivacyCompileResult> {
    const findings = new Findings();
    const secret = await readSecret(options === false ? undefined : options, findings);
    return PrivacyEngine.build(options, scopes, logger, secret, findings);
  }

  /**
   * @internal Like `compile`, but a module with findings still yields an engine that holds them
   * (`bootFindings`), so the boot resolver throws them together with the findings of every other
   * subject (SD-55, 7.1). Such an engine logs no boot line and must not write before boot ends.
   */
  static async forBoot(
    options: PrivacyOption,
    scopes: PrivacyScopes = {},
    logger: PrivacyLogger = noopLogger,
  ): Promise<PrivacyEngine> {
    const findings = new Findings();
    const secret = await readSecret(options === false ? undefined : options, findings);
    return PrivacyEngine.build(options, scopes, logger, secret, findings, true).engine!;
  }

  /**
   * @internal The baseline engine of a writer built without a module (section 2, D3): the pinned
   * `secrets@1` pack and `DEFAULT_HIDDEN_HEADERS`, no fingerprint secret, no boot lines.
   */
  static baseline(): PrivacyEngine {
    const result = PrivacyEngine.build(undefined, {}, noopLogger, undefined, new Findings());
    // The baseline has no configuration, so it cannot have a finding.
    return result.engine!;
  }

  /**
   * @internal A standalone engine compiled without I/O (no fingerprint secret), for writers
   * built outside a module, such as a saga runner without `privacy.engine` (SD-63).
   */
  static compileSync(
    options: PrivacyModuleOptions | undefined,
    scopes: PrivacyScopes,
    logger: PrivacyLogger = noopLogger,
  ): PrivacyEngine {
    const result = PrivacyEngine.build(options, scopes, logger, undefined, new Findings());
    if (result.engine === undefined) {
      throw new PrivacyConfigError(result.problems, result.findings);
    }
    return result.engine;
  }

  private static build(
    options: PrivacyOption,
    scopes: PrivacyScopes,
    logger: PrivacyLogger,
    secret: FingerprintSecret | undefined,
    findings: Findings,
    deferred = false,
  ): PrivacyCompileResult {
    const module: ModuleLevel = {
      options: options === false ? undefined : options,
      off: options === false,
    };
    const env = compileEnv(module.options, findings);
    if (module.options !== undefined) checkModule(module.options, env);
    const modulePlan = options === false ? undefined : resolveModule(module, env);
    const resolved = resolveScopes(scopes, module, env);
    const failed = findings.count > 0;
    if (failed && !deferred) {
      return { engine: undefined, findings: findings.list, problems: findings.problems };
    }
    const engine = new PrivacyEngine({
      disabled: options === false,
      options: module.options,
      moduleLevel: module,
      module: modulePlan,
      scopes: resolved.plans,
      secret,
      limits: limitsOf(module.options),
      logger,
      pending: failed ? { findings: findings.list, problems: findings.problems } : undefined,
    });
    if (failed) return { engine, findings: findings.list, problems: findings.problems };
    engine.logBoot(['module', ...resolved.logged], env.exemptions, resolved.notes);
    return { engine, findings: [], problems: [] };
  }

  /**
   * @internal Adds scopes found after the module compiled (activators, inbound endpoints, flows,
   * saga runners). Nothing is added when a scope has a finding; the caller throws them (SD-37).
   */
  addScopes(
    scopes: PrivacyScopes,
    extra: AddScopesOptions = {},
  ): Pick<PrivacyCompileResult, 'findings' | 'problems'> {
    const { findings, env, resolved } = this.resolve(scopes, extra);
    if (findings.count > 0) return { findings: findings.list, problems: findings.problems };
    for (const [name, plan] of resolved.plans) this.parts.scopes.set(name, plan);
    this.logBoot(resolved.logged, env.exemptions, resolved.notes, extra.logger);
    return { findings: [], problems: [] };
  }

  /**
   * @internal Resolves scopes against the frozen profile registry without adding or logging them:
   * an L5 call reference is checked this way at its first call (SD-56).
   */
  checkScopes(scopes: PrivacyScopes): Pick<PrivacyCompileResult, 'findings' | 'problems'> {
    const { findings } = this.resolve(scopes, {});
    return { findings: findings.list, problems: findings.problems };
  }

  private resolve(
    scopes: PrivacyScopes,
    extra: AddScopesOptions,
  ): { findings: Findings; env: CompileEnv; resolved: ReturnType<typeof resolveScopes> } {
    const findings = new Findings();
    const base = compileEnv(this.parts.options, findings);
    const env: CompileEnv = { ...base, hasSealKeys: base.hasSealKeys || extra.sealKeys === true };
    return { findings, env, resolved: resolveScopes(scopes, this.parts.moduleLevel, env) };
  }

  /** @internal The module compile findings `forBoot` held back; empty for a valid module. */
  bootFindings(): Pick<PrivacyCompileResult, 'findings' | 'problems'> {
    return this.parts.pending ?? { findings: [], problems: [] };
  }

  /** @internal True once a scope is known to the engine. */
  hasScope(scope: string): boolean {
    return this.parts.scopes.has(scope);
  }

  /** @internal `forRoot({ privacy: false })`: every writer keeps its 0.9.0 text (section 2). */
  get off(): boolean {
    return this.parts.disabled;
  }

  /** @internal True when an explicit privacy reaches the context (SD-57); the baseline never does. */
  reaches(ctx: Omit<TrailContext, 'output'>): boolean {
    return this.planOf({ ...ctx, output: TrailOutput.Log })?.explicit === true;
  }

  /**
   * @internal The record codec of a durable scope (4.6, 8.2): its resolved `remember`, the module
   * `SealKeyProvider` unless the writer brings its own, and `forTrail` for `Remember.AsShown`.
   */
  recordCodec(
    scope: string,
    output: TrailOutput,
    sealKeys: SealKeyProvider | undefined = this.parts.options?.sealKeys,
  ): RecordCodec {
    return createRecordCodec(this.rememberOf(scope), {
      scope,
      sealKeys,
      asShown: (record) => this.forTrail(record, { output, scope }),
    });
  }

  /** A sink copy of `value` (6.2); `[HIDE_FAILED]` when hiding throws (SD-23). */
  forTrail<T>(value: T, ctx: TrailContext): unknown {
    const plan = this.planOf(ctx);
    if (plan === undefined) return value;
    try {
      const out = this.walkWith(plan, value, ctx, false);
      return out === OMIT ? undefined : out;
    } catch {
      return this.hideFailed(ctx);
    }
  }

  /** Name, message, stack, code, status and own properties of an error, hidden (SD-04, SD-11). */
  errorForTrail(error: unknown, ctx: TrailContext): TrailError {
    const plan = this.planOf(ctx);
    if (plan === undefined) return disabledErrorShape(error);
    try {
      const shaped = this.keyBearing(rawErrorShape(error));
      const out = this.walkWith(plan, shaped, ctx, false);
      if (typeof out !== 'object' || out === null) return { name: 'Error', message: HIDE_FAILED };
      return asTrailError(out as Record<string, unknown>);
    } catch {
      return { name: 'Error', message: this.hideFailed(ctx) };
    }
  }

  textForTrail(text: string, ctx: TrailContext): string {
    const out = this.forTrail(text, ctx);
    return typeof out === 'string' ? out : HIDE_FAILED;
  }

  /** For app code (SD-39): the module privacy, output TrailOutput.Log. */
  forLog(value: unknown, ctx: { channel?: string } = {}): unknown {
    const trail: TrailContext = { output: TrailOutput.Log };
    if (ctx.channel !== undefined) trail.channel = ctx.channel;
    return this.forTrail(value, trail);
  }

  /** What a durable scope keeps (SD-29). */
  rememberOf(scope: string): Remember {
    if (this.parts.disabled) return Remember.Everything;
    return (
      this.parts.scopes.get(scope)?.remember ?? this.parts.module?.remember ?? Remember.Everything
    );
  }

  /** Reads the fingerprint secret again; a failure keeps the current one and warns (SD-16). */
  async refreshFingerprintSecret(): Promise<void> {
    const provider = this.parts.options?.fingerprintSecret;
    if (provider === undefined) return;
    try {
      const material = await provider.current();
      const problem = fingerprintSecretProblem(material);
      if (problem !== undefined) throw new Error(problem);
      this.useSecret(material);
    } catch {
      this.parts.logger.warn(
        `privacy: fingerprint secret refresh failed; keeping secret id '${this.secretId ?? 'none'}'`,
      );
    }
  }

  /** Monotonic counters by rule, trail output and subject; never values (SD-61). */
  stats(): PrivacyStats {
    return {
      byRule: { ...this.counters.byRule },
      byOutput: { ...this.counters.byOutput },
      bySubject: { ...this.counters.bySubject },
      hideFailed: this.counters.hideFailed,
      deliveryCopyFailed: this.counters.deliveryCopyFailed,
    };
  }

  /**
   * @internal A delivery-reach copy (SD-50, SD-51): only the scope's own `Reach.Delivery` rules,
   * faithful or a DeliveryCopyError. Returns the value itself when the scope has none.
   */
  forDelivery<T>(value: T, scope: string): unknown {
    const plan = this.parts.scopes.get(scope)?.delivery;
    if (plan === undefined) return value;
    try {
      return this.walkWith(plan, value, { output: TrailOutput.Capture, scope }, true);
    } catch (error) {
      this.counters.deliveryCopyFailed++;
      // A throwing rule (a `confirm` callback) must not reach the sender as a retryable error.
      if (error instanceof DeliveryCopyError) throw error;
      throw new DeliveryCopyError(scope, 'hiding threw');
    }
  }

  /** @internal True when the scope has delivery-reach rules (SD-50). */
  delivers(scope: string): boolean {
    return this.parts.scopes.get(scope)?.delivery !== undefined;
  }

  /** @internal The frozen plan of a scope, for the boot resolver and the graph (SD-59). */
  planOfScope(scope: string): FrozenPlan | undefined {
    return this.parts.scopes.get(scope);
  }

  private planOf(ctx: TrailContext): FrozenPlan | undefined {
    if (this.parts.disabled) return undefined;
    const byScope = ctx.scope === undefined ? undefined : this.parts.scopes.get(ctx.scope);
    const byChannel =
      ctx.channel === undefined ? undefined : this.parts.scopes.get(`channel:${ctx.channel}`);
    return byScope ?? byChannel ?? this.parts.module;
  }

  private walkWith(
    plan: FrozenPlan,
    value: unknown,
    ctx: TrailContext,
    faithful: boolean,
  ): unknown {
    const subject = ctx.scope ?? (ctx.channel === undefined ? 'module' : `channel:${ctx.channel}`);
    return walk(value, {
      ...this.parts.limits,
      plan,
      fingerprinter: this.fingerprinter,
      faithful,
      subject,
      onHide: (rule) => this.count(rule, ctx.output, subject),
    });
  }

  private count(rule: string, output: string, subject: string): void {
    const { byRule, byOutput, bySubject } = this.counters;
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    byOutput[output] = (byOutput[output] ?? 0) + 1;
    bySubject[subject] = (bySubject[subject] ?? 0) + 1;
  }

  private hideFailed(ctx: TrailContext): string {
    this.counters.hideFailed++;
    const now = Date.now();
    const last = this.lastFailureLog.get(ctx.output);
    if (last === undefined || now - last >= FAILURE_LOG_INTERVAL_MS) {
      this.lastFailureLog.set(ctx.output, now);
      this.parts.logger.error(`privacy: hiding failed for trail output '${ctx.output}'`);
    }
    return HIDE_FAILED;
  }

  /** SD-43: idempotency keys on Estela's own errors get the idempotency-key treatment. */
  private keyBearing(shaped: Record<string, unknown>): Record<string, unknown> {
    const property = KEY_PROPERTIES[String(shaped.name)];
    if (property === undefined || typeof shaped[property] !== 'string') return shaped;
    const key = shaped[property];
    const shown =
      this.fingerprinter === undefined
        ? hiddenToken('header')
        : this.fingerprinter.fingerprint(key);
    return { ...shaped, [property]: shown };
  }

  private useSecret(material: FingerprintSecret | undefined): void {
    if (material === undefined) return;
    const chars = this.parts.options?.fingerprintChars ?? DEFAULT_FINGERPRINT_CHARS;
    this.fingerprinter = hmacFingerprinter(material.id, material.secret, chars);
    this.secretId = material.id;
  }

  /** SD-37, SD-60: subject, profile and pack names, rule counts and reach; never a rule body. */
  private summaryLine(name: string, plan: FrozenPlan): string {
    const uses = plan.names.length === 0 ? '-' : plan.names.join(',');
    const reach = plan.delivery === undefined ? '' : ' reach=delivery';
    return (
      `privacy scope '${name}': fields=${plan.fieldCount} patterns=${plan.patterns.length}` +
      ` uses=${uses} remember=${plan.remember ?? '-'} fingerprint=${this.secretId ?? 'none'}` +
      reach
    );
  }

  /** SD-37, SD-18, SD-29, SD-60: names, counts and reasons only. */
  private logBoot(
    names: readonly string[],
    exemptions: CompileEnv['exemptions'],
    notes: readonly string[],
    logger: PrivacyLogger = this.parts.logger,
  ): void {
    if (this.parts.disabled) {
      if (names.includes('module')) logger.log('privacy: off (forRoot({ privacy: false }))');
      return;
    }
    for (const name of names) {
      const plan = name === 'module' ? this.parts.module : this.parts.scopes.get(name);
      if (plan !== undefined) logger.log(this.summaryLine(name, plan));
    }
    for (const exemption of exemptions) {
      logger.warn(
        `privacy exemption: ${exemption.subject} path '${exemption.path}' show ${exemption.show}` +
          ` reason: ${exemption.reason}`,
      );
    }
    for (const note of notes) logger.warn(note);
  }
}

function resolveScopes(
  scopes: PrivacyScopes,
  module: ModuleLevel,
  env: CompileEnv,
): { plans: Map<string, FrozenPlan>; notes: string[]; logged: string[] } {
  const plans = new Map<string, FrozenPlan>();
  const notes: string[] = [];
  const logged: string[] = [];
  for (const [name, scope] of Object.entries(scopes)) {
    const resolved = resolveScope(name, scope, module, env);
    plans.set(name, resolved.plan);
    notes.push(...resolved.notes);
    if (summarized(scope, resolved.plan)) logged.push(name);
  }
  return { plans, notes, logged };
}

/** SD-37, SD-60: which scopes get a boot summary line. */
function summarized(scope: PrivacyScopes[string], plan: FrozenPlan): boolean {
  if (scope.summary === 'none') return false;
  return scope.summary !== 'explicit' || plan.explicit;
}

async function readSecret(
  options: PrivacyModuleOptions | undefined,
  findings: Findings,
): Promise<FingerprintSecret | undefined> {
  const provider = options?.fingerprintSecret;
  if (provider === undefined) return undefined;
  let material: FingerprintSecret;
  try {
    material = await provider.current();
  } catch {
    findings.add(CODE.INVALID_OPTION, 'module', 'privacy.fingerprintSecret', 'could not be read');
    return undefined;
  }
  const problem = fingerprintSecretProblem(material);
  if (problem === undefined) return material;
  findings.add(CODE.FINGERPRINT_SECRET_SHORT, 'module', 'privacy.fingerprintSecret', problem);
  return undefined;
}

function compileEnv(options: PrivacyModuleOptions | undefined, findings: Findings): CompileEnv {
  return {
    findings,
    // A provider whose secret is unusable already failed; do not add FINGERPRINT_WITHOUT_SECRET.
    hasFingerprintSecret: options?.fingerprintSecret !== undefined,
    hasSealKeys: options?.sealKeys !== undefined,
    engine: options?.regexEngine ?? nativeRegexEngine,
    profiles: options?.profiles ?? {},
    patternCache: new WeakMap(),
    exemptions: [],
  };
}

function checkModule(options: PrivacyModuleOptions, env: CompileEnv): void {
  for (const [key, range] of Object.entries(LIMITS)) {
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined && !inRange(value, range)) {
      env.findings.add(
        CODE.INVALID_OPTION,
        'module',
        `privacy.${key}`,
        `must be an integer in ${range[0]}..${range[1]}`,
      );
    }
  }
  // The type has no `reach`; a JavaScript caller can still pass it (SD-50).
  if ((options as { reach?: unknown }).reach === Reach.Delivery) {
    env.findings.add(
      CODE.DELIVERY_REACH_LEVEL,
      'module',
      'privacy.reach',
      'Reach.Delivery is accepted only on a flow step or target',
    );
  }
  checkPrivacy(options, 'module', 'privacy', env);
  checkProfiles(env);
}

function limitsOf(options: PrivacyModuleOptions | undefined): WalkLimits {
  return {
    maxScanBytes: options?.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES,
    maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: options?.maxNodes ?? DEFAULT_MAX_NODES,
  };
}

function rawErrorShape(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const shaped = errorShape(error);
    if (typeof shaped.url === 'string') shaped.url = urlForTrail(shaped.url);
    return shaped;
  }
  if (typeof error === 'string') return { name: 'Error', message: error };
  return { name: 'NonError', message: '', value: error };
}

function asTrailError(out: Record<string, unknown>): TrailError {
  return {
    ...out,
    name: typeof out.name === 'string' ? out.name : 'Error',
    message: typeof out.message === 'string' ? out.message : HIDE_FAILED,
  };
}

/** `privacy: false`: `{ name, message, code?, status?, url? }` only (SD-04). */
function disabledErrorShape(error: unknown): TrailError {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: typeof error === 'string' ? error : '' };
  }
  const out: TrailError = { name: error.name, message: error.message };
  const source = error as unknown as Record<string, unknown>;
  for (const key of ['code', 'status'] as const) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  if (typeof source.url === 'string') out.url = urlForTrail(source.url);
  return out;
}
