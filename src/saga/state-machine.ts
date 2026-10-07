/**
 * Typed finite state machine: the allowed transitions of an entity, declared once. A lock
 * protects one unit of work; a state machine plus compare-and-set (see transition.ts) protects an
 * invariant across a whole saga, outbound calls included.
 *
 *   const Instance = defineStateMachine('instance', {
 *     PENDING: ['RUNNING', 'CANCELLED'],
 *     RUNNING: ['DONE', 'FAILED'],
 *     DONE: [], FAILED: [], CANCELLED: [],
 *   });
 */
type Targets<M> = { readonly [K in keyof M]: readonly (keyof M & string)[] };

export type StateOf<M> = keyof M & string;

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  isState(value: unknown): value is S;
  canTransition(from: S, to: S): boolean;
  /** Throws IllegalTransitionError when `from` cannot move to `to`. */
  assertTransition(from: S, to: S): void;
  /** States that may move to `to` (precomputed inverse map, frozen). */
  sourcesOf(to: S): readonly S[];
  targetsOf(from: S): readonly S[];
  /** A state with no outgoing transition. */
  isTerminal(state: S): boolean;
}

/** A transition the machine does not allow: a logic error, never retried. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: readonly string[],
    readonly to: string,
  ) {
    super(`ILLEGAL_TRANSITION: ${machine} [${from.join(', ')}] -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

const NONE: readonly never[] = Object.freeze([]);

function readTargets(name: string, map: Record<string, unknown>): Map<string, readonly string[]> {
  const states = Object.keys(map);
  if (states.length === 0) throw new TypeError(`state machine ${name} has no states`);
  const targets = new Map<string, readonly string[]>();
  for (const state of states) {
    const list: unknown = map[state];
    if (!Array.isArray(list)) {
      throw new TypeError(`state machine ${name}: targets of ${state} must be an array`);
    }
    const values = list as unknown[];
    for (const target of values) {
      if (typeof target !== 'string' || !Object.hasOwn(map, target)) {
        throw new TypeError(`state machine ${name}: ${state} -> ${String(target)} is not a state`);
      }
    }
    if (new Set(values).size !== values.length) {
      throw new TypeError(`state machine ${name}: ${state} lists a target twice`);
    }
    targets.set(state, Object.freeze([...(values as string[])]));
  }
  return targets;
}

function invert(targets: ReadonlyMap<string, readonly string[]>): Map<string, readonly string[]> {
  const sources = new Map<string, string[]>();
  for (const [from, list] of targets) {
    for (const to of list) sources.set(to, [...(sources.get(to) ?? []), from]);
  }
  return new Map([...sources].map(([to, list]) => [to, Object.freeze(list)]));
}

/**
 * Declares a machine. Every state must be a key (a final one is `X: []`); targets must be keys.
 * Targets keep their literal types through the `Targets<M>` constraint alone. A `const` type
 * parameter is TS 5.0+ syntax, and the emitted .d.ts must still parse on TS 4.9
 * (test/dist-typescript4.spec.ts).
 */
export function defineStateMachine<M extends Targets<M>>(
  name: string,
  map: M,
): StateMachine<StateOf<M>> {
  type S = StateOf<M>;
  const targets = readTargets(name, map);
  const sources = invert(targets);
  const states = Object.freeze([...targets.keys()] as S[]);
  const machine: StateMachine<S> = {
    name,
    states,
    isState: (value: unknown): value is S => typeof value === 'string' && targets.has(value),
    canTransition: (from, to) => targets.get(from)?.includes(to) ?? false,
    assertTransition: (from, to) => {
      if (!machine.canTransition(from, to)) throw new IllegalTransitionError(name, [from], to);
    },
    sourcesOf: (to) => (sources.get(to) ?? NONE) as readonly S[],
    targetsOf: (from) => (targets.get(from) ?? NONE) as readonly S[],
    isTerminal: (state) => (targets.get(state)?.length ?? 0) === 0,
  };
  return Object.freeze(machine);
}
