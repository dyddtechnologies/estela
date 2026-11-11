import type { IntegrationMessage } from '../message';

export type FailureClass = 'transient' | 'busy' | 'rejected' | 'quota' | 'unknown';
/** Why Estela refused or stopped a call. */
export type TurnedAwayKind = 'valve-shut' | 'lanes-full' | 'over-pace' | 'out-of-time';
export type PlanBTrigger = FailureClass | TurnedAwayKind;
/** Random spread of the gap between tries, so callers do not line up. */
export type SpreadMode = 'full' | 'half' | 'none';
export type CareEdge =
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
  /** When the other side says it can take calls again, in ms; >= 0. */
  readyInMs?: number;
}

export interface CareContext {
  edge: CareEdge;
  /** Binding name, activator scope, inbound channel, `<saga>:<step>` or a flow edge name. */
  binding: string;
  channel?: string;
  message?: IntegrationMessage;
  /** 1-based try number; 0 while keys are resolved before the first try. */
  tryNumber: number;
  /** Edge data (REST: the OutboundExchangeContext of the try). Never logged. */
  data?: unknown;
}

/** Your hook that names the kind of a failure; `undefined` defers to the next one. */
export type CareClassifierFn = {
  bivarianceHack(error: unknown, ctx: CareContext): FailureClass | Classification | undefined;
}['bivarianceHack'];

/** Splits valve or pace state per tenant, account or number. */
export type CareKeyFn = (ctx: CareContext) => string;

/** How long Estela waits. */
export interface Patience {
  /** Longest wait for one try, integer ms 0..2147483647; 0 = no limit. */
  eachTryMs?: number;
  /** Longest whole call, integer ms 1..2147483647: waiting turns, every try and the gaps. */
  totalMs?: number;
}

/** Gap between tries. */
export interface Spacing {
  /** First gap, ms; default 200. */
  firstMs?: number;
  /** Growth per try, >= 1; default 2. */
  growth?: number;
  /** Largest gap, ms; default 10000. */
  capMs?: number;
  /** Default 'full'. */
  spread?: SpreadMode;
}
export type SpacingFn = (tryNumber: number, error: unknown) => number;

/** Trying again after a failure. */
export interface Tries {
  /** Default true; `false` turns this part off at this level. */
  enabled?: boolean;
  /** Total tries, counting the first; integer 1..20; default 3. */
  max?: number;
  spacing?: number | Spacing | SpacingFn;
  /** Kinds worth another try; default ['transient', 'busy']. 'quota' is refused (RS-16). */
  on?: readonly Exclude<FailureClass, 'quota'>[];
  /** Wait as long as the other side asks; default true. */
  heedServerWait?: boolean;
  /** A longer requested wait ends the call; default `spacing.capMs`. */
  maxServerWaitMs?: number;
  /** Safe to repeat without an idempotency key. Default false. */
  idempotent?: boolean;
  /**
   * 'keep' (default): this edge spends the extra tries and sends 0 downstream.
   * 'forward': downstream gets the incoming tries left.
   */
  triesLeft?: 'keep' | 'forward';
  /** RS-48: a non-safe call without an idempotency key fails before the first try. */
  requireIdempotencyKey?: boolean;
}

/** What a valve does when a call fails with the 'quota' class (RS-16). */
export enum OnQuota {
  /** Shut for `shutMs`, then let probes through, like any other shut. Default. */
  ShutLikeFailure = 'shut-like-failure',
  /** Shut for `quotaShutMs`, then let probes through. */
  ShutFor = 'shut-for',
  /** Stay shut, with no probes, until `CareControl.resume` is called (RS-49). */
  ShutUntilResumed = 'shut-until-resumed',
}

/** Shuts traffic to a dependency that keeps failing, then lets probes through. */
export interface Valve {
  enabled?: boolean;
  /** Default: the binding name (flow edges: the target channel). Non-empty, <= 200 code units. */
  key?: CareKeyFn;
  /** Failure percent that shuts the valve, 1..100; default 50. */
  failPercent?: number;
  /** Calls to see before judging, integer >= 1; default 10. */
  minCalls?: number;
  /** Which recent calls are judged; default { lastCalls: 20 }. */
  lookBack?: { lastCalls: number } | { lastMs: number };
  /** How long the valve stays shut, integer ms >= 1; default 30000. */
  shutMs?: number;
  /** Trial calls when the shut period ends, integer >= 1; default 1. */
  probes?: number;
  /** Kinds counted as failures; default ['transient']. 'quota' always shuts and need not be listed. */
  countOn?: readonly FailureClass[];
  /** What a 'quota' failure does; default `OnQuota.ShutLikeFailure` (RS-16). */
  onQuota?: OnQuota;
  /** Integer ms >= 1; required with `OnQuota.ShutFor`, refused with any other `onQuota`. */
  quotaShutMs?: number;
  /** Integer >= 1; default 1000. */
  maxKeys?: number;
  /** Default 'local'. */
  state?: 'local' | CareStatePort;
  /** How long a shared "shut" mark is cached locally; default 1000. */
  syncMs?: number;
}

/** How many calls run at the same time. */
export interface Lanes {
  enabled?: boolean;
  /** Number of lanes (calls in flight at once), integer >= 1. */
  count: number;
  /** Calls that may wait for a free lane, integer >= 0; default 0. */
  waitlist?: number;
  /** Longest wait on the waitlist, integer ms >= 1; default: the remaining totalMs, else no limit. */
  waitlistMs?: number;
}

/** How many calls start per second. */
export interface Pace {
  enabled?: boolean;
  /** Steady rate, finite > 0 (fractions allowed: 0.5 = one every 2 s). */
  perSecond: number;
  /** Calls allowed back to back, integer >= 1; default ceil(perSecond). */
  burst?: number;
  key?: CareKeyFn;
  /** Longest wait for a turn, integer ms >= 0; default 0 (refuse at once). */
  waitMs?: number;
  state?: 'local' | CareStatePort;
  /** Per-pod rate while shared state is lost, finite > 0; default perSecond / replicas. Never unlimited. */
  soloPerSecond?: number;
  /** Integer >= 1; default 1000. LRU bound of local turns (RS-22). */
  maxKeys?: number;
  /** Pods that share perSecond, integer >= 1; default 1. */
  replicas?: number;
}

/** How plan B uses its `channel`. */
export enum PlanBMode {
  /** Request/reply on the channel: its answer is the plan B answer. Default. */
  Ask = 'ask',
  /**
   * Leave the message on the channel and go on, without waiting for an answer: the call counts
   * as handled by plan B, and `value`, when set, is what the caller gets.
   */
  Leave = 'leave',
}

/** What answers when the call still fails. */
export interface PlanB<R = unknown> {
  enabled?: boolean;
  /**
   * Exactly one of value | channel, except with `mode: PlanBMode.Leave`, where `value` is the
   * answer given after the message is left on the channel.
   */
  value?: (error: unknown, ctx: CareContext) => R | Promise<R>;
  /** Request/reply on this channel with the same message; flow send steps re-send it instead. */
  channel?: string;
  /**
   * How `channel` is used; default `PlanBMode.Ask` (a `to` step: its 0.9.0 re-send). Only with
   * `channel`. `PlanBMode.Leave` refuses `cacheable: true`.
   */
  mode?: PlanBMode;
  /** Default: transient, busy and every TurnedAwayKind. */
  on?: readonly PlanBTrigger[];
  /** Default false: a plan B answer is never stored as the idempotent result (RS-27). */
  cacheable?: boolean;
}

/** One set of care parts; each part is replaced whole by a higher level. */
export interface Care {
  classify?: CareClassifierFn | readonly CareClassifierFn[];
  patience?: false | Patience;
  tries?: false | Tries;
  valve?: false | Valve;
  lanes?: false | Lanes;
  pace?: false | Pace;
  planB?: false | PlanB;
}

/** Profile names: `^[a-z0-9][a-z0-9._-]{0,63}$` (RS-53). */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- names the profile grammar in the public API
export type ProfileName = string;

/** RS-53: a named `Care`; `extends` is single inheritance resolved at boot. */
export interface CareProfile extends Care {
  extends?: ProfileName;
}

/**
 * RS-51, RS-52: a profile name, an inline `Care`, a name with inline fields deep-merged over it
 * (`{ use, ...inline }`), or `false` (nothing at this level and below).
 */
export type CareRefOf<C = Care> = ProfileName | (C & { use?: ProfileName }) | false;
// eslint-disable-next-line sonarjs/redundant-type-aliases -- shared flow parameter model name
export type CareRef = CareRefOf;
export type InboundCareRef = CareRefOf<InboundCare>;

/** Inbound accepts `lanes` and `pace` only (RS-37). */
export type InboundCare = Pick<Care, 'lanes'> & {
  pace?: false | (Omit<Pace, 'key'> & { key?: (ctx: InboundCareContext) => string });
};

/** What an inbound `pace.key` reads. */
export interface InboundCareContext {
  channel: string;
  transport: string;
  /** Raw transport headers; read tenant or route from here or from the guard's request user. */
  rawHeaders: Record<string, unknown>;
  /** Nest ExecutionContext, typed as unknown to keep the care engine free of @nestjs imports. */
  execution: unknown;
}

export type CareEventType =
  | 'try.again'
  | 'try.held'
  | 'valve.shut'
  | 'valve.probing'
  | 'valve.flowing'
  | 'valve.forced-shut'
  | 'valve.keys-full'
  | 'lanes.full'
  | 'pace.over'
  | 'patience.ran-out'
  | 'plan-b.used'
  | 'plan-b.failed'
  | 'quota.used-up'
  | 'shared-state.lost'
  | 'shared-state.back';

export interface CareEvent {
  type: CareEventType;
  edge: CareEdge;
  binding: string;
  /** RS-66: the target channel of a flow send or jump edge; absent elsewhere. */
  channel?: string;
  /** keyLabel(key) when configured; never the raw key (RS-43). */
  keyLabel?: string;
  class?: FailureClass;
  reason?: TurnedAwayKind | 'waitlist-expired';
  tryNumber?: number;
  delayMs?: number;
  /** Wall-clock ms. */
  at: number;
  traceId?: string;
  correlationId?: string;
}

export interface CareMetricsPort {
  counter(name: string, labels: Record<string, string>, value?: number): void;
  histogram(name: string, labels: Record<string, string>, value: number): void;
  gauge(name: string, labels: Record<string, string>, value: number): void;
}

export interface CareTimer {
  cancel(): void;
}

export interface CareClock {
  /** Monotonic ms (default performance.now). */
  monotonic(): number;
  /** Wall ms (default Date.now), for events and shared "shut" marks only. */
  wall(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  setTimer(ms: number, fn: () => void): CareTimer;
}

/** Engine log sink; the module wires Nest `Logger('EstelaCare')` (RS-45). */
export interface CareLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** forRoot({ care }) */
export interface CareModuleOptions {
  /** RS-53: named, reusable care settings, referenced by name anywhere `Care` is accepted. */
  profiles?: Readonly<Record<ProfileName, CareProfile>>;
  /** RS-54: L1 default per edge; a profile name or an inline `Care`. `inbound` is refused. */
  defaults?: Partial<Record<CareEdge, CareRefOf>>;
  /** Default channel 'estela.care.events'; `channel: false` turns the channel off. */
  events?: { channel?: string | false; onEvent?: (event: CareEvent) => void };
  metrics?: CareMetricsPort;
  /** Label of a custom key in events; omitted when absent. Never the raw key (RS-43, D-PHONE). */
  keyLabel?: (key: string, ctx: CareContext) => string | undefined;
  /**
   * Keyed digest (HMAC) of a custom key in state-port keys. Required with a custom key and a
   * shared state port; there is no unsalted alternative (RS-43).
   */
  keyHasher?: (key: string) => string;
  /** Extra tries allowed along one call path; default header 'x-tries-left'. */
  triesLeft?: { header?: string; initial?: number };
  /** Longest wait for the shared state before using local state, ms; default 100. */
  sharedStateWaitMs?: number;
  /** How often lost shared state is checked again, ms; default 5000. */
  sharedStateCheckMs?: number;
  clock?: CareClock;
  /** Test seam; default node:crypto randomInt. */
  random?: (maxExclusive: number) => number;
  /** Log sink; default the module's Nest logger, or nothing outside the module. */
  logger?: CareLogger;
}

/** State of one valve as `CareControl.valveState` reports it. */
export interface ValveStateView {
  state: 'flowing' | 'shut' | 'probing';
  forcedBy?: 'quota';
}

/** Shared state for `pace` and `valve` across pods (RS-23). */
export interface CareStatePort {
  /** Atomic take of one turn; returns granted and ms until the next turn. */
  takeTurn(
    key: string,
    perSecond: number,
    burst: number,
  ): Promise<{ granted: boolean; readyInMs: number }>;
  /** Shared "shut" mark (RS-23); `untilMs` is wall-clock time. */
  markShut(key: string, untilMs: number): Promise<void>;
  shutUntil(key: string): Promise<number | undefined>;
  /** Probe lease; true for exactly one caller per lease period. */
  claimProbe(key: string, leaseMs: number): Promise<boolean>;
  clearShut(key: string): Promise<void>;
}
