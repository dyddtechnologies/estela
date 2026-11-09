import type { ResilienceExecutor } from './executor';
import type { InboundShedContext, ResilienceContext } from './resilience.types';

/**
 * Inbound load shedding (RS-37): bulkhead and rate limit only, through a resilience executor
 * whose call is held open until the caller releases it, so the slot lives as long as the request.
 * `admit` rejects with `BulkheadFullError` or `RateLimitedError` before anything is dispatched.
 */
export class LoadShedder {
  constructor(private readonly executor: ResilienceExecutor<unknown>) {}

  admit(ctx: InboundShedContext): Promise<() => void> {
    return new Promise((admitted, rejected) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const call: Omit<ResilienceContext, 'attempt'> = {
        edge: 'inbound',
        binding: ctx.channel,
        channel: ctx.channel,
        data: ctx,
      };
      this.executor
        .execute(call, () => {
          admitted(release);
          return held;
        })
        .catch(rejected);
    });
  }
}
