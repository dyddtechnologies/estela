import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';
import { answerCaller, callerOf } from './answer-caller';

/** Computes the answer a caller gets for a dropped message. */
export type DropReplyFn = (payload: unknown, msg: IntegrationMessage) => unknown;

/** A fixed answer for a dropped message. */
export type DropReplyValue = string | number | boolean | null | object;

/**
 * What a `filter` does with a dropped message besides stopping the flow. `reply` answers the
 * caller waiting on the message `replyChannel` (inbound request/reply, a jump): a fixed value,
 * or a function of the dropped payload and message (a function value is always called).
 */
export interface FilterWhenDropped {
  reply: DropReplyValue | DropReplyFn;
}

/**
 * Reads `msg.payload`; false -> exits with success (idempotency completes `{filtered:true}`).
 * With `whenDropped.reply` a dropped message that has a caller is answered before the exit;
 * without it the drop is silent (0.9.0).
 */
export class FilterStep implements FlowStep {
  readonly kind = 'filter' as const;

  constructor(
    private readonly predicate: (
      payload: unknown,
      msg: IntegrationMessage,
    ) => boolean | Promise<boolean>,
    readonly params?: StepParams,
    private readonly whenDropped?: FilterWhenDropped,
  ) {}

  /** The option, never the reply value. */
  describe(): Record<string, unknown> {
    if (this.whenDropped === undefined) return { kind: this.kind };
    return { kind: this.kind, whenDropped: 'reply' };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const pass = await this.predicate(ctx.msg.payload, ctx.msg);
    if (pass) return { action: 'continue', msg: ctx.msg };
    const replyChannel = callerOf(ctx);
    if (this.whenDropped !== undefined && replyChannel !== undefined) {
      const { reply } = this.whenDropped;
      const value =
        typeof reply === 'function'
          ? await (reply as DropReplyFn)(ctx.msg.payload, ctx.msg)
          : reply;
      await answerCaller(ctx, replyChannel, value);
    }
    return { action: 'stop', reason: 'filtered' };
  }
}
