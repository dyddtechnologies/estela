import type { ChannelRegistry } from '../channel-registry';
import type { IntegrationMessage } from '../message';
import type { CareRef } from '../resilience/resilience.types';
import type { TraceContext } from '../trace/trace-context';

/**
 * Command contract of a pipeline step (plan sec.3.4, ADR-009).
 * Domain file: no npm dependencies (enforced by dependency-cruiser).
 */

export type FlowStepKind =
  | 'filter'
  | 'transform'
  | 'headers'
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
  /** Resolved care of this step (RS-55..RS-66); absent = the 0.9.0 code path. */
  care?: StepCarePort;
  /** True once plan B answered for this flow run (RS-64); absent when the run has no care. */
  planB?: () => boolean;
  /** Trail writers of this step (SPI-433); absent = the 0.9.0 code path. */
  trail?: StepTrailPort;
}

/** What a wire tap delivers (SPI-433, SD-52). */
export enum TapCopy {
  /** A copy as the trail shows it: hidden values, same id, copied history. */
  AsShown = 'as-shown',
  /** The 0.9.0 copy: the same payload reference. Needs `copyReason` under explicit privacy. */
  Original = 'original',
}

/** Trail writers a step asks for; the flow layer implements them with the privacy engine. */
export interface StepTrailPort {
  /** The `error` of a `wait: false` envelope (S4), from `serializeError`. */
  envelopeBody(body: unknown): unknown;
  /** The message a wire tap sends (S10); undefined keeps the shared 0.9.0 copy. */
  tapCopy(msg: IntegrationMessage): IntegrationMessage | undefined;
}

/** One try as the care engine hands it to a step. */
export interface StepTry {
  tryNumber: number;
  signal: AbortSignal | undefined;
  /** Effective wait of this try in ms; 0 = no limit. */
  eachTryMs: number;
  /** Tries left to stamp on the hop; undefined = leave the hop as built. */
  triesLeftOut: number | undefined;
}

/** Resolved care of one subject: a `handle` step or one send or jump target. */
export interface TargetCarePort {
  /** Care subject, `flow:<flow>#<stepId>` or `flow:<flow>#<stepId>:<channel>`. */
  readonly binding: string;
  /** Runs the tries; `data` is edge data (the hop of a send target). */
  run<T>(
    msg: IntegrationMessage,
    attempt: (current: StepTry) => Promise<T>,
    data?: unknown,
  ): Promise<{ value: T; planB: boolean }>;
}

/**
 * What a step asks of its resolved care. The flow layer implements it;
 * the domain only names the shape.
 */
export interface StepCarePort {
  /** Care of one target channel, or undefined when the target has no effective care. */
  target(channel: string): TargetCarePort | undefined;
  /** Care of a `handle` step, or undefined. */
  readonly handle?: TargetCarePort | undefined;
}

export type StepOutcome =
  | { action: 'continue'; msg: IntegrationMessage }
  | { action: 'stop'; reason: 'filtered' | 'terminated' }
  | { action: 'fail'; error: unknown };

export interface FlowStep {
  readonly kind: FlowStepKind;
  describe(): Record<string, unknown>;
  execute(ctx: FlowStepContext): Promise<StepOutcome>;
  /** Flow parameters of the step (id, care, targets); absent on a step built without any. */
  readonly params?: StepParams | undefined;
}

// ---------- Flow parameter model (minimal scaffolding pending SPI-433, SD-67) ----------

/**
 * Options every step accepts. Only `id` exists here; the privacy concern (SPI-433) adds its
 * member to this interface.
 */
export interface StepCommonOptions {
  /** Stable step id; default `<kind>#<index>`; unique per flow (DUPLICATE_STEP_ID). */
  id?: string;
}

/** Options of a step that accepts care (L4). */
export interface CareStepOptions extends StepCommonOptions {
  care?: CareRef;
}

/** Options of `jump(channel, opts)`. `timeoutMs` is the 0.9.0 spelling of `care.patience.eachTryMs`. */
export interface JumpOptions {
  wait?: boolean;
  timeoutMs?: number;
  care?: CareRef;
  id?: string;
}

/** Flow-level defaults (L3), split by step family (RS-55). */
export interface FlowOptions {
  care?: {
    handle?: CareRef;
    jump?: CareRef;
    /** `to`, `publish`, `route` and `fanoutTo`. */
    send?: CareRef;
  };
}

/** Parameters a step carries for the boot resolver (RS-67). */
export interface StepParams {
  /** Explicit id, when the author set one. */
  readonly id?: string;
  /** L4 step care; on `fanoutTo`/`jumpTo` it applies to every target. */
  readonly care?: CareRef;
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

/** A target of `fanoutTo` / `jumpTo`; its own care replaces the step's part by part. */
export interface FlowTarget extends FanoutTargetInput {
  care?: CareRef;
}

export type FlowDest = string | FlowTarget;

export function normalizeDests(dests: readonly FlowDest[]): FlowTarget[] {
  return dests.map((dest) => (typeof dest === 'string' ? { channel: dest } : dest));
}

/** A target as the graph shows it: the care reference is never described (RS-66). */
export function describeDest(target: FlowTarget): Record<string, unknown> {
  if (!Object.hasOwn(target, 'care')) return target as unknown as Record<string, unknown>;
  const described: Record<string, unknown> = { ...target };
  delete described.care;
  return described;
}

export class JumpTimeoutError extends Error {
  constructor(
    channel: string,
    /** The wait that ran out, in ms. */
    readonly timeoutMs: number,
  ) {
    super(`jump a '${channel}' excedió el timeout (${timeoutMs}ms)`);
    this.name = 'JumpTimeoutError';
  }
}

/**
 * A `headers` step function returned something that cannot be merged: not a plain object, or
 * reserved names (`names`, sorted). The flow fails and reports to `error.channel`.
 */
export class FlowHeadersError extends Error {
  constructor(
    message: string,
    /** Reserved names the function tried to set; empty when the result was not an object. */
    readonly names: readonly string[] = [],
  ) {
    super(message);
    this.name = 'FlowHeadersError';
  }
}

/** Safe serialization for error envelopes. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { value: error };
}
