import { recordHop, type IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

function isMessageLike(value: unknown): value is IntegrationMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'payload' in value &&
    'headers' in value &&
    typeof (value as IntegrationMessage).headers === 'object'
  );
}

/** A `{payload, headers}` result replaces `msg`; any other result replaces the payload and records a hop (spec sec.6.1). */
export class TransformStep implements FlowStep {
  readonly kind = 'transform' as const;

  constructor(
    private readonly fn: (payload: unknown, msg: IntegrationMessage) => unknown,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const out = await this.fn(ctx.msg.payload, ctx.msg);
    // SD-50: a delivery-reach step hides its output; the trail port returns it as is otherwise.
    const deliver = (msg: IntegrationMessage): IntegrationMessage => ctx.trail?.deliver(msg) ?? msg;
    if (isMessageLike(out)) {
      return {
        action: 'continue',
        msg: deliver({
          payload: out.payload,
          headers: { ...out.headers, history: [...out.headers.history] },
        }),
      };
    }
    const msg: IntegrationMessage = recordHop(
      { payload: out, headers: { ...ctx.msg.headers, history: [...ctx.msg.headers.history] } },
      { channel: ctx.flowName, component: 'transform' },
    );
    return { action: 'continue', msg: deliver(msg) };
  }
}
