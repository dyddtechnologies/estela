import type { AmqpLikeChannel } from '../adapters/amqp-like.channel';
import { bindGrpcOut, handleGrpcInbound } from '../adapters/grpc.adapter';
import { bindRabbitOutbound } from '../adapters/rabbit.adapter';
import { bindRestOut, type RestFetch } from '../adapters/rest.adapter';
import { ChannelRegistry } from '../channel-registry';
import { ReplyGateway, ReplyTimeoutError } from './reply-gateway';
import { TraceContext } from '../trace/trace-context';
import { InboundInterceptor } from '../inbound/inbound.interceptor';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { INBOUND_SPEC_METADATA, type InboundSpec } from '../inbound/inbound.types';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeWorld = () => {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  const gateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 200 });
  return { registry, trace, gateway };
};

describe('ReplyGateway — test 7 del spec (request/reply, spec §8)', () => {
  it('.reply cierra sendAndReceive; sin fugas de canales efímeros', async () => {
    const { registry, gateway } = makeWorld();
    registry.create({ name: 'orders.persist', type: 'direct' }).subscribe(async (msg) => {
      await registry.send(msg.headers.replyChannel!, { persisted: true });
    });
    const sizeBefore = registry.list().length;
    const result = await gateway.sendAndReceive(
      'orders.persist',
      { orderId: 'o-1' },
      { traceId: 't-7' },
    );
    expect(result).toEqual({ persisted: true });
    expect(registry.list()).toHaveLength(sizeBefore); // leak-free (plan sec.8.3)
  });

  it('timeout → ReplyTimeoutError + deregistro en finally', async () => {
    const { registry, gateway } = makeWorld();
    registry.create({ name: 'silent', type: 'direct' }).subscribe(async () => undefined);
    const sizeBefore = registry.list().length;
    await expect(gateway.sendAndReceive('silent', 'p', {}, 40)).rejects.toBeInstanceOf(
      ReplyTimeoutError,
    );
    await delay(10);
    expect(registry.list()).toHaveLength(sizeBefore);
  });

  it('a late reply on an awaited channel surfaces as the timeout, other errors untouched', async () => {
    const { registry, gateway } = makeWorld();
    let executions = 0;
    registry.create({ name: 'slow', type: 'direct' }).subscribe(async (msg) => {
      executions += 1;
      await delay(60);
      if (msg.payload === 'boom') throw new Error('business failure');
      await registry.send(msg.headers.replyChannel!, { late: true });
    });
    const sizeBefore = registry.list().length;
    await expect(gateway.sendAndReceive('slow', 'p', {}, 15)).rejects.toBeInstanceOf(
      ReplyTimeoutError,
    );
    await expect(gateway.sendAndReceive('slow', 'boom', {}, 15)).rejects.toThrow(
      'business failure',
    );
    expect(executions).toBe(2);
    expect(registry.list()).toHaveLength(sizeBefore);
  });

  it('headers are optional: the request still carries its ephemeral reply channel', async () => {
    const { registry, gateway } = makeWorld();
    const replyChannels: unknown[] = [];
    registry.create({ name: 'bare', type: 'direct' }).subscribe(async (msg) => {
      replyChannels.push(msg.headers.replyChannel);
      await registry.send(msg.headers.replyChannel!, 'pong');
    });
    expect(await gateway.sendAndReceive('bare', 'ping')).toBe('pong');
    expect(replyChannels).toEqual([expect.stringMatching(/^reply\./)]);
  });

  it('without any configured timeout the wait gives up after ten seconds', async () => {
    jest.useFakeTimers();
    try {
      const trace = new TraceContext();
      const registry = new ChannelRegistry({ trace });
      const gateway = new ReplyGateway({ registry, trace });
      registry.create({ name: 'silent', type: 'direct' }).subscribe(async () => undefined);
      const sizeBefore = registry.list().length;
      let outcome: unknown = 'pending';
      gateway.sendAndReceive('silent', 'p').then(
        () => (outcome = 'replied'),
        (error: unknown) => (outcome = error),
      );
      await jest.advanceTimersByTimeAsync(9_999);
      expect(outcome).toBe('pending');
      await jest.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(ReplyTimeoutError);
      expect((outcome as Error).message).toContain('(10000ms)');
      expect(registry.list()).toHaveLength(sizeBefore);
    } finally {
      jest.useRealTimers();
    }
  });

  it('integración inbound requestReply:true end-to-end vía interceptor', async () => {
    const { registry, trace, gateway } = makeWorld();
    registry.create({ name: 'echo', type: 'direct' }).subscribe(async (msg) => {
      await registry.send(msg.headers.replyChannel!, { echoed: msg.payload });
    });
    const interceptor = new InboundInterceptor({ registry, trace, replyGateway: gateway });
    const spec: InboundSpec = {
      channel: 'echo',
      transport: 'rest',
      requestReply: true,
      timeoutMs: 200,
    };
    const handler = function handle(): void {};
    Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ body: { hi: 1 }, headers: {} }) }),
      getHandler: () => handler,
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of(undefined) };
    const response = (await lastValueFrom(await interceptor.intercept(ctx, next))) as {
      status: string;
      result: unknown;
    };
    expect(response.status).toBe('ok');
    expect(response.result).toEqual({ echoed: { hi: 1 } });
  });
});

describe('REST outbound (spec §9)', () => {
  it('fetch con headers de traza + idempotencia; body JSON; !ok → throw', async () => {
    const { registry } = makeWorld();
    const calls: {
      url: string;
      init: { method: string; headers: Record<string, string>; body: string };
    }[] = [];
    const fetchFn: RestFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ done: true }) };
    };
    registry.create({ name: 'http.out.erp', type: 'direct' });
    bindRestOut(registry, 'http.out.erp', { url: 'https://erp.example/orders', fetchFn });
    await registry.send(
      'http.out.erp',
      { orderId: 'o-2' },
      { traceId: 't-rest', idempotencyKey: 'k-rest' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://erp.example/orders');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['x-trace-id']).toBe('t-rest');
    expect(calls[0]?.init.headers['idempotency-key']).toBe('k-rest');
    const body = calls[0]?.init.body;
    expect(typeof body === 'string' ? JSON.parse(body) : null).toEqual({ orderId: 'o-2' });

    const failFetch: RestFetch = async () => ({ ok: false, status: 500, text: async () => '' });
    registry.create({ name: 'http.fail', type: 'direct' });
    bindRestOut(registry, 'http.fail', { url: 'https://erp.example/fail', fetchFn: failFetch });
    await expect(registry.send('http.fail', {})).rejects.toThrow('HTTP 500');
  });
});

describe('REST outbound: bindRestOut keeps its fire-and-forget defaults', () => {
  type Init = Parameters<RestFetch>[1];
  const okFetch = (
    calls: { url: string; init: Init }[],
    text: () => Promise<string>,
  ): RestFetch => {
    return async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text };
    };
  };

  it('sends exactly method, headers and body: no signal, no timeout, no extra header', async () => {
    const { registry } = makeWorld();
    const calls: { url: string; init: Init }[] = [];
    registry.create({ name: 'http.legacy', type: 'direct' });
    bindRestOut(registry, 'http.legacy', {
      url: 'https://erp.example/orders?v=1',
      method: 'PUT',
      headers: { 'x-api': 'static', 'x-trace-id': 'static-loses' },
      fetchFn: okFetch(calls, async () => '{"ignored":true}'),
    });
    await registry.send('http.legacy', { a: 1 }, { traceId: 't-9', correlationId: 'c-9' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://erp.example/orders?v=1');
    expect(Object.keys(calls[0]?.init ?? {}).sort()).toEqual(['body', 'headers', 'method']);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(calls[0]?.init.body).toBe('{"a":1}');
    expect(calls[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      'x-api': 'static',
      'x-trace-id': 't-9',
      'x-span-id': expect.any(String) as string,
      'x-correlation-id': 'c-9',
    });
  });

  it('drains and discards the response body: nothing is replied, even with a reply channel', async () => {
    const { registry } = makeWorld();
    const replies: unknown[] = [];
    registry.create({ name: 'reply.legacy', type: 'direct' }).subscribe(async (msg) => {
      replies.push(msg.payload);
    });
    const text = jest.fn(async () => '{"id":"o-1"}');
    registry.create({ name: 'http.legacy', type: 'direct' });
    bindRestOut(registry, 'http.legacy', {
      url: 'https://erp.example/orders',
      fetchFn: okFetch([], text),
    });
    await registry.send('http.legacy', {}, { replyChannel: 'reply.legacy' });
    expect(text).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([]);
  });

  it('fails with a plain Error and the historical message', async () => {
    const { registry } = makeWorld();
    const text = jest.fn(async () => 'never read');
    registry.create({ name: 'http.legacy', type: 'direct' });
    bindRestOut(registry, 'http.legacy', {
      url: 'https://erp.example/fail',
      method: 'PATCH',
      fetchFn: async () => ({ ok: false, status: 503, text }),
    });
    const error: unknown = await registry
      .send('http.legacy', {})
      .catch((caught: unknown) => caught);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect((error as Error).message).toBe('restOut PATCH https://erp.example/fail → HTTP 503');
    expect(text).not.toHaveBeenCalled();
  });

  it('uses globalThis.fetch when no fetch is injected', async () => {
    const { registry } = makeWorld();
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      return { ok: true, status: 200, text: async () => '' };
    }) as unknown as typeof fetch;
    try {
      registry.create({ name: 'http.legacy', type: 'direct' });
      bindRestOut(registry, 'http.legacy', { url: 'https://erp.example/global' });
      await registry.send('http.legacy', {});
      expect(seen).toEqual(['https://erp.example/global']);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('gRPC outbound/inbound (spec §9 — cero @grpc/grpc-js)', () => {
  it('stub inyectado recibe metadata de traza; replyChannel reenvía resultado', async () => {
    const { registry } = makeWorld();
    const stubCalls: { payload: unknown; metadata: Record<string, string> }[] = [];
    const replies: unknown[] = [];
    registry.create({ name: 'reply.grpc', type: 'direct' }).subscribe(async (msg) => {
      replies.push(msg.payload);
    });
    registry.create({ name: 'grpc.out', type: 'direct' });
    bindGrpcOut(
      registry,
      'grpc.out',
      (payload, metadata) => {
        stubCalls.push({ payload, metadata });
        return 'stub-result';
      },
      { replyChannel: 'reply.grpc' },
    );
    await registry.send('grpc.out', { q: 1 }, { traceId: 't-grpc' });
    expect(stubCalls).toHaveLength(1);
    expect(stubCalls[0]?.payload).toEqual({ q: 1 });
    expect(stubCalls[0]?.metadata['x-trace-id']).toBe('t-grpc');
    expect(replies).toEqual(['stub-result']);
  });

  it('handleGrpcInbound: fire-and-forget entrega al canal con trazas mapeadas', async () => {
    const { registry, trace } = makeWorld();
    const received: { payload: unknown; traceId?: string }[] = [];
    registry.create({ name: 'orders.place', type: 'direct' }).subscribe(async (msg) => {
      received.push({ payload: msg.payload, traceId: msg.headers.traceId });
    });
    await handleGrpcInbound(
      { registry, trace },
      'orders.place',
      { id: 7 },
      { 'x-trace-id': 't-grpc-in' },
    );
    await delay(10);
    expect(received).toEqual([{ payload: { id: 7 }, traceId: 't-grpc-in' }]);
  });
});

describe('Rabbit outbound (spec §9)', () => {
  const fakeAmqp = (): { amqp: AmqpLikeChannel; sent: unknown[]; published: unknown[] } => {
    const sent: unknown[] = [];
    const published: unknown[] = [];
    const amqp: AmqpLikeChannel = {
      assertQueue: async () => undefined,
      consume: async () => ({}),
      ack: () => undefined,
      nack: () => undefined,
      sendToQueue: (queue, content, options) => {
        sent.push({ queue, content, options });
        return true;
      },
      publish: (exchange, routingKey, content, options) => {
        published.push({ exchange, routingKey, content, options });
        return true;
      },
    };
    return { amqp, sent, published };
  };

  it('sendToQueue: JSON + persistent + headers de traza + messageId', async () => {
    const { registry } = makeWorld();
    const { amqp, sent } = fakeAmqp();
    registry.create({ name: 'amqp.out', type: 'direct' });
    bindRabbitOutbound(amqp, registry, 'amqp.out', { queue: 'orders.persist.q' });
    const msg = { orderId: 'o-9' };
    await registry.send('amqp.out', msg, { traceId: 't-rabbit', idempotencyKey: 'k-rabbit' });
    expect(sent).toHaveLength(1);
    const entry = sent[0] as {
      queue: string;
      content: Buffer;
      options: { deliveryMode: number; headers: Record<string, string>; messageId: string };
    };
    expect(entry.queue).toBe('orders.persist.q');
    expect(JSON.parse(entry.content.toString('utf8'))).toEqual(msg);
    expect(entry.options.deliveryMode).toBe(2);
    expect(entry.options.headers['x-trace-id']).toBe('t-rabbit');
    expect(entry.options.headers['idempotency-key']).toBe('k-rabbit');
    expect(entry.options.messageId).toBeTruthy();
  });

  it('exchange + routingKey vía publish()', async () => {
    const { registry } = makeWorld();
    const { amqp, published, sent } = fakeAmqp();
    registry.create({ name: 'domain.events.out', type: 'direct' });
    bindRabbitOutbound(amqp, registry, 'domain.events.out', {
      exchange: 'domain',
      routingKey: 'order.placed',
    });
    await registry.send('domain.events.out', 'evt');
    expect(published).toHaveLength(1);
    const entry = published[0] as { exchange: string; routingKey: string };
    expect(entry.exchange).toBe('domain');
    expect(entry.routingKey).toBe('order.placed');
    expect(sent).toHaveLength(0);
  });
});
