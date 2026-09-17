import { copyMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

/** `copyMessage` + fire-and-forget. Never fails el flow (spec sec.6.2, sec.17.6). */
export class WireTapStep implements FlowStep {
  readonly kind = 'wireTap' as const;

  constructor(private readonly channel: string) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, channel: this.channel };
  }

  execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const tap = copyMessage(ctx.msg);
    void ctx.registry.sendMessage(this.channel, tap).catch(() => undefined);
    return Promise.resolve({ action: 'continue', msg: ctx.msg });
  }
}
