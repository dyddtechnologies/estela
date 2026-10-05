import 'reflect-metadata';

import { ChannelError } from '../channel';
import { ChannelRegistry } from '../channel-registry';
import { IntegrationFlow } from '../flow/integration-flow';
import { ReplyGateway } from '../gateway/reply-gateway';
import { createMessage, type IntegrationMessage } from '../message';
import { bindFlow } from '../testing';
import { HopLogger } from '../trace/hop-logger';
import { TraceContext } from '../trace/trace-context';
import { OutboundRestGateway, type OutboundRestGatewayDeps } from './outbound-rest.gateway';
import {
  OUTBOUND_REST_METADATA,
  OutboundRest,
  outboundRestBindingOf,
  readOutboundRestSpec,
} from './outbound.decorators';
import {
  OutboundError,
  OutboundHttpError,
  OutboundNetworkError,
  OutboundRestError,
  OutboundTimeoutError,
  redactUrl,
} from './outbound.errors';
import type {
  OutboundBodySerializer,
  OutboundErrorMapper,
  OutboundExchangeContext,
  OutboundFetch,
  OutboundFetchInit,
  OutboundFetchResponse,
  OutboundHeaderMapper,
  OutboundKeyResolver,
  OutboundProviderResolver,
  OutboundResponseContext,
  OutboundResponseMapper,
  OutboundCallContext,
  OutboundRequestContext,
  OutboundRestRequestOptions,
  OutboundRestRequest,
  OutboundRestResponse,
  OutboundRestTarget,
  OutboundRetryClassifier,
  OutboundTargetResolver,
} from './outbound.types';

interface Call {
  url: string;
  init: OutboundFetchInit;
}

type Reply = OutboundFetchResponse | Error | ((call: Call) => Promise<OutboundFetchResponse>);

function answer(
  status: number,
  body: unknown = undefined,
  headers: NonNullable<OutboundFetchResponse['headers']> = { 'Content-Type': 'application/json' },
): OutboundFetchResponse {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, headers, text: async () => text };
}

/** Fake fetch: answers the replies in order (the last one repeats) and records every call. */
function fakeFetch(...replies: Reply[]): { fetchFn: OutboundFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: OutboundFetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const reply = replies[Math.min(calls.length, replies.length) - 1] ?? answer(200, { ok: true });
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply;
  };
  return { fetchFn, calls };
}

const URL_ORDERS = 'https://erp.example/orders';

function gatewayWith(
  deps: OutboundRestGatewayDeps,
  ...replies: Reply[]
): { gateway: OutboundRestGateway; calls: Call[]; sleeps: number[] } {
  const { fetchFn, calls } = fakeFetch(...replies);
  const sleeps: number[] = [];
  const gateway = new OutboundRestGateway({
    fetchFn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...deps,
  });
  return { gateway, calls, sleeps };
}

const first = (calls: Call[]): Call => {
  const call = calls[0];
  if (call === undefined) throw new Error('no call was made');
  return call;
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

describe('OutboundRestGateway.request: defaults', () => {
  it('posts the payload as JSON with the trace headers and replies { status, headers, body }', async () => {
    const { gateway, calls } = gatewayWith(
      {},
      answer(201, { id: 'o-1' }, { 'Content-Type': 'application/json', 'X-Rate': '9' }),
    );
    const reply = await gateway.request(
      { url: URL_ORDERS },
      { payload: { sku: 'A' }, headers: { traceId: 't-1', correlationId: 'c-1' } },
    );

    expect(reply).toEqual({
      status: 201,
      headers: { 'content-type': 'application/json', 'x-rate': '9' },
      body: { id: 'o-1' },
    });
    const { url, init } = first(calls);
    expect(url).toBe(URL_ORDERS);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"sku":"A"}');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-trace-id']).toBe('t-1');
    expect(init.headers['x-correlation-id']).toBe('c-1');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('never invents an idempotency key: no key on the message means no header', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS }, { payload: {} });
    const names = Object.keys(first(calls).init.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('idempotency-key');
    expect(names).not.toContain('x-idempotency-key');
  });

  it('forwards the idempotency key of the message under Idempotency-Key, once', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS }, { payload: {}, headers: { idempotencyKey: 'k-9' } });
    const { headers } = first(calls).init;
    expect(headers['Idempotency-Key']).toBe('k-9');
    expect(Object.keys(headers).filter((name) => /^idempotency-key$/i.test(name))).toHaveLength(1);
  });

  it('does not retry by default, not even a GET that fails with 503', async () => {
    const { gateway, calls, sleeps } = gatewayWith({}, answer(503));
    const error = await failure(
      gateway.request({ url: URL_ORDERS, method: 'GET' }, { payload: 1 }),
    );
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('uses a 30 s timeout unless told otherwise', async () => {
    const { gateway } = gatewayWith({}, answer(200));
    const request = await gateway.request<OutboundRestRequest>(
      { url: URL_ORDERS, response: (ctx) => ctx.request },
      { payload: null },
    );
    expect(request.timeoutMs).toBe(30_000);
  });

  it('falls back to globalThis.fetch when no fetch is injected', async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      return answer(204);
    }) as unknown as typeof fetch;
    try {
      const reply = await new OutboundRestGateway().request({ url: URL_ORDERS }, { payload: 1 });
      expect(reply).toEqual({
        status: 204,
        headers: { 'content-type': 'application/json' },
        body: null,
      });
      expect(seen).toEqual([URL_ORDERS]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('response parsing and mapping', () => {
  const bodyOf = async (reply: OutboundFetchResponse): Promise<unknown> => {
    const { gateway } = gatewayWith({}, reply);
    return gateway.request({ url: URL_ORDERS, response: 'body' }, { payload: 1 });
  };
  const raw = (
    text: string,
    headers?: OutboundFetchResponse['headers'],
  ): OutboundFetchResponse => ({
    ok: true,
    status: 200,
    text: async () => text,
    ...(headers === undefined ? {} : { headers }),
  });

  it('parses JSON declared by the content type, also with a suffix type', async () => {
    expect(await bodyOf(raw('{"a":1}', { 'content-type': 'application/problem+json' }))).toEqual({
      a: 1,
    });
  });

  it('keeps a body that claims to be JSON but is not as text', async () => {
    expect(await bodyOf(raw('<html>', { 'content-type': 'application/json' }))).toBe('<html>');
  });

  it('returns text for a non-JSON content type even when it looks like JSON', async () => {
    expect(await bodyOf(raw('{"a":1}', { 'content-type': 'text/plain' }))).toBe('{"a":1}');
  });

  it('sniffs JSON when the response has no content type, and falls back to text', async () => {
    expect(await bodyOf(raw('[1,2]'))).toEqual([1, 2]);
    expect(await bodyOf(raw('plain'))).toBe('plain');
  });

  it('answers null for an empty body', async () => {
    expect(await bodyOf(raw('', { 'content-type': 'application/json' }))).toBeNull();
  });

  it('reads the headers of a real Headers object in lower case', async () => {
    const { gateway } = gatewayWith(
      {},
      raw('ok', new Headers({ 'Content-Type': 'text/plain', 'X-Request-Id': 'r-1' })),
    );
    const reply = await gateway.request({ url: URL_ORDERS }, { payload: 1 });
    expect(reply.headers).toEqual({ 'content-type': 'text/plain', 'x-request-id': 'r-1' });
    expect(reply.body).toBe('ok');
  });

  it('hands the mapper the response, the request, the payload and the attempt count', async () => {
    const { gateway } = gatewayWith({}, answer(200, { total: 5 }));
    const seen: OutboundResponseContext[] = [];
    const reply = await gateway.request(
      {
        name: 'pricing',
        url: URL_ORDERS,
        response: (ctx: OutboundResponseContext<{ sku: string }, { total: number }>) => {
          seen.push(ctx);
          return { sku: ctx.payload.sku, total: ctx.response.body.total };
        },
      },
      { payload: { sku: 'A' } },
    );
    expect(reply).toEqual({ sku: 'A', total: 5 });
    expect(seen[0]?.name).toBe('pricing');
    expect(seen[0]?.channel).toBeUndefined();
    expect(seen[0]?.attempts).toBe(1);
    expect(seen[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]?.request.method).toBe('POST');
    expect(seen[0]?.url).toBe(URL_ORDERS);
  });

  it('accepts a mapper instance and awaits an async mapper', async () => {
    const mapper: OutboundResponseMapper = {
      mapResponse: async (ctx) => `status:${ctx.response.status}`,
    };
    const { gateway } = gatewayWith({}, answer(202));
    expect(await gateway.request({ url: URL_ORDERS, response: mapper }, { payload: 1 })).toBe(
      'status:202',
    );
  });

  it('propagates what a response mapper throws without passing it to the error mapper', async () => {
    const mapError = jest.fn();
    const { gateway } = gatewayWith({}, answer(200));
    const boom = new Error('contract violation');
    const error = await failure(
      gateway.request(
        {
          url: URL_ORDERS,
          response: () => {
            throw boom;
          },
          mapError,
        },
        { payload: 1 },
      ),
    );
    expect(error).toBe(boom);
    expect(mapError).not.toHaveBeenCalled();
  });
});

describe('dynamic target', () => {
  it('resolves url, method, headers, query and body per message', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    const options: OutboundRestRequestOptions = {
      query: { tenant: 't-1', page: 1 },
      target: ({ payload }: OutboundRequestContext<{ id: string }>) => ({
        url: `https://api.example/items/${payload.id}?v=2`,
        method: 'put',
        headers: { 'X-Client-Id': 'c-7', 'X-Skipped': undefined },
        query: { page: 3, tags: ['a', 'b'], none: null, missing: undefined, active: true },
        body: { renamed: payload.id },
      }),
    };
    await gateway.request(options, { payload: { id: 'i-1' } });
    const { url, init } = first(calls);
    expect(url).toBe(
      'https://api.example/items/i-1?v=2&tenant=t-1&page=3&tags=a&tags=b&active=true',
    );
    expect(init.method).toBe('PUT');
    expect(init.headers['X-Client-Id']).toBe('c-7');
    expect(init.headers).not.toHaveProperty('X-Skipped');
    expect(init.body).toBe('{"renamed":"i-1"}');
  });

  it('sends the configured url verbatim when there is no query to add', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: 'https://erp.example' }, { payload: 1 });
    expect(first(calls).url).toBe('https://erp.example');
  });

  it.each(['GET', 'HEAD'] as const)('sends no body and no content type for %s', async (method) => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS, method }, { payload: { ignored: true } });
    const { init } = first(calls);
    expect(init.method).toBe(method);
    expect(init).not.toHaveProperty('body');
    expect(Object.keys(init.headers).map((name) => name.toLowerCase())).not.toContain(
      'content-type',
    );
  });

  it.each(['DELETE', 'OPTIONS', 'PATCH'] as const)('sends the payload for %s', async (method) => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS, method }, { payload: { a: 1 } });
    expect(first(calls).init.method).toBe(method);
    expect(first(calls).init.body).toBe('{"a":1}');
  });

  it('sends no body when the target sets body to undefined, and the payload when it omits it', async () => {
    const targets: OutboundRestTarget[] = [{ body: undefined }, {}];
    const { gateway, calls } = gatewayWith({}, answer(200));
    const options: OutboundRestRequestOptions = {
      url: URL_ORDERS,
      target: () => targets.shift() ?? {},
    };
    await gateway.request(options, { payload: { p: 1 } });
    await gateway.request(options, { payload: { p: 1 } });
    expect(calls[0]?.init).not.toHaveProperty('body');
    expect(calls[0]?.init.headers).not.toHaveProperty('content-type');
    expect(calls[1]?.init.body).toBe('{"p":1}');
  });

  it('hands the resolved target, with its free-form data, to the later strategies', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200, { total: 9 }), answer(500));
    const row = { id: 'api-7', pick: 'total' };
    const options: OutboundRestRequestOptions = {
      target: () => ({ url: URL_ORDERS, data: row }),
      mapHeaders: (ctx) => ({ 'x-api-id': (ctx.target.data as typeof row).id }),
      idempotency: { key: (ctx) => ['call', (ctx.target.data as typeof row).id] },
      response: (ctx) =>
        (ctx.response.body as Record<string, unknown>)[(ctx.target.data as typeof row).pick],
      mapError: (error, ctx) => new Error(`${(ctx.target.data as typeof row).id}:${error.kind}`),
    };
    expect(await gateway.request(options, { payload: 1 })).toBe(9);
    expect(first(calls).init.headers['x-api-id']).toBe('api-7');
    expect(first(calls).init.headers['Idempotency-Key']).toBe('call:api-7');
    expect(first(calls).init.body).toBe('1');
    const error = await failure(gateway.request(options, { payload: 1 }));
    expect((error as Error).message).toBe('api-7:http');

    const seen: unknown[] = [];
    const plain = gatewayWith({}, answer(200));
    await plain.gateway.request(
      { url: URL_ORDERS, response: (ctx) => seen.push(ctx.target) },
      { payload: 1 },
    );
    expect(seen).toEqual([{}]);
  });

  it('accepts a resolver instance and passes it the binding name and the message', async () => {
    const seen: unknown[] = [];
    const resolver: OutboundTargetResolver<string> = {
      resolveTarget(ctx) {
        seen.push([ctx.name, ctx.channel, ctx.payload, ctx.message.headers.correlationId]);
        return Promise.resolve({ url: `https://api.example/${ctx.payload}` });
      },
    };
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request(
      { name: 'items', target: resolver },
      { payload: 'x', headers: { correlationId: 'c-2' } },
    );
    expect(first(calls).url).toBe('https://api.example/x');
    expect(seen).toEqual([['items', undefined, 'x', 'c-2']]);
  });

  it('rejects a target without url, a non-object target, a relative url and an unknown method', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    const send = (target: unknown): Promise<unknown> =>
      failure(
        gateway.request(
          { name: 'dyn', target: () => target as OutboundRestTarget },
          { payload: 1 },
        ),
      );
    for (const target of [{}, { url: '' }]) {
      const error = await send(target);
      expect(error).toBeInstanceOf(OutboundError);
      expect((error as Error).message).toBe("outbound rest 'dyn': the target has no url");
    }
    expect((await send(null)) as Error).toHaveProperty(
      'message',
      "target resolver of outbound rest 'dyn' returned no target",
    );
    expect((await send('https://x')) as Error).toBeInstanceOf(OutboundError);
    expect((await send({ url: '/orders?token=s3cret' })) as Error).toHaveProperty(
      'message',
      "outbound rest 'dyn': '/orders' is not an absolute url",
    );
    expect((await send({ url: URL_ORDERS, method: 'TRACE' })) as Error).toHaveProperty(
      'message',
      "outbound rest method 'TRACE' is not supported",
    );
    expect(calls).toHaveLength(0);
  });
});

describe('body serialization', () => {
  const sent = async (
    options: OutboundRestRequestOptions,
    payload: unknown,
  ): Promise<OutboundFetchInit> => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS, ...options }, { payload });
    return first(calls).init;
  };

  it('json: an undefined payload sends neither body nor content type', async () => {
    const init = await sent({}, undefined);
    expect(init).not.toHaveProperty('body');
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('text: sends a string verbatim and nothing for a nullish body', async () => {
    const init = await sent({ serializer: 'text' }, '<xml/>');
    expect(init.body).toBe('<xml/>');
    expect(init.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(await sent({ serializer: 'text' }, null)).not.toHaveProperty('body');
    expect(await sent({ serializer: 'text' }, undefined)).not.toHaveProperty('body');
  });

  it('text: rejects a body that is not a string', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    const error = await failure(
      gateway.request(
        { name: 'legacy', url: URL_ORDERS, serializer: 'text' },
        { payload: { a: 1 } },
      ),
    );
    expect(error).toBeInstanceOf(OutboundError);
    expect((error as Error).message).toBe(
      "outbound rest 'legacy': the 'text' serializer needs a string body",
    );
    expect(calls).toHaveLength(0);
  });

  it('form: encodes a record, repeats arrays, skips nullish entries and passes a string through', async () => {
    const init = await sent(
      { serializer: 'form' },
      { grant_type: 'client credentials', scope: ['a', 'b'], skip: null, n: 2 },
    );
    expect(init.body).toBe('grant_type=client+credentials&scope=a&scope=b&n=2');
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect((await sent({ serializer: 'form' }, 'a=1&b=2')).body).toBe('a=1&b=2');
    expect(await sent({ serializer: 'form' }, null)).not.toHaveProperty('body');
    expect(await sent({ serializer: 'form' }, undefined)).not.toHaveProperty('body');
  });

  it('form: rejects arrays and scalars', async () => {
    for (const payload of [[1, 2], 7]) {
      const { gateway } = gatewayWith({}, answer(200));
      const error = await failure(
        gateway.request({ name: 'token', url: URL_ORDERS, serializer: 'form' }, { payload }),
      );
      expect((error as Error).message).toBe(
        "outbound rest 'token': the 'form' serializer needs a record",
      );
    }
  });

  it('custom function: a bare string is a body without content type', async () => {
    const init = await sent({ serializer: (body) => `raw:${String(body)}` }, 'x');
    expect(init.body).toBe('raw:x');
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('custom instance: body and content type, with the call context', async () => {
    const serializer: OutboundBodySerializer = {
      serialize: (body, ctx) => ({
        body: `${ctx.method}:${JSON.stringify(body)}`,
        contentType: 'application/vnd.acme+json',
      }),
    };
    const init = await sent({ serializer }, { a: 1 });
    expect(init.body).toBe('POST:{"a":1}');
    expect(init.headers['content-type']).toBe('application/vnd.acme+json');
  });

  it('custom function returning nothing sends no body; a content type without body is ignored', async () => {
    expect(await sent({ serializer: () => undefined }, { a: 1 })).not.toHaveProperty('body');
    const init = await sent({ serializer: () => ({ contentType: 'text/csv' }) }, { a: 1 });
    expect(init).not.toHaveProperty('body');
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('a content-type header of the call wins over the serializer, whatever its case', async () => {
    const init = await sent({ headers: { 'Content-Type': 'application/merge-patch+json' } }, {});
    expect(init.headers).toEqual(
      expect.objectContaining({ 'Content-Type': 'application/merge-patch+json' }),
    );
    expect(init.headers).not.toHaveProperty('content-type');
  });
});

describe('header mapping', () => {
  it('layers static < trace < target < mapHeaders < call headers, case-insensitively', async () => {
    const { gateway, calls } = gatewayWith(
      { defaults: { headers: { 'X-App': 'module', 'X-Module': 'm' } } },
      answer(200),
    );
    const seen: string[] = [];
    await gateway.request(
      {
        url: URL_ORDERS,
        headers: { 'X-App': 'binding', 'x-trace-id': 'static-loses', 'X-Layer': 'static' },
        target: () => ({ headers: { 'X-Correlation-ID': 'from-target', 'x-layer': 'target' } }),
        mapHeaders: (ctx) => {
          seen.push(`${ctx.method} ${ctx.url}`);
          return { Authorization: 'Bearer abc', 'X-LAYER': 'hook', 'X-Call': 'hook' };
        },
      },
      {
        payload: 1,
        headers: { traceId: 't-7', correlationId: 'c-7', authorization: 'Bearer abc' },
      },
      { headers: { 'x-call': 'call', 'X-Undefined': undefined } },
    );
    expect(first(calls).init.headers).toEqual({
      'X-App': 'binding',
      'X-Module': 'm',
      'x-trace-id': 't-7',
      'x-span-id': expect.any(String) as string,
      'X-Correlation-ID': 'from-target',
      'X-LAYER': 'hook',
      Authorization: 'Bearer abc',
      'x-call': 'call',
      'content-type': 'application/json',
    });
    expect(seen).toEqual([`POST ${URL_ORDERS}`]);
  });

  it('accepts a header mapper instance, an async one, and one that returns nothing', async () => {
    const mapper: OutboundHeaderMapper<{ token: string }> = {
      mapHeaders: async (ctx) => ({ authorization: `Bearer ${ctx.payload.token}` }),
    };
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS, mapHeaders: mapper }, { payload: { token: 'tk' } });
    await gateway.request({ url: URL_ORDERS, mapHeaders: () => undefined }, { payload: {} });
    expect(calls[0]?.init.headers.authorization).toBe('Bearer tk');
    expect(calls[1]?.init.headers).not.toHaveProperty('authorization');
  });

  it('traceHeaders: false sends no trace header', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request(
      { url: URL_ORDERS, traceHeaders: false },
      { payload: 1, headers: { traceId: 't-1' } },
    );
    expect(first(calls).init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('joins the ambient trace when the caller gives no trace headers, and lets headers override', async () => {
    const trace = new TraceContext();
    const { gateway, calls } = gatewayWith({ trace }, answer(200));
    const ambient = { traceId: 't-amb', correlationId: 'c-amb', spanId: 's-amb' };
    await trace.run(ambient, async () => {
      await gateway.request({ url: URL_ORDERS }, { payload: 1 });
      await gateway.request({ url: URL_ORDERS }, { payload: 1, headers: { traceId: 't-own' } });
    });
    await gateway.request({ url: URL_ORDERS }, { payload: 1, headers: { traceId: 't-out' } });
    expect(calls[0]?.init.headers['x-trace-id']).toBe('t-amb');
    expect(calls[0]?.init.headers['x-correlation-id']).toBe('c-amb');
    expect(calls[0]?.init.headers['x-parent-span-id']).toBe('s-amb');
    expect(calls[1]?.init.headers['x-trace-id']).toBe('t-own');
    expect(calls[2]?.init.headers['x-trace-id']).toBe('t-out');
  });
});

describe('timeouts', () => {
  const hanging: OutboundFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
    });

  it('aborts the request and throws a typed timeout error', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const gateway = new OutboundRestGateway({
      fetchFn: (url, init) => {
        signals.push(init.signal);
        return hanging(url, init);
      },
    });
    const error = await failure(
      gateway.request(
        { name: 'slow', url: `${URL_ORDERS}?apiKey=s3cret`, timeoutMs: 15 },
        { payload: 1 },
      ),
    );
    expect(error).toBeInstanceOf(OutboundTimeoutError);
    expect(error).toBeInstanceOf(OutboundRestError);
    const timeout = error as OutboundTimeoutError;
    expect(timeout.kind).toBe('timeout');
    expect(timeout.timeoutMs).toBe(15);
    expect(timeout.name).toBe('OutboundTimeoutError');
    expect(timeout.message).toBe(
      "outbound rest 'slow' POST https://erp.example/orders -> timeout after 15ms",
    );
    expect(timeout.url).toBe(`${URL_ORDERS}?apiKey=s3cret`);
    expect(timeout.attempts).toBe(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('times out even when the fetch ignores the abort signal', async () => {
    const gateway = new OutboundRestGateway({ fetchFn: () => new Promise(() => undefined) });
    const error = await failure(
      gateway.request({ url: URL_ORDERS, timeoutMs: 10 }, { payload: 1 }),
    );
    expect(error).toBeInstanceOf(OutboundTimeoutError);
  });

  it('covers a response whose body never arrives', async () => {
    const gateway = new OutboundRestGateway({
      fetchFn: async () => ({ ok: true, status: 200, text: () => new Promise(() => undefined) }),
    });
    const error = await failure(
      gateway.request({ url: URL_ORDERS, timeoutMs: 10 }, { payload: 1 }),
    );
    expect(error).toBeInstanceOf(OutboundTimeoutError);
  });

  it('resolves the timeout as call > target > binding > module default', async () => {
    const { gateway } = gatewayWith({ defaults: { timeoutMs: 4000 } }, answer(200));
    const response = (ctx: OutboundResponseContext): number => ctx.request.timeoutMs;
    const fromModule = { url: URL_ORDERS, response };
    const fromBinding = { url: URL_ORDERS, response, timeoutMs: 3000 };
    const fromTarget = { ...fromBinding, target: () => ({ timeoutMs: 2000 }) };
    expect(await gateway.request(fromModule, { payload: 1 })).toBe(4000);
    expect(await gateway.request(fromBinding, { payload: 1 })).toBe(3000);
    expect(await gateway.request(fromTarget, { payload: 1 })).toBe(2000);
    expect(await gateway.request(fromTarget, { payload: 1 }, { timeoutMs: 1000 })).toBe(1000);
  });

  it('timeoutMs: 0 disables the timeout and passes no signal', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS, timeoutMs: 0 }, { payload: 1 });
    expect(first(calls).init).not.toHaveProperty('signal');
  });

  it('rejects a timeout that is not a finite, non-negative number', async () => {
    const { gateway, calls } = gatewayWith({}, answer(200));
    expect(() => gateway.bind({ name: 'bad', url: URL_ORDERS, timeoutMs: -1 })).toThrow(
      "outbound rest timeoutMs '-1' is not a valid timeout",
    );
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number]) {
      const error = await failure(
        gateway.request({ url: URL_ORDERS }, { payload: 1 }, { timeoutMs }),
      );
      expect(error).toBeInstanceOf(OutboundError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('typed errors and the error mapper', () => {
  it('an HTTP error keeps status, parsed body, headers, url and method', async () => {
    const { gateway } = gatewayWith(
      {},
      {
        ...answer(
          422,
          { code: 'INVALID', message: 'sku is required' },
          {
            'Content-Type': 'application/json',
            'X-Request-Id': 'r-9',
          },
        ),
        statusText: 'Unprocessable Entity',
      },
    );
    const error = await failure(
      gateway.request(
        { name: 'orders', url: `${URL_ORDERS}?token=s3cret`, method: 'PUT' },
        { payload: { a: 1 } },
      ),
    );
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect(error).toBeInstanceOf(OutboundRestError);
    expect(error).toBeInstanceOf(OutboundError);
    expect(error).toBeInstanceOf(ChannelError);
    const http = error as OutboundHttpError;
    expect(http.kind).toBe('http');
    expect(http.name).toBe('OutboundHttpError');
    expect(http.status).toBe(422);
    expect(http.statusText).toBe('Unprocessable Entity');
    expect(http.body).toEqual({ code: 'INVALID', message: 'sku is required' });
    expect(http.headers).toEqual({ 'content-type': 'application/json', 'x-request-id': 'r-9' });
    expect(http.url).toBe(`${URL_ORDERS}?token=s3cret`);
    expect(http.method).toBe('PUT');
    expect(http.binding).toBe('orders');
    expect(http.attempts).toBe(1);
    expect(http.message).toBe("outbound rest 'orders' PUT https://erp.example/orders -> HTTP 422");
    expect(http.message).not.toContain('s3cret');
  });

  it('an HTTP error without status text or headers still reads its text body', async () => {
    const { gateway } = gatewayWith(
      {},
      { ok: false, status: 500, text: async () => 'upstream down' },
    );
    const http = (await failure(
      gateway.request({ url: URL_ORDERS }, { payload: 1 }),
    )) as OutboundHttpError;
    expect(http.statusText).toBe('');
    expect(http.headers).toEqual({});
    expect(http.body).toBe('upstream down');
  });

  it('a network error keeps the cause and its code, from the error or from its cause', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { gateway } = gatewayWith({}, refused, reset, new Error('boom'));
    const options = { name: 'erp', url: URL_ORDERS };

    const one = (await failure(gateway.request(options, { payload: 1 }))) as OutboundNetworkError;
    expect(one).toBeInstanceOf(OutboundNetworkError);
    expect(one.kind).toBe('network');
    expect(one.code).toBe('ECONNREFUSED');
    expect(one.cause).toBe(refused);
    expect(one.message).toBe(
      "outbound rest 'erp' POST https://erp.example/orders -> network error (ECONNREFUSED)",
    );

    const two = (await failure(gateway.request(options, { payload: 1 }))) as OutboundNetworkError;
    expect(two.code).toBe('ECONNRESET');

    const three = (await failure(gateway.request(options, { payload: 1 }))) as OutboundNetworkError;
    expect(three.code).toBeUndefined();
    expect(three.message).toBe(
      "outbound rest 'erp' POST https://erp.example/orders -> network error",
    );
  });

  it('a non-Error rejection of fetch is still a network error', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const gateway = new OutboundRestGateway({ fetchFn: () => Promise.reject('offline') });
    const error = (await failure(
      gateway.request({ url: URL_ORDERS }, { payload: 1 }),
    )) as OutboundNetworkError;
    expect(error).toBeInstanceOf(OutboundNetworkError);
    expect(error.cause).toBe('offline');
    expect(error.code).toBeUndefined();
  });

  it('the error mapper translates each failure into the error of the service', async () => {
    class UpstreamError extends Error {
      constructor(
        readonly type: string,
        readonly status: number,
        readonly detail: unknown,
        readonly durationMs: number,
      ) {
        super(`upstream ${type}`);
      }
    }
    const contexts: OutboundExchangeContext[] = [];
    const options: OutboundRestRequestOptions = {
      url: URL_ORDERS,
      timeoutMs: 10,
      mapError: (error, ctx) => {
        contexts.push(ctx);
        const status = error instanceof OutboundHttpError ? error.status : 0;
        const detail = error instanceof OutboundHttpError ? error.body : error.message;
        return new UpstreamError(error.kind, status, detail, ctx.durationMs);
      },
    };
    const { gateway } = gatewayWith(
      {},
      answer(409, { reason: 'taken' }),
      new Error('down'),
      () => new Promise(() => undefined),
    );
    const http = (await failure(gateway.request(options, { payload: { id: 1 } }))) as UpstreamError;
    const network = (await failure(gateway.request(options, { payload: 1 }))) as UpstreamError;
    const timeout = (await failure(gateway.request(options, { payload: 1 }))) as UpstreamError;
    expect(http).toBeInstanceOf(UpstreamError);
    expect([http.type, http.status, http.detail]).toEqual(['http', 409, { reason: 'taken' }]);
    expect([network.type, network.status]).toEqual(['network', 0]);
    expect([timeout.type, timeout.status]).toEqual(['timeout', 0]);
    expect(contexts[0]?.payload).toEqual({ id: 1 });
    expect(contexts[0]?.attempts).toBe(1);
    expect(contexts[0]?.request.url).toBe(URL_ORDERS);
  });

  it('a mapper that returns nothing keeps the typed error; an instance mapper may be async', async () => {
    const { gateway } = gatewayWith({}, answer(500));
    const kept = await failure(
      gateway.request({ url: URL_ORDERS, mapError: () => undefined }, { payload: 1 }),
    );
    expect(kept).toBeInstanceOf(OutboundHttpError);

    const mapper: OutboundErrorMapper = { mapError: async (error) => ({ code: error.kind }) };
    const mapped = await failure(
      gateway.request({ url: URL_ORDERS, mapError: mapper }, { payload: 1 }),
    );
    expect(mapped).toEqual({ code: 'http' });
  });
});

describe('outbound idempotency key', () => {
  const headersOf = async (
    options: OutboundRestRequestOptions,
    input: { payload: unknown; headers?: Record<string, unknown> },
    deps: OutboundRestGatewayDeps = {},
    call = {},
  ): Promise<Record<string, string>> => {
    const { gateway, calls } = gatewayWith(deps, answer(200));
    await gateway.request({ url: URL_ORDERS, ...options }, input, call);
    return first(calls).init.headers;
  };
  const withKey = { payload: { orderId: 'o-1' }, headers: { idempotencyKey: 'inbound-key' } };

  it('uses a configurable header name', async () => {
    const headers = await headersOf({ idempotency: { header: 'X-Idempotency-Key' } }, withKey);
    expect(headers['X-Idempotency-Key']).toBe('inbound-key');
    expect(headers).not.toHaveProperty('Idempotency-Key');
    expect(headers).not.toHaveProperty('idempotency-key');
  });

  it('sends a stable key derived from the message by a resolver', async () => {
    const options: OutboundRestRequestOptions = {
      idempotency: {
        key: ({ payload, method }: OutboundCallContext<{ orderId: string }>) =>
          `order:${payload.orderId}:${method}`,
      },
    };
    const one = await headersOf(options, withKey);
    const two = await headersOf(options, withKey);
    expect(one['Idempotency-Key']).toBe('order:o-1:POST');
    expect(two['Idempotency-Key']).toBe('order:o-1:POST');
  });

  it('escapes and joins key parts so that no part can forge another', async () => {
    const headers = await headersOf(
      { idempotency: { key: () => ['tenant:a', 42, '100%'] } },
      { payload: 1 },
    );
    expect(headers['Idempotency-Key']).toBe('tenant%3Aa:42:100%25');
  });

  it('with a resolver the message key is not forwarded unless forward is set', async () => {
    const silent: OutboundKeyResolver = { resolveKey: async () => undefined };
    const none = await headersOf({ idempotency: { key: silent } }, withKey);
    expect(none).not.toHaveProperty('Idempotency-Key');

    const viaNull = await headersOf({ idempotency: { key: () => null, forward: true } }, withKey);
    expect(viaNull['Idempotency-Key']).toBe('inbound-key');
  });

  it('forward: false sends nothing without a resolver', async () => {
    const headers = await headersOf({ idempotency: { forward: false } }, withKey);
    expect(headers).not.toHaveProperty('Idempotency-Key');
  });

  it('ignores a message key that is not a non-empty string', async () => {
    for (const idempotencyKey of ['', 7]) {
      const headers = await headersOf({}, { payload: 1, headers: { idempotencyKey } });
      expect(headers).not.toHaveProperty('Idempotency-Key');
    }
  });

  it('idempotency: false sends no key at all, not even an explicit one', async () => {
    const headers = await headersOf(
      { idempotency: false, target: () => ({ idempotencyKey: 'explicit' }) },
      withKey,
      {},
      { idempotencyKey: 'call' },
    );
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('idempotency-key');
  });

  it('explicit keys win: call over target over resolver', async () => {
    const options: OutboundRestRequestOptions = {
      idempotency: { key: () => 'from-resolver' },
      target: () => ({ idempotencyKey: ['from', 'target'] }),
    };
    expect((await headersOf(options, withKey))['Idempotency-Key']).toBe('from:target');
    const viaCall = await headersOf(options, withKey, {}, { idempotencyKey: 'from-call' });
    expect(viaCall['Idempotency-Key']).toBe('from-call');
  });

  it('rejects an empty key or an empty part instead of sending it', async () => {
    for (const key of ['', [], ['a', ''], [Number.NaN]]) {
      const { gateway, calls } = gatewayWith({}, answer(200));
      const error = await failure(
        gateway.request(
          { name: 'pay', url: URL_ORDERS, idempotency: { key: () => key as string } },
          { payload: 1 },
        ),
      );
      expect(error).toBeInstanceOf(OutboundError);
      expect((error as Error).message).toContain(
        "outbound rest 'pay': the idempotency key must be",
      );
      expect(calls).toHaveLength(0);
    }
  });

  it('layers binding options over module defaults; enabled is not inherited', async () => {
    const defaults = { idempotency: { header: 'X-Key', forward: false } };
    const inherited = await headersOf({}, withKey, { defaults });
    expect(inherited).not.toHaveProperty('X-Key');

    const overridden = await headersOf({ idempotency: { forward: true } }, withKey, { defaults });
    expect(overridden['X-Key']).toBe('inbound-key');

    const moduleOff = { defaults: { idempotency: false as const } };
    expect(await headersOf({}, withKey, moduleOff)).not.toHaveProperty('Idempotency-Key');
    const backOn = await headersOf({ idempotency: { header: 'X-Own' } }, withKey, moduleOff);
    expect(backOn['X-Own']).toBe('inbound-key');

    const undefinedInherits = await headersOf(
      { idempotency: { header: undefined as unknown as string, forward: true } },
      withKey,
      { defaults },
    );
    expect(undefinedInherits['X-Key']).toBe('inbound-key');
  });

  it('rejects an empty header name', () => {
    const { gateway } = gatewayWith({});
    expect(() => gateway.bind({ name: 'x', url: URL_ORDERS, idempotency: { header: '' } })).toThrow(
      'outbound idempotency header must be a non-empty string',
    );
  });
});

describe('retry policy', () => {
  const run = async (
    options: OutboundRestRequestOptions,
    replies: Reply[],
    input: { payload: unknown; headers?: Record<string, unknown> } = { payload: 1 },
    deps: OutboundRestGatewayDeps = {},
  ): Promise<{ outcome: unknown; calls: Call[]; sleeps: number[] }> => {
    const { gateway, calls, sleeps } = gatewayWith(deps, ...replies);
    const outcome = await gateway
      .request({ url: URL_ORDERS, ...options }, input)
      .catch((error: unknown) => error);
    return { outcome, calls, sleeps };
  };

  it('retries a safe method on a retryable status with exponential backoff', async () => {
    const { outcome, calls, sleeps } = await run(
      { method: 'GET', retry: { maxAttempts: 4 }, response: (ctx) => ctx.attempts },
      [answer(503), answer(429), answer(408), answer(200)],
    );
    expect(outcome).toBe(4);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([200, 400, 800]);
  });

  it('defaults to three attempts and throws the last failure with its attempt count', async () => {
    const { outcome, calls } = await run({ method: 'HEAD', retry: {} }, [answer(500)]);
    expect(calls).toHaveLength(3);
    expect(outcome).toBeInstanceOf(OutboundHttpError);
    expect((outcome as OutboundHttpError).attempts).toBe(3);
  });

  it('retries network errors and timeouts', async () => {
    const { outcome, calls } = await run(
      { method: 'OPTIONS', timeoutMs: 10, retry: { maxAttempts: 3, backoff: 0 } },
      [new Error('reset'), () => new Promise(() => undefined), answer(200, { ok: 1 })],
    );
    expect((outcome as OutboundRestResponse).body).toEqual({ ok: 1 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a status that a retry cannot fix', async () => {
    for (const status of [400, 401, 404, 409, 422]) {
      const { calls } = await run({ method: 'GET', retry: { maxAttempts: 3 } }, [answer(status)]);
      expect(calls).toHaveLength(1);
    }
  });

  it('never retries an unsafe method that carries no idempotency key', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const { outcome, calls, sleeps } = await run({ method, retry: { maxAttempts: 3 } }, [
        answer(503),
      ]);
      expect(outcome).toBeInstanceOf(OutboundHttpError);
      expect(calls).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it('retries an unsafe method while an idempotency key is sent, reusing the same key', async () => {
    let resolved = 0;
    const { outcome, calls } = await run(
      {
        retry: { maxAttempts: 3 },
        idempotency: {
          key: () => {
            resolved += 1;
            return `pay:${resolved}`;
          },
        },
      },
      [answer(502), new Error('reset'), answer(200, { paid: true })],
    );
    expect((outcome as OutboundRestResponse).body).toEqual({ paid: true });
    expect(calls.map((call) => call.init.headers['Idempotency-Key'])).toEqual([
      'pay:1',
      'pay:1',
      'pay:1',
    ]);
    expect(resolved).toBe(1);
  });

  it('retries an unsafe method with the forwarded message key', async () => {
    const { calls } = await run({ retry: { maxAttempts: 2 } }, [answer(503), answer(200)], {
      payload: 1,
      headers: { idempotencyKey: 'k-1' },
    });
    expect(calls.map((call) => call.init.headers['Idempotency-Key'])).toEqual(['k-1', 'k-1']);
  });

  it('retries a method the policy allows explicitly', async () => {
    const { calls } = await run({ method: 'PUT', retry: { maxAttempts: 2, methods: ['PUT'] } }, [
      answer(503),
      answer(200),
    ]);
    expect(calls).toHaveLength(2);
  });

  it('honours a custom classifier, as a function or an instance', async () => {
    const onlyConflict: OutboundRetryClassifier = {
      isRetryable: async (error) => error instanceof OutboundHttpError && error.status === 409,
    };
    const conflict = await run({ method: 'GET', retry: { retryOn: onlyConflict } }, [
      answer(409),
      answer(200),
    ]);
    expect(conflict.calls).toHaveLength(2);
    const never = await run({ method: 'GET', retry: { retryOn: () => false } }, [answer(503)]);
    expect(never.calls).toHaveLength(1);
  });

  it('supports a fixed delay, custom exponential settings with a cap, and a function', async () => {
    const replies = [answer(503)];
    const fixed = await run({ method: 'GET', retry: { maxAttempts: 3, backoff: 50 } }, replies);
    expect(fixed.sleeps).toEqual([50, 50]);

    const capped = await run(
      {
        method: 'GET',
        retry: { maxAttempts: 5, backoff: { initialMs: 100, factor: 3, maxMs: 500 } },
      },
      replies,
    );
    expect(capped.sleeps).toEqual([100, 300, 500, 500]);

    const seen: [number, string][] = [];
    const custom = await run(
      {
        method: 'GET',
        retry: {
          maxAttempts: 3,
          backoff: (attempt, error) => {
            seen.push([attempt, error.kind]);
            return attempt === 1 ? -5 : 7;
          },
        },
      },
      replies,
    );
    expect(seen).toEqual([
      [1, 'http'],
      [2, 'http'],
    ]);
    expect(custom.sleeps).toEqual([0, 7]);
  });

  it('waits for real between attempts when no sleep is injected', async () => {
    const { fetchFn, calls } = fakeFetch(answer(503), answer(200));
    const gateway = new OutboundRestGateway({ fetchFn });
    const startedAt = Date.now();
    await gateway.request(
      { url: URL_ORDERS, method: 'GET', retry: { maxAttempts: 2, backoff: 25 } },
      { payload: 1 },
    );
    expect(calls).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it('applies the error mapper once, after the last attempt', async () => {
    const mapError = jest.fn(
      (error: OutboundRestError) => new Error(`gave up after ${error.attempts}`),
    );
    const { outcome } = await run({ method: 'GET', retry: { maxAttempts: 2 }, mapError }, [
      answer(503),
    ]);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect((outcome as Error).message).toBe('gave up after 2');
  });

  it('inherits the module policy, and a binding can refine it or turn it off', async () => {
    const deps: OutboundRestGatewayDeps = { defaults: { retry: { maxAttempts: 2, backoff: 5 } } };
    const input = { payload: 1 };
    const inherited = await run({ method: 'GET' }, [answer(503)], input, deps);
    expect(inherited.calls).toHaveLength(2);
    expect(inherited.sleeps).toEqual([5]);

    const refined = await run(
      { method: 'GET', retry: { maxAttempts: 4 } },
      [answer(503)],
      input,
      deps,
    );
    expect(refined.calls).toHaveLength(4);
    expect(refined.sleeps).toEqual([5, 5, 5]);

    const off = await run({ method: 'GET', retry: false }, [answer(503)], input, deps);
    expect(off.calls).toHaveLength(1);
    const disabled = await run(
      { method: 'GET', retry: { enabled: false } },
      [answer(503)],
      input,
      deps,
    );
    expect(disabled.calls).toHaveLength(1);

    const moduleOff: OutboundRestGatewayDeps = { defaults: { retry: false } };
    const stillOff = await run({ method: 'GET' }, [answer(503)], input, moduleOff);
    expect(stillOff.calls).toHaveLength(1);
  });

  it('rejects a maxAttempts that is not a positive integer', () => {
    const { gateway } = gatewayWith({});
    for (const maxAttempts of [0, 1.5, Number.NaN]) {
      expect(() => gateway.bind({ name: 'r', url: URL_ORDERS, retry: { maxAttempts } })).toThrow(
        'outbound retry maxAttempts must be an integer of at least 1',
      );
    }
    expect(() =>
      gateway.bind({ name: 'r', url: URL_ORDERS, retry: { methods: ['TRACE' as 'PUT'] } }),
    ).toThrow("outbound rest method 'TRACE' is not supported");
  });
});

describe('strategies from DI and misconfigurations', () => {
  class TenantTargets implements OutboundTargetResolver<{ tenant: string }> {
    calls = 0;
    resolveTarget(ctx: OutboundRequestContext<{ tenant: string }>): OutboundRestTarget {
      this.calls += 1;
      return { url: `https://${ctx.payload.tenant}.example/api` };
    }
  }

  it('resolves { useExisting } strategies once and calls them as methods', async () => {
    const targets = new TenantTargets();
    const resolve = jest.fn(() => targets);
    const resolver = { resolve } as unknown as OutboundProviderResolver;
    const { gateway, calls } = gatewayWith({ resolver }, answer(200));
    const options: OutboundRestRequestOptions = { target: { useExisting: TenantTargets } };
    await gateway.request(options, { payload: { tenant: 'acme' } });
    await gateway.request(options, { payload: { tenant: 'globex' } });
    expect(calls.map((call) => call.url)).toEqual([
      'https://acme.example/api',
      'https://globex.example/api',
    ]);
    expect(targets.calls).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(TenantTargets);
  });

  it('rejects a class passed where an instance or a ref is expected', () => {
    const { gateway } = gatewayWith({});
    expect(() =>
      gateway.bind({ name: 'x', target: TenantTargets as unknown as OutboundTargetResolver }),
    ).toThrow("outbound target 'TenantTargets' is a class; pass { useExisting: TenantTargets }");
  });

  it('reports a ref that cannot be resolved', () => {
    const { gateway } = gatewayWith({});
    expect(() => gateway.bind({ name: 'x', target: { useExisting: 'TARGETS' } })).toThrow(
      "outbound target 'TARGETS' needs a provider resolver",
    );
    const failing = (thrown: unknown): OutboundRestGateway =>
      new OutboundRestGateway({
        resolver: {
          resolve: () => {
            throw thrown;
          },
        },
      });
    expect(() =>
      failing(new Error('Nest could not find TenantTargets')).bind({
        name: 'x',
        url: URL_ORDERS,
        mapError: { useExisting: TenantTargets as never },
      }),
    ).toThrow(
      "outbound error mapper 'TenantTargets' could not be resolved: Nest could not find TenantTargets",
    );
    expect(() =>
      failing('nope').bind({
        name: 'x',
        url: URL_ORDERS,
        response: { useExisting: Symbol('MAPPER') },
      }),
    ).toThrow("outbound response mapper 'Symbol(MAPPER)' could not be resolved: unknown provider");
  });

  it('rejects an instance that lacks the port method, and nullish strategies', () => {
    const { gateway } = gatewayWith({});
    expect(() =>
      gateway.bind({ name: 'x', url: URL_ORDERS, serializer: {} as OutboundBodySerializer }),
    ).toThrow("outbound serializer has no 'serialize' method");
    expect(() =>
      gateway.bind({
        name: 'x',
        url: URL_ORDERS,
        mapHeaders: null as unknown as OutboundHeaderMapper,
      }),
    ).toThrow("outbound header mapper has no 'mapHeaders' method");
    expect(() =>
      gateway.bind({
        name: 'x',
        url: URL_ORDERS,
        retry: { retryOn: { useExisting: 'R' } },
      }),
    ).toThrow("outbound retry classifier 'R' needs a provider resolver");
    expect(() =>
      gateway.bind({ name: 'x', url: URL_ORDERS, idempotency: { key: {} as OutboundKeyResolver } }),
    ).toThrow("outbound key resolver has no 'resolveKey' method");
  });

  it('rejects unknown built-in names, methods and incomplete bindings', () => {
    const { gateway } = gatewayWith({});
    expect(() => gateway.bind({ url: URL_ORDERS })).toThrow(
      'an outbound rest binding needs a channel or a name',
    );
    expect(() => gateway.bind({ name: '', url: URL_ORDERS })).toThrow(OutboundError);
    expect(() => gateway.bind({ name: 'x' })).toThrow(
      "outbound rest 'x' needs a url or a target resolver",
    );
    expect(() => gateway.bind({ name: 'x', url: URL_ORDERS, method: 'TRACE' as 'GET' })).toThrow(
      "outbound rest method 'TRACE' is not supported",
    );
    expect(() => gateway.bind({ name: 'x', url: URL_ORDERS, response: 'raw' as 'body' })).toThrow(
      "outbound response 'raw' is not a known mapper",
    );
    expect(() => gateway.bind({ name: 'x', url: URL_ORDERS, serializer: 'xml' as 'json' })).toThrow(
      "outbound serializer 'xml' is not a known serializer",
    );
    expect(gateway.bindings()).toEqual([]);
  });

  it('an option set to undefined inherits the module default instead of erasing it', async () => {
    const { gateway, calls } = gatewayWith(
      { defaults: { method: 'PUT', response: 'body' } },
      answer(200, 7),
    );
    const reply = await gateway.request(
      {
        url: URL_ORDERS,
        method: undefined as unknown as 'GET',
        response: undefined as unknown as 'full',
      },
      { payload: 1 },
    );
    expect(first(calls).init.method).toBe('PUT');
    expect(reply).toBe(7);
  });

  it('prefers the fetch of the binding, then of the module defaults, then of the gateway', async () => {
    const own = fakeFetch(answer(200, 'binding'));
    const moduleWide = fakeFetch(answer(200, 'module'));
    const { gateway, calls } = gatewayWith(
      { defaults: { fetchFn: moduleWide.fetchFn } },
      answer(200),
    );
    const viaBinding = await gateway.request(
      { url: URL_ORDERS, fetchFn: own.fetchFn },
      { payload: 1 },
    );
    const viaModule = await gateway.request({ url: URL_ORDERS }, { payload: 1 });
    expect(viaBinding.body).toBe('binding');
    expect(viaModule.body).toBe('module');
    expect(calls).toHaveLength(0);
  });
});

describe('declared bindings', () => {
  const world = (
    ...replies: Reply[]
  ): {
    registry: ChannelRegistry;
    reply: ReplyGateway;
    gateway: OutboundRestGateway;
    calls: Call[];
  } => {
    const trace = new TraceContext();
    const registry = new ChannelRegistry({ trace });
    const { gateway, calls } = gatewayWith({ registry, trace }, ...replies);
    return { registry, reply: new ReplyGateway({ registry, trace }), gateway, calls };
  };

  it('describes each binding for the boot log without leaking query or credentials', () => {
    const { registry, gateway } = world();
    registry.create({ name: 'orders.http', type: 'direct' });
    gateway.bind({
      channel: 'orders.http',
      url: 'https://user:pass@erp.example/orders?apiKey=s3cret#frag',
      method: 'PUT',
    });
    gateway.bind({ name: 'pricing', target: () => ({ url: URL_ORDERS }) });
    gateway.bind({ name: 'mixed', url: URL_ORDERS, target: () => ({}) });
    expect(gateway.bindings()).toEqual([
      {
        name: 'orders.http',
        channel: 'orders.http',
        target: 'PUT https://erp.example/orders',
        line: 'outbound rest: orders.http -> PUT https://erp.example/orders',
      },
      { name: 'pricing', target: 'dynamic', line: 'outbound rest: pricing -> dynamic' },
      { name: 'mixed', target: 'dynamic', line: 'outbound rest: mixed -> dynamic' },
    ]);
  });

  it('request by name uses the declared binding; an unknown name is rejected', async () => {
    const { gateway, calls } = world(answer(200, { price: 3 }));
    gateway.bind({ name: 'pricing', url: URL_ORDERS, method: 'GET', response: 'body' });
    expect(await gateway.request('pricing', { payload: null })).toEqual({ price: 3 });
    expect(first(calls).init.method).toBe('GET');
    const error = await failure(gateway.request('billing', { payload: null }));
    expect(error).toBeInstanceOf(OutboundError);
    expect((error as Error).message).toBe("outbound rest 'billing' is not declared");
  });

  it('rejects a duplicate name and frees it when the binding is removed', async () => {
    const { registry, gateway, calls } = world(answer(200));
    registry.create({ name: 'orders.http', type: 'direct' });
    const unbind = gateway.bind({ channel: 'orders.http', url: URL_ORDERS });
    expect(() => gateway.bind({ name: 'orders.http', url: URL_ORDERS })).toThrow(
      "outbound rest 'orders.http' is already declared",
    );
    unbind();
    expect(gateway.bindings()).toEqual([]);
    await expect(registry.send('orders.http', {})).rejects.toThrow('no tiene subscriber');
    expect(calls).toHaveLength(0);
    const unbindNamed = gateway.bind({ name: 'orders.http', url: URL_ORDERS });
    unbindNamed();
    expect(gateway.bindings()).toEqual([]);
  });

  it('a channel binding needs a registry and an existing channel', () => {
    expect(() =>
      new OutboundRestGateway().bind({ channel: 'orders.http', url: URL_ORDERS }),
    ).toThrow("outbound rest 'orders.http': a channel binding needs a registry");
    const { gateway } = world();
    expect(() => gateway.bind({ channel: 'missing', url: URL_ORDERS })).toThrow("'missing'");
    expect(gateway.bindings()).toEqual([]);
  });

  it('replies the response on the reply channel: ReplyGateway.sendAndReceive works', async () => {
    const { registry, reply, gateway, calls } = world(answer(200, { id: 'o-1' }));
    registry.create({ name: 'orders.http', type: 'direct' });
    const contexts: OutboundResponseContext[] = [];
    gateway.bind({
      channel: 'orders.http',
      name: 'orders',
      url: URL_ORDERS,
      response: (ctx) => {
        contexts.push(ctx);
        return ctx.response;
      },
    });
    const result = await reply.sendAndReceive(
      'orders.http',
      { sku: 'A' },
      { traceId: 't-1', correlationId: 'c-1' },
    );
    expect(result).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { id: 'o-1' },
    });
    expect(first(calls).init.headers['x-correlation-id']).toBe('c-1');
    expect(contexts[0]?.name).toBe('orders');
    expect(contexts[0]?.channel).toBe('orders.http');
    expect(registry.list().map((channel) => channel.name)).toEqual(['orders.http']);
  });

  it('the reply continues the trace of the request', async () => {
    const { registry, gateway } = world(answer(200, 1));
    registry.create({ name: 'orders.http', type: 'direct' });
    const replies: IntegrationMessage[] = [];
    registry.create({ name: 'reply.manual', type: 'direct' }).subscribe((msg) => {
      replies.push(msg);
    });
    gateway.bind({ channel: 'orders.http', url: URL_ORDERS, response: 'body' });
    const request = createMessage(
      {},
      { traceId: 't-2', correlationId: 'c-2', replyChannel: 'reply.manual' },
    );
    await registry.sendMessage('orders.http', request);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toBe(1);
    expect(replies[0]?.headers.traceId).toBe('t-2');
    expect(replies[0]?.headers.correlationId).toBe('c-2');
    expect(replies[0]?.headers.causationId).toBe(request.headers.id);
    expect(replies[0]?.headers.parentSpanId).toBe(request.headers.spanId);
  });

  it('without a reply channel the call is made and nothing is replied', async () => {
    const { registry, gateway, calls } = world(answer(200));
    registry.create({ name: 'orders.http', type: 'direct' });
    gateway.bind({ channel: 'orders.http', url: URL_ORDERS });
    await registry.send('orders.http', { sku: 'A' });
    await registry.send('orders.http', { sku: 'B' }, { replyChannel: '' });
    expect(calls.map((call) => call.init.body)).toEqual(['{"sku":"A"}', '{"sku":"B"}']);
  });

  it('a failed call rejects the sender with the typed error', async () => {
    const { registry, reply, gateway } = world(answer(404, { message: 'no such order' }));
    registry.create({ name: 'orders.http', type: 'direct' });
    gateway.bind({ channel: 'orders.http', url: URL_ORDERS });
    const error = await failure(reply.sendAndReceive('orders.http', {}));
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect((error as OutboundHttpError).body).toEqual({ message: 'no such order' });
    expect(registry.list().map((channel) => channel.name)).toEqual(['orders.http']);
  });

  it('a flow jumpTo collects the HTTP reply of the binding', async () => {
    const { registry, reply, gateway } = world(answer(200, { stock: 4 }));
    registry.create({ name: 'inventory.http', type: 'direct' });
    gateway.bind({ channel: 'inventory.http', url: URL_ORDERS, method: 'GET', response: 'body' });
    bindFlow(
      {
        name: 'check-stock',
        build: () =>
          IntegrationFlow.from('stock.check')
            .jumpTo([{ channel: 'inventory.http', timeoutMs: 500 }])
            .reply({ payload: 'jumpMerge' }),
      },
      registry,
    );
    const result = await reply.sendAndReceive('stock.check', { sku: 'A' });
    expect(result).toEqual({ sku: 'A', jumpReplies: { 'inventory.http': { stock: 4 } } });
  });
});

describe('hop logging', () => {
  it('brackets each call with a hop line and prints no body, header, key or query value', async () => {
    const logger = new HopLogger();
    const start = jest.spyOn(logger, 'hopStart').mockImplementation(() => undefined);
    const end = jest.spyOn(logger, 'hopEnd').mockImplementation(() => undefined);
    const trace = new TraceContext();
    const registry = new ChannelRegistry({ trace });
    registry.create({ name: 'orders.http', type: 'direct' });
    const { gateway } = gatewayWith({ logger, registry, trace }, answer(200), answer(500));
    gateway.bind({ channel: 'orders.http', url: `${URL_ORDERS}?apiKey=s3cret` });
    gateway.bind({ name: 'pricing', url: URL_ORDERS, method: 'GET' });

    await registry.send(
      'orders.http',
      { card: '4111' },
      { idempotencyKey: 'k-secret', traceId: 't-1' },
    );
    await failure(
      gateway.request('pricing', { payload: 1 }, { headers: { authorization: 'Bearer tk' } }),
    );

    const target = 'outbound:rest POST https://erp.example/orders';
    expect(start).toHaveBeenNthCalledWith(
      1,
      'orders.http',
      target,
      expect.objectContaining({ traceId: 't-1' }),
    );
    expect(end).toHaveBeenNthCalledWith(
      1,
      'orders.http',
      target,
      expect.anything(),
      true,
      expect.any(Number),
    );
    expect(start).toHaveBeenNthCalledWith(
      2,
      'pricing',
      `outbound:rest GET ${URL_ORDERS}`,
      expect.anything(),
    );
    expect(end).toHaveBeenNthCalledWith(
      2,
      'pricing',
      `outbound:rest GET ${URL_ORDERS}`,
      expect.anything(),
      false,
      expect.any(Number),
    );
    const printed = [...start.mock.calls, ...end.mock.calls]
      .map(([channel, hopTarget]) => `${channel} ${hopTarget}`)
      .join('\n');
    expect(printed).not.toMatch(/s3cret|4111|k-secret|Bearer/);
  });

  it('logs nothing without a hop logger', async () => {
    const log = jest.spyOn(HopLogger.prototype, 'hopStart');
    const { gateway } = gatewayWith({}, answer(200));
    await gateway.request({ url: URL_ORDERS }, { payload: 1 });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe('redactUrl', () => {
  it('drops query, fragment and credentials and keeps the rest', () => {
    expect(redactUrl('https://u:p@host.example:8443/a/b?x=1#y')).toBe(
      'https://host.example:8443/a/b',
    );
    expect(redactUrl('https://host.example/a#frag')).toBe('https://host.example/a');
    expect(redactUrl('https://host.example/a')).toBe('https://host.example/a');
  });
});

describe('@OutboundRest', () => {
  class ApiCalls {
    readonly base = 'https://api.example';

    @OutboundRest({ channel: 'api.call', timeoutMs: 500 })
    target(payload: { path: string }, message: IntegrationMessage): OutboundRestTarget {
      return {
        url: `${this.base}/${payload.path}`,
        headers: { 'x-corr': message.headers.correlationId },
      };
    }

    plain(): void {}
  }

  it('stores the spec on the method and nothing on the others', () => {
    expect(readOutboundRestSpec(ApiCalls.prototype, 'target')).toEqual({
      channel: 'api.call',
      timeoutMs: 500,
    });
    expect(readOutboundRestSpec(ApiCalls.prototype, 'plain')).toBeUndefined();
    expect(Reflect.getMetadataKeys(ApiCalls.prototype, 'target')).toContain(OUTBOUND_REST_METADATA);
  });

  it('turns the annotated method into the target resolver, bound to its instance', async () => {
    const instance = new ApiCalls();
    const spec = readOutboundRestSpec(ApiCalls.prototype, 'target');
    const binding = outboundRestBindingOf(instance, 'target', {
      name: 'api',
      timeoutMs: spec?.timeoutMs ?? 0,
    });
    const { gateway, calls } = gatewayWith({}, answer(200));
    gateway.bind(binding);
    await gateway.request('api', {
      payload: { path: 'v1/items' },
      headers: { correlationId: 'c-5' },
    });
    expect(first(calls).url).toBe('https://api.example/v1/items');
    expect(first(calls).init.headers['x-corr']).toBe('c-5');
    expect(binding.timeoutMs).toBe(500);
  });

  it('rejects a method that does not exist on the instance', () => {
    expect(() => outboundRestBindingOf(new ApiCalls(), 'gone', { name: 'x' })).toThrow(
      "outbound rest: method 'gone' was not found",
    );
  });
});
