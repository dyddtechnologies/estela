import type { ResilienceExecutor } from './executor';

export interface BreakerStateView {
  state: 'closed' | 'open' | 'half-open';
  forcedBy?: 'quota';
}

/** RS-49. Injectable when forRoot({ resilience }) is set. Keys are passed raw and never logged. */
export abstract class ResilienceRegistry {
  abstract breakerState(binding: string, key?: string): BreakerStateView | undefined;
  abstract resetBreaker(binding: string, key?: string): Promise<void>;
}

/** Registry over the executors a runtime created; unknown bindings or keys are a no-op. */
export class RuntimeResilienceRegistry extends ResilienceRegistry {
  private readonly executors = new Map<string, ResilienceExecutor<unknown>[]>();

  track(executor: ResilienceExecutor<unknown>): void {
    const list = this.executors.get(executor.binding) ?? [];
    list.push(executor);
    this.executors.set(executor.binding, list);
  }

  breakerState(binding: string, key?: string): BreakerStateView | undefined {
    for (const executor of this.executors.get(binding) ?? []) {
      const state = executor.breakerState(key);
      if (state !== undefined) return state;
    }
    return undefined;
  }

  async resetBreaker(binding: string, key?: string): Promise<void> {
    for (const executor of this.executors.get(binding) ?? []) await executor.resetBreaker(key);
  }
}
