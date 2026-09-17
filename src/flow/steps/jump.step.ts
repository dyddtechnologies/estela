import { JumpTimeoutError } from '../flow-step';
import {
  normalizeDests,
  type FanoutDest,
  type FlowStep,
  type FlowStepContext,
  type StepOutcome,
} from '../flow-step';
import { awaitFirstMessage } from '../../channels/one-shot';
import { JUMP_REPLY_HEADER, nextHop, newId } from '../../message';
import { reportFireAndForget } from './forget';

const DEFAULT_JUMP_TIMEOUT_MS = 10_000;

/**
 * Jump: reply efímero propio `reply.<uuid>`; el padre conserva su `replyChannel`
 * (plan §8.1). Awaited → timeout/errores fallan el flow; forget → error.channel.
 * Resultado en `headers.jumpReplies[channel]`; payload del padre no se pisa.
 */
export class JumpStep implements FlowStep {
  readonly kind = 'jump' as const;

  constructor(
    private readonly dests: readonly FanoutDest[],
    private readonly defaultTimeoutMs = DEFAULT_JUMP_TIMEOUT_MS,
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, dests: normalizeDests(this.dests) };
  }

  async execute(ctx: FlowStepContext): Promise<StepOutcome> {
    const jumpReplies: Record<string, unknown> = { ...(ctx.msg.headers.jumpReplies ?? {}) };
    const awaited: Promise<void>[] = [];
    for (const target of normalizeDests(this.dests)) {
      const timeoutMs = target.timeoutMs ?? this.defaultTimeoutMs;
      const run = this.runJump(ctx, target.channel, timeoutMs, jumpReplies);
      if (target.wait === false) reportFireAndForget(ctx, target.channel, run, ctx.msg);
      else {
        awaited.push(run.then(() => undefined));
      }
    }
    await Promise.all(awaited);
    return {
      action: 'continue',
      msg: { payload: ctx.msg.payload, headers: { ...ctx.msg.headers, jumpReplies } },
    };
  }

  private async runJump(
    ctx: FlowStepContext,
    channel: string,
    timeoutMs: number,
    jumpReplies: Record<string, unknown>,
  ): Promise<void> {
    const replyName = `reply.${newId()}`;
    const replyChannel = ctx.registry.create({ name: replyName, type: 'direct' });
    try {
      const first = awaitFirstMessage(replyChannel, {
        timeoutMs,
        name: channel,
        timeoutError: () => new JumpTimeoutError(channel, timeoutMs),
      });
      const hop = nextHop(
        ctx.msg,
        { channel, component: `jump:${ctx.flowName}` },
        { reply: replyName },
      );
      hop.headers[JUMP_REPLY_HEADER] = '1'; // ADR-014: metadato del efímero
      await ctx.registry.sendMessage(channel, hop);
      const reply = await first;
      jumpReplies[channel] = reply.payload;
    } finally {
      ctx.registry.unregister(replyName);
    }
  }
}
