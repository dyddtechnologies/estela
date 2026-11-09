import { rejectionTrigger, FallbackFailedError } from './resilience.errors';
import type { FallbackPlan } from './resilience.plan';
import type { FailureClass, FallbackTrigger, ResilienceContext } from './resilience.types';

/**
 * Trigger of a final failure (section 5.1): the engine rejection kind, `'quota'` for a
 * quota-forced open circuit, else the failure class. Key and definition errors have none.
 */
export function fallbackTrigger(
  error: unknown,
  lastClass: FailureClass | undefined,
): FallbackTrigger | undefined {
  const rejection = rejectionTrigger(error);
  if (rejection === 'none') return undefined;
  if (rejection !== undefined) return rejection;
  return lastClass ?? 'unknown';
}

/** Runs the fallback (value or channel); a failure becomes `FallbackFailedError` (RS-26). */
export async function runFallback(
  plan: FallbackPlan,
  error: unknown,
  ctx: ResilienceContext,
  channelRunner: ((channel: string, ctx: ResilienceContext) => Promise<unknown>) | undefined,
  attempts: number,
): Promise<unknown> {
  try {
    if (plan.value !== undefined) return await plan.value(error, ctx);
    if (channelRunner === undefined) throw new Error('no fallback channel runner on this edge');
    return await channelRunner(plan.channel ?? '', ctx);
  } catch (cause) {
    throw new FallbackFailedError({
      binding: ctx.binding,
      edge: ctx.edge,
      attempts,
      cause,
      original: error,
    });
  }
}
