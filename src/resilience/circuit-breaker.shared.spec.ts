import { manualResilienceClock } from '../testing/manual-resilience-clock';
import { MemoryResilienceStatePort } from '../testing/memory-resilience-state-port';
import { CircuitOpenError } from './resilience.errors';
import { ctxOf, harness, settle, transient } from './test-kit.spec-helper';

/** RS-23: pods sharing one breaker key through a state port, on one manual clock. */
function pods(count: number, halfOpenCalls = 1) {
  const clock = manualResilienceClock();
  const port = new MemoryResilienceStatePort(() => clock.wall());
  const policy = {
    circuitBreaker: {
      minimumCalls: 1,
      window: { type: 'count' as const, size: 1 },
      openMs: 1000,
      syncMs: 10,
      halfOpenCalls,
      state: port,
    },
  };
  return {
    clock,
    port,
    engines: Array.from({ length: count }, () => harness<string>(policy, { clock }).exec),
  };
}

describe('shared circuit breaker half-open (RS-23)', () => {
  it('only one pod probes after the open period, the opener included', async () => {
    const { clock, engines } = pods(3);
    const [opener, ...others] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.flush();
    for (const other of others) {
      await expect(other.execute(ctxOf(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(
        CircuitOpenError,
      );
    }
    await clock.advance(1000);
    let probes = 0;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const work = async (): Promise<string> => {
      probes += 1;
      await done;
      return 'ok';
    };
    const calls = engines.map((engine) => settle(engine.execute(ctxOf(), work)));
    await clock.flush();
    finish();
    await clock.flush();
    expect(probes).toBe(1);
    expect(calls.filter((call) => call.value?.value === 'ok')).toHaveLength(1);
    expect(calls.filter((call) => call.error instanceof CircuitOpenError)).toHaveLength(2);
  });

  it('the opener still probes on its own when no other pod holds the lease', async () => {
    const { clock, engines } = pods(1, 2);
    const [opener] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.advance(1000);
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('a'))).resolves.toMatchObject({
      value: 'a',
    });
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('b'))).resolves.toMatchObject({
      value: 'b',
    });
    expect(opener!.breakerState()).toEqual({ state: 'closed' });
  });

  it('a degraded state port leaves the half-open decision to the local breaker', async () => {
    const { clock, port, engines } = pods(1);
    const [opener] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.advance(1000);
    port.down();
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('a'))).resolves.toMatchObject({
      value: 'a',
    });
  });
});
