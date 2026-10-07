import type { CasCommand, CasResult, TransitionPort } from '../saga/transition';

interface Row {
  state: string;
  version: number;
}

/**
 * In-process compare-and-set for unit tests: atomic because Node is single-threaded. It ignores
 * the transaction handle, so a rolled-back unit does NOT undo its writes here. `forceNext`
 * injects the next result (or error) verbatim, e.g. `{ affected: undefined }` to exercise the
 * unknown-outcome path.
 */
export class MemoryTransitionPort<Tx = unknown> implements TransitionPort<Tx> {
  private readonly rows = new Map<string | number, Row>();
  private readonly forced: unknown[] = [];
  readonly commands: CasCommand[] = [];

  seed(id: string | number, state: string, version = 0): void {
    this.rows.set(id, { state, version });
  }

  get(id: string | number): { state: string; version: number } | undefined {
    const row = this.rows.get(id);
    return row === undefined ? undefined : { ...row };
  }

  forceNext(result: unknown): void {
    this.forced.push(result);
  }

  compareAndSet(_tx: Tx, command: CasCommand): Promise<CasResult> {
    this.commands.push(command);
    if (this.forced.length > 0) {
      const forced = this.forced.shift();
      return forced instanceof Error
        ? Promise.reject(forced)
        : Promise.resolve(forced as CasResult);
    }
    const row = this.rows.get(command.id);
    const matches =
      row !== undefined &&
      command.from.includes(row.state) &&
      (command.expectedVersion === undefined || command.expectedVersion === row.version);
    if (!matches) return Promise.resolve({ affected: 0 });
    row.state = command.to;
    row.version += 1;
    return Promise.resolve({ affected: 1, version: row.version });
  }
}
