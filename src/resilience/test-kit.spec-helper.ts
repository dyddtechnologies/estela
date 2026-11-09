import {
  manualResilienceClock,
  type ManualResilienceClock,
} from '../testing/manual-resilience-clock';
import { defaultInProcessClassifier } from './classifiers';
import { ResilienceExecutor, type ResilienceDeps, type ResilienceEdgeAdapter } from './executor';
import { ResilienceObserver } from './observability';
import { resolveResiliencePlan } from './resilience.plan';
import type {
  ResilienceEvent,
  ResilienceLogger,
  ResilienceMetricsPort,
  ResiliencePolicyRef,
} from './resilience.types';

export class TestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout ${timeoutMs}`);
  }
}

export const transient = (message = 'transient'): Error =>
  Object.assign(new Error(message), { retryable: true });
export const rejected = (message = 'rejected'): Error =>
  Object.assign(new Error(message), { retryable: false });

export function fakeAdapter(over: Partial<ResilienceEdgeAdapter> = {}): ResilienceEdgeAdapter {
  return {
    kind: 'activator',
    classify: (error) => {
      if (error instanceof TestTimeoutError) return { class: 'transient' };
      return defaultInProcessClassifier(error);
    },
    repeatable: () => true,
    timeoutError: (_ctx, ms) => new TestTimeoutError(ms),
    ...over,
  };
}

export interface Lines {
  log: string[];
  warn: string[];
  error: string[];
  debug: string[];
}

export function recordingLogger(): { logger: ResilienceLogger; lines: Lines } {
  const lines: Lines = { log: [], warn: [], error: [], debug: [] };
  return {
    lines,
    logger: {
      log: (m) => lines.log.push(m),
      warn: (m) => lines.warn.push(m),
      error: (m) => lines.error.push(m),
      debug: (m) => lines.debug.push(m),
    },
  };
}

export interface MetricCall {
  type: 'counter' | 'histogram' | 'gauge';
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function recordingMetrics(): { port: ResilienceMetricsPort; calls: MetricCall[] } {
  const calls: MetricCall[] = [];
  return {
    calls,
    port: {
      counter: (name, labels, value = 1) => calls.push({ type: 'counter', name, labels, value }),
      histogram: (name, labels, value) => calls.push({ type: 'histogram', name, labels, value }),
      gauge: (name, labels, value) => calls.push({ type: 'gauge', name, labels, value }),
    },
  };
}

export interface Harness<T> {
  exec: ResilienceExecutor<T>;
  clock: ManualResilienceClock;
  events: ResilienceEvent[];
  lines: Lines;
  metrics: MetricCall[];
}

export function harness<T = unknown>(
  policy: ResiliencePolicyRef,
  options: {
    adapter?: Partial<ResilienceEdgeAdapter>;
    deps?: Partial<ResilienceDeps>;
    clock?: ManualResilienceClock;
    binding?: string;
    defaultPerAttemptMs?: number;
  } = {},
): Harness<T> {
  const clock = options.clock ?? manualResilienceClock();
  const events: ResilienceEvent[] = [];
  const { logger, lines } = recordingLogger();
  const metrics = recordingMetrics();
  const observer = new ResilienceObserver({
    clock,
    logger,
    metrics: metrics.port,
    onEvent: (event) => events.push(event),
  });
  const plan = resolveResiliencePlan(options.binding ?? 'b', [policy], 'activator', {
    ...(options.defaultPerAttemptMs === undefined
      ? {}
      : { defaultPerAttemptMs: options.defaultPerAttemptMs }),
  });
  const exec = new ResilienceExecutor<T>(plan, fakeAdapter(options.adapter), {
    clock,
    random: (max) => max - 1,
    observer,
    ...options.deps,
  });
  return { exec, clock, events, lines, metrics: metrics.calls };
}

export interface Settled<T> {
  done: boolean;
  value?: T;
  error?: unknown;
}

/** Tracks a promise without leaving an unhandled rejection. */
export function settle<T>(promise: Promise<T>): Settled<T> {
  const state: Settled<T> = { done: false };
  promise.then(
    (value) => {
      state.done = true;
      state.value = value;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

export const ctxOf = (binding = 'b'): { edge: 'activator'; binding: string } => ({
  edge: 'activator',
  binding,
});
