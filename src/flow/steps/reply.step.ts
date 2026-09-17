import type { FlowStep, FlowStepContext, StepOutcome } from '../flow-step';

export interface ReplyOptions {
  /** `'current'` (default) | `'jumpMerge'` = `{ ...payload, jumpReplies }` (spec §6.3). */
  payload?: 'current' | 'jumpMerge';
}

/** Envía al `replyChannel` si existe; no corta por sí solo (spec §6.3). */
export class ReplyStep implements FlowStep {
  readonly kind = 'reply' as const;

  constructor(private readonly options: ReplyOptions = {}) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, payload: this.options.payload ?? 'current' };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const replyChannel = ctx.msg.headers.replyChannel;
    if (typeof replyChannel !== 'string' || replyChannel.length === 0) {
      return { action: 'continue', msg: ctx.msg };
    }
    const payload =
      this.options.payload === 'jumpMerge'
        ? this.mergeJumps(ctx.msg.payload, ctx.msg.headers.jumpReplies ?? {})
        : ctx.msg.payload;
    await ctx.registry.send(replyChannel, payload, {
      correlationId: ctx.msg.headers.correlationId,
      traceId: ctx.msg.headers.traceId,
      causationId: ctx.msg.headers.id,
      parentSpanId: ctx.msg.headers.spanId,
    });
    return { action: 'continue', msg: ctx.msg };
  }

  private mergeJumps(payload: unknown, jumpReplies: Record<string, unknown>): unknown {
    if (typeof payload === 'object' && payload !== null) {
      return { ...(payload as Record<string, unknown>), jumpReplies };
    }
    return { value: payload, jumpReplies };
  }
}
