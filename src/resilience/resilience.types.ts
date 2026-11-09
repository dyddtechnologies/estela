import type { IntegrationMessage } from '../message';
import type { JitterMode } from './backoff';

export type FailureClass = 'transient' | 'throttled' | 'rejected' | 'quota' | 'unknown';
export type RejectionKind = 'circuit-open' | 'bulkhead-full' | 'rate-limited' | 'deadline';
export type FallbackTrigger = FailureClass | RejectionKind;
export type ResilienceEdgeKind =
  | 'outbound-rest'
  | 'outbound-grpc'
  | 'outbound-sdk'
  | 'activator'
  | 'inbound'
  | 'saga-outbound'
  | 'flow-handle'
  | 'flow-jump'
  | 'flow-send';

export interface Classification {
  class: FailureClass;
  /** From Retry-After or grpc-retry-pushback-ms; >= 0. */
  retryAfterMs?: number;
}

export interface ResilienceContext {
  edge: ResilienceEdgeKind;
  /** Binding name, activator scope, inbound channel, `<saga>:<step>` or a flow edge name. */
  binding: string;
  channel?: string;
  message?: IntegrationMessage;
  /** 1-based attempt; 0 while keys are resolved before the first attempt. */
  attempt: number;
  /** Edge data (REST: the OutboundExchangeContext of the attempt). Never logged. */
  data?: unknown;
}

export type ResilienceClassifierFn = {
  bivarianceHack(error: unknown, ctx: ResilienceContext): FailureClass | Classification | undefined;
}['bivarianceHack'];

export type ResilienceKeyFn = (ctx: ResilienceContext) => string;

export interface TimeoutPolicy {
  /** Integer ms, 0..2147483647; 0 = no per-attempt timeout. */
  perAttemptMs?: number;
  /** Integer ms, 1..2147483647; whole call including queue waits, retries and backoff. */
  deadlineMs?: number;
}

export interface BackoffPolicy {
  initialMs?: number;
  factor?: number;
  maxMs?: number;
  jitter?: JitterMode;
}
export type BackoffFn = (attempt: number, error: unknown) => number;

export interface RetryPolicyOptions {
  /** Default true; not inherited (same rule as the outbound `layer()`). */
  enabled?: boolean;
  /** TOTAL attempts including the first; integer 1..20; default 3. */
  maxAttempts?: number;
  backoff?: number | BackoffPolicy | BackoffFn;
  /** Default ['transient', 'throttled']. 'quota' is refused here (RS-16). */
  retryOn?: readonly Exclude<FailureClass, 'quota'>[];
  /** Default true under `resilience`; false for the legacy alias. */
  honorRetryAfter?: boolean;
  /** Default backoff.maxMs. A longer Retry-After makes the failure final. */
  maxRetryAfterMs?: number;
  /** Declares the operation safe to repeat without an idempotency key. Default false. */
  idempotent?: boolean;
  /** 'claim' (default): downstream gets budget 0. 'forward': downstream gets the incoming budget. */
  propagate?: 'claim' | 'forward';
  /** RS-48: a non-safe operation without an idempotency key fails before any attempt. Default false. */
  requireIdempotencyKey?: boolean;
}

export interface CircuitBreakerPolicy {
  enabled?: boolean;
  /** Default: the binding name (flow edges: the target channel). Non-empty, <= 200 code units. */
  key?: ResilienceKeyFn;
  /** Percent, 1..100; default 50. */
  failureRateThreshold?: number;
  /** Integer >= 1; default 10. */
  minimumCalls?: number;
  /** Default { type: 'count', size: 20 }. */
  window?: { type: 'count'; size: number } | { type: 'time'; sizeMs: number };
  /** Integer ms >= 1; default 30000. */
  openMs?: number;
  /** Integer >= 1; default 1. */
  halfOpenCalls?: number;
  /** Default ['transient']. 'quota' always forces open and need not be listed. */
  recordOn?: readonly FailureClass[];
  /** Default openMs. 'manual': open until ResilienceRegistry.resetBreaker (RS-16, RS-49). */
  quotaOpenMs?: number | 'manual';
  /** Integer >= 1; default 1000. */
  maxKeys?: number;
  /** Default 'local'. */
  state?: 'local' | ResilienceStatePort;
  /** How long a shared open marker is cached locally; default 1000. */
  syncMs?: number;
}

export interface BulkheadPolicy {
  enabled?: boolean;
  /** Integer >= 1. */
  maxConcurrent: number;
  /** Integer >= 0; default 0. */
  maxQueue?: number;
  /** Integer ms >= 1; default: the remaining deadline, else no limit. */
  queueTimeoutMs?: number;
}

export interface RateLimitPolicy {
  enabled?: boolean;
  /** Finite > 0 (fractions allowed: 0.5 = one per 2 s). */
  limitPerSec: number;
  /** Integer >= 1; default ceil(limitPerSec). */
  burst?: number;
  key?: ResilienceKeyFn;
  /** Integer ms >= 0; default 0 (reject at once). */
  maxWaitMs?: number;
  state?: 'local' | ResilienceStatePort;
  /** Finite > 0; default limitPerSec / replicasHint. Never unlimited (D-REDIS-DOWN). */
  degradedLimitPerSec?: number;
  /** Integer >= 1; default 1000. LRU bound of local buckets (RS-22). */
  maxKeys?: number;
  /** Integer >= 1; default 1. Expected replicas sharing the limit. */
  replicasHint?: number;
}

export interface FallbackPolicy<R = unknown> {
  enabled?: boolean;
  /** Exactly one of value | channel. */
  value?: (error: unknown, ctx: ResilienceContext) => R | Promise<R>;
  /** Request/reply on this channel with the same message; flow send steps re-send it instead. */
  channel?: string;
  /** Default ['transient','throttled','circuit-open','bulkhead-full','rate-limited','deadline']. */
  on?: readonly FallbackTrigger[];
  /** Default false: a fallback result is never stored as an idempotent result (RS-27). */
  cacheable?: boolean;
}

export interface ResiliencePolicy {
  classify?: ResilienceClassifierFn | readonly ResilienceClassifierFn[];
  timeout?: false | TimeoutPolicy;
  retry?: false | RetryPolicyOptions;
  circuitBreaker?: false | CircuitBreakerPolicy;
  bulkhead?: false | BulkheadPolicy;
  rateLimit?: false | RateLimitPolicy;
  fallback?: false | FallbackPolicy;
}

/** Profile names: `^[a-z0-9][a-z0-9._-]{0,63}$` (RS-53). */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- names the profile grammar in the public API
export type ProfileName = string;

/** RS-53: a reusable profile; `extends` is single inheritance resolved at boot. */
export interface NamedResiliencePolicy extends ResiliencePolicy {
  extends?: ProfileName;
}

/**
 * RS-51, RS-52: a profile name, an inline policy, a name with inline fields deep-merged over it
 * (`{ use, ...inline }`), or `false` (no policy at this level and below).
 */
export type ResiliencePolicyRef<P = ResiliencePolicy> =
  ProfileName | (P & { use?: ProfileName }) | false;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- shared flow parameter model name
export type ResilienceRef = ResiliencePolicyRef;
export type InboundResilienceRef = ResiliencePolicyRef<InboundResiliencePolicy>;

/** Inbound accepts load shedding only (RS-37). */
export type InboundResiliencePolicy = Pick<ResiliencePolicy, 'bulkhead'> & {
  rateLimit?:
    false | (Omit<RateLimitPolicy, 'key'> & { key?: (ctx: InboundShedContext) => string });
};

export interface InboundShedContext {
  channel: string;
  transport: string;
  /** Raw transport headers; read tenant or route from here or from the guard's request user. */
  rawHeaders: Record<string, unknown>;
  /** Nest ExecutionContext, typed as unknown to keep src/resilience free of @nestjs imports. */
  execution: unknown;
}

export type ResilienceEventType =
  | 'retry'
  | 'retry.suppressed'
  | 'breaker.open'
  | 'breaker.half-open'
  | 'breaker.closed'
  | 'breaker.forced-open'
  | 'breaker.capacity'
  | 'bulkhead.rejected'
  | 'ratelimit.rejected'
  | 'deadline.exceeded'
  | 'fallback.used'
  | 'fallback.failed'
  | 'quota.exhausted'
  | 'state.degraded'
  | 'state.recovered';

export interface ResilienceEvent {
  type: ResilienceEventType;
  edge: ResilienceEdgeKind;
  binding: string;
  /** RS-66: the target channel of a flow send or jump edge; absent elsewhere. */
  channel?: string;
  /** keyLabel(key) when configured; never the raw key (RS-43). */
  keyLabel?: string;
  class?: FailureClass;
  reason?: RejectionKind | 'queue-timeout';
  attempt?: number;
  delayMs?: number;
  /** Wall-clock ms. */
  at: number;
  traceId?: string;
  correlationId?: string;
}

export interface ResilienceMetricsPort {
  counter(name: string, labels: Record<string, string>, value?: number): void;
  histogram(name: string, labels: Record<string, string>, value: number): void;
  gauge(name: string, labels: Record<string, string>, value: number): void;
}

export interface ResilienceTimer {
  cancel(): void;
}

export interface ResilienceClock {
  /** Monotonic ms (default performance.now). */
  monotonic(): number;
  /** Wall ms (default Date.now), for events and shared open markers only. */
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimer(ms: number, fn: () => void): ResilienceTimer;
}

/** Engine log sink; the module wires Nest `Logger('EstelaResilience')` (RS-45). */
export interface ResilienceLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** forRoot({ resilience }) */
export interface ResilienceModuleOptions {
  events?: { channel?: string | false; onEvent?: (event: ResilienceEvent) => void };
  metrics?: ResilienceMetricsPort;
  /** Label of a custom key in events; omitted when absent. Never the raw key (RS-43, D-PHONE). */
  keyLabel?: (key: string, ctx: ResilienceContext) => string | undefined;
  /**
   * Keyed digest (HMAC) of a custom key in state-port keys. Required with a custom key and a
   * shared state port; there is no unsalted fallback (RS-43).
   */
  keyHasher?: (key: string) => string;
  retryBudget?: { header?: string; initial?: number };
  /** RS-53: named reusable profiles, referenced by name anywhere a policy is accepted. */
  policies?: Readonly<Record<ProfileName, NamedResiliencePolicy>>;
  /** RS-54: L1 defaults per edge kind; a profile name or an inline policy. `inbound` is refused. */
  defaults?: Partial<Record<ResilienceEdgeKind, ResiliencePolicyRef>>;
  /** Default 100 (provisional until SPI-444). */
  stateTimeoutMs?: number;
  /** Default 5000. */
  stateProbeMs?: number;
  clock?: ResilienceClock;
  /** Test seam; default node:crypto randomInt. */
  random?: (maxExclusive: number) => number;
  /** Log sink; default the module's Nest logger, or nothing outside the module. */
  logger?: ResilienceLogger;
}

/** Shared state for rate limiters and breakers (RS-23). */
export interface ResilienceStatePort {
  /** Atomic token bucket take; returns granted and ms until the next token. */
  takeToken(
    key: string,
    limitPerSec: number,
    burst: number,
  ): Promise<{ granted: boolean; retryAfterMs: number }>;
  /** Shared open marker (RS-23); `untilMs` is wall-clock time. */
  markOpen(key: string, untilMs: number): Promise<void>;
  openUntil(key: string): Promise<number | undefined>;
  /** Half-open probe lease; true for exactly one caller per lease period. */
  tryProbeLease(key: string, leaseMs: number): Promise<boolean>;
  clearOpen(key: string): Promise<void>;
}
