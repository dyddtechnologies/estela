import { JumpTimeoutError } from '../flow-step';
import {
  describeDest,
  normalizeDests,
  type FlowDest,
  type FlowStep,
  type FlowStepContext,
  type StepOutcome,
  type StepParams,
  type TargetCarePort,
} from '../flow-step';
import { openFirstMessageWait } from '../../channels/one-shot';
import { JUMP_REPLY_HEADER, nextHop, newId, type IntegrationMessage } from '../../message';
import { jumpWithCare, LEGACY_JUMP_WAIT_MS, markIfPlanB } from '../flow-resilience';
import { reportFireAndForget } from './forget';

/**
 * Jump: its own ephemeral reply `reply.<uuid>`; the parent keeps its `replyChannel`
 * (plan sec.8.1). Awaited -> timeout/errors fail the flow; forget -> error.channel.
 * Result lands in `headers.jumpReplies[channel]`; the parent payload is not overwritten.
 * A target with care runs its tries through the care engine (RS-62); a plan B value lands in
 * `jumpReplies[channel]` with `jumpPlanB[channel] = true` (RS-64).
 */
export class JumpStep implements FlowStep {
  readonly kind = 'jump' as const;

  constructor(
    private readonly dests: readonly FlowDest[],
    private readonly defaultTimeoutMs = LEGACY_JUMP_WAIT_MS,
    readonly params?: StepParams,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, dests: normalizeDests(this.dests).map(describeDest) };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const jumpReplies: Record<string, unknown> = { ...(ctx.msg.headers.jumpReplies ?? {}) };
    const jumpPlanB: Record<string, boolean> = {};
    const awaited: Promise<void>[] = [];
    for (const target of normalizeDests(this.dests)) {
      const care = ctx.care?.target(target.channel);
      const run =
        care === undefined
          ? this.runJump(
              ctx,
              target.channel,
              target.timeoutMs ?? this.defaultTimeoutMs,
              jumpReplies,
            )
          : runWithCare(ctx, care, target.channel, jumpReplies, jumpPlanB);
      if (target.wait === false) reportFireAndForget(ctx, target.channel, run, ctx.msg);
      else {
        awaited.push(run.then(() => undefined));
      }
    }
    await Promise.all(awaited);
    const headers: IntegrationMessage['headers'] = { ...ctx.msg.headers, jumpReplies };
    if (Object.keys(jumpPlanB).length > 0) {
      const previous = (ctx.msg.headers.jumpPlanB ?? {}) as Record<string, boolean>;
      headers.jumpPlanB = { ...previous, ...jumpPlanB };
    }
    return { action: 'continue', msg: { payload: ctx.msg.payload, headers } };
  }

  private async runJump(
    ctx: FlowStepContext,
    channel: string,
    timeoutMs: number,
    jumpReplies: Record<string, unknown>,
  ): Promise<void> {
    const replyName = `reply.${newId()}`;
    const replyChannel = ctx.registry.create({ name: replyName, type: 'direct' });
    const wait = openFirstMessageWait(replyChannel, {
      timeoutMs,
      name: channel,
      timeoutError: () => new JumpTimeoutError(channel, timeoutMs),
    });
    try {
      const hop = nextHop(
        ctx.msg,
        { channel, component: `jump:${ctx.flowName}` },
        { reply: replyName },
      );
      hop.headers[JUMP_REPLY_HEADER] = '1'; // ADR-014: ephemeral-reply marker
      await ctx.registry.sendMessage(channel, hop);
      const reply = await wait.promise;
      markIfPlanB(reply);
      jumpReplies[channel] = reply.payload;
    } finally {
      // A failed hop send abandons the wait: release its timer and subscription.
      wait.cancel();
      ctx.registry.unregister(replyName);
    }
  }
}

async function runWithCare(
  ctx: FlowStepContext,
  care: TargetCarePort,
  channel: string,
  jumpReplies: Record<string, unknown>,
  jumpPlanB: Record<string, boolean>,
): Promise<void> {
  const result = await jumpWithCare(ctx, care, channel);
  jumpReplies[channel] = result.value;
  if (result.planB) jumpPlanB[channel] = true;
}
