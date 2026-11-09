import type { ChannelRegistry } from '../channel-registry';
import type { IntegrationMessage } from '../message';
import type { ResilienceRef } from '../resilience/resilience.types';
import type { TraceContext } from '../trace/trace-context';

/**
 * Command contract of a pipeline step (plan sec.3.4, ADR-009).
 * Domain file: no npm dependencies (enforced by dependency-cruiser).
 */

export type FlowStepKind =
  | 'filter'
  | 'transform'
  | 'handle'
  | 'wireTap'
  | 'fanout'
  | 'jump'
  | 'publish'
  | 'route'
  | 'to'
  | 'reply';

export interface FlowStepContext {
  msg: IntegrationMessage;
  registry: ChannelRegistry; // output port (Mediator)
  trace: TraceContext;
  errorChannel: string;
  flowName: string;
  /** Resolved resilience of this step (RS-55..RS-66); absent = the 0.9.0 code path. */
  policy?: StepPolicyPort;
  /** True once a fallback marked this flow run degraded (RS-64); absent without a runtime. */
  degraded?: () => boolean;
}

/** One attempt as the resilience engine hands it to a step. */
export interface PolicyAttempt {
  attempt: number;
  signal: AbortSignal | undefined;
  /** Effective wait of this attempt in ms; 0 = no per-attempt timeout. */
  timeoutMs: number;
  /** Retry budget to stamp on the hop; undefined = leave the hop as built. */
  budgetOut: number | undefined;
}

/** Resolved policy of one subject: a `handle` step or one send or jump target. */
export interface TargetPolicyPort {
  /** Policy subject, `flow:<flow>#<stepId>` or `flow:<flow>#<stepId>:<channel>`. */
  readonly binding: string;
  /** Runs the attempts; `data` is edge data (the hop of a send target). */
  run<T>(
    msg: IntegrationMessage,
    attempt: (a: PolicyAttempt) => Promise<T>,
    data?: unknown,
  ): Promise<{ value: T; fallback: boolean }>;
}

/**
 * What a step asks of its resolved resilience. The flow layer implements it
 * (`flow-resilience.ts`); the domain only names the shape.
 */
export interface StepPolicyPort {
  /** Policy of one target channel, or undefined when the target has no effective policy. */
  target(channel: string): TargetPolicyPort | undefined;
  /** Policy of a `handle` step, or undefined. */
  readonly handle?: TargetPolicyPort;
}

export type StepOutcome =
  | { action: 'continue'; msg: IntegrationMessage }
  | { action: 'stop'; reason: 'filtered' | 'terminated' }
  | { action: 'fail'; error: unknown };

export interface FlowStep {
  readonly kind: FlowStepKind;
  describe(): Record<string, unknown>;
  execute(ctx: FlowStepContext): Promise<StepOutcome>;
  /** Flow parameters of the step (id, resilience, targets); absent on a step built without any. */
  readonly params?: StepParams | undefined;
}

// ---------- Flow parameter model (minimal scaffolding pending SPI-433, SD-67) ----------

/**
 * Options every step accepts. Only `id` exists here; the sensitive concern (SPI-433) adds its
 * member to this interface.
 */
export interface StepCommonOptions {
  /** Stable step id; default `<kind>#<index>`; unique per flow (DUPLICATE_STEP_ID). */
  id?: string;
}

/** Options of a step that accepts a resilience policy (L4). */
export interface ResilientStepOptions extends StepCommonOptions {
  resilience?: ResilienceRef;
}

/** Options of `jump(channel, opts)`. `timeoutMs` is the legacy alias of `perAttemptMs`. */
export interface JumpOptions {
  wait?: boolean;
  timeoutMs?: number;
  resilience?: ResilienceRef;
  id?: string;
}

/** Flow-level defaults (L3), split by step family (RS-55). */
export interface FlowOptions {
  resilience?: {
    handle?: ResilienceRef;
    jump?: ResilienceRef;
    /** `to`, `publish`, `route` and `fanoutTo`. */
    send?: ResilienceRef;
  };
}

/** Parameters a step carries for the boot resolver (RS-67). */
export interface StepParams {
  /** Explicit id, when the author set one. */
  readonly id?: string;
  /** L4 step policy; on `fanoutTo`/`jumpTo` it applies to every target. */
  readonly resilience?: ResilienceRef;
  /** Static targets; `route` resolves its targets at run time. */
  readonly targets?: readonly FlowTarget[];
}

// ---------- Mixed destinations (spec sec.6.2) ----------

export interface FanoutTargetInput {
  channel: string;
  wait?: boolean; // default true
  timeoutMs?: number; // jump only
}

export type FanoutDest = string | FanoutTargetInput;

/** A target of `fanoutTo` / `jumpTo`; its own policy replaces the step's per primitive. */
export interface FlowTarget extends FanoutTargetInput {
  resilience?: ResilienceRef;
}

export type FlowDest = string | FlowTarget;

export function normalizeDests(dests: readonly FlowDest[]): FlowTarget[] {
  return dests.map((dest) => (typeof dest === 'string' ? { channel: dest } : dest));
}

/** A target as the graph shows it: the policy reference is never described (RS-66). */
export function describeDest(target: FlowTarget): Record<string, unknown> {
  if (!Object.hasOwn(target, 'resilience')) return target as unknown as Record<string, unknown>;
  const described: Record<string, unknown> = { ...target };
  delete described.resilience;
  return described;
}

export class JumpTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`jump a '${channel}' excedió el timeout (${timeoutMs}ms)`);
    this.name = 'JumpTimeoutError';
  }
}

/** Safe serialization for error envelopes. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { value: error };
}
