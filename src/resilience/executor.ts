import { randomInt } from 'node:crypto';
import { Bulkhead } from './bulkhead';
import { CircuitBreakers, type Admission, type BreakerTransition } from './circuit-breaker';
import { fallbackTrigger, runFallback } from './fallback';
import { ResilienceObserver } from './observability';
import { RateLimiter } from './rate-limiter';
import {
  BulkheadFullError,
  CircuitOpenError,
  DeadlineExceededError,
  RateLimitedError,
  ResilienceError,
  ResilienceKeyError,
  type ResilienceKeyErrorReason,
} from './resilience.errors';
import { FAILURE_CLASSES, type ResiliencePlan } from './resilience.plan';
import type {
  Classification,
  FailureClass,
  ResilienceClock,
  ResilienceContext,
  ResilienceEdgeKind,
  ResilienceEvent,
} from './resilience.types';
import {
  parseRetryBudgetValue,
  RETRY_BUDGET_MESSAGE_HEADER,
  ResilienceScope,
} from './retry-budget';
import { StateSwitch } from './state-port';
import { AttemptTimeout, systemResilienceClock, withAttemptTimeout } from './timeout';

export { currentResilienceSignal } from './retry-budget';

const MAX_KEY_LENGTH = 200;
const SINK_KEY = /^[A-Za-z0-9:_.-]{1,128}$/;

/** What an edge (REST, gRPC, SDK, activator, saga step, flow step, channel) gives the engine (RS-39). */
export interface ResilienceEdgeAdapter {
  readonly kind: ResilienceEdgeKind;
  /** Edge default classifier (RS-14, RS-15, or defaultInProcessClassifier, RS-17a). */
  classify(error: unknown, ctx: ResilienceContext): Classification;
  /** RS-09: safe method, idempotency key present, or declared idempotent. */
  repeatable(ctx: ResilienceContext): boolean;
  /** Error for an expired per-attempt timeout (REST: OutboundTimeoutError). */
  timeoutError(ctx: ResilienceContext, timeoutMs: number): Error;
  /** Called per attempt with the budget to send downstream (undefined = send nothing). */
  outgoingBudget?(budget: number | undefined): void;
  /** RS-48: true for an operation that is safe without a key (REST GET, HEAD, OPTIONS). */
  safe?(ctx: ResilienceContext): boolean;
  /** RS-48: the idempotency key of the call, when there is one. */
  idempotencyKey?(ctx: ResilienceContext): string | undefined;
  /** Breaker and rate-limit key when the policy sets none; default the binding name. */
  defaultKey?(ctx: ResilienceContext): string;
  /** Marker of this edge's own timeout errors on top of the engine timer (flow jumps). */
  isTimeout?(error: unknown): boolean;
}

export interface ResilienceAttempt {
  attempt: number;
  signal: AbortSignal | undefined;
  /** Effective per-attempt timeout, 0 = none. */
  timeoutMs: number;
  /** Budget to send downstream on this attempt. */
  budgetOut: number | undefined;
}

export interface ResilienceResult<T> {
  value: T;
  attempts: number;
  fallback: boolean;
  durationMs: number;
}

/** Collaborators of an executor; every field has a default, so tests pass only what they need. */
export interface ResilienceDeps {
  clock?: ResilienceClock;
  random?: (maxExclusive: number) => number;
  observer?: ResilienceObserver;
  /** Retry budget (RS-29): enabled only under forRoot({ resilience }). */
  budget?: { enabled: boolean; initial?: number };
  stateTimeoutMs?: number;
  stateProbeMs?: number;
  keyLabel?: (key: string, ctx: ResilienceContext) => string | undefined;
  keyHasher?: (key: string) => string;
  /** Runs a `fallback.channel` for this edge (request/reply, or a re-send on send steps). */
  fallbackChannel?: (channel: string, ctx: ResilienceContext) => Promise<unknown>;
  /** Static default key (registry lookups); default the binding name. */
  defaultKey?: string;
}

export interface ExecuteOptions {
  /** Per-call override of the per-attempt timeout (REST call or target `timeoutMs`). */
  perAttemptMs?: number;
}

interface CallKeys {
  breaker: string;
  limiter: string;
}

interface CallState {
  attempts: number;
  lastClass?: FailureClass;
}

const defaultRandom = (maxExclusive: number): number => randomInt(maxExclusive);

/**
 * Runs one call under a resolved plan, composing the primitives in the fixed order of RS-02:
 * fallback > deadline > bulkhead > retry > breaker > rateLimit > per-attempt timeout > call.
 * Stateful primitives (breakers, bulkhead, buckets) live in the executor, so one executor is
 * created per edge and binding and reused for every call.
 */
export class ResilienceExecutor<T = unknown> {
  private readonly clock: ResilienceClock;
  private readonly random: (maxExclusive: number) => number;
  private readonly observer: ResilienceObserver;
  private readonly breakers?: CircuitBreakers;
  private readonly bulkhead?: Bulkhead;
  private readonly limiter?: RateLimiter;
  private readonly labels: Record<string, string>;
  readonly defaultKey: string;

  constructor(
    readonly plan: ResiliencePlan,
    private readonly adapter: ResilienceEdgeAdapter,
    private readonly deps: ResilienceDeps = {},
  ) {
    this.clock = deps.clock ?? systemResilienceClock;
    this.random = deps.random ?? defaultRandom;
    this.observer = deps.observer ?? new ResilienceObserver({ clock: this.clock });
    this.defaultKey = deps.defaultKey ?? plan.binding;
    this.labels = { edge: plan.edge, binding: plan.binding };
    if (plan.circuitBreaker !== undefined) {
      const shared =
        plan.circuitBreaker.state === undefined
          ? undefined
          : {
              switch: this.stateSwitch(),
              stateKey: (key: string) => this.stateKey('breaker', key),
            };
      this.breakers = new CircuitBreakers(
        plan.circuitBreaker,
        this.clock,
        {
          transition: (type, key) => this.onTransition(type, key),
          capacity: () => this.onCapacity(),
        },
        shared,
      );
    }
    if (plan.bulkhead !== undefined) this.bulkhead = new Bulkhead(plan.bulkhead, this.clock);
    if (plan.rateLimit !== undefined) {
      const shared =
        plan.rateLimit.state === undefined
          ? undefined
          : {
              switch: this.stateSwitch(),
              stateKey: (key: string) => this.stateKey('ratelimit', key),
            };
      this.limiter = new RateLimiter(plan.rateLimit, this.clock, shared);
    }
  }

  get binding(): string {
    return this.plan.binding;
  }

  breakerState(
    key?: string,
  ): { state: 'closed' | 'open' | 'half-open'; forcedBy?: 'quota' } | undefined {
    return this.breakers?.stateOf(key ?? this.defaultKey);
  }

  /** Closes the breaker of `key` and clears its shared markers; emits `breaker.closed` (RS-49). */
  async resetBreaker(key?: string): Promise<void> {
    if (this.breakers === undefined) return;
    await this.breakers.reset(key ?? this.defaultKey);
  }

  /** Size of the local breaker and bucket maps (I11). */
  get stateSizes(): { breakers: number; buckets: number } {
    return { breakers: this.breakers?.size ?? 0, buckets: this.limiter?.bucketCount ?? 0 };
  }

  async execute(
    input: Omit<ResilienceContext, 'attempt'>,
    run: (attempt: ResilienceAttempt) => Promise<T>,
    options: ExecuteOptions = {},
  ): Promise<ResilienceResult<T>> {
    const started = this.clock.monotonic();
    const ctx: ResilienceContext = { ...input, attempt: 0 };
    if (this.plan.empty && options.perAttemptMs === undefined) {
      const budgetOut = this.incomingBudget(ctx);
      const value = await run({ attempt: 1, signal: undefined, timeoutMs: 0, budgetOut });
      return { value, attempts: 1, fallback: false, durationMs: this.clock.monotonic() - started };
    }
    this.assertIdempotencyKey(ctx);
    const keys = this.resolveKeys(ctx);
    const deadlineAt =
      this.plan.deadlineMs === undefined ? Infinity : started + this.plan.deadlineMs;
    const state: CallState = { attempts: 0 };
    try {
      const value = await this.withBulkhead(ctx, deadlineAt, state, () =>
        this.retryLoop(ctx, keys, deadlineAt, state, run, options),
      );
      this.finish('success', started);
      return {
        value,
        attempts: state.attempts,
        fallback: false,
        durationMs: this.clock.monotonic() - started,
      };
    } catch (error) {
      return this.recover(error, ctx, state, started);
    }
  }

  // ---------- Keys and preconditions ----------

  private assertIdempotencyKey(ctx: ResilienceContext): void {
    if (this.plan.retry?.requireIdempotencyKey !== true) return;
    if (this.adapter.safe?.(ctx) === true) return;
    if (this.adapter.idempotencyKey?.(ctx) !== undefined) return;
    throw this.keyError('idempotency-key-required');
  }

  private keyError(reason: ResilienceKeyErrorReason, cause?: unknown): ResilienceKeyError {
    return new ResilienceKeyError({
      binding: this.plan.binding,
      edge: this.plan.edge,
      reason,
      cause,
    });
  }

  private resolveKeys(ctx: ResilienceContext): CallKeys {
    const fallbackKey = this.adapter.defaultKey?.(ctx) ?? this.defaultKey;
    const breaker = this.keyOf(
      this.plan.circuitBreaker?.key,
      ctx,
      fallbackKey,
      this.plan.circuitBreaker?.state,
    );
    const limiter = this.keyOf(
      this.plan.rateLimit?.key,
      ctx,
      fallbackKey,
      this.plan.rateLimit?.state,
    );
    return { breaker, limiter };
  }

  /** RS-20, RS-43: a custom key is validated, and hashed and labelled before any attempt. */
  private keyOf(
    fn: ((ctx: ResilienceContext) => string) | undefined,
    ctx: ResilienceContext,
    fallbackKey: string,
    shared: unknown,
  ): string {
    if (fn === undefined) return fallbackKey;
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
  private labelOf(key: string, ctx: ResilienceContext, strict: boolean): string | undefined {
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

  /** `estela:rs:<kind>:<binding>` for the default key, `...:<keyHasher(key)>` for a custom one. */
  private stateKey(kind: 'breaker' | 'ratelimit', key: string): string {
    const base = `estela:rs:${kind}:${this.plan.binding}`;
    if (key === this.plan.binding) return base;
    if (key === this.defaultKey) return `${base}:${key}`;
    return `${base}:${this.hashKey(key)}`;
  }

  private stateSwitch(): StateSwitch {
    return new StateSwitch(
      this.clock,
      this.deps.stateTimeoutMs ?? 100,
      this.deps.stateProbeMs ?? 5000,
      {
        onDegraded: () => {
          this.emit({ type: 'state.degraded' });
          this.observer.logger.warn(
            `resilience state degraded for ${this.where()}; using local state`,
          );
          this.observer.gauge('estela_resilience_state_degraded', this.labels, 1);
        },
        onRecovered: () => {
          this.emit({ type: 'state.recovered' });
          this.observer.logger.log(`resilience state recovered for ${this.where()}`);
          this.observer.gauge('estela_resilience_state_degraded', this.labels, 0);
        },
      },
    );
  }

  // ---------- Budget ----------

  private incomingBudget(ctx: ResilienceContext): number | undefined {
    const budget = this.deps.budget;
    if (budget?.enabled !== true) return undefined;
    const raw = ctx.message?.headers[RETRY_BUDGET_MESSAGE_HEADER];
    if (raw !== undefined) {
      const parsed = parseRetryBudgetValue(raw);
      if (parsed.invalid) {
        this.observer.counter('estela_resilience_budget_invalid_total', { edge: this.plan.edge });
      }
      if (parsed.budget !== undefined) return parsed.budget;
    }
    return ResilienceScope.current()?.budget ?? budget.initial;
  }

  // ---------- Composition ----------

  private async withBulkhead<R>(
    ctx: ResilienceContext,
    deadlineAt: number,
    state: CallState,
    fn: () => Promise<R>,
  ): Promise<R> {
    if (this.bulkhead === undefined) return fn();
    const slot = await this.bulkhead.acquire(deadlineAt);
    if (typeof slot !== 'function') {
      if (slot.reason === 'queue-timeout' && slot.byDeadline)
        throw this.deadline(ctx, state.attempts, undefined);
      this.emit({ type: 'bulkhead.rejected', reason: 'bulkhead-full' }, ctx);
      throw new BulkheadFullError({ ...this.meta(state.attempts), reason: slot.reason });
    }
    try {
      return await fn();
    } finally {
      slot();
    }
  }

  private async retryLoop(
    ctx: ResilienceContext,
    keys: CallKeys,
    deadlineAt: number,
    state: CallState,
    run: (attempt: ResilienceAttempt) => Promise<T>,
    options: ExecuteOptions,
  ): Promise<T> {
    const { retries, budgetOut } = this.retriesOf(ctx);
    const perAttempt = options.perAttemptMs ?? this.plan.perAttemptMs;
    const limit = perAttempt > 0 ? perAttempt : Infinity;
    let lastError: unknown;
    for (let attempt = 1; ; attempt += 1) {
      state.attempts = attempt;
      const actx: ResilienceContext = { ...ctx, attempt };
      const admission = await this.admit(actx, keys, deadlineAt, lastError);
      const remaining = deadlineAt - this.clock.monotonic();
      if (remaining <= 0) {
        this.breakers?.release(admission);
        throw this.deadline(actx, attempt - 1, lastError);
      }
      try {
        const value = await this.attempt(actx, Math.min(limit, remaining), budgetOut, run);
        this.breakers?.success(admission);
        this.observer.counter('estela_resilience_attempts_total', {
          ...this.labels,
          class: 'success',
        });
        return value;
      } catch (raw) {
        const cut = raw instanceof AttemptTimeout && remaining < limit;
        lastError = raw instanceof AttemptTimeout ? raw.error : raw;
        const failure = { error: lastError, cut, admission, retries, deadlineAt };
        await this.backoffOrThrow(actx, state, failure);
      }
    }
  }

  /** Records a failed attempt, then sleeps before the next one or throws the final error. */
  private async backoffOrThrow(
    ctx: ResilienceContext,
    state: CallState,
    failure: {
      error: unknown;
      cut: boolean;
      admission: Admission;
      retries: number;
      deadlineAt: number;
    },
  ): Promise<void> {
    const { error, admission } = failure;
    if (failure.cut) {
      this.breakers?.release(admission);
      throw this.deadline(ctx, ctx.attempt, error);
    }
    const verdict = await this.afterFailure(error, ctx, admission, state);
    const delay = await this.retryDelay(error, verdict, ctx, failure.retries, failure.deadlineAt);
    if (delay === undefined) throw error;
    this.emit({ type: 'retry', class: verdict.class, attempt: ctx.attempt, delayMs: delay }, ctx);
    this.observer.counter('estela_resilience_retries_total', this.labels);
    this.observer.logger.debug(`retry ${ctx.attempt} of ${this.where()} in ${delay}ms`);
    await this.clock.sleep(delay);
  }

  /** RS-30: effective retries `min(maxAttempts - 1, budget)` and the budget sent downstream. */
  private retriesOf(ctx: ResilienceContext): { retries: number; budgetOut: number | undefined } {
    const retry = this.plan.retry;
    if (retry === undefined) return { retries: 0, budgetOut: this.incomingBudget(ctx) };
    const max = retry.maxAttempts;
    const repeatable = retry.idempotent || this.adapter.repeatable(ctx);
    if (retry.legacy !== undefined)
      return { retries: repeatable ? max - 1 : 0, budgetOut: undefined };
    const budgetIn = this.incomingBudget(ctx);
    const retries = repeatable ? Math.min(max - 1, budgetIn ?? Infinity) : 0;
    if (max > 1 && retries === 0) this.emit({ type: 'retry.suppressed' }, ctx);
    return { retries, budgetOut: this.claims(retries, retry.propagate) ? 0 : budgetIn };
  }

  /** A retrying layer under an enabled budget sends budget 0 downstream (RS-30). */
  private claims(retries: number, propagate: 'claim' | 'forward'): boolean {
    return retries > 0 && propagate === 'claim' && this.deps.budget?.enabled === true;
  }

  /** Breaker admission, then a rate-limit token, for every attempt (I1). */
  private async admit(
    ctx: ResilienceContext,
    keys: CallKeys,
    deadlineAt: number,
    lastError: unknown,
  ): Promise<Admission> {
    let admission: Admission = { key: keys.breaker, probe: false };
    if (this.breakers !== undefined) {
      const result = await this.breakers.admit(keys.breaker, deadlineAt);
      if (!result.admitted) {
        this.observer.counter('estela_resilience_rejected_total', {
          ...this.labels,
          reason: 'circuit-open',
        });
        const meta = { ...this.meta(ctx.attempt - 1), cause: lastError };
        throw new CircuitOpenError({
          ...meta,
          ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
          ...(result.forcedBy === undefined ? {} : { forcedBy: result.forcedBy }),
        });
      }
      admission = result.admission;
    }
    if (this.limiter === undefined) return admission;
    const outcome = await this.limiter.take(keys.limiter, deadlineAt);
    if (outcome.granted) return admission;
    this.breakers?.release(admission);
    if (outcome.byDeadline) throw this.deadline(ctx, ctx.attempt - 1, lastError);
    this.emit({ type: 'ratelimit.rejected', reason: 'rate-limited' }, ctx);
    this.observer.counter('estela_resilience_rejected_total', {
      ...this.labels,
      reason: 'rate-limited',
    });
    throw new RateLimitedError({
      ...this.meta(ctx.attempt - 1),
      cause: lastError,
      retryAfterMs: outcome.retryAfterMs,
    });
  }

  private attempt(
    ctx: ResilienceContext,
    timeoutMs: number,
    budgetOut: number | undefined,
    run: (attempt: ResilienceAttempt) => Promise<T>,
  ): Promise<T> {
    this.adapter.outgoingBudget?.(budgetOut);
    const scoped = { ...(budgetOut === undefined ? {} : { budget: budgetOut }) };
    return withAttemptTimeout(
      this.clock,
      timeoutMs,
      (signal) =>
        ResilienceScope.run({ ...scoped, ...(signal === undefined ? {} : { signal }) }, () =>
          run({
            attempt: ctx.attempt,
            signal,
            timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 0,
            budgetOut,
          }),
        ),
      () => this.adapter.timeoutError(ctx, timeoutMs),
    );
  }

  /** Classifies the failure and records it: quota forces the breaker open (RS-16). */
  private async afterFailure(
    error: unknown,
    ctx: ResilienceContext,
    admission: Admission,
    state: CallState,
  ): Promise<Classification> {
    const verdict = await this.classify(error, ctx);
    state.lastClass = verdict.class;
    this.observer.counter('estela_resilience_attempts_total', {
      ...this.labels,
      class: verdict.class,
    });
    if (verdict.class === 'quota') {
      this.breakers?.forceOpen(admission);
      this.emit({ type: 'quota.exhausted', class: 'quota' }, ctx);
      return verdict;
    }
    if (this.plan.circuitBreaker?.recordOn.has(verdict.class) === true)
      this.breakers?.failure(admission);
    else this.breakers?.release(admission);
    return verdict;
  }

  /** RS-08, RS-11: the delay before the next attempt, or undefined when the failure is final. */
  private async retryDelay(
    error: unknown,
    verdict: Classification,
    ctx: ResilienceContext,
    retries: number,
    deadlineAt: number,
  ): Promise<number | undefined> {
    const retry = this.plan.retry;
    if (retry === undefined || ctx.attempt > retries || verdict.class === 'quota') return undefined;
    if (retry.legacy !== undefined) {
      if (!(await retry.legacy.retryOn(error, ctx))) return undefined;
    } else if (!retry.retryOn.has(verdict.class)) {
      return undefined;
    }
    let delay = retry.delay(ctx.attempt, error, this.random);
    if (retry.honorRetryAfter && verdict.retryAfterMs !== undefined) {
      if (verdict.retryAfterMs > retry.maxRetryAfterMs) return undefined;
      delay = Math.max(delay, verdict.retryAfterMs);
    }
    if (this.clock.monotonic() + delay >= deadlineAt) throw this.deadline(ctx, ctx.attempt, error);
    return delay;
  }

  /** RS-13: app classifiers first (first defined wins), then the edge default, then 'unknown'. */
  private classify(error: unknown, ctx: ResilienceContext): Promise<Classification> {
    for (const fn of this.plan.classify) {
      let result: unknown;
      try {
        result = fn(error, ctx);
      } catch {
        this.observer.errorOnce(
          `classify:${this.plan.binding}`,
          `resilience classifier of ${this.where()} threw; class unknown`,
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

  // ---------- Fallback and outcome ----------

  private async recover(
    error: unknown,
    ctx: ResilienceContext,
    state: CallState,
    started: number,
  ): Promise<ResilienceResult<T>> {
    const fallback = this.plan.fallback;
    const trigger = fallbackTrigger(error, state.lastClass);
    if (fallback === undefined || trigger === undefined || !fallback.on.has(trigger)) {
      this.finish(error instanceof ResilienceError ? 'rejected' : 'failure', started);
      throw error;
    }
    const fctx: ResilienceContext = { ...ctx, attempt: state.attempts };
    try {
      const value = (await runFallback(
        fallback,
        error,
        fctx,
        this.deps.fallbackChannel,
        state.attempts,
      )) as T;
      this.emit({ type: 'fallback.used', ...classOrReason(trigger) }, fctx);
      if (!fallback.cacheable) ResilienceScope.markDegraded();
      this.finish('fallback', started);
      return {
        value,
        attempts: state.attempts,
        fallback: true,
        durationMs: this.clock.monotonic() - started,
      };
    } catch (failed) {
      this.emit({ type: 'fallback.failed', ...classOrReason(trigger) }, fctx);
      this.finish('failure', started);
      throw failed;
    }
  }

  private deadline(
    ctx: ResilienceContext,
    attempts: number,
    cause: unknown,
  ): DeadlineExceededError {
    this.emit({ type: 'deadline.exceeded', reason: 'deadline' }, ctx);
    this.observer.counter('estela_resilience_rejected_total', {
      ...this.labels,
      reason: 'deadline',
    });
    return new DeadlineExceededError({
      ...this.meta(attempts),
      cause,
      deadlineMs: this.plan.deadlineMs ?? 0,
    });
  }

  private finish(outcome: 'success' | 'failure' | 'fallback' | 'rejected', started: number): void {
    const labels = { ...this.labels, outcome };
    this.observer.counter('estela_resilience_calls_total', labels);
    this.observer.histogram(
      'estela_resilience_call_seconds',
      labels,
      (this.clock.monotonic() - started) / 1000,
    );
  }

  // ---------- Events ----------

  private meta(attempts: number): { binding: string; edge: ResilienceEdgeKind; attempts: number } {
    return { binding: this.plan.binding, edge: this.plan.edge, attempts };
  }

  private where(): string {
    return `${this.plan.edge.replace(/-/g, ' ')} '${this.plan.binding}'`;
  }

  private emit(
    event: Omit<ResilienceEvent, 'at' | 'edge' | 'binding'>,
    ctx?: ResilienceContext,
    key?: string,
  ): void {
    const full: Omit<ResilienceEvent, 'at'> = {
      ...event,
      edge: this.plan.edge,
      binding: this.plan.binding,
    };
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
    const ctx: ResilienceContext = { edge: this.plan.edge, binding: this.plan.binding, attempt: 0 };
    this.emit({ type }, ctx, key);
    if (type === 'breaker.open' || type === 'breaker.forced-open') {
      this.observer.logger.warn(`${type} for ${this.where()}`);
    } else if (type === 'breaker.closed') {
      this.observer.logger.log(`breaker.closed for ${this.where()}`);
    } else {
      this.observer.logger.debug(`${type} for ${this.where()}`);
    }
    this.observer.gauge(
      'estela_resilience_breakers_open',
      this.labels,
      this.breakers?.openCount ?? 0,
    );
  }

  private onCapacity(): void {
    if (this.observer.allowed(`capacity:${this.plan.binding}`))
      this.emit({ type: 'breaker.capacity' });
  }
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
  if (typeof value.retryAfterMs === 'number' && value.retryAfterMs >= 0)
    out.retryAfterMs = value.retryAfterMs;
  return out;
}

function classOrReason(trigger: string): Pick<ResilienceEvent, 'class' | 'reason'> {
  return FAILURE_CLASSES.includes(trigger as FailureClass)
    ? { class: trigger as FailureClass }
    : { reason: trigger as ResilienceEvent['reason'] & string };
}
