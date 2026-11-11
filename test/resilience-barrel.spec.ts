/** Resilience spec section 3.9: the runtime values each public entry must export. */
import * as main from '../src/index';
import * as testing from '../src/testing/index';

const MAIN_VALUES = [
  'CareError',
  'ValveShutError',
  'LanesFullError',
  'OverPaceError',
  'OutOfTimeError',
  'PlanBFailedError',
  'CareKeyError',
  'CareConfigError',
  'CareExecutor',
  'CareControl',
  'currentTrySignal',
  'defaultRestClassifier',
  'defaultGrpcClassifier',
  'defaultInProcessClassifier',
  'parseServerWait',
  'parseTriesLeft',
  'redisCareState',
  'InboundBusyError',
  'FlowDefinitionError',
];

const TESTING_VALUES = ['manualCareClock', 'MemoryCareState', 'collectCareEvents'];

describe('care barrels (spec section 3.9)', () => {
  it.each(MAIN_VALUES)('@estela/nest exports %s', (name) => {
    expect((main as Record<string, unknown>)[name]).toBeDefined();
  });

  it.each(TESTING_VALUES)('@estela/nest/testing exports %s', (name) => {
    expect((testing as Record<string, unknown>)[name]).toBeDefined();
  });
});
