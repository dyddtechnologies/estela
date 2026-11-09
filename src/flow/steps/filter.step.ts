import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** Reads `msg.payload`; false -> exits with success (idempotency completes `{filtered:true}`). */
export class FilterStep implements FlowStep {
  readonly kind = 'filter' as const;

  constructor(
    private readonly predicate: (
      payload: unknown,
      msg: IntegrationMessage,
    ) => boolean | Promise<boolean>,
    readonly params?: StepParams,
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
