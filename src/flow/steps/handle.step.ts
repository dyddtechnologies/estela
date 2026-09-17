import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

/** Si `return !== undefined` pisa payload. Never dispara reply (spec sec.6.1). */
export class HandleStep implements FlowStep {
  readonly kind = 'handle' as const;

  constructor(private readonly fn: (payload: unknown, msg: IntegrationMessage) => unknown) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const out = await this.fn(ctx.msg.payload, ctx.msg);
    if (out === undefined) return { action: 'continue', msg: ctx.msg };
    return { action: 'continue', msg: { payload: out, headers: ctx.msg.headers } };
  }
}
