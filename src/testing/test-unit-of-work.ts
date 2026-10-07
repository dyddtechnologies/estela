import type { UnitOfWork } from '../saga/saga';

type Callback = () => Promise<void> | void;

export interface TestUnitOfWork extends UnitOfWork {
  /** Callbacks registered so far, in registration order. */
  readonly callbacks: readonly Callback[];
  /** Runs the callbacks in order, as the runner does after a commit, then settles the unit. */
  commit(): Promise<void>;
  /** Discards the callbacks, as the runner does after a rollback, then settles the unit. */
  rollback(): void;
}

/**
 * A UnitOfWork for calling a transaction step directly in a unit test, e.g.
 * `await step(ctx, tx, unit); await unit.commit();`. Like the runner's, afterCommit throws once
 * the unit settled (a plain Error: the CJS testing bundle has its own copy of SagaUsageError, so
 * an instanceof check against the main entry's class would fail). Unlike the runner, commit()
 * lets a callback's error propagate, so a test sees it.
 */
export function testUnitOfWork(attempt = 1): TestUnitOfWork {
  const callbacks: Callback[] = [];
  let settled = false;
  const settle = (): void => {
    if (settled) throw new Error('test unit of work already settled');
    settled = true;
  };
  return {
    attempt,
    callbacks,
    afterCommit: (fn) => {
      if (settled) throw new Error('afterCommit called after the test unit of work settled');
      callbacks.push(fn);
    },
    commit: async () => {
      settle();
      for (const callback of callbacks) await callback();
    },
    rollback: () => {
      settle();
      callbacks.length = 0;
    },
  };
}
