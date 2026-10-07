import { MemoryTransitionPort } from '../testing/memory-transition-port';
import { ConcurrencyError } from './concurrency-errors';
import { defineStateMachine, IllegalTransitionError } from './state-machine';
import {
  StaleStateError,
  transition,
  TransitionOutcomeUnknownError,
  type TransitionPort,
} from './transition';

const Instance = defineStateMachine('instance', {
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['DONE', 'FAILED', 'RUNNING'],
  DONE: [],
  FAILED: ['PENDING'],
  CANCELLED: [],
});

describe('defineStateMachine (U13)', () => {
  it('rejects an unknown target at compile time and at run time', () => {
    // @ts-expect-error 'GONE' is not a state of the machine
    expect(() => defineStateMachine('bad', { A: ['GONE'] })).toThrow(TypeError);
    expect(() => defineStateMachine('bad', {})).toThrow('no states');
    expect(() => defineStateMachine('bad', { A: ['A', 'A'] } as unknown as { A: ['A'] })).toThrow(
      'twice',
    );
    expect(() => defineStateMachine('bad', { A: 'A' } as unknown as { A: ['A'] })).toThrow(
      'must be an array',
    );
    expect(() => defineStateMachine('bad', { A: ['toString'] } as unknown as { A: ['A'] })).toThrow(
      'is not a state',
    );
  });

  it('answers sourcesOf, targetsOf, isTerminal and canTransition', () => {
    expect(Instance.states).toEqual(['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED']);
    expect(Instance.sourcesOf('RUNNING')).toEqual(['PENDING', 'RUNNING']);
    expect(Instance.sourcesOf('PENDING')).toEqual(['FAILED']);
    expect(Instance.targetsOf('RUNNING')).toEqual(['DONE', 'FAILED', 'RUNNING']);
    expect(Instance.isTerminal('DONE')).toBe(true);
    expect(Instance.isTerminal('FAILED')).toBe(false);
    expect(Instance.canTransition('PENDING', 'DONE')).toBe(false);
    expect(Instance.canTransition('PENDING', 'PENDING')).toBe(false);
    expect(Instance.canTransition('RUNNING', 'RUNNING')).toBe(true);
    expect(Instance.isState('DONE')).toBe(true);
    expect(Instance.isState('toString')).toBe(false);
    expect(() => Instance.assertTransition('DONE', 'RUNNING')).toThrow(IllegalTransitionError);
    expect(Object.isFrozen(Instance)).toBe(true);
    expect(Object.isFrozen(Instance.sourcesOf('RUNNING'))).toBe(true);
  });
});

describe('transition (U13)', () => {
  const spyPort = (result: unknown): TransitionPort<null> & { calls: number } => {
    const port = {
      calls: 0,
      compareAndSet: () => {
        port.calls += 1;
        return Promise.resolve(result as { affected: number });
      },
    };
    return port;
  };

  it('throws IllegalTransitionError before calling the port', async () => {
    const port = spyPort({ affected: 1 });
    await expect(
      transition(Instance, port, null, { id: 1, to: 'DONE', from: 'PENDING' }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    await expect(
      transition(Instance, port, null, { id: 1, to: 'RUNNING', from: ['PENDING', 'DONE'] }),
    ).rejects.toMatchObject({ machine: 'instance', from: ['PENDING', 'DONE'], to: 'RUNNING' });
    await expect(
      transition(Instance, port, null, { id: 1, to: 'RUNNING', from: [] }),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
    const Lonely = defineStateMachine('lonely', { A: ['B'], B: [], C: [] });
    await expect(transition(Lonely, port, null, { id: 1, to: 'A' })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(
      transition(Instance, port, null, { id: 1, to: 'RUNNING', expectedVersion: 1.5 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(port.calls).toBe(0);
  });

  it('defaults from to sourcesOf(to) and passes the expected version', async () => {
    const port = new MemoryTransitionPort<null>();
    port.seed('a', 'PENDING', 3);
    await expect(
      transition(Instance, port, null, { id: 'a', to: 'RUNNING', expectedVersion: 3 }),
    ).resolves.toEqual({ id: 'a', from: ['PENDING', 'RUNNING'], to: 'RUNNING', version: 4 });
    expect(port.commands[0]).toEqual({
      machine: 'instance',
      id: 'a',
      from: ['PENDING', 'RUNNING'],
      to: 'RUNNING',
      expectedVersion: 3,
    });
    await expect(
      transition(Instance, port, null, { id: 'a', to: 'DONE', expectedVersion: 3 }),
    ).rejects.toMatchObject({ kind: 'stale-state', expectedVersion: 3, id: 'a', to: 'DONE' });
  });

  it.each([
    [0, 'stale'],
    [1, 'ok'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    [Number.NaN, 'unknown'],
    [2, 'unknown'],
    [1.5, 'unknown'],
    [-1, 'unknown'],
    ['1', 'unknown'],
  ])('maps affected=%p to %s', async (affected, outcome) => {
    const run = transition(Instance, spyPort({ affected }), null, { id: 7, to: 'DONE' });
    if (outcome === 'ok') {
      await expect(run).resolves.toEqual({ id: 7, from: ['RUNNING'], to: 'DONE' });
    } else if (outcome === 'stale') {
      const error = await run.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StaleStateError);
      expect(error).toBeInstanceOf(ConcurrencyError);
    } else {
      await expect(run).rejects.toBeInstanceOf(TransitionOutcomeUnknownError);
    }
  });

  it('treats a port that resolves to nothing as an unknown outcome', async () => {
    await expect(
      transition(Instance, spyPort(undefined), null, { id: 7, to: 'DONE' }),
    ).rejects.toThrow('exact integer row count');
  });

  it('lets MemoryTransitionPort inject an error', async () => {
    const port = new MemoryTransitionPort<null>();
    port.forceNext(new Error('driver down'));
    await expect(transition(Instance, port, null, { id: 1, to: 'DONE' })).rejects.toThrow(
      'driver down',
    );
    expect(port.get('missing')).toBeUndefined();
  });
});

describe('transition typing (U13)', () => {
  it('rejects a misspelled to or from at compile time instead of widening the state type', async () => {
    const port = new MemoryTransitionPort<null>();
    port.seed(7, 'PENDING');
    const misspelled = async (): Promise<void> => {
      // @ts-expect-error 'CANCELED' is not a state of Instance (it is 'CANCELLED').
      await transition(Instance, port, null, { id: 7, to: 'CANCELED' });
      // @ts-expect-error 'NOPE' is not a state of Instance.
      await transition(Instance, port, null, { id: 7, to: 'DONE', from: 'NOPE' });
      // @ts-expect-error 'NOPE' is not a state of Instance.
      await transition(Instance, port, null, { id: 7, to: 'DONE', from: ['RUNNING', 'NOPE'] });
    };
    await expect(misspelled()).rejects.toBeInstanceOf(IllegalTransitionError);
    expect(port.commands).toEqual([]);
    const outcome = await transition(Instance, port, null, { id: 7, to: 'RUNNING' });
    const to: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED' = outcome.to;
    expect(to).toBe('RUNNING');
  });
});
