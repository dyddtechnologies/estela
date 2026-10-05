import type { IntegrationMessage } from '../message';
import type { HopLogger } from '../trace/hop-logger';
import {
  OutboundHttpError,
  OutboundNetworkError,
  OutboundRestError,
  OutboundTimeoutError,
  redactUrl,
  type OutboundFailureInfo,
} from './outbound.errors';
import type { OutboundRestPlan } from './outbound.plan';
import { buildOutboundRequest } from './outbound.request';
import type {
  OutboundCallContext,
  OutboundExchangeContext,
  OutboundFetch,
  OutboundFetchInit,
  OutboundFetchResponse,
  OutboundRestCallOptions,
  OutboundRestRequest,
  OutboundRestResponse,
} from './outbound.types';

/** What one call needs from the gateway. */
export interface OutboundCallDeps {
  fetchFn: OutboundFetch;
  logger?: HopLogger;
  /** Waits between attempts; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readHeaders(headers: OutboundFetchResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (value: string, name: string): void => {
    out[name.toLowerCase()] = value;
  };
  if (headers === undefined) return out;
  if (typeof headers.forEach === 'function') {
    (headers as { forEach(callback: typeof add): void }).forEach(add);
    return out;
  }
  for (const [name, value] of Object.entries(headers)) add(String(value), name);
  return out;
}

/**
 * JSON when the response says so (or says nothing and parses), the text otherwise and
 * `null` when empty. A body that fails to parse is kept as text, never dropped.
 */
function parseBody(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return null;
  if (contentType !== undefined && !/json/i.test(contentType)) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface Answer {
  ok: boolean;
  statusText: string;
  response: OutboundRestResponse;
}

async function send(
  request: OutboundRestRequest,
  fetchFn: OutboundFetch,
  signal: AbortSignal | undefined,
): Promise<Answer> {
  const init: OutboundFetchInit = { method: request.method, headers: { ...request.headers } };
  if (request.body !== undefined) init.body = request.body;
  if (signal !== undefined) init.signal = signal;
  const raw = await fetchFn(request.url, init);
  const headers = readHeaders(raw.headers);
  const body = parseBody(await raw.text(), headers['content-type']);
  return {
    ok: raw.ok,
    statusText: raw.statusText ?? '',
    response: { status: raw.status, headers, body },
  };
}

/** Runs `work` under an AbortController; the timeout wins even over a fetch that ignores the signal. */
async function withTimeout<T>(
  timeoutMs: number,
  work: (signal: AbortSignal | undefined) => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  if (timeoutMs === 0) return work(undefined);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(onTimeout());
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** One attempt: the response, or the typed failure as a value. */
async function attempt(
  request: OutboundRestRequest,
  attempts: number,
  fetchFn: OutboundFetch,
): Promise<OutboundRestResponse | OutboundRestError> {
  const info: OutboundFailureInfo = {
    binding: request.name,
    url: request.url,
    method: request.method,
    attempts,
  };
  try {
    const answer = await withTimeout(
      request.timeoutMs,
      (signal) => send(request, fetchFn, signal),
      () => new OutboundTimeoutError(info, request.timeoutMs),
    );
    if (answer.ok) return answer.response;
    const { status, headers, body } = answer.response;
    return new OutboundHttpError(info, status, answer.statusText, headers, body);
  } catch (error) {
    return error instanceof OutboundTimeoutError ? error : new OutboundNetworkError(info, error);
  }
}

/**
 * Delay before the next attempt, or undefined when the failure is final. A retry needs
 * attempts left, a failure classified as retryable and a method that is safe to repeat:
 * GET, HEAD or OPTIONS, any method while an idempotency key is being sent, or a method the
 * policy allows explicitly.
 */
async function retryDelay(
  plan: OutboundRestPlan,
  error: OutboundRestError,
  exchange: OutboundExchangeContext,
): Promise<number | undefined> {
  const policy = plan.retry;
  if (policy === undefined || exchange.attempts >= policy.maxAttempts) return undefined;
  const { method, idempotencyKey } = exchange.request;
  const repeatable =
    SAFE_METHODS.has(method) || idempotencyKey !== undefined || policy.methods.has(method);
  if (!repeatable || !(await policy.retryOn(error, exchange))) return undefined;
  return Math.max(0, policy.backoff(exchange.attempts, error));
}

async function exchange(
  plan: OutboundRestPlan,
  ctx: OutboundCallContext,
  request: OutboundRestRequest,
  deps: OutboundCallDeps,
): Promise<unknown> {
  const startedAt = Date.now();
  const fetchFn = plan.fetchFn ?? deps.fetchFn;
  const sleep = deps.sleep ?? realSleep;
  for (let attempts = 1; ; attempts += 1) {
    const outcome = await attempt(request, attempts, fetchFn);
    const context: OutboundExchangeContext = {
      ...ctx,
      request,
      attempts,
      durationMs: Date.now() - startedAt,
    };
    if (!(outcome instanceof OutboundRestError)) {
      return plan.response({ ...context, response: outcome });
    }
    const delayMs = await retryDelay(plan, outcome, context);
    if (delayMs === undefined) {
      // The mapper returns the error of the service; nothing returned keeps the typed one.
      const failure: unknown = (await plan.mapError?.(outcome, context)) ?? outcome;
      throw failure;
    }
    await sleep(delayMs);
  }
}

/**
 * Delivers one message as an HTTP call: builds the request, sends it with timeout and the
 * retry policy, maps the response or the failure. Logs one hop (never bodies, headers or
 * key values) when a hop logger is given.
 */
export async function executeOutboundRest(
  plan: OutboundRestPlan,
  message: IntegrationMessage,
  call: OutboundRestCallOptions,
  deps: OutboundCallDeps,
): Promise<unknown> {
  const { ctx, request } = await buildOutboundRequest(plan, message, call);
  const log = deps.logger;
  if (log === undefined) return exchange(plan, ctx, request, deps);
  const channel = plan.channel ?? plan.name;
  const target = `outbound:rest ${request.method} ${redactUrl(request.url)}`;
  const startedAt = Date.now();
  log.hopStart(channel, target, message.headers);
  let ok = false;
  try {
    const result = await exchange(plan, ctx, request, deps);
    ok = true;
    return result;
  } finally {
    log.hopEnd(channel, target, message.headers, ok, Date.now() - startedAt);
  }
}
