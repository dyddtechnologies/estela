import { PLAN_B_HEADER } from '../../resilience/retry-budget';
import type { FlowStepContext } from '../flow-step';

/** The reply channel a caller waits on, or undefined when the message has none. */
export function callerOf(ctx: FlowStepContext): string | undefined {
  const replyChannel = ctx.msg.headers.replyChannel;
  return typeof replyChannel === 'string' && replyChannel.length > 0 ? replyChannel : undefined;
}

/** Sends `payload` to `replyChannel` with the message trace; shared by `reply` and `filter`. */
export async function answerCaller(
  ctx: FlowStepContext,
  replyChannel: string,
  payload: unknown,
): Promise<void> {
  await ctx.registry.send(replyChannel, payload, {
    correlationId: ctx.msg.headers.correlationId,
    traceId: ctx.msg.headers.traceId,
    causationId: ctx.msg.headers.id,
    parentSpanId: ctx.msg.headers.spanId,
    // RS-64: only a run that plan B answered adds the mark; other replies keep 0.9.0 headers.
    ...(ctx.planB?.() === true ? { [PLAN_B_HEADER]: true } : {}),
  });
}
