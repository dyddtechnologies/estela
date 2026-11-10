import type { CareExecutor } from './executor';
import type { InboundCareContext, CareContext } from './resilience.types';

/**
 * Inbound care (RS-37): lanes and pace only, through a care executor whose call is held open
 * until the caller releases it, so the lane lives as long as the request.
 * `admit` rejects with `LanesFullError` or `OverPaceError` before anything is dispatched.
 */
export class LoadShedder {
  constructor(private readonly executor: CareExecutor<unknown>) {}

  admit(ctx: InboundCareContext): Promise<() => void> {
    return new Promise((admitted, rejected) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const call: Omit<CareContext, 'tryNumber'> = {
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
