import { recordHop, type IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

function isMessageLike(value: unknown): value is IntegrationMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'payload' in value &&
    'headers' in value &&
    typeof (value as IntegrationMessage).headers === 'object'
  );
}

/** Si el return trae `{payload, headers}` replaces `msg`; si no, pisa payload + hop (spec sec.6.1). */
export class TransformStep implements FlowStep {
  readonly kind = 'transform' as const;

  constructor(private readonly fn: (payload: unknown, msg: IntegrationMessage) => unknown) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const out = await this.fn(ctx.msg.payload, ctx.msg);
    if (isMessageLike(out)) {
      return {
        action: 'continue',
        msg: {
          payload: out.payload,
          headers: { ...out.headers, history: [...out.headers.history] },
        },
      };
    }
    const msg: IntegrationMessage = recordHop(
      { payload: out, headers: { ...ctx.msg.headers, history: [...ctx.msg.headers.history] } },
      { channel: ctx.flowName, component: 'transform' },
    );
    return { action: 'continue', msg };
  }
}
