import { HttpException } from '@nestjs/common';
import { NoSubscriberError } from '../channel';
import { ReplyTimeoutError } from '../gateway/reply-gateway';
import {
  InboundError,
  type InboundFailureAction,
  type InboundFailureClassifierFn,
  type InboundFailureCodec,
  type InboundKeyContext,
} from './inbound.types';

const FAILURE_MARK = Symbol.for('estela.inbound.failure');
const FAILURE_ACTIONS: readonly unknown[] = ['keep', 'release', 'store'];

/** Key of the completed record that carries a failure stored for replay. */
export const INBOUND_STORED_FAILURE_KEY = 'estelaStoredFailure';

function isFailureAction(value: unknown): value is InboundFailureAction {
  return FAILURE_ACTIONS.includes(value);
}

/**
 * Tags an error with what the inbound idempotency claim must do with it. The mark is a
 * non-enumerable symbol property, so it never shows up in logs or serialized bodies.
 * It is obeyed only by endpoints that opted in (`onFailure` other than `'keep'`).
 */
export function markInboundFailure<E extends object>(error: E, action: InboundFailureAction): E {
  Object.defineProperty(error, FAILURE_MARK, {
    value: action,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Reads the mark left by `markInboundFailure`, if any. */
export function readInboundFailureMark(error: unknown): InboundFailureAction | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const mark: unknown = (error as Record<symbol, unknown>)[FAILURE_MARK];
  return isFailureAction(mark) ? mark : undefined;
}

/**
 * Thrown by `onInFlight: 'reject'` when a repeat arrives while the first request is still
 * running. Map it to HTTP 409 (or a gRPC status) in your own exception filter.
 */
export class InboundIdempotencyInFlightError extends InboundError {
  readonly code = 'IDEMPOTENCY_KEY_IN_PROGRESS';

  constructor(
    readonly channel: string,
    readonly scope: string,
    readonly clientKey: string | undefined,
  ) {
    // The message carries no storage key: it may hold tenant or resource ids.
    super(`IDEMPOTENCY_KEY_IN_PROGRESS: ${channel}`);
  }
}

/** Thrown when a stored failure that was not an HTTP exception is replayed. */
export class InboundReplayedFailureError extends InboundError {
  constructor(
    message: string,
    readonly stored: unknown,
    readonly originalName?: string,
  ) {
    super(message);
  }
}

interface HttpExceptionLike {
  getStatus(): unknown;
  getResponse(): unknown;
}

function isHttpExceptionLike(error: unknown): error is HttpExceptionLike {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<Record<keyof HttpExceptionLike, unknown>>;
  return typeof candidate.getStatus === 'function' && typeof candidate.getResponse === 'function';
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: typeof error === 'string' ? error : 'Unknown error' };
}

/**
 * Default failure codec. A Nest `HttpException` round-trips its status and body; any other
 * error keeps only its name and message (no stack) and is replayed as an
 * `InboundReplayedFailureError`.
 */
export class HttpExceptionFailureCodec implements InboundFailureCodec {
  serialize(error: unknown): unknown {
    const data = isHttpExceptionLike(error)
      ? { kind: 'http', status: error.getStatus(), body: error.getResponse() }
      : { kind: 'error', ...describeError(error) };
    return JSON.parse(JSON.stringify(data)) as unknown;
  }

  deserialize(stored: unknown): unknown {
    const data = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<
      string,
      unknown
    >;
    if (data.kind === 'http' && typeof data.status === 'number') {
      return new HttpException(data.body as string | Record<string, unknown>, data.status);
    }
    const message = typeof data.message === 'string' ? data.message : 'Replayed inbound failure';
    return typeof data.name === 'string'
      ? new InboundReplayedFailureError(message, stored, data.name)
      : new InboundReplayedFailureError(message, stored);
  }
}

/** Record written by the `store` action; read back by `readStoredFailure`. */
export function wrapStoredFailure(data: unknown): Record<string, unknown> {
  return { [INBOUND_STORED_FAILURE_KEY]: { v: 1, data } };
}

/** Returns the serialized failure of a completed record, or undefined when it holds none. */
export function readStoredFailure(
  result: Record<string, unknown> | undefined,
): { data: unknown } | undefined {
  const wrapped = result?.[INBOUND_STORED_FAILURE_KEY];
  if (typeof wrapped !== 'object' || wrapped === null) return undefined;
  return { data: (wrapped as { data?: unknown }).data };
}

/** Resolved `onFailure` option. */
export type InboundFailurePolicy =
  | { mode: 'keep' }
  | { mode: 'marker' }
  | { mode: 'static'; action: 'release' | 'store' }
  | { mode: 'classifier'; classify: InboundFailureClassifierFn };

/**
 * Picks the action for a failed dispatch: `keep` ignores marks; otherwise the mark wins,
 * then the static value or the classifier. A static value never applies to a reply timeout
 * or a missing subscriber: the flow may still be running, or have finished unanswered.
 */
export async function decideFailureAction(
  policy: InboundFailurePolicy,
  error: unknown,
  ctx: InboundKeyContext,
): Promise<InboundFailureAction> {
  if (policy.mode === 'keep') return 'keep';
  const mark = readInboundFailureMark(error);
  if (mark !== undefined) return mark;
  if (policy.mode === 'marker') return 'keep';
  if (policy.mode === 'static') {
    const unanswered = error instanceof ReplyTimeoutError || error instanceof NoSubscriberError;
    return unanswered ? 'keep' : policy.action;
  }
  const decided: unknown = await policy.classify(error, ctx);
  return isFailureAction(decided) ? decided : 'keep';
}
