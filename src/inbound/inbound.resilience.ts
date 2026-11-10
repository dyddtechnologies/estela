import type { ExecutionContext } from '@nestjs/common';
import { LanesFullError, OverPaceError, CareConfigError } from '../resilience/resilience.errors';
import { expandCareRef, type CarePlan } from '../resilience/resilience.plan';
import type { InboundCareContext, CareContext, Care } from '../resilience/resilience.types';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import { parseTriesLeftValue } from '../resilience/retry-budget';
import type { CareEngine } from '../resilience/runtime';
import { LoadShedder } from '../resilience/shedder';
import { InboundBusyError } from './inbound.failure';
import type { InboundTransportStrategy } from './inbound.transport';
import type { InboundDefaults, InboundSpec } from './inbound.types';

const shedders = new WeakMap<CareEngine, WeakMap<InboundSpec, LoadShedder | null>>();

/** The `pace.key` of inbound care receives the inbound context, not a call context. */
// eslint-disable-next-line sonarjs/function-return-type -- a layer stays care, false (cut) or nothing
function adaptKey(care: Care | false | undefined): Care | false | undefined {
  if (care === false) return false;
  const pace = care?.pace;
  if (pace === undefined || pace === false || pace.key === undefined) return care;
  const key = pace.key as unknown as (ctx: InboundCareContext) => string;
  return {
    ...care,
    pace: {
      ...pace,
      key: (ctx: CareContext) => key(ctx.data as InboundCareContext),
    },
  };
}

/**
 * RS-37: resolves the inbound care plan of an endpoint (`lanes` and `pace` only) or undefined
 * when it has none. Throws `CareConfigError` for other parts and for any care on Rabbit.
 */
export function inboundShedPlan(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
  runtime: CareEngine,
): CarePlan | undefined {
  if (spec.transport === 'rabbit') {
    if (spec.care !== undefined) {
      throw new CareConfigError(spec.channel, 'transport', 'is not allowed on @InboundRabbit');
    }
    return undefined;
  }
  if (spec.care === undefined && defaults?.care === undefined) return undefined;
  const profiles = runtime.options.profiles;
  const layers = [spec.care, defaults?.care].map((ref) =>
    adaptKey(expandCareRef(spec.channel, ref as never, profiles)),
  );
  const plan = runtime.plan(`inbound:${spec.channel}`, layers, 'inbound', {
    allowed: ['lanes', 'pace'],
  });
  return plan.empty ? undefined : plan;
}

/** The endpoint's shedder, created once per runtime and spec. */
export function inboundShedder(
  spec: InboundSpec,
  defaults: InboundDefaults | undefined,
  runtime: CareEngine,
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
            overdueError: () => new Error('inbound care has no eachTryMs'),
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
): InboundCareContext {
  return {
    channel: spec.channel,
    transport: spec.transport,
    rawHeaders: strategy.rawHeaders?.(context) ?? {},
    execution: context,
  };
}

/** Maps a turned-away call to `InboundBusyError`, setting `Retry-After` on HTTP responses. */
export function busy(error: unknown, context: ExecutionContext, spec: InboundSpec): unknown {
  let failure: InboundBusyError;
  if (error instanceof OverPaceError) {
    failure = new InboundBusyError(spec.channel, 'over-pace', error.readyInMs);
  } else if (error instanceof LanesFullError) {
    failure = new InboundBusyError(spec.channel, 'lanes-full');
  } else {
    return error;
  }
  if (spec.transport === 'rest' && failure.readyInMs !== undefined) {
    setServerWait(context, Math.max(1, Math.ceil(failure.readyInMs / 1000)));
  }
  return failure;
}

function setServerWait(context: ExecutionContext, seconds: number): void {
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

/** RS-29: the raw `x-tries-left` header, only under forRoot({ care }). */
export function inboundTriesLeft(
  rawHeaders: Record<string, unknown>,
  runtime: CareEngine | undefined,
): number | undefined {
  if (runtime?.enabled !== true) return undefined;
  const name = runtime.triesLeftHeader.toLowerCase();
  const raw = Object.entries(rawHeaders).find(([header]) => header.toLowerCase() === name)?.[1];
  const parsed = parseTriesLeftValue(raw);
  if (parsed.invalid)
    runtime.observer.counter('estela_care_tries_left_invalid_total', { edge: 'inbound' });
  return parsed.triesLeft ?? runtime.options.triesLeft?.initial;
}
