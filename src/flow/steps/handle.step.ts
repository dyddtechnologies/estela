import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** A result other than `undefined` replaces the payload. It never replies (spec sec.6.1). */
export class HandleStep implements FlowStep {
  readonly kind = 'handle' as const;

  constructor(
    private readonly fn: (payload: unknown, msg: IntegrationMessage) => unknown,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const out = await this.fn(ctx.msg.payload, ctx.msg);
    if (out === undefined) return { action: 'continue', msg: ctx.msg };
    return { action: 'continue', msg: { payload: out, headers: ctx.msg.headers } };
  }
}
