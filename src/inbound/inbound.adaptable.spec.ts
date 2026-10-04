import 'reflect-metadata';

import { lastValueFrom, of } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';
import { ReplyGateway, ReplyTimeoutError } from '../gateway/reply-gateway';
import type { IntegrationMessage } from '../message';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IdempotencyRecord, IdempotencyStore } from '../idempotency/idempotency-store';
import { InboundInterceptor, type InboundInterceptorDeps } from './inbound.interceptor';
import {
  HttpExceptionFailureCodec,
  INBOUND_STORED_FAILURE_KEY,
  InboundIdempotencyInFlightError,
  InboundReplayedFailureError,
  markInboundFailure,
  readInboundFailureMark,
} from './inbound.failure';
import {
  InboundIdempotencyGate,
  encodeInboundKey,
  toStorePort,
  type InboundIdempotencyPlan,
} from './inbound.idempotency';
import type { InboundTransportStrategy } from './inbound.transport';
import {
  INBOUND_SPEC_METADATA,
  InboundError,
  duplicateResponse,
  type InboundFailureClassifier,
  type InboundFailureCodec,
  type InboundIdempotencyOptions,
  type InboundKeyContext,
  type InboundKeyResolver,
  type InboundProviderResolver,
  type InboundProviderToken,
  type InboundReplyContext,
  type InboundReplyMapper,
  type InboundSpec,
} from './inbound.types';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<unknown>; resolve: (value: unknown) => void } {
  const hold: { resolve: (value: unknown) => void } = { resolve: () => undefined };
  const promise = new Promise<unknown>((resolve) => {
    hold.resolve = resolve;
  });
  return { promise, resolve: (value) => hold.resolve(value) };
}

interface Request {
  body?: unknown;
  headers?: Record<string, unknown>;
}

/** Store without the optional release(), like a custom store written for 0.5.0. */
class LegacyStore implements IdempotencyStore {
  readonly inner = new MemoryIdempotencyStore();
  begin = (scope: string, key: string, ttlMs: number): Promise<boolean> =>
    this.inner.begin(scope, key, ttlMs);
  complete = (scope: string, key: string, result: Record<string, unknown>): Promise<void> =>
    this.inner.complete(scope, key, result);
  fail = (scope: string, key: string, error: unknown): Promise<void> =>
    this.inner.fail(scope, key, error);
  get = (scope: string, key: string): Promise<IdempotencyRecord | undefined> =>
    this.inner.get(scope, key);
  purgeExpired = (): Promise<number> => this.inner.purgeExpired();
}

function fakeContext(
  transport: InboundSpec['transport'],
  handler: object,
  request: Request,
): ExecutionContext {
  const headers = request.headers ?? {};
  const byTransport: Record<string, object> = {
    rest: { switchToHttp: () => ({ getRequest: () => ({ body: request.body, headers }) }) },
    grpc: {
      switchToRpc: () => ({ getData: () => request.body, getContext: () => ({ ...headers }) }),
    },
    graphql: { getArgs: () => [undefined, request.body, { req: { headers } }, undefined] },
  };
  return { ...byTransport[transport], getHandler: () => handler } as unknown as ExecutionContext;
}

function fakeResolver(providers: Map<unknown, unknown>): InboundProviderResolver {
  return {
    resolve: <T>(token: InboundProviderToken<T>): T => {
      if (!providers.has(token)) throw new Error('Nest could not find the provider');
      return providers.get(token) as T;
    },
  };
}

const makeWorld = (
  extra: Partial<InboundInterceptorDeps> = {},
  options: { idempotency?: boolean } = {},
) => {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  const gateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 200 });
  const store = new MemoryIdempotencyStore();
  const seen: IntegrationMessage[] = [];
  const world = {
    registry,
    store,
    seen,
    /** Business behaviour of the 'work' channel; its return value is the flow reply. */
    behave: (msg: IntegrationMessage): unknown => ({ echoed: msg.payload }),
  };
  registry.create({ name: 'work', type: 'direct' }).subscribe(async (msg) => {
    seen.push(msg);
    const result = await world.behave(msg);
    await registry.send(msg.headers.replyChannel!, result);
  });
  registry.create({ name: 'bg', type: 'direct' }).subscribe(async (msg) => {
    seen.push(msg);
    await world.behave(msg);
  });
  registry.create({ name: 'silent', type: 'direct' }).subscribe(async () => undefined);
  const deps: InboundInterceptorDeps = {
    registry,
    trace,
    replyGateway: gateway,
    ...(options.idempotency === false ? {} : { idempotency: new IdempotencyService({ store }) }),
    ...extra,
  };
  const interceptor = new InboundInterceptor(deps);
  const handlers = new WeakMap<InboundSpec, object>();
  const run = async (
    spec: InboundSpec,
    request: Request = {},
    handlerResult?: unknown,
  ): Promise<unknown> => {
    let handler = handlers.get(spec);
    if (handler === undefined) {
      handler = function handle(): void {};
      Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
      handlers.set(spec, handler);
    }
    const next: CallHandler = { handle: () => of(handlerResult) };
    const context = fakeContext(spec.transport, handler, request);
    return lastValueFrom(await interceptor.intercept(context, next));
  };
  return { ...world, world, run, interceptor };
};

const reply = (extra: Partial<InboundSpec> = {}): InboundSpec => ({
  channel: 'work',
  transport: 'rest',
  requestReply: true,
  ...extra,
});
const accepted = (extra: Partial<InboundSpec> = {}): InboundSpec => ({
  channel: 'bg',
  transport: 'rest',
  ...extra,
});
const keyed = (key: string, body: unknown = { n: 1 }, more: Record<string, unknown> = {}) => ({
  body,
  headers: { 'idempotency-key': key, ...more },
});

describe('inbound 0.6.0: defaults reproduce 0.5.0', () => {
  it('ok envelope with its headers sub-object', async () => {
    const { run } = makeWorld();
    const response = await run(reply(), {
      body: { hi: 1 },
      headers: { 'x-trace-id': 't-1', 'x-correlation-id': 'c-1' },
    });
    const { id, headers } = response as { id: string; headers: Record<string, string> };
    expect(response).toEqual({
      status: 'ok',
      result: { echoed: { hi: 1 } },
      id,
      traceId: 't-1',
      correlationId: 'c-1',
      headers: {
        traceId: 't-1',
        correlationId: 'c-1',
        causationId: id,
        parentSpanId: headers.parentSpanId,
      },
    });
    expect(Object.keys(response as object)).toEqual([
      'status',
      'result',
      'id',
      'traceId',
      'correlationId',
      'headers',
    ]);
  });

  it('accepted envelope merges the handler result; canonical fields win', async () => {
    const { run } = makeWorld();
    const response = await run(
      accepted(),
      { body: {}, headers: { 'x-trace-id': 't-2' } },
      { echo: 42, status: 'fake' },
    );
    const { id } = response as { id: string };
    expect(response).toEqual({
      echo: 42,
      status: 'accepted',
      id,
      traceId: 't-2',
      correlationId: id,
    });
    expect(Object.keys(response as object)).toEqual([
      'echo',
      'status',
      'id',
      'traceId',
      'correlationId',
    ]);
  });

  it('duplicate envelope for a completed record; record shape {cachedResult}', async () => {
    const { run, store, seen } = makeWorld();
    const spec = reply();
    await run(spec, keyed('k-1'));
    expect(await store.get('inbound:work', 'k-1')).toEqual({
      status: 'completed',
      result: { cachedResult: { echoed: { n: 1 } } },
    });
    expect(await run(spec, keyed('k-1', { n: 1 }, { 'x-trace-id': 't-9' }))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-1',
      replayed: true,
      result: { echoed: { n: 1 } },
      traceId: 't-9',
    });
    expect(await run(spec, keyed('k-1'))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-1',
      replayed: true,
      result: { echoed: { n: 1 } },
      traceId: '',
    });
    expect(seen).toHaveLength(1);
  });

  it('accepted record shape {accepted, id}; its duplicate has result null', async () => {
    const { run, store } = makeWorld();
    const spec = accepted();
    const first = (await run(spec, keyed('k-2'))) as { id: string };
    expect(await store.get('inbound:bg', 'k-2')).toEqual({
      status: 'completed',
      result: { accepted: true, id: first.id },
    });
    expect(await run(spec, keyed('k-2'))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-2',
      replayed: true,
      result: null,
      traceId: '',
    });
  });

  it('in-flight duplicate answers result null', async () => {
    const { run, world } = makeWorld();
    const spec = reply();
    const gate = deferred();
    world.behave = () => gate.promise;
    const first = run(spec, keyed('k-3'));
    await delay(5);
    expect(await run(spec, keyed('k-3'))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-3',
      replayed: true,
      result: null,
      traceId: '',
    });
    gate.resolve({ done: true });
    expect(((await first) as { status: string }).status).toBe('ok');
  });

  it('failure: same error instance rethrown, key stays blocked, marks ignored', async () => {
    const { run, world, store, seen } = makeWorld();
    const spec = reply();
    const boom = markInboundFailure(new Error('boom'), 'release');
    world.behave = () => {
      throw boom;
    };
    await expect(run(spec, keyed('k-4'))).rejects.toBe(boom);
    expect(await store.get('inbound:work', 'k-4')).toEqual({ status: 'failed', error: boom });
    expect(await run(spec, keyed('k-4'))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-4',
      replayed: true,
      result: null,
      traceId: '',
    });
    expect(seen).toHaveLength(1);
  });

  it('the client key is still forwarded into the message headers', async () => {
    const { run, seen } = makeWorld();
    await run(reply(), keyed('k-5'));
    await run(reply(), keyed('k-6', {}, {}));
    await run(reply(), { body: {}, headers: { 'x-idempotency-key': 'k-7' } });
    await run(reply(), { body: {}, headers: {} });
    expect(seen.map((msg) => msg.headers.idempotencyKey)).toEqual(['k-5', 'k-6', 'k-7', undefined]);
  });

  it('no idempotency service and nothing configured: the claim is skipped silently', async () => {
    const { run, seen } = makeWorld({}, { idempotency: false });
    const spec = reply();
    await run(spec, keyed('k-8'));
    expect(((await run(spec, keyed('k-8'))) as { status: string }).status).toBe('ok');
    expect(seen).toHaveLength(2);
  });
});

describe('inbound reply mapping', () => {
  it("'raw' answers the flow result (rest) and the handler result (accepted)", async () => {
    const { run } = makeWorld();
    expect(await run(reply({ reply: 'raw' }), { body: { a: 1 } })).toEqual({ echoed: { a: 1 } });
    expect(await run(accepted({ reply: 'raw' }), { body: {} }, { queued: true })).toEqual({
      queued: true,
    });
    expect(await run(accepted({ reply: 'raw' }), { body: {} })).toBeUndefined();
  });

  it("'raw' on grpc answers the bare flow result and the bare handler result", async () => {
    const { run } = makeWorld();
    expect(await run(reply({ transport: 'grpc', reply: 'raw' }), { body: { a: 1 } })).toEqual({
      echoed: { a: 1 },
    });
    const spec = accepted({ transport: 'grpc', reply: 'raw' });
    expect(await run(spec, { body: {} }, { instanceId: 'i-1' })).toEqual({ instanceId: 'i-1' });
  });

  it("'raw' keeps the duplicate envelope unless onDuplicate is 'replay'", async () => {
    const { run } = makeWorld();
    const spec = reply({ reply: 'raw' });
    await run(spec, keyed('r-1'));
    expect(((await run(spec, keyed('r-1'))) as { status: string }).status).toBe('duplicate');
    const replaying = reply({ reply: 'raw', idempotency: { onDuplicate: 'replay' } });
    const first = await run(replaying, keyed('r-2'));
    expect(await run(replaying, keyed('r-2'))).toEqual(first);
  });

  it('custom function builds a gRPC proto shape from the result and the request payload', async () => {
    const { run, world } = makeWorld();
    world.behave = () => ({ state: 7 });
    const spec = reply({
      transport: 'grpc',
      reply: ({
        result,
        payload,
      }: InboundReplyContext<{ instanceId: string }, { state: number }>) => ({
        instanceId: payload.instanceId,
        state: String(result.state),
        resultJson: JSON.stringify(result),
      }),
    });
    expect(
      await run(spec, { body: { instanceId: 'i-1' }, headers: { 'x-trace-id': 't' } }),
    ).toEqual({ instanceId: 'i-1', state: '7', resultJson: '{"state":7}' });
  });

  it('custom function on graphql sees kind, envelope, message, context and receivedAt', async () => {
    const { run } = makeWorld();
    const before = Date.now();
    const seenCtx: InboundReplyContext[] = [];
    const spec = reply({
      transport: 'graphql',
      reply: (ctx) => {
        seenCtx.push(ctx);
        return { data: ctx.result };
      },
    });
    expect(await run(spec, { body: { q: 1 } })).toEqual({ data: { echoed: { q: 1 } } });
    const ctx = seenCtx[0]!;
    expect(ctx.kind).toBe('reply');
    expect(ctx.replayed).toBe(false);
    expect(ctx.envelope).toMatchObject({ status: 'ok', result: { echoed: { q: 1 } } });
    expect(ctx.message.headers.id).toBe((ctx.envelope as { id: string }).id);
    expect(ctx.spec).toBe(spec);
    expect(typeof ctx.context.getHandler).toBe('function');
    expect(ctx.receivedAt).toBeGreaterThanOrEqual(before);
    expect(ctx.receivedAt).toBeLessThanOrEqual(Date.now());
    expect('idempotencyKey' in ctx).toBe(false);
  });

  it('a custom mapper sees all three kinds', async () => {
    const { run } = makeWorld();
    const kinds = (ctx: InboundReplyContext): unknown => [ctx.kind, ctx.duplicateOf, ctx.result];
    const replying = reply({ reply: kinds });
    expect(await run(replying, keyed('m-1'))).toEqual(['reply', undefined, { echoed: { n: 1 } }]);
    expect(await run(replying, keyed('m-1'))).toEqual([
      'duplicate',
      'completed',
      { echoed: { n: 1 } },
    ]);
    const accepting = accepted({ reply: kinds });
    expect(await run(accepting, keyed('m-2'), { h: 1 })).toEqual(['accepted', undefined, { h: 1 }]);
    expect(await run(accepting, keyed('m-2'), { h: 1 })).toEqual(['duplicate', 'completed', null]);
  });

  it('instance mapper, async mapper and DI mapper through the resolver', async () => {
    class WrapMapper implements InboundReplyMapper {
      constructor(private readonly tag: string) {}
      mapReply(ctx: InboundReplyContext): unknown {
        return { tag: this.tag, data: ctx.result };
      }
    }
    const resolver = fakeResolver(new Map([[WrapMapper, new WrapMapper('di')]]));
    const { run } = makeWorld({ resolver });
    expect(await run(reply({ reply: new WrapMapper('inst') }), { body: 1 })).toEqual({
      tag: 'inst',
      data: { echoed: 1 },
    });
    expect(await run(reply({ reply: { useExisting: WrapMapper } }), { body: 2 })).toEqual({
      tag: 'di',
      data: { echoed: 2 },
    });
    const slow = reply({ reply: async (ctx) => Promise.resolve({ later: ctx.result }) });
    expect(await run(slow, { body: 3 })).toEqual({ later: { echoed: 3 } });
  });

  it('module default applies and an endpoint overrides it', async () => {
    const { run } = makeWorld({ defaults: { reply: 'raw' } });
    expect(await run(reply(), { body: 1 })).toEqual({ echoed: 1 });
    const enveloped = (await run(reply({ reply: 'envelope' }), { body: 1 })) as { status: string };
    expect(enveloped.status).toBe('ok');
  });

  it('a mapper throw does not touch the claim (no fail, no release)', async () => {
    const { run, store } = makeWorld();
    const fail = jest.spyOn(store, 'fail');
    const release = jest.spyOn(store, 'release');
    const spec = reply({
      reply: () => {
        throw new Error('mapper broke');
      },
      idempotency: { onFailure: 'release' },
    });
    await expect(run(spec, keyed('m-3'))).rejects.toThrow('mapper broke');
    expect(fail).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect((await store.get('inbound:work', 'm-3'))?.status).toBe('completed');
  });
});

describe('inbound strategy refs', () => {
  class Mapper implements InboundReplyMapper {
    mapReply(): unknown {
      return 'mapped';
    }
  }

  it('a ref without a resolver is a clear InboundError', async () => {
    const { run } = makeWorld();
    const pending = run(reply({ reply: { useExisting: Mapper } }));
    await expect(pending).rejects.toBeInstanceOf(InboundError);
    await expect(pending).rejects.toThrow("inbound strategy 'Mapper' needs a provider resolver");
  });

  it('a class passed where a function is expected is rejected', async () => {
    const { run } = makeWorld();
    const spec = reply({ reply: Mapper as unknown as InboundReplyMapper });
    await expect(run(spec)).rejects.toThrow(
      "inbound strategy 'Mapper' is a class; pass { useExisting: Mapper }",
    );
    const store = reply({
      idempotency: { store: MemoryIdempotencyStore as unknown as IdempotencyStore },
    });
    await expect(run(store, keyed('c-1'))).rejects.toThrow('is a class');
  });

  it('an unresolvable token is wrapped with its cause', async () => {
    const { run } = makeWorld({ resolver: fakeResolver(new Map()) });
    await expect(run(reply({ reply: { useExisting: 'MISSING' } }))).rejects.toThrow(
      "inbound strategy 'MISSING' could not be resolved: Nest could not find the provider",
    );
  });

  it('a resolved provider without the port method is rejected', async () => {
    const { run } = makeWorld({ resolver: fakeResolver(new Map([['X', {}]])) });
    await expect(run(reply({ reply: { useExisting: 'X' } }))).rejects.toThrow(
      "inbound strategy has no 'mapReply' method",
    );
  });

  it('strategies resolve once per endpoint and are cached with the plan', async () => {
    const resolve = jest.fn(() => new Mapper());
    const { run } = makeWorld({ resolver: { resolve } as unknown as InboundProviderResolver });
    const spec = reply({ reply: { useExisting: Mapper } });
    expect(await run(spec)).toBe('mapped');
    expect(await run(spec)).toBe('mapped');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('inbound idempotency: disabled', () => {
  it('idempotency:false makes no store call and the header just travels', async () => {
    const { run, store, seen } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = accepted({ idempotency: false });
    await run(spec, keyed('d-1'));
    const second = (await run(spec, keyed('d-1'))) as { status: string };
    expect(second.status).toBe('accepted');
    expect(begin).not.toHaveBeenCalled();
    expect(seen.map((msg) => msg.headers.idempotencyKey)).toEqual(['d-1', 'd-1']);
    expect(seen.map((msg) => msg.payload)).toEqual([{ n: 1 }, { n: 1 }]);
  });

  it('disabled on requestReply: the key is not forwarded unless asked for', async () => {
    const { run, store, seen } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = reply({ idempotency: false });
    await run(spec, keyed('d-1'));
    expect(((await run(spec, keyed('d-1'))) as { status: string }).status).toBe('ok');
    await run(reply({ idempotency: { enabled: false, forward: 'raw' } }), keyed('d-1'));
    // On a disabled endpoint there is no storage key: 'resolved' forwards the client key.
    await run(reply({ idempotency: { enabled: false, forward: 'resolved' } }), keyed('d-1'));
    expect(begin).not.toHaveBeenCalled();
    expect(seen.map((msg) => msg.headers.idempotencyKey)).toEqual([
      undefined,
      undefined,
      'd-1',
      'd-1',
    ]);
  });

  it('disabling an endpoint under a module key resolver does not bring raw forwarding back', async () => {
    const { run, seen } = makeWorld({
      defaults: { idempotency: { key: ({ clientKey }) => ['acme', clientKey ?? '-'] } },
    });
    await run(accepted({ idempotency: false }), keyed('d-5'));
    expect(seen[0]?.headers.idempotencyKey).toBeUndefined();
  });

  it("with forward:'none' the key is stripped from the message headers", async () => {
    const { run, seen } = makeWorld();
    await run(reply({ idempotency: { enabled: false, forward: 'none' } }), keyed('d-2'));
    expect(seen[0]?.headers.idempotencyKey).toBeUndefined();
    expect('idempotencyKey' in seen[0]!.headers).toBe(false);
  });

  it('module default false is inherited, and an endpoint object turns it back on', async () => {
    const { run, seen } = makeWorld({
      defaults: { idempotency: { enabled: false, forward: 'none' } },
    });
    const inherited = reply();
    await run(inherited, keyed('d-3'));
    expect(((await run(inherited, keyed('d-3'))) as { status: string }).status).toBe('ok');
    const enabled = reply({ idempotency: { onDuplicate: 'envelope' } });
    await run(enabled, keyed('d-4'));
    expect(((await run(enabled, keyed('d-4'))) as { status: string }).status).toBe('duplicate');
    // forward:'none' is inherited from the module default
    expect(seen.map((msg) => msg.headers.idempotencyKey)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('inbound idempotency: endpoint over module precedence', () => {
  it('an endpoint option present as undefined inherits the module default', async () => {
    const { run, store, seen } = makeWorld({
      defaults: {
        idempotency: {
          key: ({ payload, clientKey }: InboundKeyContext<{ tenant: string }>) => [
            payload.tenant,
            clientKey ?? '-',
          ],
          scope: 'mod',
        },
      },
    });
    // Legal for consumers compiling without exactOptionalPropertyTypes.
    const sparse = { key: undefined, scope: undefined, forward: undefined };
    const spec = reply({ idempotency: sparse as unknown as InboundIdempotencyOptions });
    await run(spec, keyed('p-1', { tenant: 'acme' }));
    expect((await store.get('mod', 'acme:p-1'))?.status).toBe('completed');
    expect(await store.get('inbound:work', 'p-1')).toBeUndefined();
    expect(seen[0]?.headers.idempotencyKey).toBeUndefined();
  });

  it('a defined endpoint option still wins', async () => {
    const { run, store } = makeWorld({ defaults: { idempotency: { scope: 'mod' } } });
    await run(reply({ idempotency: { scope: 'own' } }), keyed('p-2'));
    expect((await store.get('own', 'p-2'))?.status).toBe('completed');
  });
});

describe('inbound idempotency: client key', () => {
  it('custom header name, case-insensitive, and the default header is then ignored', async () => {
    const { run, seen } = makeWorld();
    const spec = reply({ idempotency: { clientKey: 'X-Request-Id' } });
    await run(spec, { body: 1, headers: { 'x-request-id': 'rq-1', 'idempotency-key': 'other' } });
    const second = await run(spec, { body: 1, headers: { 'X-REQUEST-ID': 'rq-1' } });
    expect(second).toMatchObject({ status: 'duplicate', idempotencyKey: 'rq-1' });
    const third = await run(spec, { body: 1, headers: { 'idempotency-key': 'other' } });
    expect((third as { status: string }).status).toBe('ok');
    // 'raw' forwarding carries the resolved client key, or nothing when absent
    expect(seen.map((msg) => msg.headers.idempotencyKey)).toEqual(['rq-1', undefined]);
  });

  it('list of names takes the first non-empty match; arrays are normalized', async () => {
    const { run } = makeWorld();
    const spec = reply({ idempotency: { clientKey: ['x-a', 'x-b'], onDuplicate: 'envelope' } });
    await run(spec, { body: 1, headers: { 'x-a': '', 'x-b': ['', 'b-1'] } });
    expect(await run(spec, { body: 1, headers: { 'x-b': 'b-1' } })).toMatchObject({
      status: 'duplicate',
      idempotencyKey: 'b-1',
    });
  });

  it('function form reads the key from anywhere in the request', async () => {
    const { run } = makeWorld();
    const spec = reply({
      idempotency: { clientKey: ({ payload }) => (payload as { requestId?: string }).requestId },
    });
    await run(spec, { body: { requestId: 'p-1' } });
    expect(await run(spec, { body: { requestId: 'p-1' } })).toMatchObject({
      status: 'duplicate',
      idempotencyKey: 'p-1',
    });
    expect(await run(spec, { body: {} })).toMatchObject({ status: 'ok' });
  });

  it('a function returning an empty string means no key: nothing is claimed', async () => {
    const { run, store } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = reply({ idempotency: { clientKey: () => '' } });
    expect(((await run(spec, keyed('e-1'))) as { status: string }).status).toBe('ok');
    expect(((await run(spec, keyed('e-1'))) as { status: string }).status).toBe('ok');
    expect(begin).not.toHaveBeenCalled();
  });

  it('graphql: default path drops headers (0.5.0); an explicit clientKey reads them', async () => {
    const { run } = makeWorld();
    const byDefault = reply({ transport: 'graphql' });
    await run(byDefault, keyed('g-1'));
    expect(await run(byDefault, keyed('g-1'))).toMatchObject({ status: 'ok' });
    const explicit = reply({ transport: 'graphql', idempotency: { clientKey: 'idempotency-key' } });
    await run(explicit, keyed('g-2'));
    expect(await run(explicit, keyed('g-2'))).toMatchObject({ status: 'duplicate' });
  });
});

describe('inbound idempotency: key resolver', () => {
  it('string, array and {scope, key} results land where expected in the store', async () => {
    const { run, store } = makeWorld();
    await run(reply({ idempotency: { key: () => 'plain:key' } }), keyed('x'));
    expect((await store.get('inbound:work', 'plain:key'))?.status).toBe('completed');
    await run(reply({ idempotency: { key: ({ clientKey }) => ['t1', 7, clientKey ?? '-'] } }), {
      ...keyed('x'),
    });
    expect((await store.get('inbound:work', 't1:7:x'))?.status).toBe('completed');
    await run(
      reply({ idempotency: { scope: 'opt', key: () => ({ scope: 'custom', key: ['a'] }) } }),
      keyed('x'),
    );
    expect((await store.get('custom', 'a'))?.status).toBe('completed');
    await run(reply({ idempotency: { scope: 'opt', key: () => ['b'] } }), keyed('x'));
    expect((await store.get('opt', 'b'))?.status).toBe('completed');
  });

  it('a throwing resolver propagates and claims nothing (validation before the claim)', async () => {
    const { run, store, seen } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = reply({
      idempotency: {
        key: async () => Promise.reject(new BadRequestException('IDEMPOTENCY_KEY_TOO_LONG')),
      },
    });
    await expect(run(spec, keyed('x'))).rejects.toBeInstanceOf(BadRequestException);
    expect(begin).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('undefined skips the claim; the resolver also runs without a client key', async () => {
    const { run, store, seen } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const calls: (string | undefined)[] = [];
    const spec = reply({
      idempotency: {
        key: ({ clientKey }) => {
          calls.push(clientKey);
          return clientKey === undefined ? undefined : ['t', clientKey];
        },
      },
    });
    await run(spec, { body: 1 });
    await run(spec, { body: 1 });
    expect(calls).toEqual([undefined, undefined]);
    expect(begin).not.toHaveBeenCalled();
    expect(seen).toHaveLength(2);
  });

  it('a resolver without a client key can still claim; the envelope key is empty', async () => {
    const { run } = makeWorld();
    const spec = reply({ idempotency: { key: ({ payload }) => ['order', String(payload)] } });
    await run(spec, { body: 'o-1' });
    expect(await run(spec, { body: 'o-1' })).toEqual({
      status: 'duplicate',
      idempotencyKey: '',
      replayed: true,
      result: { echoed: 'o-1' },
      traceId: '',
    });
  });

  it('an empty resolved key is rejected instead of colliding', async () => {
    const { run, store } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const rejects = async (key: () => unknown, message: string): Promise<void> => {
      const spec = reply({ idempotency: { key: key as () => string } });
      const failure = await run(spec, keyed('x')).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InboundError);
      expect((failure as Error).message).toContain("key resolver of inbound 'work'");
      expect((failure as Error).message).toContain(message);
    };
    await rejects(() => [], 'non-empty');
    await rejects(() => '', 'non-empty');
    await rejects(() => ['', ''], 'non-empty strings or finite numbers');
    await rejects(() => ({ key: '' }), 'non-empty');
    await rejects(() => 42, 'a string, an array of parts or { key }');
    expect(begin).not.toHaveBeenCalled();
  });

  it('a missing part is rejected: header-less requests of a tenant never share a key', async () => {
    const { run, seen, store } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = reply({
      idempotency: {
        key: ({ payload, clientKey }: InboundKeyContext<{ t?: string }>) =>
          [payload.t, clientKey] as string[],
      },
    });
    await expect(run(spec, { body: { t: 't1', n: 1 } })).rejects.toThrow(
      "key resolver of inbound 'work': inbound key parts must be non-empty strings or finite numbers",
    );
    await expect(run(spec, { body: { t: 't1', n: 2 } })).rejects.toBeInstanceOf(InboundError);
    await expect(run(spec, keyed('k', { n: 3 }))).rejects.toBeInstanceOf(InboundError);
    expect(begin).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
    expect(() => encodeInboundKey(['t1', null] as unknown as string[])).toThrow(InboundError);
    expect(() => encodeInboundKey(['t1', Number.NaN])).toThrow(InboundError);
    expect(encodeInboundKey(['t1', 7])).toBe('t1:7');
  });

  it('a resolver returning null skips the claim like undefined', async () => {
    const { run, store } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const spec = reply({ idempotency: { key: (() => null) as unknown as () => undefined } });
    expect(((await run(spec, keyed('x'))) as { status: string }).status).toBe('ok');
    expect(begin).not.toHaveBeenCalled();
  });

  it('DI resolver and instance resolver', async () => {
    class TenantResolver implements InboundKeyResolver<{ tenant: string }> {
      resolveKey(ctx: InboundKeyContext<{ tenant: string }>): string[] {
        return [ctx.payload.tenant, ctx.clientKey ?? '-'];
      }
    }
    const resolver = fakeResolver(new Map([[TenantResolver, new TenantResolver()]]));
    const { run, store } = makeWorld({ resolver });
    await run(reply({ idempotency: { key: { useExisting: TenantResolver } } }), {
      ...keyed('k', { tenant: 'acme' }),
    });
    expect((await store.get('inbound:work', 'acme:k'))?.status).toBe('completed');
    await run(reply({ idempotency: { key: new TenantResolver() } }), keyed('k', { tenant: 'b' }));
    expect((await store.get('inbound:work', 'b:k'))?.status).toBe('completed');
  });
});

describe('inbound idempotency: tenant isolation', () => {
  const tenantSpec = (): InboundSpec =>
    reply({
      reply: 'raw',
      idempotency: {
        onDuplicate: 'replay',
        key: ({ rawHeaders, clientKey }) =>
          clientKey === undefined ? undefined : [String(rawHeaders['x-tenant']), clientKey],
      },
    });

  it('0.5.0 default: two tenants with the same key collide (the leak being fixed)', async () => {
    const { run, world } = makeWorld();
    world.behave = (msg) => ({ secretOf: (msg.payload as { tenant: string }).tenant });
    const spec = reply();
    await run(spec, keyed('same', { tenant: 'a' }, { 'x-tenant': 'a' }));
    const leaked = await run(spec, keyed('same', { tenant: 'b' }, { 'x-tenant': 'b' }));
    expect(leaked).toMatchObject({ status: 'duplicate', result: { secretOf: 'a' } });
  });

  it('tenant-bound resolver: same header value, two executions, no cross-tenant result', async () => {
    const { run, world, seen } = makeWorld();
    world.behave = (msg) => ({ secretOf: (msg.payload as { tenant: string }).tenant });
    const spec = tenantSpec();
    const a = await run(spec, keyed('same', { tenant: 'a' }, { 'x-tenant': 'a' }));
    const b = await run(spec, keyed('same', { tenant: 'b' }, { 'x-tenant': 'b' }));
    expect(a).toEqual({ secretOf: 'a' });
    expect(b).toEqual({ secretOf: 'b' });
    expect(seen).toHaveLength(2);
    // each tenant replays its own answer only
    expect(await run(spec, keyed('same', { tenant: 'a' }, { 'x-tenant': 'a' }))).toEqual(a);
    expect(await run(spec, keyed('same', { tenant: 'b' }, { 'x-tenant': 'b' }))).toEqual(b);
    expect(seen).toHaveLength(2);
    // with a resolver the raw key is not forwarded, so tenants cannot meet at the flow scope
    expect(seen.every((msg) => !('idempotencyKey' in msg.headers))).toBe(true);
  });

  it('delimiter forgery: parts are escaped, so boundaries cannot be moved', () => {
    expect(encodeInboundKey(['a:b', 'c'])).not.toBe(encodeInboundKey(['a', 'b:c']));
    expect(encodeInboundKey(['a%3Ab', 'c'])).not.toBe(encodeInboundKey(['a:b', 'c']));
    expect(encodeInboundKey(['a:b', 'c'])).toBe('a%3Ab:c');
    expect(encodeInboundKey(['t-1', 42, '9f8e7d6c-0000-4000-8000-000000000001'])).toBe(
      ['t-1', 42, '9f8e7d6c-0000-4000-8000-000000000001'].join(':'),
    );
    expect(encodeInboundKey('used:verbatim')).toBe('used:verbatim');
  });
});

describe("inbound idempotency: onDuplicate 'replay'", () => {
  it('a reply is replayed through the same mapper; the client cannot tell', async () => {
    const { run, seen } = makeWorld();
    const contexts: InboundReplyContext[] = [];
    const spec = reply({
      reply: (ctx) => {
        contexts.push(ctx);
        return { data: ctx.result, success: true };
      },
      idempotency: { onDuplicate: 'replay' },
    });
    const first = await run(spec, keyed('p-1'));
    const second = await run(spec, keyed('p-1'));
    expect(second).toEqual(first);
    expect(second).toEqual({ data: { echoed: { n: 1 } }, success: true });
    expect(seen).toHaveLength(1);
    expect(contexts.map((ctx) => [ctx.kind, ctx.replayed, ctx.idempotencyKey])).toEqual([
      ['reply', false, 'p-1'],
      ['reply', true, 'p-1'],
    ]);
  });

  it('an accepted reply is replayed with the stored id (default envelope is identical)', async () => {
    const { run, seen } = makeWorld();
    const spec = accepted({ idempotency: { onDuplicate: 'replay' } });
    const first = await run(spec, keyed('p-2'), { echo: 1 });
    expect(await run(spec, keyed('p-2'), { echo: 1 })).toEqual(first);
    expect(seen).toHaveLength(1);
    const contexts: InboundReplyContext[] = [];
    const custom = accepted({
      idempotency: { onDuplicate: 'replay' },
      reply: (ctx) => {
        contexts.push(ctx);
        return (ctx.envelope as { id: string }).id;
      },
    });
    const id = await run(custom, keyed('p-3'));
    expect(await run(custom, keyed('p-3'))).toBe(id);
    expect(contexts[1]).toMatchObject({ kind: 'accepted', replayed: true, acceptedId: id });
    expect(contexts[0]?.acceptedId).toBeUndefined();
  });

  it('a void reply is replayed as void even when the store serializes its records', async () => {
    class JsonStore extends MemoryIdempotencyStore {
      override complete(
        scope: string,
        key: string,
        result: Record<string, unknown>,
      ): Promise<void> {
        return super.complete(scope, key, JSON.parse(JSON.stringify(result)) as typeof result);
      }
    }
    const store = new JsonStore();
    const world = makeWorld({ idempotency: new IdempotencyService({ store }) });
    world.world.behave = () => undefined;
    const spec = reply({ reply: 'raw', idempotency: { onDuplicate: 'replay' } });
    expect(await world.run(spec, keyed('v-1'))).toBeUndefined();
    expect((await store.get('inbound:work', 'v-1'))?.result).toEqual({});
    expect(await world.run(spec, keyed('v-1'))).toBeUndefined();
    expect(world.seen).toHaveLength(1);
  });

  it('a kept failure has nothing to replay: it stays a duplicate', async () => {
    const { run, world } = makeWorld();
    world.behave = () => {
      throw new Error('boom');
    };
    const kinds: unknown[] = [];
    const spec = reply({
      idempotency: { onDuplicate: 'replay' },
      reply: (ctx) => kinds.push([ctx.kind, ctx.duplicateOf, ctx.result]),
    });
    await expect(run(spec, keyed('p-4'))).rejects.toThrow('boom');
    await run(spec, keyed('p-4'));
    expect(kinds).toEqual([['duplicate', 'failed', null]]);
  });
});

describe('inbound idempotency: onInFlight', () => {
  const inFlight = async (
    spec: InboundSpec,
    world: ReturnType<typeof makeWorld>,
  ): Promise<{ second: Promise<unknown>; finish: () => Promise<unknown> }> => {
    const gate = deferred();
    world.world.behave = () => gate.promise;
    const first = world.run(spec, keyed('f-1', { tenant: 'acme' }));
    await delay(5);
    const second = world.run(spec, keyed('f-1', { tenant: 'acme' }));
    return {
      second,
      finish: () => {
        gate.resolve({ done: true });
        return first;
      },
    };
  };

  it("'reject' throws the typed error; its message leaks no storage key", async () => {
    const world = makeWorld();
    const spec = reply({
      idempotency: { onInFlight: 'reject', key: ({ clientKey }) => ['tenant-acme', clientKey!] },
    });
    const { second, finish } = await inFlight(spec, world);
    const error = (await second.catch(
      (caught: unknown) => caught,
    )) as InboundIdempotencyInFlightError;
    expect(error).toBeInstanceOf(InboundIdempotencyInFlightError);
    expect(error).toBeInstanceOf(InboundError);
    expect(error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
    expect(error.message).toBe('IDEMPOTENCY_KEY_IN_PROGRESS: work');
    expect(error.message).not.toContain('tenant-acme');
    expect(error).toMatchObject({ channel: 'work', scope: 'inbound:work', clientKey: 'f-1' });
    expect(await finish()).toMatchObject({ status: 'ok' });
  });

  it('a factory decides the error (e.g. HTTP 409)', async () => {
    const world = makeWorld();
    const spec = reply({
      idempotency: { onInFlight: () => new ConflictException('IDEMPOTENCY_KEY_IN_PROGRESS') },
    });
    const { second, finish } = await inFlight(spec, world);
    const error = (await second.catch((caught: unknown) => caught)) as ConflictException;
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getStatus()).toBe(409);
    await finish();
  });

  it('a mapper can shape the default in-flight duplicate via duplicateOf', async () => {
    const world = makeWorld();
    const spec = reply({
      reply: (ctx) => (ctx.duplicateOf === 'in-flight' ? { retryLater: true } : ctx.result),
    });
    const { second, finish } = await inFlight(spec, world);
    expect(await second).toEqual({ retryLater: true });
    await finish();
  });

  it('a record gone between begin() and get() is treated as in flight', async () => {
    const vanished: IdempotencyStore = {
      begin: async () => false,
      complete: async () => undefined,
      fail: async () => undefined,
      get: async () => undefined,
      purgeExpired: async () => 0,
    };
    const { run } = makeWorld();
    expect(await run(reply({ idempotency: { store: vanished } }), keyed('f-2'))).toMatchObject({
      status: 'duplicate',
      result: null,
    });
    const rejecting = reply({ idempotency: { store: vanished, onInFlight: 'reject' } });
    await expect(run(rejecting, keyed('f-2'))).rejects.toBeInstanceOf(
      InboundIdempotencyInFlightError,
    );
  });
});

describe('inbound idempotency: onFailure', () => {
  const failing = (error: unknown) => {
    const world = makeWorld();
    let failures = 1;
    world.world.behave = (msg) => {
      if (failures > 0) {
        failures -= 1;
        throw error;
      }
      return { echoed: msg.payload };
    };
    return world;
  };

  it("'release' frees the key: the retry executes for real", async () => {
    const boom = new Error('validation');
    const { run, store, seen } = failing(boom);
    const spec = reply({ idempotency: { onFailure: 'release' } });
    await expect(run(spec, keyed('x-1'))).rejects.toBe(boom);
    expect(await store.get('inbound:work', 'x-1')).toBeUndefined();
    expect(await run(spec, keyed('x-1'))).toMatchObject({ status: 'ok' });
    expect(seen).toHaveLength(2);
  });

  it("'store' replays an HttpException with equal status and body", async () => {
    const body = { statusCode: 422, message: 'half committed', code: 'PARTIAL' };
    const original = new HttpException(body, 422);
    const { run, store, seen } = failing(original);
    const spec = reply({ idempotency: { onFailure: 'store' } });
    await expect(run(spec, keyed('x-2'))).rejects.toBe(original);
    const record = await store.get('inbound:work', 'x-2');
    expect(record).toEqual({
      status: 'completed',
      result: {
        [INBOUND_STORED_FAILURE_KEY]: { v: 1, data: { kind: 'http', status: 422, body } },
      },
    });
    expect(JSON.parse(JSON.stringify(record))).toEqual(record);
    const replayed = (await run(spec, keyed('x-2')).catch((e: unknown) => e)) as HttpException;
    expect(replayed).toBeInstanceOf(HttpException);
    expect(replayed).not.toBe(original);
    expect(replayed.getStatus()).toBe(422);
    expect(replayed.getResponse()).toEqual(body);
    expect(seen).toHaveLength(1);
  });

  it('a Nest subclass with a string body round-trips status and body too', async () => {
    const original = new ConflictException('ALREADY_DONE');
    const { run } = failing(original);
    const spec = reply({ idempotency: { onFailure: 'store', onDuplicate: 'replay' } });
    await expect(run(spec, keyed('x-3'))).rejects.toBe(original);
    const replayed = (await run(spec, keyed('x-3')).catch((e: unknown) => e)) as HttpException;
    expect(replayed.getStatus()).toBe(409);
    expect(replayed.getResponse()).toEqual(original.getResponse());
  });

  it('a non-HTTP error is replayed as InboundReplayedFailureError (no stack stored)', async () => {
    const { run, store } = failing(new TypeError('db exploded'));
    const spec = reply({ idempotency: { onFailure: 'store' } });
    await expect(run(spec, keyed('x-4'))).rejects.toThrow('db exploded');
    const stored = (await store.get('inbound:work', 'x-4'))?.result?.[INBOUND_STORED_FAILURE_KEY];
    expect(stored).toEqual({
      v: 1,
      data: { kind: 'error', name: 'TypeError', message: 'db exploded' },
    });
    const replayed = (await run(spec, keyed('x-4')).catch(
      (e: unknown) => e,
    )) as InboundReplayedFailureError;
    expect(replayed).toBeInstanceOf(InboundReplayedFailureError);
    expect(replayed.message).toBe('db exploded');
    expect(replayed.originalName).toBe('TypeError');
  });

  it('custom codec (instance and DI) controls what is stored and rethrown', async () => {
    const codec: InboundFailureCodec = {
      serialize: () => ({ status: 500, body: 'Internal server error' }),
      deserialize: (stored) => {
        const { status, body } = stored as { status: number; body: string };
        return new HttpException(body, status);
      },
    };
    const { run } = failing(new Error('secret detail'));
    const spec = reply({ idempotency: { onFailure: 'store', failureCodec: codec } });
    await expect(run(spec, keyed('x-5'))).rejects.toThrow('secret detail');
    const replayed = (await run(spec, keyed('x-5')).catch((e: unknown) => e)) as HttpException;
    expect(replayed.getStatus()).toBe(500);
    expect(replayed.getResponse()).toBe('Internal server error');

    const world = makeWorld({ resolver: fakeResolver(new Map([['CODEC', codec]])) });
    world.world.behave = () => {
      throw new Error('again');
    };
    const viaDi = reply({
      idempotency: { onFailure: 'store', failureCodec: { useExisting: 'CODEC' } },
    });
    await expect(world.run(viaDi, keyed('x-6'))).rejects.toThrow('again');
    await expect(world.run(viaDi, keyed('x-6'))).rejects.toBeInstanceOf(HttpException);
  });

  it('classifier decides per error; the mark on the error beats the classifier', async () => {
    const world = makeWorld();
    const classify = jest.fn((error: unknown, _ctx: InboundKeyContext) =>
      error instanceof BadRequestException ? ('release' as const) : ('store' as const),
    );
    const spec = reply({ idempotency: { onFailure: classify } });
    const errors: unknown[] = [
      new BadRequestException('invalid'),
      new Error('partial'),
      markInboundFailure(new Error('marked'), 'release'),
    ];
    world.world.behave = (msg) => {
      throw errors[(msg.payload as { i: number }).i];
    };
    await expect(world.run(spec, keyed('c-1', { i: 0 }))).rejects.toBe(errors[0]);
    expect(await world.store.get('inbound:work', 'c-1')).toBeUndefined();
    await expect(world.run(spec, keyed('c-2', { i: 1 }))).rejects.toBe(errors[1]);
    expect((await world.store.get('inbound:work', 'c-2'))?.status).toBe('completed');
    await expect(world.run(spec, keyed('c-3', { i: 2 }))).rejects.toBe(errors[2]);
    expect(await world.store.get('inbound:work', 'c-3')).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[0]?.[1]).toMatchObject({ clientKey: 'c-1', payload: { i: 0 } });
  });

  it("'marker' obeys marked errors and keeps unmarked ones", async () => {
    const world = makeWorld();
    const spec = reply({ idempotency: { onFailure: 'marker' } });
    const marked = markInboundFailure(new HttpException('partial', 500), 'store');
    expect(readInboundFailureMark(marked)).toBe('store');
    expect(Object.keys(marked)).not.toContain('estela.inbound.failure');
    expect(JSON.stringify(marked)).not.toContain('store');
    world.world.behave = () => {
      throw marked;
    };
    await expect(world.run(spec, keyed('m-1'))).rejects.toBe(marked);
    await expect(world.run(spec, keyed('m-1'))).rejects.toBeInstanceOf(HttpException);
    world.world.behave = () => {
      throw new Error('unmarked');
    };
    await expect(world.run(spec, keyed('m-2'))).rejects.toThrow('unmarked');
    expect((await world.store.get('inbound:work', 'm-2'))?.status).toBe('failed');
    expect(readInboundFailureMark(new Error('plain'))).toBeUndefined();
    expect(readInboundFailureMark('text')).toBeUndefined();
  });

  it('DI classifier and instance classifier', async () => {
    class Releaser implements InboundFailureClassifier {
      classify(): 'release' {
        return 'release';
      }
    }
    const world = makeWorld({ resolver: fakeResolver(new Map([[Releaser, new Releaser()]])) });
    world.world.behave = () => {
      throw new Error('nope');
    };
    const viaDi = reply({ idempotency: { onFailure: { useExisting: Releaser } } });
    await expect(world.run(viaDi, keyed('d-1'))).rejects.toThrow('nope');
    expect(await world.store.get('inbound:work', 'd-1')).toBeUndefined();
    const instance = reply({ idempotency: { onFailure: new Releaser() } });
    await expect(world.run(instance, keyed('d-2'))).rejects.toThrow('nope');
    expect(await world.store.get('inbound:work', 'd-2')).toBeUndefined();
  });

  it("a reply timeout stays kept under static 'release'; a classifier may still decide", async () => {
    const { run, store } = makeWorld();
    const spec: InboundSpec = {
      channel: 'silent',
      transport: 'rest',
      requestReply: true,
      timeoutMs: 20,
      idempotency: { onFailure: 'release' },
    };
    await expect(run(spec, keyed('t-1'))).rejects.toBeInstanceOf(ReplyTimeoutError);
    expect((await store.get('inbound:silent', 't-1'))?.status).toBe('failed');
    const classified: InboundSpec = { ...spec, idempotency: { onFailure: () => 'release' } };
    await expect(run(classified, keyed('t-2'))).rejects.toBeInstanceOf(ReplyTimeoutError);
    expect(await store.get('inbound:silent', 't-2')).toBeUndefined();
  });

  it('a flow that outlives the reply timeout is a timeout: static policies keep the key', async () => {
    for (const onFailure of ['release', 'store'] as const) {
      const { run, world, seen, store } = makeWorld();
      world.behave = async () => {
        await delay(80);
        return { late: true };
      };
      const spec = reply({ timeoutMs: 20, idempotency: { onFailure } });
      await expect(run(spec, keyed('slow'))).rejects.toBeInstanceOf(ReplyTimeoutError);
      expect((await store.get('inbound:work', 'slow'))?.status).toBe('failed');
      // The work ran to completion once; the retry must not run it again nor replay a failure.
      expect(await run(spec, keyed('slow'))).toMatchObject({ status: 'duplicate' });
      expect(seen).toHaveLength(1);
    }
  });

  it('a missing subscriber is never released or stored by a static policy', async () => {
    const { run, registry, store } = makeWorld();
    registry.create({ name: 'nobody', type: 'direct' });
    const spec: InboundSpec = {
      channel: 'nobody',
      transport: 'rest',
      idempotency: { onFailure: 'release' },
    };
    await expect(run(spec, keyed('n-1'))).rejects.toThrow('no tiene subscriber');
    expect((await store.get('inbound:nobody', 'n-1'))?.status).toBe('failed');
  });

  it('a failing complete() is never classified nor released: the work is committed', async () => {
    const { run, store } = makeWorld();
    const stuck = new Error('store down');
    jest.spyOn(store, 'complete').mockRejectedValueOnce(stuck);
    const release = jest.spyOn(store, 'release');
    const classify = jest.fn(() => 'release' as const);
    await expect(run(reply({ idempotency: { onFailure: classify } }), keyed('s-1'))).rejects.toBe(
      stuck,
    );
    expect(classify).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect((await store.get('inbound:work', 's-1'))?.status).toBe('failed');
  });

  it('a throwing classifier or codec degrades to keep and never masks the business error', async () => {
    const boom = new Error('business');
    const world = makeWorld();
    world.world.behave = () => {
      throw boom;
    };
    const badClassifier = reply({
      idempotency: {
        onFailure: () => {
          throw new Error('classifier broke');
        },
      },
    });
    await expect(world.run(badClassifier, keyed('b-1'))).rejects.toBe(boom);
    expect((await world.store.get('inbound:work', 'b-1'))?.status).toBe('failed');
    const badCodec = reply({
      idempotency: {
        onFailure: 'store',
        failureCodec: {
          serialize: () => {
            throw new Error('codec broke');
          },
          deserialize: () => undefined,
        },
      },
    });
    await expect(world.run(badCodec, keyed('b-2'))).rejects.toBe(boom);
    expect((await world.store.get('inbound:work', 'b-2'))?.status).toBe('failed');
    const unknownAction = reply({
      idempotency: { onFailure: () => 'explode' as unknown as 'keep' },
    });
    await expect(world.run(unknownAction, keyed('b-3'))).rejects.toBe(boom);
    expect((await world.store.get('inbound:work', 'b-3'))?.status).toBe('failed');
  });

  it('fire-and-forget endpoints apply the same policy to a failed send', async () => {
    const boom = new Error('queue full');
    const { run, store, seen } = failing(boom);
    const spec = accepted({ idempotency: { onFailure: 'release' } });
    await expect(run(spec, keyed('a-1'))).rejects.toBe(boom);
    expect(await store.get('inbound:bg', 'a-1')).toBeUndefined();
    expect(await run(spec, keyed('a-1'))).toMatchObject({ status: 'accepted' });
    expect(seen).toHaveLength(2);
  });

  it('default codec: circular HTTP bodies cannot be stored, so the key is kept', () => {
    const codec = new HttpExceptionFailureCodec();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => codec.serialize(new HttpException(circular, 400))).toThrow();
    expect(codec.serialize('just text')).toEqual({
      kind: 'error',
      name: 'Error',
      message: 'just text',
    });
    expect(codec.deserialize(null)).toBeInstanceOf(InboundReplayedFailureError);
  });
});

describe('inbound idempotency: stores', () => {
  it("static 'release' on a store without release() fails fast", async () => {
    const { run } = makeWorld();
    const spec = reply({ idempotency: { store: new LegacyStore(), onFailure: 'release' } });
    await expect(run(spec, keyed('l-1'))).rejects.toThrow(
      "onFailure 'release' needs a store that implements release()",
    );
  });

  it('a dynamic release on such a store degrades to keep and warns once per scope', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const legacy = new LegacyStore();
    const world = makeWorld();
    world.world.behave = () => {
      throw new Error('nope');
    };
    const spec = reply({ idempotency: { store: legacy, onFailure: () => 'release' } });
    await expect(world.run(spec, keyed('l-2'))).rejects.toThrow('nope');
    await expect(world.run(spec, keyed('l-3'))).rejects.toThrow('nope');
    expect((await legacy.get('inbound:work', 'l-2'))?.status).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('no release()');
    warn.mockRestore();
  });

  it('module store without release(): static release fails fast, dynamic degrades to keep', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const legacy = new LegacyStore();
    const world = makeWorld({ idempotency: new IdempotencyService({ store: legacy }) });
    await expect(
      world.run(reply({ idempotency: { onFailure: 'release' } }), keyed('m-1')),
    ).rejects.toThrow("onFailure 'release' needs a store that implements release()");
    world.world.behave = () => {
      throw new Error('nope');
    };
    const spec = reply({ idempotency: { onFailure: () => 'release' } });
    await expect(world.run(spec, keyed('m-2'))).rejects.toThrow('nope');
    expect((await legacy.get('inbound:work', 'm-2'))?.status).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('per-endpoint store (instance and DI) is used instead of the module service', async () => {
    const own = new MemoryIdempotencyStore();
    const viaDi = new MemoryIdempotencyStore();
    const { run, store } = makeWorld({ resolver: fakeResolver(new Map([['STORE', viaDi]])) });
    await run(reply({ idempotency: { store: own } }), keyed('o-1'));
    await run(reply({ idempotency: { store: { useExisting: 'STORE' } } }), keyed('o-2'));
    expect((await own.get('inbound:work', 'o-1'))?.status).toBe('completed');
    expect((await viaDi.get('inbound:work', 'o-2'))?.status).toBe('completed');
    expect(await store.get('inbound:work', 'o-1')).toBeUndefined();
    expect(await store.get('inbound:work', 'o-2')).toBeUndefined();
  });

  it('ttl: endpoint value, else the module service ttl, else one hour', async () => {
    const own = new MemoryIdempotencyStore();
    const begin = jest.spyOn(own, 'begin');
    const moduleStore = new MemoryIdempotencyStore();
    const { run } = makeWorld({
      idempotency: new IdempotencyService({ store: moduleStore, ttlMs: 5_000 }),
    });
    await run(reply({ idempotency: { store: own, ttlMs: 86_400_000 } }), keyed('t-1'));
    await run(reply({ idempotency: { store: own } }), keyed('t-2'));
    const bare = makeWorld({}, { idempotency: false });
    await bare.run(reply({ idempotency: { store: own } }), keyed('t-3'));
    expect(begin.mock.calls.map((call) => call[2])).toEqual([86_400_000, 5_000, 3_600_000]);
  });

  it('explicit options without any store are a configuration error', async () => {
    const { run } = makeWorld({}, { idempotency: false });
    await expect(
      run(reply({ idempotency: { onDuplicate: 'replay' } }), keyed('n-1')),
    ).rejects.toThrow("inbound 'work': idempotency is configured but has no store");
  });
});

describe('inbound idempotency: forward', () => {
  const forwardedBy = async (idempotency: InboundSpec['idempotency']): Promise<unknown> => {
    const { run, seen } = makeWorld();
    await run(reply(idempotency === undefined ? {} : { idempotency }), keyed('fw'));
    return seen[0]?.headers.idempotencyKey;
  };
  const key = ({ clientKey }: InboundKeyContext): string[] => ['acme', clientKey ?? '-'];

  it('explicit raw, resolved and none', async () => {
    expect(await forwardedBy({ key, forward: 'raw' })).toBe('fw');
    expect(await forwardedBy({ key, forward: 'resolved' })).toBe('acme:fw');
    expect(await forwardedBy({ forward: 'none' })).toBeUndefined();
  });

  it("default is 'raw', and shifts to 'none' with a key resolver or an active failure policy", async () => {
    expect(await forwardedBy(undefined)).toBe('fw');
    expect(await forwardedBy({ onDuplicate: 'replay', onFailure: 'keep' })).toBe('fw');
    expect(await forwardedBy({ key })).toBeUndefined();
    expect(await forwardedBy({ onFailure: 'release' })).toBeUndefined();
    expect(await forwardedBy({ onFailure: 'marker' })).toBeUndefined();
  });

  it('an active failure policy with raw or resolved forwarding is rejected', async () => {
    const { run } = makeWorld();
    await expect(
      run(reply({ idempotency: { onFailure: 'store', forward: 'raw' } }), keyed('fw')),
    ).rejects.toThrow("forward 'raw' cannot be combined with an onFailure policy");
    await expect(
      run(reply({ idempotency: { onFailure: 'marker', key, forward: 'resolved' } }), keyed('fw')),
    ).rejects.toBeInstanceOf(InboundError);
  });

  it('unknown option values are rejected', async () => {
    const { run } = makeWorld();
    const bad = (spec: Partial<InboundSpec>): Promise<unknown> => run(reply(spec), keyed('bad'));
    await expect(bad({ reply: 'xml' as 'raw' })).rejects.toThrow('not a known mapper');
    await expect(bad({ idempotency: { onFailure: 'retry' as 'keep' } })).rejects.toThrow(
      'not a known policy',
    );
    await expect(bad({ idempotency: { onInFlight: 'wait' as 'reject' } })).rejects.toThrow(
      'not a known policy',
    );
  });
});

describe('inbound interceptor: routing guards', () => {
  it('a handler without @Inbound metadata passes through untouched', async () => {
    const { interceptor, seen, store } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const plain = function plain(): void {};
    const context = fakeContext('rest', plain, keyed('p-1'));
    const next: CallHandler = { handle: () => of({ untouched: true }) };
    const result = await lastValueFrom(await interceptor.intercept(context, next));
    expect(result).toEqual({ untouched: true });
    expect(seen).toHaveLength(0);
    expect(begin).not.toHaveBeenCalled();
  });

  it('a transport without a strategy is rejected before the handler runs', async () => {
    const { interceptor, seen } = makeWorld();
    const spec = accepted({ transport: 'rabbit' });
    const handler = function handle(): void {};
    Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
    const handle = jest.fn(() => of('never'));
    const outcome = interceptor.intercept(fakeContext('rest', handler, {}), { handle });
    await expect(outcome).rejects.toBeInstanceOf(InboundError);
    await expect(outcome).rejects.toThrow("sin strategy para transporte 'rabbit'");
    expect(handle).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('custom strategies replace the built-in ones', async () => {
    const onlyGrpc: InboundTransportStrategy = {
      transport: 'grpc',
      extract: () => ({ payload: { from: 'custom' }, rawHeaders: {} }),
    };
    const { run, seen } = makeWorld({ strategies: [onlyGrpc] });
    await expect(run(accepted())).rejects.toThrow("sin strategy para transporte 'rest'");
    await run(accepted({ transport: 'grpc' }));
    expect(seen.map((msg) => msg.payload)).toEqual([{ from: 'custom' }]);
  });

  it('a strategy for a transport without a header mapper dispatches nothing', async () => {
    const soap = {
      transport: 'soap',
      extract: () => ({ payload: 'p', rawHeaders: {} }),
    } as unknown as InboundTransportStrategy;
    const { run, seen } = makeWorld({ strategies: [soap] });
    const spec = accepted({ transport: 'soap' as InboundSpec['transport'] });
    await expect(run(spec)).rejects.toThrow("sin header-mapper para 'soap'");
    expect(seen).toHaveLength(0);
  });
});

describe('inbound idempotency: store and resolver edge cases', () => {
  const brokenStore = (overrides: Partial<IdempotencyStore>): IdempotencyStore => {
    const inner = new MemoryIdempotencyStore();
    return {
      begin: (scope, key, ttlMs) => inner.begin(scope, key, ttlMs),
      complete: (scope, key, result) => inner.complete(scope, key, result),
      fail: (scope, key, error) => inner.fail(scope, key, error),
      get: (scope, key) => inner.get(scope, key),
      purgeExpired: () => inner.purgeExpired(),
      ...overrides,
    };
  };

  it('a non-InboundError raised while reading the resolved key propagates unwrapped', async () => {
    const { run, store, seen } = makeWorld();
    const begin = jest.spyOn(store, 'begin');
    const hostile = new TypeError('key getter exploded');
    const resolved = {
      get key(): string {
        throw hostile;
      },
    };
    const spec = reply({ idempotency: { key: () => resolved } });
    await expect(run(spec, keyed('h-1'))).rejects.toBe(hostile);
    expect(begin).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('a completed record without a result is a duplicate with a null result', async () => {
    const bare = brokenStore({
      begin: () => Promise.resolve(false),
      get: () => Promise.resolve({ status: 'completed' }),
    });
    const { run, seen } = makeWorld();
    expect(await run(reply({ idempotency: { store: bare } }), keyed('b-1'))).toEqual({
      status: 'duplicate',
      idempotencyKey: 'b-1',
      replayed: true,
      result: null,
      traceId: '',
    });
    const replayed = reply({ idempotency: { store: bare, onDuplicate: 'replay' }, reply: 'raw' });
    expect(await run(replayed, keyed('b-1'))).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('when complete() and fail() both reject, the complete() error is the one thrown', async () => {
    const stuck = new Error('complete down');
    const fail = jest.fn(() => Promise.reject(new Error('fail down')));
    const store = brokenStore({ complete: () => Promise.reject(stuck), fail });
    const { run, seen } = makeWorld();
    await expect(run(reply({ idempotency: { store } }), keyed('d-1'))).rejects.toBe(stuck);
    expect(fail).toHaveBeenCalledWith('inbound:work', 'd-1', stuck);
    expect(seen).toHaveLength(1);
  });

  it('a rejecting fail() never masks the business error', async () => {
    const fail = jest.fn(() => Promise.reject(new Error('fail down')));
    const store = brokenStore({ fail });
    const world = makeWorld();
    const business = new Error('nope');
    world.world.behave = () => {
      throw business;
    };
    await expect(world.run(reply({ idempotency: { store } }), keyed('d-2'))).rejects.toBe(business);
    expect(fail).toHaveBeenCalledWith('inbound:work', 'd-2', business);
    expect((await store.get('inbound:work', 'd-2'))?.status).toBe('in-flight');
  });

  it('a gate built without a warn sink still degrades a dynamic release to keep', async () => {
    const legacy = new LegacyStore();
    const plan: InboundIdempotencyPlan = {
      store: toStorePort(legacy),
      ttlMs: 60_000,
      scope: 'inbound:gate',
      onDuplicate: 'envelope',
      onInFlight: 'duplicate',
      failure: { mode: 'classifier', classify: () => 'release' },
      codec: new HttpExceptionFailureCodec(),
    };
    const ctx = { spec: accepted(), clientKey: 'g-1' } as InboundKeyContext;
    const gate = new InboundIdempotencyGate();
    const claim = await gate.claim(plan, ctx);
    expect(claim.status).toBe('acquired');
    await expect(gate.failed(claim, new Error('nope'), ctx)).resolves.toBeUndefined();
    expect((await legacy.get('inbound:gate', 'g-1'))?.status).toBe('failed');
  });
});

describe('inbound: remaining defaults and messages', () => {
  it('default codec stores a thrown non-Error as a generic failure, a string as its message', () => {
    const codec = new HttpExceptionFailureCodec();
    expect(codec.serialize(42)).toEqual({ kind: 'error', name: 'Error', message: 'Unknown error' });
    expect(codec.serialize('plain text')).toEqual({
      kind: 'error',
      name: 'Error',
      message: 'plain text',
    });
    const replayed = codec.deserialize(codec.serialize(42));
    expect(replayed).toBeInstanceOf(InboundReplayedFailureError);
    expect((replayed as InboundReplayedFailureError).message).toBe('Unknown error');
  });

  it('an anonymous class passed as a strategy is reported as such', async () => {
    const { run } = makeWorld();
    const anonymous = (() =>
      class {
        mapReply(): string {
          return 'never';
        }
      })();
    expect(anonymous.name).toBe('');
    const spec = reply({ reply: anonymous as unknown as InboundReplyMapper });
    await expect(run(spec)).rejects.toThrow(
      "inbound strategy 'anonymous' is a class; pass { useExisting: anonymous }",
    );
  });

  it('a resolver that throws a non-Error is wrapped with a generic cause', async () => {
    const resolver: InboundProviderResolver = {
      resolve: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'container closed';
      },
    };
    const { run } = makeWorld({ resolver });
    await expect(run(reply({ reply: { useExisting: 'MAPPER' } }))).rejects.toThrow(
      "inbound strategy 'MAPPER' could not be resolved: unknown provider",
    );
  });

  it('duplicateResponse without options is a replayed duplicate with no result or trace', () => {
    expect(duplicateResponse('k-0')).toEqual({
      status: 'duplicate',
      idempotencyKey: 'k-0',
      replayed: true,
      result: null,
      traceId: '',
    });
  });
});
