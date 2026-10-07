import { ConcurrencyError, type ConcurrencyErrorMeta } from './concurrency-errors';
import { IllegalTransitionError, type StateMachine } from './state-machine';

/**
 * Compare-and-set state transitions. The port runs one conditional UPDATE
 * (`... WHERE id = :id AND state IN (:from) [AND version = :expected]`) and reports how many rows
 * it changed; `transition()` turns that count into an outcome. A lost race is NEVER a silent
 * success: 0 rows is a StaleStateError, and any count that is not exactly 0 or 1 is reported as
 * TransitionOutcomeUnknownError.
 */
export interface CasCommand {
  machine: string;
  id: string | number;
  from: readonly string[];
  to: string;
  expectedVersion?: number;
}

export interface CasResult {
  /** MUST be an integer: the exact number of rows changed. */
  affected: number;
  /** New version when the port tracks one. */
  version?: number;
}

export interface TransitionPort<Tx = unknown> {
  compareAndSet(tx: Tx, command: CasCommand): Promise<CasResult>;
}

export interface TransitionRequest<S extends string> {
  id: string | number;
  to: S;
  /** Default: machine.sourcesOf(to). */
  from?: S | readonly S[];
  /** Safe integer. */
  expectedVersion?: number;
}

export interface TransitionOutcome<S extends string> {
  id: string | number;
  from: readonly S[];
  to: S;
  version?: number;
}

/** The row is missing, or its state or version changed under us. */
export class StaleStateError extends ConcurrencyError {
  static override readonly errorKind = 'stale-state';
  readonly kind = 'stale-state';
  readonly machine: string;
  readonly id: string | number;
  readonly from: readonly string[];
  readonly to: string;
  readonly expectedVersion?: number;

  constructor(command: CasCommand, meta: ConcurrencyErrorMeta = {}) {
    const version =
      command.expectedVersion === undefined ? '' : ` at version ${command.expectedVersion}`;
    super(
      `STALE_STATE: ${command.machine} ${String(command.id)} is not in [${command.from.join(', ')}]${version}; transition to ${command.to} not applied`,
      meta,
    );
    this.machine = command.machine;
    this.id = command.id;
    this.from = command.from;
    this.to = command.to;
    if (command.expectedVersion !== undefined) this.expectedVersion = command.expectedVersion;
  }
}

/** The port returned something other than an exact integer row count of 0 or 1. */
export class TransitionOutcomeUnknownError extends Error {
  constructor(
    readonly received: unknown,
    readonly command?: CasCommand,
  ) {
    super(
      `TRANSITION_OUTCOME_UNKNOWN: the transition port must return { affected } as an exact integer row count of 0 or 1, got ${describe(received)}; adapt the driver result in the query function`,
    );
    this.name = 'TransitionOutcomeUnknownError';
  }
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return typeof value === 'number' || value === undefined || value === null
    ? String(value)
    : typeof value;
}

/** Blocks inference from this position. Same effect as TS 5.4 `NoInfer`, which the emitted
 *  .d.ts avoids so that consumers on older TypeScript still compile. */
type StateOnly<S> = [S][S extends unknown ? 0 : never];

function sourcesFor<S extends string>(
  machine: StateMachine<S>,
  request: TransitionRequest<S>,
): readonly S[] {
  if (request.from === undefined) {
    const sources = machine.sourcesOf(request.to);
    if (sources.length === 0) throw new IllegalTransitionError(machine.name, [], request.to);
    return sources;
  }
  const from: readonly S[] = typeof request.from === 'string' ? [request.from] : request.from;
  const unique = [...new Set(from)];
  if (unique.length === 0 || unique.some((state) => !machine.canTransition(state, request.to))) {
    throw new IllegalTransitionError(machine.name, unique, request.to);
  }
  return unique;
}

/**
 * Moves one entity from one of `from` to `to` with compare-and-set. Illegal requests throw before
 * the port is called; a lost race throws StaleStateError, so the unit of work rolls back.
 * S is inferred from the machine only, so a misspelled `to` or `from` is a compile error instead
 * of widening S.
 */
export async function transition<S extends string, Tx>(
  machine: StateMachine<S>,
  port: TransitionPort<Tx>,
  tx: Tx,
  request: TransitionRequest<StateOnly<S>>,
): Promise<TransitionOutcome<S>> {
  const from = sourcesFor(machine, request);
  const expectedVersion = request.expectedVersion;
  if (expectedVersion !== undefined && !Number.isSafeInteger(expectedVersion)) {
    throw new TypeError(`expectedVersion must be a safe integer, got ${String(expectedVersion)}`);
  }
  const command: CasCommand = { machine: machine.name, id: request.id, from, to: request.to };
  if (expectedVersion !== undefined) command.expectedVersion = expectedVersion;
  const result: unknown = await port.compareAndSet(tx, command);
  const affected: unknown =
    typeof result === 'object' && result !== null ? (result as CasResult).affected : result;
  if (affected === 0) throw new StaleStateError(command);
  if (affected !== 1) throw new TransitionOutcomeUnknownError(affected, command);
  const version = (result as CasResult).version;
  const outcome: TransitionOutcome<S> = { id: request.id, from, to: request.to };
  if (version !== undefined) outcome.version = version;
  return outcome;
}
