import type { MessageHeaders, MessageHeadersInit } from '../message';

/**
 * Tabla de headers de protocolo (spec §4):
 * x-trace-id/x-span-id/x-parent-span-id/x-correlation-id/x-causation-id +
 * idempotency-key|x-idempotency-key.
 */
const TRACE_IN: readonly (readonly [protocolKey: string, headerKey: string])[] = [
  ['x-trace-id', 'traceId'],
  ['x-span-id', 'spanId'],
  ['x-parent-span-id', 'parentSpanId'],
  ['x-correlation-id', 'correlationId'],
  ['x-causation-id', 'causationId'],
];

export interface HeaderMapper<TRaw = Record<string, unknown>> {
  readonly protocol: string;
  mapIn(raw: TRaw): MessageHeadersInit;
  mapOut(headers: MessageHeaders): Record<string, string>;
}

export function normalizeHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeHeaderValue(item);
      if (normalized !== undefined) return normalized;
    }
    return undefined;
  }
  if (value instanceof Uint8Array) {
    const text = new TextDecoder().decode(value);
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

export function mapTraceHeadersIn(
  get: (protocolKey: string) => string | undefined,
): MessageHeadersInit {
  const init: MessageHeadersInit = {};
  for (const [protocolKey, headerKey] of TRACE_IN) {
    const value = get(protocolKey);
    if (value !== undefined) {
      (init as Record<string, unknown>)[headerKey] = value;
    }
  }
  const idempotency = get('idempotency-key') ?? get('x-idempotency-key');
  if (idempotency !== undefined) init.idempotencyKey = idempotency;
  return init;
}

export function mapTraceHeadersOut(headers: MessageHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (key: string, value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  };
  for (const [protocolKey, headerKey] of TRACE_IN) {
    set(protocolKey, headers[headerKey]);
  }
  set('idempotency-key', headers.idempotencyKey);
  return out;
}

type RawRecord = Record<string, unknown>;

function recordGetter(raw: RawRecord): (protocolKey: string) => string | undefined {
  return (protocolKey) => normalizeHeaderValue(raw[protocolKey]);
}

/** HTTP (Express req.headers). */
export class HttpHeaderMapper implements HeaderMapper<RawRecord> {
  readonly protocol = 'http';
  mapIn(raw: RawRecord): MessageHeadersInit {
    return mapTraceHeadersIn(recordGetter(raw));
  }
  mapOut(headers: MessageHeaders): Record<string, string> {
    return mapTraceHeadersOut(headers);
  }
}

/** gRPC metadata (claves lower-case, valores string|Buffer|array). */
export class GrpcHeaderMapper implements HeaderMapper<RawRecord> {
  readonly protocol = 'grpc';
  mapIn(raw: RawRecord): MessageHeadersInit {
    return mapTraceHeadersIn(recordGetter(raw));
  }
  mapOut(headers: MessageHeaders): Record<string, string> {
    return mapTraceHeadersOut(headers);
  }
}

/** AMQP properties.headers (valores Buffer|string). */
export class AmqpHeaderMapper implements HeaderMapper<RawRecord> {
  readonly protocol = 'amqp';
  mapIn(raw: RawRecord): MessageHeadersInit {
    return mapTraceHeadersIn(recordGetter(raw));
  }
  mapOut(headers: MessageHeaders): Record<string, string> {
    return mapTraceHeadersOut(headers);
  }
}

export interface GraphqlRawSource {
  /** req.headers cuando el transporte subyacente es HTTP. */
  req?: { headers?: RawRecord };
  headers?: RawRecord;
  /** extensions con claves de traza planas (ADR-017). */
  extensions?: RawRecord;
}

/** GraphQL: headers HTTP si existen; si no, `extensions` con claves planas. */
export class GraphQLHeaderMapper implements HeaderMapper<GraphqlRawSource> {
  readonly protocol = 'graphql';
  mapIn(raw: GraphqlRawSource): MessageHeadersInit {
    const source = raw.req?.headers ?? raw.headers ?? raw.extensions ?? {};
    return mapTraceHeadersIn(recordGetter(source));
  }
  mapOut(headers: MessageHeaders): Record<string, string> {
    return mapTraceHeadersOut(headers);
  }
}
