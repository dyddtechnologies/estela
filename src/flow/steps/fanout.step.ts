import { nextHop } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, FanoutDest } from '../flow-step';
import { normalizeDests } from '../flow-step';
import { reportFireAndForget } from './forget';

/**
 * Copia con `nextHop(..., { reply: 'none' })` (plan §8.1). Grupo awaited en
 * paralelo (`Promise.all`); forget nunca tumba. El payload del padre NO se pisa.
 */
export class FanoutStep implements FlowStep {
  readonly kind = 'fanout' as const;

  constructor(private readonly dests: readonly FanoutDest[]) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, dests: normalizeDests(this.dests) };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const awaited: Array<Promise<void>> = [];
    for (const target of normalizeDests(this.dests)) {
      const hop = nextHop(
        ctx.msg,
        { channel: target.channel, component: `fanout:${ctx.flowName}` },
        { reply: 'none' },
      );
      const send = ctx.registry.sendMessage(target.channel, hop);
      if (target.wait === false) reportFireAndForget(ctx, target.channel, send, ctx.msg);
      else awaited.push(send);
    }
    await Promise.all(awaited);
    return { action: 'continue', msg: ctx.msg };
  }
}
