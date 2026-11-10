import { currentTrySignal } from '../resilience/executor';
import { ValveShutError, CareConfigError } from '../resilience/resilience.errors';
import type { CareLogger, CareRef } from '../resilience/resilience.types';
import { CareEngine } from '../resilience/runtime';
import { TryOverdueError } from '../resilience/timeout';
import { HopLogger } from '../trace/hop-logger';
import { SagaDefinitionError } from './concurrency-errors';
import { saga, type OutboundOptions } from './saga';
import { SagaRunner, type SagaRunnerOptions } from './saga-runner';
import type { TransactionPort } from './transaction-port';

/** Fake database: counts transactions, commits staged writes. */
class FakeDb {
  committed: string[] = [];
  transactions = 0;
  readonly port: TransactionPort<string[]> = {
    run: async <T>(work: (tx: string[]) => Promise<T>): Promise<T> => {
      this.transactions += 1;
      const staged: string[] = [];
      const result = await work(staged);
      this.committed.push(...staged);
      return result;
    },
  };
}

interface Ctx {
  trail: string[];
}

class Transient extends Error {
  readonly retryable = true;
}

function recordingLogger(): CareLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
  };
}

/** A saga whose single outbound step runs `run` under `care`, with a recorded compensation. */
function outboundSaga(
  run: (ctx: Ctx) => Promise<void> | void,
  care: CareRef | undefined,
  name = 'pay',
) {
  const options: OutboundOptions<Ctx, string[]> = {
    compensate: (ctx, tx) => {
      ctx.trail.push('compensate');
      tx.push('compensated');
    },
  };
  if (care !== undefined) options.care = care;
  return saga<Ctx, string[], string[]>(name)
    .transaction('claim', (ctx, tx) => {
      ctx.trail.push('claim');
      tx.push('claimed');
    })
    .outbound('charge', run, options)
    .reply((ctx) => ctx.trail);
}

function runner(db: FakeDb, extra: Partial<SagaRunnerOptions<string[]>> = {}) {
  return new SagaRunner<string[]>({ transactions: db.port, ...extra });
}

describe('saga outbound step care (RS-38)', () => {
  it('RU-38a extra tries the step, then compensates once, then rethrows the last error', async () => {
    const db = new FakeDb();
    const errors: Error[] = [];
    const definition = outboundSaga(
      (ctx) => {
        ctx.trail.push('charge');
        const error = new Transient(`attempt ${errors.length + 1}`);
        errors.push(error);
        throw error;
      },
      { tries: { max: 3, idempotent: true, spacing: 0 } },
    );
    const ctx: Ctx = { trail: [] };
    const failure: unknown = await runner(db)
      .run(definition, ctx)
      .catch((error: unknown) => error);
    expect(failure).toBe(errors[2]);
    expect(ctx.trail).toEqual(['claim', 'charge', 'charge', 'charge', 'compensate']);
    expect(db.committed).toEqual(['claimed', 'compensated']);
  });

  it('RU-38a logs one outbound hop for the whole care', async () => {
    const db = new FakeDb();
    const logger = new HopLogger();
    const hopStart = jest.spyOn(logger, 'hopStart').mockImplementation(() => undefined);
    const hopEnd = jest.spyOn(logger, 'hopEnd').mockImplementation(() => undefined);
    jest.spyOn(logger, 'flowStart').mockImplementation(() => undefined);
    jest.spyOn(logger, 'flowEnd').mockImplementation(() => undefined);
    let calls = 0;
    const definition = outboundSaga(
      () => {
        calls += 1;
        if (calls < 3) throw new Transient('flaky');
      },
      { tries: { max: 3, idempotent: true, spacing: 0 } },
    );
    await runner(db, { logger }).run(definition, { trail: [] });
    expect(calls).toBe(3);
    const outboundHops = hopStart.mock.calls.filter(([, target]) => target === 'outbound:charge');
    expect(outboundHops).toHaveLength(1);
    const ends = hopEnd.mock.calls.filter(([, target]) => target === 'outbound:charge');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.[3]).toBe(true);
  });

  it('RU-38a does not extra try a failure the in-process classifier does not mark retryable', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(
      () => {
        calls += 1;
        throw new Error('plain failure');
      },
      { tries: { max: 3, idempotent: true, spacing: 0 } },
    );
    await expect(runner(db).run(definition, { trail: [] })).rejects.toThrow('plain failure');
    expect(calls).toBe(1);
  });

  it('RU-38a resolves a profile name against the runner care options', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, 'saga-std');
    const options = {
      care: {
        profiles: { 'saga-std': { tries: { max: 2, idempotent: true, spacing: 0 } } },
      },
    };
    await expect(runner(db, options).run(definition, { trail: [] })).rejects.toThrow('down');
    expect(calls).toBe(2);
  });

  it('RU-38a applies defaults[saga-outbound] and drops an inherited plan B with one warning', async () => {
    const logger = recordingLogger();
    const runtime = new CareEngine(
      {
        logger,
        defaults: {
          'saga-outbound': {
            tries: { max: 2, idempotent: true, spacing: 0 },
            planB: { value: () => 'hidden' },
          },
        },
      },
      { enabled: false },
    );
    const db = new FakeDb();
    const sagaRunner = runner(db, { care: runtime });
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, undefined);
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    expect(calls).toBe(4);
    const dropped = logger.warnings.filter((line) => line.includes('planB'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('pay:charge');
  });

  it('RU-38a keeps the valve of a step across runs', async () => {
    const db = new FakeDb();
    const sagaRunner = runner(db);
    let calls = 0;
    const definition = outboundSaga(
      () => {
        calls += 1;
        throw new Transient('down');
      },
      { valve: { minCalls: 2, failPercent: 50, shutMs: 60_000 } },
    );
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    const third: unknown = await sagaRunner
      .run(definition, { trail: [] })
      .catch((error: unknown) => error);
    expect(third).toBeInstanceOf(ValveShutError);
    expect(calls).toBe(2);
  });

  it('RU-38a times an try out with TryOverdueError and exposes the try signal', async () => {
    const db = new FakeDb();
    const signals: (AbortSignal | undefined)[] = [];
    const definition = outboundSaga(
      () => {
        signals.push(currentTrySignal());
        return new Promise<void>(() => undefined);
      },
      { patience: { eachTryMs: 20 } },
    );
    const ctx: Ctx = { trail: [] };
    const failure: unknown = await runner(db)
      .run(definition, ctx)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TryOverdueError);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(ctx.trail).toEqual(['claim', 'compensate']);
  });

  it('RU-38a leaves a step without care as one direct call', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, undefined);
    await expect(
      runner(db, { care: { profiles: {} } }).run(definition, { trail: [] }),
    ).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('RU-38b refuses an inline plan B when the saga is defined', () => {
    expect(() => outboundSaga(() => undefined, { planB: { value: () => undefined } })).toThrow(
      SagaDefinitionError,
    );
    expect(() =>
      outboundSaga(() => undefined, { use: 'p', planB: { value: () => undefined } }),
    ).toThrow(SagaDefinitionError);
  });

  it('RU-38b refuses a extra try without idempotent: true when the saga is defined', () => {
    expect(() => outboundSaga(() => undefined, { tries: { max: 3 } })).toThrow(SagaDefinitionError);
    expect(() => outboundSaga(() => undefined, { tries: {} })).toThrow(SagaDefinitionError);
    expect(() => outboundSaga(() => undefined, { tries: { max: 1 } })).not.toThrow();
  });

  it('RU-38b refuses an invalid inline care when the saga is defined', () => {
    expect(() => outboundSaga(() => undefined, { tries: { max: 0, idempotent: true } })).toThrow(
      CareConfigError,
    );
  });

  it('RU-38b refuses a plan B resolved from the step profile before any transaction', async () => {
    const db = new FakeDb();
    const definition = outboundSaga(() => undefined, 'with-fallback');
    const options = {
      care: { profiles: { 'with-fallback': { planB: { value: () => 'x' } } } },
    };
    await expect(runner(db, options).run(definition, { trail: [] })).rejects.toThrow(
      SagaDefinitionError,
    );
    expect(db.transactions).toBe(0);
  });

  it('RU-38b refuses a non-idempotent extra try resolved from a profile or a default before any transaction', async () => {
    const db = new FakeDb();
    const fromProfile = runner(db, {
      care: { profiles: { 'retry-3': { tries: { max: 3 } } } },
    });
    await expect(
      fromProfile.run(
        outboundSaga(() => undefined, 'retry-3'),
        { trail: [] },
      ),
    ).rejects.toThrow(SagaDefinitionError);
    const fromDefault = runner(db, {
      care: { defaults: { 'saga-outbound': { tries: { max: 2 } } } },
    });
    await expect(
      fromDefault.run(
        outboundSaga(() => undefined, undefined),
        { trail: [] },
      ),
    ).rejects.toThrow(SagaDefinitionError);
    expect(db.transactions).toBe(0);
  });

  it('RU-38b fails an unknown profile with CareConfigError before any transaction', async () => {
    const db = new FakeDb();
    await expect(
      runner(db).run(
        outboundSaga(() => undefined, 'missing'),
        { trail: [] },
      ),
    ).rejects.toThrow(CareConfigError);
    expect(db.transactions).toBe(0);
  });
});
