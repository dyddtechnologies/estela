import { manualCareClock } from '../testing/manual-resilience-clock';
import { MemoryCareState } from '../testing/memory-resilience-state-port';
import { ValveShutError } from './resilience.errors';
import { ctxOf, harness, settle, transient } from './test-kit.spec-helper';

/** RS-23: pods sharing one breaker key through a state port, on one manual clock. */
function pods(count: number, probes = 1) {
  const clock = manualCareClock();
  const port = new MemoryCareState(() => clock.wall());
  const policy = {
    valve: {
      minCalls: 1,
      window: { type: 'count' as const, size: 1 },
      shutMs: 1000,
      syncMs: 10,
      probes,
      state: port,
    },
  };
  return {
    clock,
    port,
    engines: Array.from({ length: count }, () => harness<string>(policy, { clock }).exec),
  };
}

describe('shared circuit valve probing (RS-23)', () => {
  it('only one pod probes after the open period, the opener included', async () => {
    const { clock, engines } = pods(3);
    const [opener, ...others] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.flush();
    for (const other of others) {
      await expect(other.execute(ctxOf(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(
        ValveShutError,
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
    expect(calls.filter((call) => call.error instanceof ValveShutError)).toHaveLength(2);
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
    expect(opener!.valveState()).toEqual({ state: 'flowing' });
  });

  it('a plan-B-marked state port leaves the probing decision to the local valve', async () => {
    const { clock, port, engines } = pods(1);
    const [opener] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.advance(1000);
    port.down();
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('a'))).resolves.toMatchObject({
      value: 'a',
    });
  });

  it('RS-49: a resume on the opener clears the cached mark on a pod that saw it', async () => {
    const { clock, engines } = pods(2);
    const [opener, other] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.flush();
    await expect(other!.execute(ctxOf(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(
      ValveShutError,
    );
    await opener!.resume();
    await clock.advance(10);
    await expect(other!.execute(ctxOf(), () => Promise.resolve('y'))).resolves.toMatchObject({
      value: 'y',
    });
  });

  it('RS-49: a resume on a pod that only saw the mark reopens the opener', async () => {
    const { clock, engines } = pods(2);
    const [opener, other] = engines;
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.flush();
    await other!.resume();
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(
      ValveShutError,
    );
    await clock.advance(10);
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('y'))).resolves.toMatchObject({
      value: 'y',
    });
    expect(opener!.valveState()).toEqual({ state: 'flowing' });
  });

  it('a mark the opener never stored does not reopen it when the state comes back', async () => {
    const { clock, port, engines } = pods(1);
    const [opener] = engines;
    port.down();
    await opener!.execute(ctxOf(), () => Promise.reject(transient())).catch(() => undefined);
    await clock.flush();
    port.up();
    await clock.advance(10);
    await expect(opener!.execute(ctxOf(), () => Promise.resolve('x'))).rejects.toBeInstanceOf(
      ValveShutError,
    );
    expect(opener!.valveState()).toEqual({ state: 'shut' });
  });
});
