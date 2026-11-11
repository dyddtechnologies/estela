import { nextHop, type IntegrationMessage } from '../../message';
import { sendHop } from '../flow-resilience';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** fn -> `string | string[]`; `nextHop(..., { reply: 'inherit' })` to each one; terminates. */
export class RouteStep implements FlowStep {
  readonly kind = 'route' as const;

  constructor(
    private readonly fn: (
      payload: unknown,
      msg: IntegrationMessage,
    ) => string | string[] | Promise<string | string[]>,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const targets = await this.fn(ctx.msg.payload, ctx.msg);
    const list = Array.isArray(targets) ? targets : [targets];
    await Promise.all(
      list.map(async (channel) => {
        const hop = nextHop(
          ctx.msg,
          { channel, component: `route:${ctx.flowName}` },
          { reply: 'inherit' },
        );
        try {
          await sendHop(ctx, channel, hop);
        } catch (error) {
          ctx.trail?.routeFailed(error, channel);
          throw error;
        }
      }),
    );
    return { action: 'stop', reason: 'terminated' };
  }
}
