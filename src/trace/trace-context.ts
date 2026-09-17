import { AsyncLocalStorage } from 'node:async_hooks';

import { newId, type IntegrationMessage, type MessageHeaders } from '../message';

/** Snapshot de tracing vivas en el contexto de execution (plan sec.8.5 — Ambient Context). */
export interface TraceContextValue {
  traceId: string;
  spanId: string;
  correlationId: string;
  parentSpanId?: string;
  causationId?: string;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmpty(value)) return value;
  }
  return undefined;
}

/**
 * Cross-cutting de tracing sobre `AsyncLocalStorage` (spec sec.10).
 *
 * Rule critica del plan sec.8.5: ALS **no** atraviesa schedulers (`setImmediate`,
 * buffers) ni listeners de `EventEmitter` outside del `run`. Por eso el dispatcher
 * (Fase 3) reconstruye el contexto desde `msg.headers` — source de verdad — en
 * cada dispatch. Esta class NO lleva estado global: la instancia la provee el DI.
 */
export class TraceContext {
  private readonly storage = new AsyncLocalStorage<TraceContextValue>();

  /** Executes `fn` inside del contexto dado (sync o async; ALS propaga el await chain). */
  run<T>(value: TraceContextValue, fn: () => T): T {
    return this.storage.run(value, fn);
  }

  /** `run` derivando el contexto de los headers de un message. */
  runWithMessage<T>(msg: IntegrationMessage, fn: () => T): T {
    return this.run(this.fromHeaders(msg.headers), fn);
  }

  /** Contexto vivo en este punto de execution, si existe. */
  current(): TraceContextValue | undefined {
    return this.storage.getStore();
  }

  /** Deriva el contexto de execution desde headers (completa faltantes con fallbacks del spec). */
  fromHeaders(headers: MessageHeaders): TraceContextValue {
    const value: TraceContextValue = {
      traceId: isNonEmpty(headers.traceId) ? headers.traceId : headers.id,
      spanId: isNonEmpty(headers.spanId) ? headers.spanId : newId(),
      correlationId: isNonEmpty(headers.correlationId) ? headers.correlationId : headers.id,
    };
    if (isNonEmpty(headers.parentSpanId)) value.parentSpanId = headers.parentSpanId;
    if (isNonEmpty(headers.causationId)) value.causationId = headers.causationId;
    return value;
  }

  /**
   * Completa `trace`/`correlation`/`parentSpan` si faltan (spec sec.10) using el
   * ambiente ALS cuando existe; never muta el message de input.
   */
  bindMessage<T>(msg: IntegrationMessage<T>): IntegrationMessage<T> {
    const ambient = this.current();
    const src = msg.headers;
    const headers: MessageHeaders = { ...src, history: [...src.history] };
    headers.traceId = firstNonEmpty(src.traceId, ambient?.traceId) ?? src.id;
    headers.spanId = isNonEmpty(src.spanId) ? src.spanId : newId();
    headers.correlationId = firstNonEmpty(src.correlationId, src.id) ?? headers.traceId;
    if (isNonEmpty(src.parentSpanId)) {
      headers.parentSpanId = src.parentSpanId;
    } else if (ambient && isNonEmpty(ambient.spanId)) {
      headers.parentSpanId = ambient.spanId;
    } else {
      delete headers.parentSpanId;
    }
    return { payload: msg.payload, headers };
  }
}
