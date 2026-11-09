import type { ExecutionContext } from '@nestjs/common';
import {
  BulkheadFullError,
  RateLimitedError,
  ResilienceDefinitionError,
} from '../resilience/resilience.errors';
import { expandPolicyRef, type ResiliencePlan } from '../resilience/resilience.plan';
import type {
  InboundShedContext,
  ResilienceContext,
  ResiliencePolicy,
} from '../resilience/resilience.types';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import { parseRetryBudgetValue } from '../resilience/retry-budget';
import type { ResilienceRuntime } from '../resilience/runtime';
import { LoadShedder } from '../resilience/shedder';
import { InboundOverloadedError } from './inbound.failure';
import type { InboundTransportStrategy } from './inbound.transport';
import type { InboundDefaults, InboundSpec } from './inbound.types';

const shedders = new WeakMap<ResilienceRuntime, WeakMap<InboundSpec, LoadShedder | null>>();

/** The shed key function of an inbound policy receives the shed context, not a call context. */
function adaptKey(policy: ResiliencePolicy | undefined): ResiliencePolicy | undefined {
  const rateLimit = policy?.rateLimit;
  if (rateLimit === undefined || rateLimit === false || rateLimit.key === undefined) return policy;
  const key = rateLimit.key as unknown as (ctx: InboundShedContext) => string;
  return {
    ...policy,
    rateLimit: {
      ...rateLimit,
      key: (ctx: ResilienceContext) => key(ctx.data as InboundShedContext),
    },
  };
}

/**
 * RS-37: resolves the load-shedding plan of an endpoint (bulkhead and rateLimit only) or
 * undefined when it has none. Throws `ResilienceDefinitionError` for other primitives and for
 * any resilience on Rabbit.
 */
export function inboundShedPlan(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
  runtime: ResilienceRuntime,
): ResiliencePlan | undefined {
  if (spec.transport === 'rabbit') {
    if (spec.resilience !== undefined) {
      throw new ResilienceDefinitionError(
        spec.channel,
        'transport',
        'is not allowed on @InboundRabbit',
      );
    }
    return undefined;
  }
  if (spec.resilience === undefined && defaults?.resilience === undefined) return undefined;
  const policies = runtime.options.policies;
  const layers = [spec.resilience, defaults?.resilience].map((ref) =>
    adaptKey(expandPolicyRef(spec.channel, ref as never, policies)),
  );
  const plan = runtime.plan(`inbound:${spec.channel}`, layers, 'inbound', {
    allowed: ['bulkhead', 'rateLimit'],
  });
  return plan.empty ? undefined : plan;
}

/** The endpoint's shedder, created once per runtime and spec. */
export function inboundShedder(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
  runtime: ResilienceRuntime,
): LoadShedder | undefined {
  const perRuntime = shedders.get(runtime) ?? new WeakMap<InboundSpec, LoadShedder | null>();
  shedders.set(runtime, perRuntime);
  const cached = perRuntime.get(spec);
  if (cached !== undefined) return cached ?? undefined;
  const plan = inboundShedPlan(spec, defaults, runtime);
  const shedder =
    plan === undefined
      ? null
      : new LoadShedder(
          runtime.executor(plan, {
            kind: 'inbound',
            classify: (error) => defaultInProcessClassifier(error),
            repeatable: () => false,
            timeoutError: () => new Error('inbound shedding has no timeout'),
            defaultKey: () => spec.channel,
          }),
        );
  perRuntime.set(spec, shedder);
  return shedder ?? undefined;
}

export function shedContext(
  context: ExecutionContext,
  spec: InboundSpec,
  strategy: InboundTransportStrategy,
): InboundShedContext {
  return {
    channel: spec.channel,
    transport: spec.transport,
    rawHeaders: strategy.rawHeaders?.(context) ?? {},
    execution: context,
  };
}

/** Maps a shed rejection to `InboundOverloadedError`, setting `Retry-After` on HTTP responses. */
export function overloaded(error: unknown, context: ExecutionContext, spec: InboundSpec): unknown {
  let failure: InboundOverloadedError;
  if (error instanceof RateLimitedError) {
    failure = new InboundOverloadedError(spec.channel, 'rate-limited', error.retryAfterMs);
  } else if (error instanceof BulkheadFullError) {
    failure = new InboundOverloadedError(spec.channel, 'bulkhead-full');
  } else {
    return error;
  }
  if (spec.transport === 'rest' && failure.retryAfterMs !== undefined) {
    setRetryAfter(context, Math.max(1, Math.ceil(failure.retryAfterMs / 1000)));
  }
  return failure;
}

function setRetryAfter(context: ExecutionContext, seconds: number): void {
  const response = context.switchToHttp().getResponse<Record<string, unknown> | undefined>();
  const value = String(seconds);
  if (typeof response?.setHeader === 'function') {
    (response.setHeader as (name: string, value: string) => void).call(
      response,
      'Retry-After',
      value,
    );
  } else if (typeof response?.header === 'function') {
    (response.header as (name: string, value: string) => void).call(response, 'Retry-After', value);
  }
}

/** RS-29: the raw `x-retry-budget` header, only under forRoot({ resilience }). */
export function inboundBudget(
  rawHeaders: Record<string, unknown>,
  runtime: ResilienceRuntime | undefined,
): number | undefined {
  if (runtime?.enabled !== true) return undefined;
  const name = runtime.budgetHeader.toLowerCase();
  const raw = Object.entries(rawHeaders).find(([header]) => header.toLowerCase() === name)?.[1];
  const parsed = parseRetryBudgetValue(raw);
  if (parsed.invalid)
    runtime.observer.counter('estela_resilience_budget_invalid_total', { edge: 'inbound' });
  return parsed.budget ?? runtime.options.retryBudget?.initial;
}
