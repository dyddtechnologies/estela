import { copyMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from '../../message';
import { TRIES_LEFT_MESSAGE_HEADER } from '../../resilience/retry-budget';
import { hasCareScope } from '../flow-resilience';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams } from '../flow-step';

/**
 * Headers that route an answer back to a caller. A tap copy never carries them (invariant 2:
 * `wireTap -> 'none'`), so a tap consumer that returns a value cannot answer the caller or a jump.
 */
const TAP_STRIPPED_HEADERS = ['replyChannel', JUMP_REPLY_HEADER] as const;

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
    const tap = tapCopy(ctx.msg);
    // RS-58: a tap consumer neither spends nor forwards the caller's tries left; without any care
    // configuration the copy keeps the care headers, as in 0.9.0 (RS-70).
    if (hasCareScope(ctx))
      delete (tap.headers as Record<string, unknown>)[TRIES_LEFT_MESSAGE_HEADER];
    void ctx.registry.sendMessage(this.channel, tap).catch(() => undefined);
    return Promise.resolve({ action: 'continue', msg: ctx.msg });
  }
}

/** Same id, trace and custom headers as `msg`, without any reply routing (SPI-448, D38). */
function tapCopy(msg: IntegrationMessage): IntegrationMessage {
  const tap = copyMessage(msg);
  const headers = tap.headers as Record<string, unknown>;
  for (const name of TAP_STRIPPED_HEADERS) delete headers[name];
  return tap;
}
