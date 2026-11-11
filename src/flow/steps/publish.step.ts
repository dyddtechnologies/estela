import { nextHop } from '../../message';
import { sendHop } from '../flow-resilience';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** `nextHop` + routingKey; does not terminate; awaits the send (spec sec.6.2). */
export class PublishStep implements FlowStep {
  readonly kind = 'publish' as const;

  constructor(
    private readonly channel: string,
    private readonly routingKey?: string,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, channel: this.channel, routingKey: this.routingKey };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const hop = nextHop(
      ctx.msg,
      { channel: this.channel, component: `publish:${ctx.flowName}` },
      { reply: 'none' },
    );
    if (this.routingKey !== undefined) hop.headers.routingKey = this.routingKey;
    await sendHop(ctx, this.channel, hop);
    return { action: 'continue', msg: ctx.msg };
  }
}
