import type { IntegrationMessage } from '../../message';
import { createMessage } from '../../message';
import { serializeError, type FlowStepContext } from '../flow-step';

/**
 * Forget (`wait:false`): never fails the flow; the failure goes to `error.channel`
 * with the envelope `{ fireAndForget: true, channel }` (spec sec.6.2, plan sec.8.2).
 */
export function reportFireAndForget(
  ctx: FlowStepContext,
  target: { channel: string; index: number },
  promise: Promise<void>,
  msg: IntegrationMessage,
): void {
  const { channel, index } = target;
  void promise.catch((error: unknown) => {
    const body = serializeError(error);
    const shown = ctx.trail === undefined ? body : ctx.trail.envelopeBody(body, index);
    const envelope = createMessage(
      { fireAndForget: true, channel, error: shown, flow: ctx.flowName },
      {
        traceId: msg.headers.traceId,
        correlationId: msg.headers.correlationId,
        causationId: msg.headers.id,
      },
    );
    return ctx.registry.sendMessage(ctx.errorChannel, envelope);
  });
}
