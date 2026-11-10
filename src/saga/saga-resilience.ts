import { Logger } from '@nestjs/common';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import type { CareEdgeAdapter, CareExecutor } from '../resilience/executor';
import { expandCareRef, resolveCarePlan, type CarePlan } from '../resilience/resilience.plan';
import type { CareLogger, CareModuleOptions, Care, CareRef } from '../resilience/resilience.types';
import { CareEngine } from '../resilience/runtime';
import { TryOverdueError } from '../resilience/timeout';
import { SagaDefinitionError } from './concurrency-errors';

const EDGE = 'saga-outbound';

/** Binding name of a saga outbound step in plans, events and errors: `<saga>:<step>`. */
export function sagaStepBinding(sagaName: string, stepName: string): string {
  return `${sagaName}:${stepName}`;
}

function hasFallback(care: Care | false | undefined): boolean {
  return care !== undefined && care !== false && care.planB !== undefined;
}

function planBError(binding: string, origin: string): SagaDefinitionError {
  return new SagaDefinitionError(
    `${binding}: care.planB ${origin} is not allowed on a saga outbound step; it would hide the failure and skip the compensation`,
  );
}

function assertIdempotentTries(plan: CarePlan): void {
  const tries = plan.tries;
  if (tries === undefined || tries.max <= 1 || tries.idempotent) return;
  throw new SagaDefinitionError(
    `${plan.binding}: care.tries.max > 1 on a saga outbound step needs tries.idempotent: true`,
  );
}

/**
 * RS-38, checked when `.outbound()` is declared: an inline plan B is refused, and inline care
 * without a profile is resolved so extra tries without `idempotent: true` and any invalid value
 * fail here. A profile reference is resolved on the first run, against the runner options.
 */
export function validateOutboundCare(
  sagaName: string,
  stepName: string,
  ref: CareRef | undefined,
): void {
  if (ref === undefined || ref === false || typeof ref === 'string') return;
  const binding = sagaStepBinding(sagaName, stepName);
  if (hasFallback(ref)) throw planBError(binding, 'set on the step');
  if (Object.hasOwn(ref, 'use')) return;
  assertIdempotentTries(resolveCarePlan(binding, [ref], EDGE));
}

function nestLogger(): CareLogger {
  const logger = new Logger('EstelaCare');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
    debug: (message) => logger.debug(message),
  };
}

function stepAdapter(binding: string): CareEdgeAdapter {
  return {
    kind: EDGE,
    classify: (error) => defaultInProcessClassifier(error),
    // Repeatable only when declared idempotent (checked at definition): a step has no key.
    repeatable: () => false,
    safe: () => false,
    overdueError: (_ctx, eachTryMs) => new TryOverdueError(binding, eachTryMs),
  };
}

interface OutboundCareStep {
  readonly name: string;
  readonly care?: CareRef;
}

/**
 * Resolves and caches the executor of each saga outbound step (RS-38). Executors are cached per
 * step object, so a step's valve, lanes and pace persist across runs of the runner.
 * The runner builds its own engine from `CareModuleOptions`, with tries left off.
 */
export class SagaCare {
  private runtime: CareEngine | undefined;
  private readonly executors = new WeakMap<object, CareExecutor<void> | null>();

  constructor(option: CareModuleOptions | CareEngine | undefined) {
    if (option instanceof CareEngine) this.runtime = option;
    else if (option !== undefined)
      this.runtime = new CareEngine(option, { enabled: false, logger: nestLogger() });
  }

  /** The executor of a step, or undefined when no level gives it care. */
  executorFor(sagaName: string, step: OutboundCareStep): CareExecutor<void> | undefined {
    const cached = this.executors.get(step);
    if (cached !== undefined) return cached ?? undefined;
    const executor = this.resolve(sagaName, step);
    this.executors.set(step, executor ?? null);
    return executor;
  }

  private resolve(sagaName: string, step: OutboundCareStep): CareExecutor<void> | undefined {
    const inherited = this.runtime?.options.defaults?.[EDGE];
    if (step.care === undefined && inherited === undefined) return undefined;
    this.runtime ??= new CareEngine({}, { enabled: false, logger: nestLogger() });
    const runtime = this.runtime;
    const binding = sagaStepBinding(sagaName, step.name);
    const profiles = runtime.options.profiles;
    const own = expandCareRef(binding, step.care, profiles);
    if (hasFallback(own)) throw planBError(binding, 'resolved from the step reference');
    if (own === false) return undefined;
    let base = expandCareRef(binding, inherited, profiles);
    if (base !== undefined && base !== false && hasFallback(base)) {
      runtime.observer.logger.warn(
        `${binding}: care.planB inherited from care.defaults.saga-outbound is not allowed on a saga outbound step and was dropped`,
      );
      const copy = { ...base };
      delete copy.planB;
      base = copy;
    }
    const plan = runtime.plan(binding, [own, base], EDGE);
    assertIdempotentTries(plan);
    return runtime.executor<void>(plan, stepAdapter(binding));
  }
}
