import { JumpTimeoutError } from '../flow-step';
import {
  describeDest,
  normalizeDests,
  type FlowDest,
  type FlowStep,
  type FlowStepContext,
  type StepOutcome,
  type StepParams,
  type TargetPolicyPort,
} from '../flow-step';
import { openFirstMessageWait } from '../../channels/one-shot';
import { JUMP_REPLY_HEADER, nextHop, newId, type IntegrationMessage } from '../../message';
import { jumpUnderPolicy, LEGACY_JUMP_WAIT_MS, markIfDegraded } from '../flow-resilience';
import { reportFireAndForget } from './forget';

/**
 * Jump: its own ephemeral reply `reply.<uuid>`; the parent keeps its `replyChannel`
 * (plan sec.8.1). Awaited -> timeout/errors fail the flow; forget -> error.channel.
 * Result lands in `headers.jumpReplies[channel]`; the parent payload is not overwritten.
 * A target with a policy runs its attempts through the resilience engine (RS-62); a fallback
 * value lands in `jumpReplies[channel]` with `jumpDegraded[channel] = true` (RS-64).
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
    const jumpDegraded: Record<string, boolean> = {};
    const awaited: Promise<void>[] = [];
    for (const target of normalizeDests(this.dests)) {
      const policy = ctx.policy?.target(target.channel);
      const run =
        policy === undefined
          ? this.runJump(
              ctx,
              target.channel,
              target.timeoutMs ?? this.defaultTimeoutMs,
              jumpReplies,
            )
          : runWithPolicy(ctx, policy, target.channel, jumpReplies, jumpDegraded);
      if (target.wait === false) reportFireAndForget(ctx, target.channel, run, ctx.msg);
      else {
        awaited.push(run.then(() => undefined));
      }
    }
    await Promise.all(awaited);
    const headers: IntegrationMessage['headers'] = { ...ctx.msg.headers, jumpReplies };
    if (Object.keys(jumpDegraded).length > 0) {
      const previous = (ctx.msg.headers.jumpDegraded ?? {}) as Record<string, boolean>;
      headers.jumpDegraded = { ...previous, ...jumpDegraded };
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
      markIfDegraded(reply);
      jumpReplies[channel] = reply.payload;
    } finally {
      // A failed hop send abandons the wait: release its timer and subscription.
      wait.cancel();
      ctx.registry.unregister(replyName);
    }
  }
}

async function runWithPolicy(
  ctx: FlowStepContext,
  policy: TargetPolicyPort,
  channel: string,
  jumpReplies: Record<string, unknown>,
  jumpDegraded: Record<string, boolean>,
): Promise<void> {
  const result = await jumpUnderPolicy(ctx, policy, channel);
  jumpReplies[channel] = result.value;
  if (result.fallback) jumpDegraded[channel] = true;
}
