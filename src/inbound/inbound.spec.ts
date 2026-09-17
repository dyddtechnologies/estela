import 'reflect-metadata';

import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';
import type { ChannelDeps } from '../channels/channel-deps';
import { createMessage } from '../message';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import {
  AmqpHeaderMapper,
  GraphQLHeaderMapper,
  GrpcHeaderMapper,
  HttpHeaderMapper,
} from '../adapters/header-mapper';
import {
  GraphQLInboundStrategy,
  GrpcInboundStrategy,
  HttpInboundStrategy,
} from './inbound.transport';
import {
  acceptedResponse,
  duplicateResponse,
  INBOUND_SPEC_METADATA,
  type InboundSpec,
} from './inbound.types';
import { InboundInterceptor } from './inbound.interceptor';
import {
  InboundRest,
  InboundRabbit,
  InboundGrpc,
  InboundGraphQL,
  Inbound,
} from './inbound.decorators';
import { readInboundSpec } from './inbound.types';

function fakeHttpCtx(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => {
      const fn = (): void => undefined;
      return fn;
    },
  } as unknown as ExecutionContext;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('HeaderMappers — tabla spec §4', () => {
  it('Http mapIn: traza + idempotency-key|x-idempotency-key', () => {
    const http = new HttpHeaderMapper();
    const init = http.mapIn({
      'x-trace-id': 't-1',
      'x-span-id': 's-1',
      'x-parent-span-id': 'p-1',
      'x-correlation-id': 'c-1',
      'x-causation-id': 'cause-1',
      'idempotency-key': 'k-1',
    });
    expect(init.traceId).toBe('t-1');
    expect(init.spanId).toBe('s-1');
    expect(init.parentSpanId).toBe('p-1');
    expect(init.correlationId).toBe('c-1');
    expect(init.causationId).toBe('cause-1');
    expect(init.idempotencyKey).toBe('k-1');
  });

  it('Http mapIn: fallback x-idempotency-key y arrays de express', () => {
    const http = new HttpHeaderMapper();
    const init = http.mapIn({ 'x-idempotency-key': ['k-2'], 'x-trace-id': ['t-2'] });
    expect(init.idempotencyKey).toBe('k-2');
    expect(init.traceId).toBe('t-2');
  });

  it('mapOut emite la tabla spec §4 y omite vacíos', () => {
    const headers = createMessage('p', {
      traceId: 't-3',
      correlationId: 'c-3',
      idempotencyKey: 'k-3',
    }).headers;
    const out = new GrpcHeaderMapper().mapOut(headers);
    expect(out['x-trace-id']).toBe('t-3');
    expect(out['x-correlation-id']).toBe('c-3');
    expect(out['idempotency-key']).toBe('k-3');
    expect(out['x-span-id']).toBe(headers.spanId); // generado por createMessage
    expect(out['x-parent-span-id']).toBeUndefined(); // ausente -> omitido
  });

  it('Amqp: valores Buffer → string', () => {
    const amqp = new AmqpHeaderMapper();
    const init = amqp.mapIn({
      'x-trace-id': Buffer.from('t-amqp'),
      'idempotency-key': Buffer.from('k-amqp'),
    });
    expect(init.traceId).toBe('t-amqp');
    expect(init.idempotencyKey).toBe('k-amqp');
  });

  it('GraphQL: req.headers tiene precedencia sobre extensions', () => {
    const gql = new GraphQLHeaderMapper();
    const fromReq = gql.mapIn({
      req: { headers: { 'x-trace-id': 'from-req' } },
      extensions: { 'x-trace-id': 'from-ext' },
    });
    expect(fromReq.traceId).toBe('from-req');
    const fromExt = gql.mapIn({ extensions: { 'x-trace-id': 'from-ext' } });
    expect(fromExt.traceId).toBe('from-ext');
  });
});

describe('Strategies de transporte (plan §5.1)', () => {
  it('rest: payload return con fallback body', () => {
    const strategy = new HttpInboundStrategy();
    const spec: InboundSpec = { channel: 'c', transport: 'rest' };
    const ctx = fakeHttpCtx({ body: { from: 'body' }, headers: {} });
    expect(strategy.extract(ctx, { from: 'return' }, spec).payload).toEqual({ from: 'return' });
    expect(strategy.extract(ctx, undefined, spec).payload).toEqual({ from: 'body' });
    expect(strategy.extract(ctx, 'x', { ...spec, payload: 'body' }).payload).toEqual({
      from: 'body',
    });
  });

  it('grpc: data + metadata.toJSON()', () => {
    const strategy = new GrpcInboundStrategy();
    const spec: InboundSpec = { channel: 'c', transport: 'grpc' };
    const ctx = {
      switchToRpc: () => ({
        getData: () => ({ id: 1 }),
        getContext: () => ({ toJSON: () => ({ 'x-trace-id': 't-grpc' }) }),
      }),
      getHandler: () => (): void => undefined,
    } as unknown as ExecutionContext;
    const extraction = strategy.extract(ctx, undefined, spec);
    expect(extraction.payload).toEqual({ id: 1 });
    expect(extraction.rawHeaders).toEqual({ 'x-trace-id': 't-grpc' });
  });

  it('graphql: args del resolver + req.headers', () => {
    const strategy = new GraphQLInboundStrategy();
    const spec: InboundSpec = { channel: 'c', transport: 'graphql' };
    const ctx = {
      getArgs: () => [
        undefined,
        { orderId: 'o-1' },
        { req: { headers: { 'x-trace-id': 't-gql' } } },
      ],
      getHandler: () => (): void => undefined,
    } as unknown as ExecutionContext;
    const extraction = strategy.extract(ctx, undefined, spec);
    expect(extraction.payload).toEqual({ orderId: 'o-1' });
    expect(extraction.rawHeaders).toEqual({ 'x-trace-id': 't-gql' });
  });
});

describe('builders de respuesta (spec §7.2)', () => {
  it('acceptedResponse: canónicos ganan sobre el merge', () => {
    const msg = createMessage('p', { traceId: 't', correlationId: 'c' });
    const response = acceptedResponse(msg, { status: 'fake', extra: 1 });
    expect(response).toEqual({
      status: 'accepted',
      extra: 1,
      id: msg.headers.id,
      traceId: 't',
      correlationId: 'c',
    });
  });

  it('duplicateResponse: replayed true por defecto', () => {
    const response = duplicateResponse('k', { result: 'cached', traceId: 't' });
    expect(response).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k',
      replayed: true,
      result: 'cached',
      traceId: 't',
    });
  });
});

describe('decorators inbound (spec §7.2 + ADR-015)', () => {
  it('leer metadata por transport', () => {
    class Ctrl {
      rest(): void {}
      grpc(): void {}
      gql(): void {}
      rabbit(): void {}
      generic(): void {}
    }
    const proto = Ctrl.prototype;
    const apply = (method: string, decorator: MethodDecorator): void => {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      if (descriptor !== undefined) decorator(proto, method, descriptor);
    };
    apply('rest', InboundRest({ channel: 'orders.place' }));
    apply('grpc', InboundGrpc({ channel: 'orders.place' }));
    apply('gql', InboundGraphQL({ channel: 'orders.query', operation: 'query' }));
    apply('rabbit', InboundRabbit({ channel: 'orders.rabbit' }));
    apply('generic', Inbound({ channel: 'x', transport: 'rest' }));
    expect(readInboundSpec(proto.rest)?.transport).toBe('rest');
    expect(readInboundSpec(proto.grpc)?.transport).toBe('grpc');
    expect(readInboundSpec(proto.gql)?.transport).toBe('graphql');
    expect(readInboundSpec(proto.gql)?.operation).toBe('query');
    expect(readInboundSpec(proto.rabbit)?.transport).toBe('rabbit');
    expect(readInboundSpec(proto.generic)?.channel).toBe('x');
  });
});

describe('InboundInterceptor — test 10 del spec', () => {
  const makeWorld = () => {
    const deps: ChannelDeps = { trace: new TraceContext() };
    const registry = new ChannelRegistry(deps);
    registry.create({ name: 'orders.persist', type: 'queue', capacity: 100 });
    const received: unknown[] = [];
    registry.get('orders.persist').subscribe(async (msg) => {
      await delay(30); // persist "lento": el accepted NO debe esperar
      received.push(msg.payload);
    });
    const idempotency = new IdempotencyService({ store: new MemoryIdempotencyStore() });
    const interceptor = new InboundInterceptor({
      registry,
      trace: registry.trace,
      idempotency,
    });
    return { registry, received, interceptor };
  };

  const runInterceptor = async (
    interceptor: InboundInterceptor,
    spec: InboundSpec,
    request: Record<string, unknown>,
    handlerResult: unknown,
  ): Promise<unknown> => {
    const handler = function handle(): void {};
    Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(handlerResult) };
    return lastValueFrom(await interceptor.intercept(ctx, next));
  };

  it('requestReply:false → accepted SIN esperar al consumidor del canal', async () => {
    const { received, interceptor } = makeWorld();
    const response = (await runInterceptor(
      interceptor,
      { channel: 'orders.persist', transport: 'rest', requestReply: false },
      { body: { orderId: 'o-1' }, headers: { 'x-trace-id': 't-10' } },
      undefined,
    )) as { status: string; traceId: string; id: string };
    expect(response.status).toBe('accepted');
    expect(response.traceId).toBe('t-10');
    expect(response.id).toBeTruthy();
    expect(received).toEqual([]); // aun en flight — accepted no awaits (spec test 10)
    await delay(60);
    expect(received).toEqual([{ orderId: 'o-1' }]);
  });

  it('+ merge del handler devuelto (objeto)', async () => {
    const { interceptor } = makeWorld();
    const response = (await runInterceptor(
      interceptor,
      { channel: 'orders.persist', transport: 'rest' },
      { body: {}, headers: {} },
      { echo: 42 },
    )) as { status: string; echo: number };
    expect(response.echo).toBe(42);
    expect(response.status).toBe('accepted');
  });

  it('replay con idempotency-key → duplicate sin re-entregar al canal', async () => {
    const { received, interceptor } = makeWorld();
    const request = { body: { orderId: 'o-2' }, headers: { 'idempotency-key': 'k-1' } };
    const first = (await runInterceptor(
      interceptor,
      { channel: 'orders.persist', transport: 'rest' },
      request,
      undefined,
    )) as { status: string };
    expect(first.status).toBe('accepted');
    const second = (await runInterceptor(
      interceptor,
      { channel: 'orders.persist', transport: 'rest' },
      request,
      undefined,
    )) as { status: string; idempotencyKey: string; replayed: boolean };
    expect(second.status).toBe('duplicate');
    expect(second.idempotencyKey).toBe('k-1');
    expect(second.replayed).toBe(true);
    await delay(60);
    expect(received).toEqual([{ orderId: 'o-2' }]); // una sola delivery
  });

  it('requestReply:true sin gateway → InboundError explícito (Fase 8 lo cierra)', async () => {
    const { interceptor } = makeWorld();
    await expect(
      runInterceptor(
        interceptor,
        { channel: 'orders.persist', transport: 'rest', requestReply: true },
        { body: {}, headers: {} },
        undefined,
      ),
    ).rejects.toThrow('ReplyGateway');
  });
});
