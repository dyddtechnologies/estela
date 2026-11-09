import { Logger } from '@nestjs/common';
import { defaultInProcessClassifier } from '../resilience/classifiers';
import type { ResilienceEdgeAdapter, ResilienceExecutor } from '../resilience/executor';
import {
  expandPolicyRef,
  resolveResiliencePlan,
  type ResiliencePlan,
} from '../resilience/resilience.plan';
import type {
  ResilienceLogger,
  ResilienceModuleOptions,
  ResiliencePolicy,
  ResilienceRef,
} from '../resilience/resilience.types';
import { ResilienceRuntime } from '../resilience/runtime';
import { AttemptTimeoutError } from '../resilience/timeout';
import { SagaDefinitionError } from './concurrency-errors';

const EDGE = 'saga-outbound';

/** Binding name of a saga outbound step in plans, events and errors: `<saga>:<step>`. */
export function sagaStepBinding(sagaName: string, stepName: string): string {
  return `${sagaName}:${stepName}`;
}

function hasFallback(policy: ResiliencePolicy | false | undefined): boolean {
  return policy !== undefined && policy !== false && policy.fallback !== undefined;
}

function fallbackError(binding: string, origin: string): SagaDefinitionError {
  return new SagaDefinitionError(
    `${binding}: resilience.fallback ${origin} is not allowed on a saga outbound step; it would hide the failure and skip the compensation`,
  );
}

function assertIdempotentRetry(plan: ResiliencePlan): void {
  const retry = plan.retry;
  if (retry === undefined || retry.maxAttempts <= 1 || retry.idempotent) return;
  throw new SagaDefinitionError(
    `${plan.binding}: resilience.retry.maxAttempts > 1 on a saga outbound step needs retry.idempotent: true`,
  );
}

/**
 * RS-38, checked when `.outbound()` is declared: an inline fallback is refused, and an inline
 * policy without a profile is resolved so a retry without `idempotent: true` and any invalid
 * value fail here. A profile reference is resolved on the first run, against the runner options.
 */
export function validateOutboundResilience(
  sagaName: string,
  stepName: string,
  ref: ResilienceRef | undefined,
): void {
  if (ref === undefined || ref === false || typeof ref === 'string') return;
  const binding = sagaStepBinding(sagaName, stepName);
  if (hasFallback(ref)) throw fallbackError(binding, 'set on the step');
  if (Object.hasOwn(ref, 'use')) return;
  assertIdempotentRetry(resolveResiliencePlan(binding, [ref], EDGE));
}

function nestLogger(): ResilienceLogger {
  const logger = new Logger('EstelaResilience');
  return {
    log: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
    debug: (message) => logger.debug(message),
  };
}

function stepAdapter(binding: string): ResilienceEdgeAdapter {
  return {
    kind: EDGE,
    classify: (error) => defaultInProcessClassifier(error),
    // Repeatable only when declared idempotent (checked at definition): a step has no key.
    repeatable: () => false,
    safe: () => false,
    timeoutError: (_ctx, timeoutMs) => new AttemptTimeoutError(binding, timeoutMs),
  };
}

interface OutboundResilienceStep {
  readonly name: string;
  readonly resilience?: ResilienceRef;
}

/**
 * Resolves and caches the executor of each saga outbound step (RS-38). Executors are cached per
 * step object, so a step's breaker, bulkhead and rate limiter persist across runs of the runner.
 * The runner builds its own runtime from `ResilienceModuleOptions`, with the retry budget off.
 */
export class SagaResilience {
  private runtime: ResilienceRuntime | undefined;
  private readonly executors = new WeakMap<object, ResilienceExecutor<void> | null>();

  constructor(option: ResilienceModuleOptions | ResilienceRuntime | undefined) {
    if (option instanceof ResilienceRuntime) this.runtime = option;
    else if (option !== undefined)
      this.runtime = new ResilienceRuntime(option, { enabled: false, logger: nestLogger() });
  }

  /** The executor of a step, or undefined when no level gives it a policy. */
  executorFor(
    sagaName: string,
    step: OutboundResilienceStep,
  ): ResilienceExecutor<void> | undefined {
    const cached = this.executors.get(step);
    if (cached !== undefined) return cached ?? undefined;
    const executor = this.resolve(sagaName, step);
    this.executors.set(step, executor ?? null);
    return executor;
  }

  private resolve(
    sagaName: string,
    step: OutboundResilienceStep,
  ): ResilienceExecutor<void> | undefined {
    const inherited = this.runtime?.options.defaults?.[EDGE];
    if (step.resilience === undefined && inherited === undefined) return undefined;
    this.runtime ??= new ResilienceRuntime({}, { enabled: false, logger: nestLogger() });
    const runtime = this.runtime;
    const binding = sagaStepBinding(sagaName, step.name);
    const policies = runtime.options.policies;
    const own = expandPolicyRef(binding, step.resilience, policies);
    if (hasFallback(own)) throw fallbackError(binding, 'resolved from the step reference');
    if (own === false) return undefined;
    let base = expandPolicyRef(binding, inherited, policies);
    if (base !== undefined && base !== false && hasFallback(base)) {
      runtime.observer.logger.warn(
        `${binding}: resilience.fallback inherited from resilience.defaults.saga-outbound is not allowed on a saga outbound step and was dropped`,
      );
      const copy = { ...base };
      delete copy.fallback;
      base = copy;
    }
    const plan = runtime.plan(binding, [own, base], EDGE);
    assertIdempotentRetry(plan);
    return runtime.executor<void>(plan, stepAdapter(binding));
  }
}
