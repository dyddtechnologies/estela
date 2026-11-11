import type { IntegrationMessage } from '../../message';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/** A result other than `undefined` replaces the payload. It never replies (spec sec.6.1). */
export class HandleStep implements FlowStep {
  readonly kind = 'handle' as const;

  constructor(
    private readonly fn: (payload: unknown, msg: IntegrationMessage) => unknown,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const care = ctx.care?.handle;
    // RS-61: one try is one call of fn with the same input message; a plan B value
    // becomes the payload (RS-64).
    const out =
      care === undefined
        ? await this.fn(ctx.msg.payload, ctx.msg)
        : (await care.run(ctx.msg, () => this.call(ctx))).value;
    if (out === undefined) return { action: 'continue', msg: ctx.msg };
    return { action: 'continue', msg: { payload: out, headers: ctx.msg.headers } };
  }

  private call(ctx: FlowStepContext): Promise<unknown> {
    try {
      return Promise.resolve(this.fn(ctx.msg.payload, ctx.msg));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
