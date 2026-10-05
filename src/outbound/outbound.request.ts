import { HttpHeaderMapper } from '../adapters/header-mapper';
import { encodeInboundKey } from '../inbound/inbound.idempotency';
import type { IntegrationMessage } from '../message';
import { OutboundError, redactUrl } from './outbound.errors';
import {
  assertOutboundTimeout,
  normalizeOutboundMethod,
  type OutboundRestPlan,
} from './outbound.plan';
import { toPairs, toSerializedBody } from './outbound.serializers';
import type {
  OutboundCallContext,
  OutboundKeyParts,
  OutboundQuery,
  OutboundRequestContext,
  OutboundRestCallOptions,
  OutboundRestMethod,
  OutboundRestRequest,
  OutboundRestTarget,
  OutboundSerializedBody,
} from './outbound.types';

const traceMapper = new HttpHeaderMapper();

/** The request to send plus the context the later strategies receive. */
export interface OutboundBuiltRequest {
  ctx: OutboundCallContext;
  request: OutboundRestRequest;
}

/** Header set with case-insensitive names: the last writer wins and keeps its spelling. */
class HeaderBag {
  private readonly entries = new Map<string, [name: string, value: string]>();

  set(name: string, value: string): void {
    this.entries.set(name.toLowerCase(), [name, value]);
  }

  setDefault(name: string, value: string): void {
    if (!this.entries.has(name.toLowerCase())) this.set(name, value);
  }

  merge(headers: Record<string, string | undefined> | undefined): void {
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (typeof value === 'string') this.set(name, value);
    }
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.entries.values());
  }
}

function appendQuery(name: string, url: string, query: OutboundQuery): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OutboundError(`outbound rest '${name}': '${redactUrl(url)}' is not an absolute url`);
  }
  const pairs = toPairs(query);
  // Without parameters the url is sent exactly as configured.
  if (pairs.length === 0) return url;
  for (const [key, value] of pairs) parsed.searchParams.append(key, value);
  return parsed.toString();
}

async function resolveTarget(
  plan: OutboundRestPlan,
  ctx: OutboundRequestContext,
): Promise<OutboundRestTarget> {
  if (plan.target === undefined) return {};
  const target: unknown = await plan.target(ctx);
  if (typeof target !== 'object' || target === null) {
    throw new OutboundError(`target resolver of outbound rest '${plan.name}' returned no target`);
  }
  return target;
}

function encodeKey(name: string, parts: OutboundKeyParts): string {
  try {
    return encodeInboundKey(parts);
  } catch {
    throw new OutboundError(
      `outbound rest '${name}': the idempotency key must be a non-empty string or a ` +
        `non-empty array of non-empty strings and finite numbers`,
    );
  }
}

/** Explicit key of the call, else the resolver, else the forwarded message key. Never generated. */
async function resolveIdempotencyKey(
  plan: OutboundRestPlan,
  ctx: OutboundCallContext,
  explicit: OutboundKeyParts | undefined,
): Promise<{ header: string; key: string } | undefined> {
  const rules = plan.idempotency;
  if (rules === undefined) return undefined;
  const { header } = rules;
  const resolved = explicit ?? (await rules.key?.(ctx));
  if (resolved !== undefined && resolved !== null) {
    return { header, key: encodeKey(plan.name, resolved) };
  }
  const forwarded = rules.forward ? ctx.message.headers.idempotencyKey : undefined;
  return typeof forwarded === 'string' && forwarded.length > 0
    ? { header, key: forwarded }
    : undefined;
}

async function serializeBody(
  plan: OutboundRestPlan,
  ctx: OutboundCallContext,
  target: OutboundRestTarget,
): Promise<OutboundSerializedBody> {
  if (ctx.method === 'GET' || ctx.method === 'HEAD') return {};
  const body = Object.hasOwn(target, 'body') ? target.body : ctx.payload;
  return toSerializedBody(await plan.serialize(body, ctx));
}

function traceHeaders(plan: OutboundRestPlan, message: IntegrationMessage): Record<string, string> {
  if (!plan.traceHeaders) return {};
  const headers = traceMapper.mapOut(message.headers);
  // The idempotency header is owned by the idempotency rules, not by the trace mapper.
  delete headers['idempotency-key'];
  return headers;
}

interface ResolvedTarget {
  target: OutboundRestTarget;
  url: string;
  method: OutboundRestMethod;
}

async function locate(
  plan: OutboundRestPlan,
  ctx: OutboundRequestContext,
): Promise<ResolvedTarget> {
  const target = await resolveTarget(plan, ctx);
  const url = target.url ?? plan.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new OutboundError(`outbound rest '${plan.name}': the target has no url`);
  }
  return {
    target,
    url: appendQuery(plan.name, url, { ...plan.query, ...target.query }),
    method: target.method === undefined ? plan.method : normalizeOutboundMethod(target.method),
  };
}

/**
 * Builds the HTTP request of one message. Header precedence, lowest first: serializer
 * content type, static headers, trace headers, target headers, `mapHeaders`, call headers,
 * idempotency header. Names are matched case-insensitively.
 */
export async function buildOutboundRequest(
  plan: OutboundRestPlan,
  message: IntegrationMessage,
  call: OutboundRestCallOptions,
): Promise<OutboundBuiltRequest> {
  const base: OutboundRequestContext = { name: plan.name, message, payload: message.payload };
  if (plan.channel !== undefined) base.channel = plan.channel;
  const { target, url, method } = await locate(plan, base);
  const ctx: OutboundCallContext = { ...base, target, url, method };

  const headers = new HeaderBag();
  headers.merge(plan.headers);
  headers.merge(traceHeaders(plan, message));
  headers.merge(target.headers);
  headers.merge(await plan.mapHeaders?.(ctx));
  headers.merge(call.headers);

  const serialized = await serializeBody(plan, ctx, target);
  if (serialized.body !== undefined && serialized.contentType !== undefined) {
    headers.setDefault('content-type', serialized.contentType);
  }
  const explicitKey = call.idempotencyKey ?? target.idempotencyKey;
  const idempotency = await resolveIdempotencyKey(plan, ctx, explicitKey);
  if (idempotency !== undefined) headers.set(idempotency.header, idempotency.key);

  const request: OutboundRestRequest = {
    name: plan.name,
    url,
    method,
    headers: headers.toRecord(),
    timeoutMs: assertOutboundTimeout(call.timeoutMs ?? target.timeoutMs ?? plan.timeoutMs),
  };
  if (serialized.body !== undefined) request.body = serialized.body;
  if (idempotency !== undefined) request.idempotencyKey = idempotency.key;
  return { ctx, request };
}
