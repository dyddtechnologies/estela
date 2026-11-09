/** Resilience spec section 3.9: the runtime values each public entry must export. */
import * as main from '../src/index';
import * as testing from '../src/testing/index';

const MAIN_VALUES = [
  'ResilienceError',
  'CircuitOpenError',
  'BulkheadFullError',
  'RateLimitedError',
  'DeadlineExceededError',
  'FallbackFailedError',
  'ResilienceKeyError',
  'ResilienceDefinitionError',
  'ResilienceExecutor',
  'ResilienceRegistry',
  'currentResilienceSignal',
  'defaultRestClassifier',
  'defaultGrpcClassifier',
  'defaultInProcessClassifier',
  'parseRetryAfter',
  'parseRetryBudget',
  'redisResilienceStatePort',
  'InboundOverloadedError',
  'FlowDefinitionError',
];

const TESTING_VALUES = [
  'manualResilienceClock',
  'MemoryResilienceStatePort',
  'collectResilienceEvents',
];

describe('resilience barrels (spec section 3.9)', () => {
  it.each(MAIN_VALUES)('@estela/nest exports %s', (name) => {
    expect((main as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(TESTING_VALUES)('@estela/nest/testing exports %s', (name) => {
    expect((testing as Record<string, unknown>)[name]).toBeDefined();
  });
});
