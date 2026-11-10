import type { CareExecutor } from './executor';
import type { ValveStateView } from './resilience.types';

/** RS-49. Injectable when forRoot({ care }) is set. Keys are passed raw and never logged. */
export abstract class CareControl {
  abstract valveState(binding: string, key?: string): ValveStateView | undefined;
  /** Reopens the flow through the valve and clears its shared "shut" marks. */
  abstract resume(binding: string, key?: string): Promise<void>;
}

/** Control over the executors an engine created; unknown bindings or keys are a no-op. */
export class RuntimeCareControl extends CareControl {
  private readonly executors = new Map<string, CareExecutor<unknown>[]>();

  track(executor: CareExecutor<unknown>): void {
    const list = this.executors.get(executor.binding) ?? [];
    list.push(executor);
    this.executors.set(executor.binding, list);
  }

  valveState(binding: string, key?: string): ValveStateView | undefined {
    for (const executor of this.executors.get(binding) ?? []) {
      const state = executor.valveState(key);
      if (state !== undefined) return state;
    }
    return undefined;
  }

  async resume(binding: string, key?: string): Promise<void> {
    for (const executor of this.executors.get(binding) ?? []) await executor.resume(key);
  }
}
