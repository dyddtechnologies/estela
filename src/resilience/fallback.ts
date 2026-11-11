import {
  isReservedHeader,
  LEFT_FROM_KEY_HEADER,
  newId,
  type IntegrationMessage,
  type MessageHeaders,
} from '../message';
import { turnedAwayTrigger, PlanBFailedError } from './resilience.errors';
import type { PlanBPlan } from './resilience.plan';
import {
  PlanBMode,
  type FailureClass,
  type PlanBTrigger,
  type CareContext,
} from './resilience.types';

/**
 * Plan B trigger of a final failure (section 5.1): the turned-away kind, `'quota'` for a
 * quota-shut valve, else the failure class. Key and config errors have none.
 */
export function planBTrigger(
  error: unknown,
  lastClass: FailureClass | undefined,
): PlanBTrigger | undefined {
  const rejection = turnedAwayTrigger(error);
  if (rejection === 'none') return undefined;
  if (rejection !== undefined) return rejection;
  return lastClass ?? 'unknown';
}

/** How an edge runs a `planB.channel`: `ask` for `PlanBMode.Ask`, `leave` for `PlanBMode.Leave`. */
export interface PlanBRunners {
  ask?: ((channel: string, ctx: CareContext) => Promise<unknown>) | undefined;
  leave?: ((channel: string, ctx: CareContext) => Promise<unknown>) | undefined;
}

/** Runs plan B (value, channel, or a left message then value); a failure becomes `PlanBFailedError` (RS-26). */
export async function runPlanB(
  plan: PlanBPlan,
  error: unknown,
  ctx: CareContext,
  runners: PlanBRunners,
  tries: number,
): Promise<unknown> {
  try {
    if (plan.channel !== undefined && plan.mode === PlanBMode.Leave) {
      if (runners.leave === undefined) throw new Error('no plan B channel sender on this edge');
      await runners.leave(plan.channel, ctx);
      return plan.value === undefined ? undefined : await plan.value(error, ctx);
    }
    if (plan.value !== undefined) return await plan.value(error, ctx);
    if (runners.ask === undefined) throw new Error('no plan B channel runner on this edge');
    return await runners.ask(plan.channel ?? '', ctx);
  } catch (cause) {
    throw new PlanBFailedError({
      binding: ctx.binding,
      edge: ctx.edge,
      tries,
      cause,
      original: error,
    });
  }
}

/** One send on a channel (the module wires `ChannelRegistry.send`). */
export type ChannelSendFn = (
  channel: string,
  payload: unknown,
  headers: Record<string, unknown>,
) => Promise<unknown>;

/** The idempotency headers of one left message (D42). */
export interface LeftKeyHeaders {
  idempotencyKey?: string;
  leftFromKey?: string;
}

/**
 * D42: the idempotency headers of one leave. The left message gets a key of its own, the origin
 * key + `:left:` + a fresh id, so a consumer that claims keys (an activator) takes every leave of
 * the same message and still drops a redelivery of one leave. `leftFromKey` keeps the origin key
 * for correlation and for a drain that sends the message on again. A message that was itself left
 * keeps its origin key, so keys do not grow when a parked message is left again.
 */
export function leftKeyHeaders(headers: MessageHeaders): LeftKeyHeaders {
  const key = headers.idempotencyKey;
  if (typeof key !== 'string') return {};
  const from = headers[LEFT_FROM_KEY_HEADER];
  const origin = typeof from === 'string' && key.startsWith(`${from}:left:`) ? from : key;
  return { idempotencyKey: `${origin}:left:${newId()}`, [LEFT_FROM_KEY_HEADER]: origin };
}

/** `msg` with the idempotency headers of one leave (D42) in place of its own. */
export function withLeftKeys(msg: IntegrationMessage): IntegrationMessage {
  const headers: MessageHeaders = { ...msg.headers };
  delete headers.idempotencyKey;
  delete headers[LEFT_FROM_KEY_HEADER];
  return { payload: msg.payload, headers: { ...headers, ...leftKeyHeaders(msg.headers) } };
}

/**
 * Headers of a message left by plan B: its trace, a key of its own derived from its idempotency
 * key (D42) and its own headers, never the headers Estela owns (reply routing, care, history), so
 * the channel's consumer cannot answer the caller.
 */
export function leftHeaders(msg: IntegrationMessage | undefined): Record<string, unknown> {
  if (msg === undefined) return {};
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(msg.headers)) {
    if (!isReservedHeader(name) && value !== undefined) headers[name] = value;
  }
  headers.traceId = msg.headers.traceId;
  headers.correlationId = msg.headers.correlationId;
  headers.causationId = msg.headers.id;
  return { ...headers, ...leftKeyHeaders(msg.headers) };
}

/**
 * Runner of a `planB.channel` with `mode: PlanBMode.Leave`: one send of the payload with
 * `leftHeaders`, no answer awaited. A failed send fails plan B.
 */
export function planBLeaveRunner(
  send: ChannelSendFn | undefined,
): (channel: string, ctx: CareContext) => Promise<unknown> {
  return (channel, ctx) => {
    if (send === undefined) {
      return Promise.reject(new Error('planB mode leave needs a channel registry'));
    }
    return send(channel, ctx.message?.payload, leftHeaders(ctx.message));
  };
}
