import { AsyncLocalStorage } from 'node:async_hooks';
import { MAX_RETRY_ATTEMPTS } from './backoff';

export const RETRY_BUDGET_HEADER = 'x-retry-budget';
export const RETRY_BUDGET_MESSAGE_HEADER = 'retryBudget';
/** Reply header of a result built while a non-cacheable fallback ran (RS-27). */
export const DEGRADED_HEADER = 'degraded';

/**
 * RS-31. A non-negative integer (number or decimal string), capped at 20; anything else is
 * `undefined`, and `invalid` reports whether a present value was rejected.
 */
export function parseRetryBudgetValue(raw: unknown): { budget?: number; invalid: boolean } {
  if (raw === undefined || raw === null) return { invalid: false };
  const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  let parsed: number | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = Number(value.trim());
  if (parsed === undefined || !Number.isFinite(parsed)) return { invalid: true };
  return { budget: Math.min(parsed, MAX_RETRY_ATTEMPTS), invalid: false };
}

/** RS-31: the budget, or undefined when absent or invalid. */
export function parseRetryBudget(raw: unknown): number | undefined {
  return parseRetryBudgetValue(raw).budget;
}

interface ScopeFrame {
  budget?: number;
  signal?: AbortSignal;
  fromEventsChannel: boolean;
  degraded: boolean;
  /** Message frames bound the degraded mark; attempt frames only carry budget and signal. */
  traceId?: string;
  /** Inbound request frame: the messages it dispatches in this chain link to it (RS-27). */
  root?: boolean;
  parent?: ScopeFrame;
}

export interface ResilienceScopeValue {
  budget?: number;
  signal?: AbortSignal;
  fromEventsChannel?: boolean;
  degraded?: boolean;
}

const storage = new AsyncLocalStorage<ScopeFrame>();

function view(frame: ScopeFrame | undefined): ResilienceScopeValue | undefined {
  if (frame === undefined) return undefined;
  const value: ResilienceScopeValue = {
    fromEventsChannel: frame.fromEventsChannel,
    degraded: frame.degraded,
  };
  if (frame.budget !== undefined) value.budget = frame.budget;
  if (frame.signal !== undefined) value.signal = frame.signal;
  return value;
}

/**
 * Per async chain resilience state (RS-29): the retry budget of the current layer, the attempt
 * signal, whether the message came from the events channel, and the degraded mark (RS-27).
 */
export class ResilienceScope {
  static current(): ResilienceScopeValue | undefined {
    return view(storage.getStore());
  }

  /** Attempt frame: budget and signal for nested executors; the degraded mark goes to the parent. */
  static run<T>(value: { budget?: number; signal?: AbortSignal }, fn: () => T): T {
    const parent = storage.getStore();
    const frame: ScopeFrame = {
      fromEventsChannel: parent?.fromEventsChannel ?? false,
      degraded: false,
    };
    if (value.budget !== undefined) frame.budget = value.budget;
    if (value.signal !== undefined) frame.signal = value.signal;
    if (parent !== undefined) frame.parent = parent;
    return storage.run(frame, fn);
  }

  /**
   * Message frame opened by the activator wrapper, the flow executor and the inbound interceptor,
   * rebuilt from the message headers at every dispatch (invariant 7). It links to the ambient
   * frame only within the same trace, so a degraded mark never leaks into an unrelated request.
   */
  static runMessage<T>(
    value: { budget?: number; traceId?: string; fromEventsChannel?: boolean; root?: boolean },
    fn: (scope: { degraded(): boolean }) => T,
  ): T {
    const ambient = storage.getStore();
    const frame: ScopeFrame = {
      fromEventsChannel: value.fromEventsChannel === true || ambient?.fromEventsChannel === true,
      degraded: false,
    };
    if (value.budget !== undefined) frame.budget = value.budget;
    if (value.traceId !== undefined) frame.traceId = value.traceId;
    if (value.root === true) frame.root = true;
    if (ambient !== undefined && linksTo(ambient, value.traceId)) frame.parent = ambient;
    return storage.run(frame, () => fn({ degraded: () => frame.degraded }));
  }

  /** RS-27: marks the current scope and its parents in the same chain degraded. */
  static markDegraded(): void {
    for (let frame = storage.getStore(); frame !== undefined; frame = frame.parent) {
      frame.degraded = true;
    }
  }
}

/** Same trace, or a message dispatched by an inbound request in its own chain. */
function linksTo(ambient: ScopeFrame, traceId: string | undefined): boolean {
  if (traceId !== undefined && traceOf(ambient) === traceId) return true;
  for (let frame: ScopeFrame | undefined = ambient; frame !== undefined; frame = frame.parent) {
    if (frame.root === true) return frame.traceId === undefined || frame.traceId === traceId;
    if (frame.traceId !== undefined) return false;
  }
  return false;
}

function traceOf(frame: ScopeFrame): string | undefined {
  for (
    let current: ScopeFrame | undefined = frame;
    current !== undefined;
    current = current.parent
  ) {
    if (current.traceId !== undefined) return current.traceId;
  }
  return undefined;
}

/** The current attempt's signal, for activator methods, flow functions and saga steps (RS-36). */
export function currentResilienceSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}
