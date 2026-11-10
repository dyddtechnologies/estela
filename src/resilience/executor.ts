import { randomInt } from 'node:crypto';
import { Bulkhead } from './bulkhead';
import { CircuitBreakers, type Admission, type BreakerTransition } from './circuit-breaker';
import { planBTrigger, runPlanB } from './fallback';
import { CareObserver } from './observability';
import { RateLimiter } from './rate-limiter';
import {
  CareError,
  CareKeyError,
  LanesFullError,
  OutOfTimeError,
  OverPaceError,
  ValveShutError,
  type CareKeyErrorReason,
} from './resilience.errors';
import { FAILURE_CLASSES, type CarePlan } from './resilience.plan';
import type {
  CareClock,
  CareContext,
  CareEdge,
  CareEvent,
  Classification,
  FailureClass,
  ValveStateView,
} from './resilience.types';
import { CareScope, parseTriesLeftValue, TRIES_LEFT_MESSAGE_HEADER } from './retry-budget';
import { StateSwitch } from './state-port';
import { AttemptTimeout, systemCareClock, withAttemptTimeout } from './timeout';

export { currentTrySignal } from './retry-budget';

const MAX_KEY_LENGTH = 200;
const SINK_KEY = /^[A-Za-z0-9:_.-]{1,128}$/;

/** What an edge (REST, gRPC, SDK, activator, saga step, flow step, channel) gives the engine (RS-39). */
export interface CareEdgeAdapter {
  readonly kind: CareEdge;
  /** Edge default classifier (RS-14, RS-15, or defaultInProcessClassifier, RS-17a). */
  classify(error: unknown, ctx: CareContext): Classification;
  /** RS-09: safe method, idempotency key present, or declared idempotent. */
  repeatable(ctx: CareContext): boolean;
  /** Error for a try that ran past `eachTryMs` (REST keeps its 0.9.0 error). */
  overdueError(ctx: CareContext, eachTryMs: number): Error;
  /** Called per try with the tries left to send downstream (undefined = send nothing). */
  outgoingTriesLeft?(triesLeft: number | undefined): void;
  /** RS-48: true for a call that is safe without a key (REST GET, HEAD, OPTIONS). */
  safe?(ctx: CareContext): boolean;
  /** RS-48: the idempotency key of the call, when there is one. */
  idempotencyKey?(ctx: CareContext): string | undefined;
  /** Valve and pace key when the care sets none; default the binding name. */
  defaultKey?(ctx: CareContext): string;
  /** Marker of this edge's own overdue errors on top of the engine timer (flow jumps). */
  isOverdue?(error: unknown): boolean;
  /** RS-66: the target channel of a flow send or jump subject, for events without a call. */
  readonly channel?: string;
}

/** One try handed to `run`. */
export interface CareTry {
  tryNumber: number;
  signal: AbortSignal | undefined;
  /** Effective longest wait of this try, 0 = no limit. */
  eachTryMs: number;
  /** Tries left to send downstream on this try. */
  triesLeftOut: number | undefined;
}

/** Outcome of a call. */
export interface CareResult<T> {
  value: T;
  tries: number;
  /** True when plan B answered. */
  planB: boolean;
  durationMs: number;
}

/** Collaborators of an executor; every field has a default, so tests pass only what they need. */
export interface CareDeps {
  clock?: CareClock;
  random?: (maxExclusive: number) => number;
  observer?: CareObserver;
  /** Tries left along the call path (RS-29): enabled only under forRoot({ care }). */
  triesLeft?: { enabled: boolean; initial?: number };
  sharedStateWaitMs?: number;
  sharedStateCheckMs?: number;
  keyLabel?: (key: string, ctx: CareContext) => string | undefined;
  keyHasher?: (key: string) => string;
  /** Runs a `planB.channel` for this edge (request/reply, or a re-send on send steps). */
  planBChannel?: (channel: string, ctx: CareContext) => Promise<unknown>;
  /** Static default key (control lookups); default the binding name. */
  defaultKey?: string;
  /**
   * Shutdown of a background caller (flow forget targets, RS-62): once aborted, a pending gap
   * between tries ends and the call fails with its last error instead of starting another try.
   */
  shutdown?: AbortSignal;
}

/** Options of one engine run. */
export interface CareExecuteOptions {
  /** Per-call `eachTryMs` (REST call or target `timeoutMs`). */
  eachTryMs?: number;
}

interface CallKeys {
  valve: string;
  pace: string;
}

interface CallState {
  tries: number;
  lastClass?: FailureClass;
}

interface FailedTry {
  error: unknown;
  cut: boolean;
  admission: Admission;
  extraTries: number;
  endsAt: number;
}

const defaultRandom = (maxExclusive: number): number => randomInt(maxExclusive);

/**
 * Runs one call under a resolved plan, composing the parts in the fixed order of RS-02:
 * planB > patience.total > lanes > tries > valve > pace > patience.eachTry > call.
 * Stateful parts (valves, lanes, turns) live in the executor, so one executor is created per
 * edge and binding and reused for every call.
 */
export class CareExecutor<T = unknown> {
  private readonly clock: CareClock;
  private readonly random: (maxExclusive: number) => number;
  private readonly observer: CareObserver;
  private readonly valves?: CircuitBreakers;
  private readonly lanes?: Bulkhead;
  private readonly pacer?: RateLimiter;
  private readonly labels: Record<string, string>;
  readonly defaultKey: string;

  constructor(
    readonly plan: CarePlan,
    private readonly adapter: CareEdgeAdapter,
    private readonly deps: CareDeps = {},
  ) {
    this.clock = deps.clock ?? systemCareClock;
    this.random = deps.random ?? defaultRandom;
    this.observer = deps.observer ?? new CareObserver({ clock: this.clock });
    this.defaultKey = deps.defaultKey ?? plan.binding;
    this.labels = { edge: plan.edge, binding: plan.binding };
    if (plan.valve !== undefined) {
      const shared =
        plan.valve.state === undefined
          ? undefined
          : {
              switch: this.stateSwitch(),
              stateKey: (key: string) => this.stateKey('valve', key),
            };
      this.valves = new CircuitBreakers(
        plan.valve,
        this.clock,
        {
          transition: (type, key) => this.onTransition(type, key),
          capacity: () => this.onCapacity(),
        },
        shared,
      );
    }
    if (plan.lanes !== undefined) this.lanes = new Bulkhead(plan.lanes, this.clock);
    if (plan.pace !== undefined) {
      const shared =
        plan.pace.state === undefined
          ? undefined
          : {
              switch: this.stateSwitch(),
              stateKey: (key: string) => this.stateKey('pace', key),
            };
      this.pacer = new RateLimiter(plan.pace, this.clock, shared);
    }
  }

  get binding(): string {
    return this.plan.binding;
  }

  valveState(key?: string): ValveStateView | undefined {
    return this.valves?.stateOf(key ?? this.defaultKey);
  }

  /** Reopens the valve of `key` and clears its shared marks; emits `valve.flowing` (RS-49). */
  async resume(key?: string): Promise<void> {
    if (this.valves === undefined) return;
    await this.valves.reset(key ?? this.defaultKey);
  }

  /** Size of the local valve and turn maps (I11). */
  get stateSizes(): { valves: number; turns: number } {
    return { valves: this.valves?.size ?? 0, turns: this.pacer?.bucketCount ?? 0 };
  }

  async execute(
    input: Omit<CareContext, 'tryNumber'>,
    run: (current: CareTry) => Promise<T>,
    options: CareExecuteOptions = {},
  ): Promise<CareResult<T>> {
    const started = this.clock.monotonic();
    const ctx: CareContext = { ...input, tryNumber: 0 };
    if (this.plan.empty && options.eachTryMs === undefined) {
      const triesLeftOut = this.incomingTriesLeft(ctx);
      const value = await run({ tryNumber: 1, signal: undefined, eachTryMs: 0, triesLeftOut });
      return { value, tries: 1, planB: false, durationMs: this.clock.monotonic() - started };
    }
    this.assertIdempotencyKey(ctx);
    const keys = this.resolveKeys(ctx);
    const endsAt = Math.min(
      this.plan.totalMs === undefined ? Infinity : started + this.plan.totalMs,
      this.enclosingDeadline(),
    );
    const state: CallState = { tries: 0 };
    try {
      const value = await this.withLanes(ctx, endsAt, state, () =>
        this.tryLoop(ctx, keys, endsAt, state, run, options),
      );
      this.finish('success', started);
      return {
        value,
        tries: state.tries,
        planB: false,
        durationMs: this.clock.monotonic() - started,
      };
    } catch (error) {
      return this.recover(error, ctx, state, started);
    }
  }

  // ---------- Keys and preconditions ----------

  private assertIdempotencyKey(ctx: CareContext): void {
    if (this.plan.tries?.requireIdempotencyKey !== true) return;
    if (this.adapter.safe?.(ctx) === true) return;
    if (this.adapter.idempotencyKey?.(ctx) !== undefined) return;
    throw this.keyError('idempotency-key-required');
  }

  private keyError(reason: CareKeyErrorReason, cause?: unknown): CareKeyError {
    return new CareKeyError({
      binding: this.plan.binding,
      edge: this.plan.edge,
      reason,
      cause,
    });
  }

  private resolveKeys(ctx: CareContext): CallKeys {
    const baseKey = this.adapter.defaultKey?.(ctx) ?? this.defaultKey;
    const valve = this.keyOf(this.plan.valve?.key, ctx, baseKey, this.plan.valve?.state);
    const pace = this.keyOf(this.plan.pace?.key, ctx, baseKey, this.plan.pace?.state);
    return { valve, pace };
  }

  /** RS-20, RS-43: a custom key is validated, and hashed and labelled before any try. */
  private keyOf(
    fn: ((ctx: CareContext) => string) | undefined,
    ctx: CareContext,
    baseKey: string,
    shared: unknown,
  ): string {
    if (fn === undefined) return baseKey;
    let key: unknown;
    try {
      key = fn(ctx);
    } catch (cause) {
      throw this.keyError('key-fn', cause);
    }
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
      throw this.keyError('invalid-key');
    }
    if (shared !== undefined) this.hashKey(key);
    if (this.deps.keyLabel !== undefined) this.labelOf(key, ctx, true);
    return key;
  }

  private hashKey(key: string): string {
    const hasher = this.deps.keyHasher;
    if (hasher === undefined) throw this.keyError('hasher');
    let digest: unknown;
    try {
      digest = hasher(key);
    } catch (cause) {
      throw this.keyError('hasher', cause);
    }
    if (typeof digest !== 'string' || !SINK_KEY.test(digest)) throw this.keyError('hasher');
    return digest;
  }

  /** `keyLabel(key)`; invalid output throws during key resolution, is omitted elsewhere. */
  private labelOf(key: string, ctx: CareContext, strict: boolean): string | undefined {
    const keyLabel = this.deps.keyLabel;
    if (keyLabel === undefined) return undefined;
    try {
      const label = keyLabel(key, ctx);
      if (label === undefined) return undefined;
      if (typeof label === 'string' && SINK_KEY.test(label)) return label;
    } catch (cause) {
      if (strict) throw this.keyError('hasher', cause);
      return undefined;
    }
    if (strict) throw this.keyError('hasher');
    return undefined;
  }

  /** `estela:care:<part>:<binding>` for the default key, `...:<keyHasher(key)>` for a custom one. */
  private stateKey(part: 'valve' | 'pace', key: string): string {
    const base = `estela:care:${part}:${this.plan.binding}`;
    if (key === this.plan.binding) return base;
    if (key === this.defaultKey) return `${base}:${key}`;
    return `${base}:${this.hashKey(key)}`;
  }

  private stateSwitch(): StateSwitch {
    return new StateSwitch(
      this.clock,
      this.deps.sharedStateWaitMs ?? 100,
      this.deps.sharedStateCheckMs ?? 5000,
      {
        onDegraded: () => {
          this.emit({ type: 'shared-state.lost' });
          this.observer.logger.warn(
            `care shared state lost for ${this.where()}; using local state`,
          );
          this.observer.gauge('estela_care_shared_state_lost', this.labels, 1);
        },
        onRecovered: () => {
          this.emit({ type: 'shared-state.back' });
          this.observer.logger.log(`care shared state back for ${this.where()}`);
          this.observer.gauge('estela_care_shared_state_lost', this.labels, 0);
        },
      },
    );
  }

  /**
   * RS-69: the total patience of an executor running in the same async chain bounds this call
   * too. A plan in the 0.9.0 spellings ignores it, so it keeps its 0.9.0 timing.
   */
  private enclosingDeadline(): number {
    if (this.plan.legacyPatience === true || this.plan.tries?.legacy !== undefined) return Infinity;
    return CareScope.current()?.deadlineAt ?? Infinity;
  }

  // ---------- Tries left ----------

  private incomingTriesLeft(ctx: CareContext): number | undefined {
    const triesLeft = this.deps.triesLeft;
    if (triesLeft?.enabled !== true) return undefined;
    const raw = ctx.message?.headers[TRIES_LEFT_MESSAGE_HEADER];
    if (raw !== undefined) {
      const parsed = parseTriesLeftValue(raw);
      if (parsed.invalid) {
        this.observer.counter('estela_care_tries_left_invalid_total', { edge: this.plan.edge });
      }
      if (parsed.triesLeft !== undefined) return parsed.triesLeft;
    }
    return CareScope.current()?.triesLeft ?? triesLeft.initial;
  }

  // ---------- Composition ----------

  private async withLanes<R>(
    ctx: CareContext,
    endsAt: number,
    state: CallState,
    fn: () => Promise<R>,
  ): Promise<R> {
    if (this.lanes === undefined) return fn();
    const slot = await this.lanes.acquire(endsAt);
    if (typeof slot !== 'function') {
      if (slot.reason === 'waitlist-expired' && slot.byDeadline)
        throw this.outOfTime(ctx, state.tries, undefined);
      this.emit({ type: 'lanes.full', reason: 'lanes-full' }, ctx);
      this.observer.counter('estela_care_turned_away_total', {
        ...this.labels,
        reason: 'lanes-full',
      });
      throw new LanesFullError({ ...this.meta(state.tries), reason: slot.reason });
    }
    try {
      return await fn();
    } finally {
      slot();
    }
  }

  private async tryLoop(
    ctx: CareContext,
    keys: CallKeys,
    endsAt: number,
    state: CallState,
    run: (current: CareTry) => Promise<T>,
    options: CareExecuteOptions,
  ): Promise<T> {
    const { extraTries, triesLeftOut } = this.extraTriesOf(ctx);
    const eachTry = options.eachTryMs ?? this.plan.eachTryMs;
    const limit = eachTry > 0 ? eachTry : Infinity;
    let lastError: unknown;
    for (let tryNumber = 1; ; tryNumber += 1) {
      state.tries = tryNumber;
      const tctx: CareContext = { ...ctx, tryNumber };
      const admission = await this.admit(tctx, keys, endsAt, lastError);
      const remaining = endsAt - this.clock.monotonic();
      if (remaining <= 0) {
        this.valves?.release(admission);
        throw this.outOfTime(tctx, tryNumber - 1, lastError);
      }
      try {
        const value = await this.runTry(
          tctx,
          { eachTryMs: Math.min(limit, remaining), endsAt },
          triesLeftOut,
          run,
        );
        this.valves?.success(admission);
        this.observer.counter('estela_care_tries_total', { ...this.labels, class: 'success' });
        return value;
      } catch (raw) {
        const cut = raw instanceof AttemptTimeout && remaining < limit;
        lastError = raw instanceof AttemptTimeout ? raw.error : raw;
        await this.waitOrThrow(tctx, state, {
          error: lastError,
          cut,
          admission,
          extraTries,
          endsAt,
        });
      }
    }
  }

  /** Records a failed try, then waits before the next one or throws the final error. */
  private async waitOrThrow(ctx: CareContext, state: CallState, failure: FailedTry): Promise<void> {
    const { error, admission } = failure;
    if (failure.cut) {
      this.valves?.release(admission);
      throw this.outOfTime(ctx, ctx.tryNumber, error);
    }
    const verdict = await this.afterFailure(error, ctx, admission, state);
    const delay = await this.nextGap(error, verdict, ctx, failure.extraTries, failure.endsAt);
    if (delay === undefined) throw error;
    this.emit(
      { type: 'try.again', class: verdict.class, tryNumber: ctx.tryNumber, delayMs: delay },
      ctx,
    );
    this.observer.counter('estela_care_extra_tries_total', this.labels);
    this.observer.logger.debug(`try ${ctx.tryNumber + 1} of ${this.where()} in ${delay}ms`);
    const shutdown = this.deps.shutdown;
    if (aborted(shutdown)) throw error;
    await this.clock.sleep(delay, shutdown);
    if (aborted(shutdown)) throw error;
  }

  /** RS-30: effective extra tries `min(max - 1, tries left)` and the tries left sent downstream. */
  private extraTriesOf(ctx: CareContext): {
    extraTries: number;
    triesLeftOut: number | undefined;
  } {
    const tries = this.plan.tries;
    if (tries === undefined) return { extraTries: 0, triesLeftOut: this.incomingTriesLeft(ctx) };
    const max = tries.max;
    const repeatable = tries.idempotent || this.adapter.repeatable(ctx);
    if (tries.legacy !== undefined)
      return { extraTries: repeatable ? max - 1 : 0, triesLeftOut: undefined };
    const incoming = this.incomingTriesLeft(ctx);
    const extraTries = repeatable ? Math.min(max - 1, incoming ?? Infinity) : 0;
    if (max > 1 && extraTries === 0) this.emit({ type: 'try.held' }, ctx);
    return { extraTries, triesLeftOut: this.keeps(extraTries, tries.triesLeft) ? 0 : incoming };
  }

  /** An edge that tries again under enabled tries-left sends 0 downstream (RS-30). */
  private keeps(extraTries: number, mode: 'keep' | 'forward'): boolean {
    return extraTries > 0 && mode === 'keep' && this.deps.triesLeft?.enabled === true;
  }

  /** Valve admission, then a pace turn, for every try (I1). */
  private async admit(
    ctx: CareContext,
    keys: CallKeys,
    endsAt: number,
    lastError: unknown,
  ): Promise<Admission> {
    let admission: Admission = { key: keys.valve, probe: false };
    if (this.valves !== undefined) {
      const result = await this.valves.admit(keys.valve, endsAt);
      if (!result.admitted) {
        this.observer.counter('estela_care_turned_away_total', {
          ...this.labels,
          reason: 'valve-shut',
        });
        const meta = { ...this.meta(ctx.tryNumber - 1), cause: lastError };
        throw new ValveShutError({
          ...meta,
          ...(result.readyInMs === undefined ? {} : { readyInMs: result.readyInMs }),
          ...(result.forcedBy === undefined ? {} : { forcedBy: result.forcedBy }),
        });
      }
      admission = result.admission;
    }
    if (this.pacer === undefined) return admission;
    const outcome = await this.pacer.take(keys.pace, endsAt);
    if (outcome.granted) return admission;
    this.valves?.release(admission);
    if (outcome.byDeadline) throw this.outOfTime(ctx, ctx.tryNumber - 1, lastError);
    this.emit({ type: 'pace.over', reason: 'over-pace' }, ctx);
    this.observer.counter('estela_care_turned_away_total', {
      ...this.labels,
      reason: 'over-pace',
    });
    throw new OverPaceError({
      ...this.meta(ctx.tryNumber - 1),
      cause: lastError,
      readyInMs: outcome.readyInMs,
    });
  }

  private runTry(
    ctx: CareContext,
    bounds: { eachTryMs: number; endsAt: number },
    triesLeftOut: number | undefined,
    run: (current: CareTry) => Promise<T>,
  ): Promise<T> {
    const { eachTryMs, endsAt } = bounds;
    this.adapter.outgoingTriesLeft?.(triesLeftOut);
    const scoped = {
      ...(triesLeftOut === undefined ? {} : { triesLeft: triesLeftOut }),
      ...(Number.isFinite(endsAt) ? { deadlineAt: endsAt } : {}),
    };
    return withAttemptTimeout(
      this.clock,
      eachTryMs,
      (signal) =>
        CareScope.run({ ...scoped, ...(signal === undefined ? {} : { signal }) }, () =>
          run({
            tryNumber: ctx.tryNumber,
            signal,
            eachTryMs: Number.isFinite(eachTryMs) ? eachTryMs : 0,
            triesLeftOut,
          }),
        ),
      () => this.adapter.overdueError(ctx, eachTryMs),
    );
  }

  /** Classifies the failure and records it: quota forces the valve shut (RS-16). */
  private async afterFailure(
    error: unknown,
    ctx: CareContext,
    admission: Admission,
    state: CallState,
  ): Promise<Classification> {
    const verdict = await this.classify(error, ctx);
    state.lastClass = verdict.class;
    this.observer.counter('estela_care_tries_total', { ...this.labels, class: verdict.class });
    if (verdict.class === 'quota') {
      this.valves?.forceOpen(admission);
      this.emit({ type: 'quota.used-up', class: 'quota' }, ctx);
      return verdict;
    }
    if (this.plan.valve?.countOn.has(verdict.class) === true) this.valves?.failure(admission);
    else this.valves?.release(admission);
    return verdict;
  }

  /** RS-08, RS-11: the gap before the next try, or undefined when the failure is final. */
  private async nextGap(
    error: unknown,
    verdict: Classification,
    ctx: CareContext,
    extraTries: number,
    endsAt: number,
  ): Promise<number | undefined> {
    const tries = this.plan.tries;
    if (tries === undefined || ctx.tryNumber > extraTries || verdict.class === 'quota')
      return undefined;
    if (tries.legacy !== undefined) {
      if (!(await tries.legacy.tryAgainOn(error, ctx))) return undefined;
    } else if (!tries.on.has(verdict.class)) {
      return undefined;
    }
    let delay = tries.delay(ctx.tryNumber, error, this.random);
    if (tries.heedServerWait && verdict.readyInMs !== undefined) {
      if (verdict.readyInMs > tries.maxServerWaitMs) return undefined;
      delay = Math.max(delay, verdict.readyInMs);
    }
    if (this.clock.monotonic() + delay >= endsAt) throw this.outOfTime(ctx, ctx.tryNumber, error);
    return delay;
  }

  /** RS-13: app classifiers first (first defined wins), then the edge default, then 'unknown'. */
  private classify(error: unknown, ctx: CareContext): Promise<Classification> {
    for (const fn of this.plan.classify) {
      let result: unknown;
      try {
        result = fn(error, ctx);
      } catch {
        this.observer.errorOnce(
          `classify:${this.plan.binding}`,
          `care classifier of ${this.where()} threw; class unknown`,
        );
        return Promise.resolve({ class: 'unknown' });
      }
      const normalized = normalizeClassification(result);
      if (normalized !== undefined) return Promise.resolve(normalized);
    }
    try {
      return Promise.resolve(
        normalizeClassification(this.adapter.classify(error, ctx)) ?? { class: 'unknown' },
      );
    } catch {
      return Promise.resolve({ class: 'unknown' });
    }
  }

  // ---------- Plan B and outcome ----------

  private async recover(
    error: unknown,
    ctx: CareContext,
    state: CallState,
    started: number,
  ): Promise<CareResult<T>> {
    const planB = this.plan.planB;
    const trigger = planBTrigger(error, state.lastClass);
    if (planB === undefined || trigger === undefined || !planB.on.has(trigger)) {
      this.finish(error instanceof CareError ? 'turned-away' : 'failure', started);
      throw error;
    }
    const pctx: CareContext = { ...ctx, tryNumber: state.tries };
    try {
      const value = (await runPlanB(planB, error, pctx, this.deps.planBChannel, state.tries)) as T;
      this.emit({ type: 'plan-b.used', ...classOrReason(trigger) }, pctx);
      if (!planB.cacheable) CareScope.markPlanB();
      this.finish('plan-b', started);
      return {
        value,
        tries: state.tries,
        planB: true,
        durationMs: this.clock.monotonic() - started,
      };
    } catch (failed) {
      this.emit({ type: 'plan-b.failed', ...classOrReason(trigger) }, pctx);
      this.finish('failure', started);
      throw failed;
    }
  }

  private outOfTime(ctx: CareContext, tries: number, cause: unknown): OutOfTimeError {
    this.emit({ type: 'patience.ran-out', reason: 'out-of-time' }, ctx);
    this.observer.counter('estela_care_turned_away_total', {
      ...this.labels,
      reason: 'out-of-time',
    });
    return new OutOfTimeError({
      ...this.meta(tries),
      cause,
      totalMs: this.plan.totalMs ?? 0,
    });
  }

  private finish(outcome: 'success' | 'failure' | 'plan-b' | 'turned-away', started: number): void {
    const labels = { ...this.labels, outcome };
    this.observer.counter('estela_care_calls_total', labels);
    this.observer.histogram(
      'estela_care_call_seconds',
      labels,
      (this.clock.monotonic() - started) / 1000,
    );
  }

  // ---------- Events ----------

  private meta(tries: number): { binding: string; edge: CareEdge; tries: number } {
    return { binding: this.plan.binding, edge: this.plan.edge, tries };
  }

  private where(): string {
    return `${this.plan.edge.replace(/-/g, ' ')} '${this.plan.binding}'`;
  }

  private emit(
    event: Omit<CareEvent, 'at' | 'edge' | 'binding'>,
    ctx?: CareContext,
    key?: string,
  ): void {
    const full: Omit<CareEvent, 'at'> = {
      ...event,
      edge: this.plan.edge,
      binding: this.plan.binding,
    };
    // RS-66: the target channel of a flow send or jump edge; absent on every other edge.
    if (
      ctx?.channel !== undefined &&
      (this.plan.edge === 'flow-send' || this.plan.edge === 'flow-jump')
    ) {
      full.channel = ctx.channel;
    }
    const headers = ctx?.message?.headers;
    if (headers !== undefined) {
      full.traceId = headers.traceId;
      full.correlationId = headers.correlationId;
    }
    if (key !== undefined && ctx !== undefined) {
      const label = this.labelOf(key, ctx, false);
      if (label !== undefined) full.keyLabel = label;
    }
    this.observer.emit(full);
  }

  private onTransition(type: BreakerTransition, key: string): void {
    const ctx: CareContext = { edge: this.plan.edge, binding: this.plan.binding, tryNumber: 0 };
    if (this.adapter.channel !== undefined) ctx.channel = this.adapter.channel;
    this.emit({ type }, ctx, key);
    if (type === 'valve.shut' || type === 'valve.forced-shut') {
      this.observer.logger.warn(`${type} for ${this.where()}`);
    } else if (type === 'valve.flowing') {
      this.observer.logger.log(`valve.flowing for ${this.where()}`);
    } else {
      this.observer.logger.debug(`${type} for ${this.where()}`);
    }
    this.observer.gauge('estela_care_valves_shut', this.labels, this.valves?.openCount ?? 0);
  }

  private onCapacity(): void {
    if (this.observer.allowed(`capacity:${this.plan.binding}`))
      this.emit({ type: 'valve.keys-full' });
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeClassification(result: unknown): Classification | undefined {
  if (typeof result === 'string') {
    return FAILURE_CLASSES.includes(result as FailureClass)
      ? { class: result as FailureClass }
      : undefined;
  }
  if (typeof result !== 'object' || result === null) return undefined;
  const value = result as Classification;
  if (!FAILURE_CLASSES.includes(value.class)) return undefined;
  const out: Classification = { class: value.class };
  if (typeof value.readyInMs === 'number' && value.readyInMs >= 0) out.readyInMs = value.readyInMs;
  return out;
}

function classOrReason(trigger: string): Pick<CareEvent, 'class' | 'reason'> {
  return FAILURE_CLASSES.includes(trigger as FailureClass)
    ? { class: trigger as FailureClass }
    : { reason: trigger as CareEvent['reason'] & string };
}
