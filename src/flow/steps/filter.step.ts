import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

/** Lee `msg.payload`; false -> exit con success (idempotency succeed `{filtered:true}`). */
export class FilterStep implements FlowStep {
  readonly kind = 'filter' as const;

  constructor(
    private readonly predicate: (
      payload: unknown,
      msg: IntegrationMessage,
    ) => boolean | Promise<boolean>,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const pass = await this.predicate(ctx.msg.payload, ctx.msg);
    if (pass) return { action: 'continue', msg: ctx.msg };
    return { action: 'stop', reason: 'filtered' };
  }
}
