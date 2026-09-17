import type { IntegrationMessage } from '../../message';
import { createMessage } from '../../message';
import { serializeError, type FlowStepContext } from '../flow-step';

/**
 * Forget (`wait:false`): jamás tumba el flow; el fallo va a `error.channel`
 * con envelope `{ fireAndForget: true, channel }` (spec §6.2, plan §8.2).
 */
export function reportFireAndForget(
  ctx: FlowStepContext,
  channel: string,
  promise: Promise<void>,
  msg: IntegrationMessage,
): void {
  void promise.catch((error: unknown) => {
    const envelope = createMessage(
      { fireAndForget: true, channel, error: serializeError(error), flow: ctx.flowName },
      {
        traceId: msg.headers.traceId,
        correlationId: msg.headers.correlationId,
        causationId: msg.headers.id,
      },
    );
    return ctx.registry.sendMessage(ctx.errorChannel, envelope);
  });
}
