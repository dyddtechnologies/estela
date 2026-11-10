import { AsyncLocalStorage } from 'node:async_hooks';
import { MAX_RETRY_ATTEMPTS } from './backoff';

/** Wire header (HTTP and gRPC metadata) carrying the extra tries left along one call path. */
export const TRIES_LEFT_HEADER = 'x-tries-left';
/** Message header carrying the extra tries left. */
export const TRIES_LEFT_MESSAGE_HEADER = 'triesLeft';
/** Reply header of a result built while a non-cacheable plan B ran; never stored (RS-27). */
export const PLAN_B_HEADER = 'planB';

/**
 * RS-31. A non-negative integer (number or decimal string), capped at 20; anything else is
 * `undefined`, and `invalid` reports whether a present value was rejected.
 */
export function parseTriesLeftValue(raw: unknown): { triesLeft?: number; invalid: boolean } {
  if (raw === undefined || raw === null) return { invalid: false };
  const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  let parsed: number | undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = Number(value.trim());
  if (parsed === undefined || !Number.isFinite(parsed)) return { invalid: true };
  return { triesLeft: Math.min(parsed, MAX_RETRY_ATTEMPTS), invalid: false };
}

/** RS-31: the tries left, or undefined when absent or invalid. */
export function parseTriesLeft(raw: unknown): number | undefined {
  return parseTriesLeftValue(raw).triesLeft;
}

interface ScopeFrame {
  triesLeft?: number;
  signal?: AbortSignal;
  /** Monotonic end of the enclosing executor's total patience (RS-69); try frames only. */
  deadlineAt?: number;
  fromEventsChannel: boolean;
  planB: boolean;
  /** Message frames bound the plan B mark; try frames only carry tries left and signal. */
  traceId?: string;
  /** Inbound request frame: the messages it dispatches in this chain link to it (RS-27). */
  root?: boolean;
  parent?: ScopeFrame;
}

export interface CareScopeValue {
  triesLeft?: number;
  signal?: AbortSignal;
  /** Monotonic end of the enclosing executor's total patience (RS-69). */
  deadlineAt?: number;
  fromEventsChannel?: boolean;
  planB?: boolean;
}

const storage = new AsyncLocalStorage<ScopeFrame>();

function view(frame: ScopeFrame | undefined): CareScopeValue | undefined {
  if (frame === undefined) return undefined;
  const value: CareScopeValue = {
    fromEventsChannel: frame.fromEventsChannel,
    planB: frame.planB,
  };
  if (frame.triesLeft !== undefined) value.triesLeft = frame.triesLeft;
  if (frame.signal !== undefined) value.signal = frame.signal;
  if (frame.deadlineAt !== undefined) value.deadlineAt = frame.deadlineAt;
  return value;
}

/**
 * Per async chain care state (RS-29): the tries left of the current layer, the signal of the
 * running try, whether the message came from the events channel, and the plan B mark (RS-27).
 */
export class CareScope {
  static current(): CareScopeValue | undefined {
    return view(storage.getStore());
  }

  /**
   * Try frame: tries left, signal and deadline for nested executors in the same async chain; the
   * plan B mark goes to the parent. A message frame (`runMessage`) never carries the deadline, so
   * it does not cross a channel hop (RS-69, invariant 7).
   */
  static run<T>(
    value: { triesLeft?: number; signal?: AbortSignal; deadlineAt?: number },
    fn: () => T,
  ): T {
    const parent = storage.getStore();
    const frame: ScopeFrame = {
      fromEventsChannel: parent?.fromEventsChannel ?? false,
      planB: false,
    };
    if (value.triesLeft !== undefined) frame.triesLeft = value.triesLeft;
    if (value.signal !== undefined) frame.signal = value.signal;
    if (value.deadlineAt !== undefined) frame.deadlineAt = value.deadlineAt;
    if (parent !== undefined) frame.parent = parent;
    return storage.run(frame, fn);
  }

  /**
   * Message frame opened by the activator wrapper, the flow executor and the inbound interceptor,
   * rebuilt from the message headers at every dispatch (invariant 7). It links to the ambient
   * frame only within the same trace, so a plan B mark never leaks into an unrelated request.
   */
  static runMessage<T>(
    value: { triesLeft?: number; traceId?: string; fromEventsChannel?: boolean; root?: boolean },
    fn: (scope: { planB(): boolean }) => T,
  ): T {
    const ambient = storage.getStore();
    const frame: ScopeFrame = {
      fromEventsChannel: value.fromEventsChannel === true || ambient?.fromEventsChannel === true,
      planB: false,
    };
    if (value.triesLeft !== undefined) frame.triesLeft = value.triesLeft;
    if (value.traceId !== undefined) frame.traceId = value.traceId;
    if (value.root === true) frame.root = true;
    if (ambient !== undefined && linksTo(ambient, value.traceId)) frame.parent = ambient;
    return storage.run(frame, () => fn({ planB: () => frame.planB }));
  }

  /** RS-27: marks the current scope and its parents in the same chain as answered by plan B. */
  static markPlanB(): void {
    for (let frame = storage.getStore(); frame !== undefined; frame = frame.parent) {
      frame.planB = true;
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

/** The running try's signal, for activator methods, flow functions and saga steps (RS-36). */
export function currentTrySignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}
