import { currentResilienceSignal } from '../resilience/executor';
import { CircuitOpenError, ResilienceDefinitionError } from '../resilience/resilience.errors';
import type { ResilienceLogger, ResilienceRef } from '../resilience/resilience.types';
import { ResilienceRuntime } from '../resilience/runtime';
import { AttemptTimeoutError } from '../resilience/timeout';
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

function recordingLogger(): ResilienceLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: () => undefined,
    warn: (message) => warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
  };
}

/** A saga whose single outbound step runs `run` under `resilience`, with a recorded compensation. */
function outboundSaga(
  run: (ctx: Ctx) => Promise<void> | void,
  resilience: ResilienceRef | undefined,
  name = 'pay',
) {
  const options: OutboundOptions<Ctx, string[]> = {
    compensate: (ctx, tx) => {
      ctx.trail.push('compensate');
      tx.push('compensated');
    },
  };
  if (resilience !== undefined) options.resilience = resilience;
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

describe('saga outbound step resilience (RS-38)', () => {
  it('RU-38a retries the step, then compensates once, then rethrows the last error', async () => {
    const db = new FakeDb();
    const errors: Error[] = [];
    const definition = outboundSaga(
      (ctx) => {
        ctx.trail.push('charge');
        const error = new Transient(`attempt ${errors.length + 1}`);
        errors.push(error);
        throw error;
      },
      { retry: { maxAttempts: 3, idempotent: true, backoff: 0 } },
    );
    const ctx: Ctx = { trail: [] };
    const failure: unknown = await runner(db)
      .run(definition, ctx)
      .catch((error: unknown) => error);
    expect(failure).toBe(errors[2]);
    expect(ctx.trail).toEqual(['claim', 'charge', 'charge', 'charge', 'compensate']);
    expect(db.committed).toEqual(['claimed', 'compensated']);
  });

  it('RU-38a logs one outbound hop for the whole policy', async () => {
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
      { retry: { maxAttempts: 3, idempotent: true, backoff: 0 } },
    );
    await runner(db, { logger }).run(definition, { trail: [] });
    expect(calls).toBe(3);
    const outboundHops = hopStart.mock.calls.filter(([, target]) => target === 'outbound:charge');
    expect(outboundHops).toHaveLength(1);
    const ends = hopEnd.mock.calls.filter(([, target]) => target === 'outbound:charge');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.[3]).toBe(true);
  });

  it('RU-38a does not retry a failure the in-process classifier does not mark retryable', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(
      () => {
        calls += 1;
        throw new Error('plain failure');
      },
      { retry: { maxAttempts: 3, idempotent: true, backoff: 0 } },
    );
    await expect(runner(db).run(definition, { trail: [] })).rejects.toThrow('plain failure');
    expect(calls).toBe(1);
  });

  it('RU-38a resolves a profile name against the runner resilience options', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, 'saga-std');
    const options = {
      resilience: {
        policies: { 'saga-std': { retry: { maxAttempts: 2, idempotent: true, backoff: 0 } } },
      },
    };
    await expect(runner(db, options).run(definition, { trail: [] })).rejects.toThrow('down');
    expect(calls).toBe(2);
  });

  it('RU-38a applies defaults[saga-outbound] and drops an inherited fallback with one warning', async () => {
    const logger = recordingLogger();
    const runtime = new ResilienceRuntime(
      {
        logger,
        defaults: {
          'saga-outbound': {
            retry: { maxAttempts: 2, idempotent: true, backoff: 0 },
            fallback: { value: () => 'hidden' },
          },
        },
      },
      { enabled: false },
    );
    const db = new FakeDb();
    const sagaRunner = runner(db, { resilience: runtime });
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, undefined);
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    expect(calls).toBe(4);
    const dropped = logger.warnings.filter((line) => line.includes('fallback'));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('pay:charge');
  });

  it('RU-38a keeps the breaker of a step across runs', async () => {
    const db = new FakeDb();
    const sagaRunner = runner(db);
    let calls = 0;
    const definition = outboundSaga(
      () => {
        calls += 1;
        throw new Transient('down');
      },
      { circuitBreaker: { minimumCalls: 2, failureRateThreshold: 50, openMs: 60_000 } },
    );
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    await expect(sagaRunner.run(definition, { trail: [] })).rejects.toThrow('down');
    const third: unknown = await sagaRunner
      .run(definition, { trail: [] })
      .catch((error: unknown) => error);
    expect(third).toBeInstanceOf(CircuitOpenError);
    expect(calls).toBe(2);
  });

  it('RU-38a times an attempt out with AttemptTimeoutError and exposes the attempt signal', async () => {
    const db = new FakeDb();
    const signals: (AbortSignal | undefined)[] = [];
    const definition = outboundSaga(
      () => {
        signals.push(currentResilienceSignal());
        return new Promise<void>(() => undefined);
      },
      { timeout: { perAttemptMs: 20 } },
    );
    const ctx: Ctx = { trail: [] };
    const failure: unknown = await runner(db)
      .run(definition, ctx)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AttemptTimeoutError);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(ctx.trail).toEqual(['claim', 'compensate']);
  });

  it('RU-38a leaves a step without resilience as one direct call', async () => {
    const db = new FakeDb();
    let calls = 0;
    const definition = outboundSaga(() => {
      calls += 1;
      throw new Transient('down');
    }, undefined);
    await expect(
      runner(db, { resilience: { policies: {} } }).run(definition, { trail: [] }),
    ).rejects.toThrow('down');
    expect(calls).toBe(1);
  });

  it('RU-38b refuses an inline fallback when the saga is defined', () => {
    expect(() => outboundSaga(() => undefined, { fallback: { value: () => undefined } })).toThrow(
      SagaDefinitionError,
    );
    expect(() =>
      outboundSaga(() => undefined, { use: 'p', fallback: { value: () => undefined } }),
    ).toThrow(SagaDefinitionError);
  });

  it('RU-38b refuses a retry without idempotent: true when the saga is defined', () => {
    expect(() => outboundSaga(() => undefined, { retry: { maxAttempts: 3 } })).toThrow(
      SagaDefinitionError,
    );
    expect(() => outboundSaga(() => undefined, { retry: {} })).toThrow(SagaDefinitionError);
    expect(() => outboundSaga(() => undefined, { retry: { maxAttempts: 1 } })).not.toThrow();
  });

  it('RU-38b refuses an invalid inline policy when the saga is defined', () => {
    expect(() =>
      outboundSaga(() => undefined, { retry: { maxAttempts: 0, idempotent: true } }),
    ).toThrow(ResilienceDefinitionError);
  });

  it('RU-38b refuses a fallback resolved from the step profile before any transaction', async () => {
    const db = new FakeDb();
    const definition = outboundSaga(() => undefined, 'with-fallback');
    const options = {
      resilience: { policies: { 'with-fallback': { fallback: { value: () => 'x' } } } },
    };
    await expect(runner(db, options).run(definition, { trail: [] })).rejects.toThrow(
      SagaDefinitionError,
    );
    expect(db.transactions).toBe(0);
  });

  it('RU-38b refuses a non-idempotent retry resolved from a profile or a default before any transaction', async () => {
    const db = new FakeDb();
    const fromProfile = runner(db, {
      resilience: { policies: { 'retry-3': { retry: { maxAttempts: 3 } } } },
    });
    await expect(
      fromProfile.run(
        outboundSaga(() => undefined, 'retry-3'),
        { trail: [] },
      ),
    ).rejects.toThrow(SagaDefinitionError);
    const fromDefault = runner(db, {
      resilience: { defaults: { 'saga-outbound': { retry: { maxAttempts: 2 } } } },
    });
    await expect(
      fromDefault.run(
        outboundSaga(() => undefined, undefined),
        { trail: [] },
      ),
    ).rejects.toThrow(SagaDefinitionError);
    expect(db.transactions).toBe(0);
  });

  it('RU-38b fails an unknown profile with ResilienceDefinitionError before any transaction', async () => {
    const db = new FakeDb();
    await expect(
      runner(db).run(
        outboundSaga(() => undefined, 'missing'),
        { trail: [] },
      ),
    ).rejects.toThrow(ResilienceDefinitionError);
    expect(db.transactions).toBe(0);
  });
});
