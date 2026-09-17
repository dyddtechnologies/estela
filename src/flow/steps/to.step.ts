import { nextHop } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

/** `nextHop(..., { reply: 'inherit' })` + send + TERMINA el pipeline (spec §6.2). */
export class ToStep implements FlowStep {
  readonly kind = 'to' as const;

  constructor(private readonly channel: string) {}

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
    await ctx.registry.sendMessage(this.channel, hop);
    return { action: 'stop', reason: 'terminated' };
  }
}
