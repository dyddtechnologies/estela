import type { ChannelRegistry } from '../channel-registry';
import type { IntegrationMessage } from '../message';
import type { TraceContext } from '../trace/trace-context';

/**
 * Contrato Command de un step del pipeline (plan §3.4, ADR-009).
 * Archivo de dominio: sin deps npm (enforzado por dependency-cruiser).
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
  registry: ChannelRegistry; // puerto de salida (Mediator)
  trace: TraceContext;
  errorChannel: string;
  flowName: string;
}

export type StepOutcome =
  | { action: 'continue'; msg: IntegrationMessage }
  | { action: 'stop'; reason: 'filtered' | 'terminated' }
  | { action: 'fail'; error: unknown };

export interface FlowStep {
  readonly kind: FlowStepKind;
  describe(): Record<string, unknown>;
  execute(ctx: FlowStepContext): Promise<StepOutcome>;
}

// ---------- Destinos mixtos (spec §6.2) ----------

export interface FanoutTargetInput {
  channel: string;
  wait?: boolean; // default true
  timeoutMs?: number; // solo jump
}

export type FanoutDest = string | FanoutTargetInput;

export function normalizeDests(dests: readonly FanoutDest[]): FanoutTargetInput[] {
  return dests.map((dest) => (typeof dest === 'string' ? { channel: dest } : dest));
}

export class JumpTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`jump a '${channel}' excedió el timeout (${timeoutMs}ms)`);
    this.name = 'JumpTimeoutError';
  }
}

/** Serialización segura para envelopes de error. */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { value: error };
}
