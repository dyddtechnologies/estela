import { nextHop } from '../../message';
import type { FlowDest, FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';
import { describeDest, normalizeDests } from '../flow-step';
import { sendHop } from '../flow-resilience';
import { reportFireAndForget } from './forget';

/**
 * Copy with `nextHop(..., { reply: 'none' })` (plan sec.8.1). Awaited targets run in parallel
 * (`Promise.all`); forget targets never fail the flow. The parent payload is NOT replaced.
 */
export class FanoutStep implements FlowStep {
  readonly kind = 'fanout' as const;

  constructor(
    private readonly dests: readonly FlowDest[],
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, dests: normalizeDests(this.dests).map(describeDest) };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const awaited: Promise<void>[] = [];
    for (const [index, target] of normalizeDests(this.dests).entries()) {
      const hop = nextHop(
        ctx.msg,
        { channel: target.channel, component: `fanout:${ctx.flowName}` },
        { reply: 'none' },
      );
      const send = sendHop(ctx, target.channel, hop);
      if (target.wait === false)
        reportFireAndForget(ctx, { channel: target.channel, index }, send, ctx.msg);
      else awaited.push(send);
    }
    await Promise.all(awaited);
    return { action: 'continue', msg: ctx.msg };
  }
}
