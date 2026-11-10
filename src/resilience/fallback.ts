import { turnedAwayTrigger, PlanBFailedError } from './resilience.errors';
import type { PlanBPlan } from './resilience.plan';
import type { FailureClass, PlanBTrigger, CareContext } from './resilience.types';

/**
 * Plan B trigger of a final failure (section 5.1): the turned-away kind, `'quota'` for a
 * quota-shut valve, else the failure class. Key and config errors have none.
 */
export function planBTrigger(
  error: unknown,
  lastClass: FailureClass | undefined,
): PlanBTrigger | undefined {
  const rejection = turnedAwayTrigger(error);
  if (rejection === 'none') return undefined;
  if (rejection !== undefined) return rejection;
  return lastClass ?? 'unknown';
}

/** Runs plan B (value or channel); a failure becomes `PlanBFailedError` (RS-26). */
export async function runPlanB(
  plan: PlanBPlan,
  error: unknown,
  ctx: CareContext,
  channelRunner: ((channel: string, ctx: CareContext) => Promise<unknown>) | undefined,
  tries: number,
): Promise<unknown> {
  try {
    if (plan.value !== undefined) return await plan.value(error, ctx);
    if (channelRunner === undefined) throw new Error('no plan B channel runner on this edge');
    return await channelRunner(plan.channel ?? '', ctx);
  } catch (cause) {
    throw new PlanBFailedError({
      binding: ctx.binding,
      edge: ctx.edge,
      tries,
      cause,
      original: error,
    });
  }
}
