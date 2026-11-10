import { TRIES_LEFT_MESSAGE_HEADER } from '../../resilience/retry-budget';
import { hasCareScope } from '../flow-resilience';
import { withoutReplyRouting } from './reply-routing';
import type { FlowStep, FlowStepContext, StepOutcome, StepParams, TapCopy } from '../flow-step';

/** What the tap delivers (SPI-433, SD-52); both absent keep the boot default. */
export interface TapCopyOptions {
  copy?: TapCopy;
  copyReason?: string;
}

/** A copy without reply routing + fire-and-forget. It never fails the flow (spec sec.6.2, sec.17.6). */
export class WireTapStep implements FlowStep {
  readonly kind = 'wireTap' as const;

  constructor(
    readonly channel: string,
    readonly params?: StepParams,
    readonly tap: TapCopyOptions = {},
  ) {}

  describe(): Record<string, unknown> {
    return { kind: this.kind, channel: this.channel };
  }

  execute(ctx: FlowStepContext): Promise<StepOutcome> {
    // SD-52: a hidden copy when the trail says so; either way the tap copy has no reply routing
    // (invariant 2, D38).
    const tap = withoutReplyRouting(ctx.trail?.tapCopy(ctx.msg) ?? ctx.msg);
    // RS-58: a tap consumer neither spends nor forwards the caller's tries left; without any care
    // configuration the copy keeps the care headers, as in 0.9.0 (RS-70).
    if (hasCareScope(ctx))
      delete (tap.headers as Record<string, unknown>)[TRIES_LEFT_MESSAGE_HEADER];
    void ctx.registry.sendMessage(this.channel, tap).catch(() => undefined);
    return Promise.resolve({ action: 'continue', msg: ctx.msg });
  }
}
