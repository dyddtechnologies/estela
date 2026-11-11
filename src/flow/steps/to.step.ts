import { nextHop } from '../../message';
import { sendHop } from '../flow-resilience';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** `nextHop(..., { reply: 'inherit' })` + send, then TERMINATES the pipeline (spec sec.6.2). */
export class ToStep implements FlowStep {
  readonly kind = 'to' as const;

  constructor(
    private readonly channel: string,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, channel: this.channel };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const hop = nextHop(
      ctx.msg,
      { channel: this.channel, component: `to:${ctx.flowName}` },
      {
        reply: 'inherit',
      },
    );
    await sendHop(ctx, this.channel, hop);
    return { action: 'stop', reason: 'terminated' };
  }
}
