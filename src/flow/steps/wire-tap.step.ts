import { copyMessage } from '../../message';
import { RETRY_BUDGET_MESSAGE_HEADER } from '../../resilience/retry-budget';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** `copyMessage` + fire-and-forget. It never fails the flow (spec sec.6.2, sec.17.6). */
export class WireTapStep implements FlowStep {
  readonly kind = 'wireTap' as const;

  constructor(
    private readonly channel: string,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, channel: this.channel };
  }

  execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const tap = copyMessage(ctx.msg);
    // RS-58: a tap consumer neither consumes nor forwards the caller's retry budget.
    delete (tap.headers as Record<string, unknown>)[RETRY_BUDGET_MESSAGE_HEADER];
    void ctx.registry.sendMessage(this.channel, tap).catch(() => undefined);
    return Promise.resolve({ action: 'continue', msg: ctx.msg });
  }
}
