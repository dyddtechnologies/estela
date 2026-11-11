import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';
import { answerCaller, callerOf } from './answer-caller';

export interface ReplyOptions {
  /** `'current'` (default) | `'jumpMerge'` = `{ ...payload, jumpReplies }` (spec sec.6.3). */
  payload?: 'current' | 'jumpMerge';
}

/** Sends to `replyChannel` when there is one; it does not terminate on its own (spec sec.6.3). */
export class ReplyStep implements FlowStep {
  readonly kind = 'reply' as const;

  constructor(
    private readonly options: ReplyOptions = {},
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, payload: this.options.payload ?? 'current' };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const replyChannel = callerOf(ctx);
    if (replyChannel === undefined) return { action: 'continue', msg: ctx.msg };
    const payload =
      this.options.payload === 'jumpMerge'
        ? this.mergeJumps(ctx.msg.payload, ctx.msg.headers.jumpReplies ?? {})
        : ctx.msg.payload;
    await answerCaller(ctx, replyChannel, payload);
    return { action: 'continue', msg: ctx.msg };
  }

  private mergeJumps(payload: unknown, jumpReplies: Record<string, unknown>): unknown {
    if (typeof payload === 'object' && payload !== null) {
      return { ...(payload as Record<string, unknown>), jumpReplies };
    }
    return { value: payload, jumpReplies };
  }
}
