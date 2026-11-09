import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, Subject } from 'rxjs';
import { ChannelRegistry } from '../channel-registry';
import { ReplyGateway } from '../gateway/reply-gateway';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage } from '../message';
import { ResilienceDefinitionError } from '../resilience/resilience.errors';
import type { ResilienceModuleOptions } from '../resilience/resilience.types';
import { DEGRADED_HEADER } from '../resilience/retry-budget';
import { ResilienceRuntime } from '../resilience/runtime';
import { manualResilienceClock } from '../testing/manual-resilience-clock';
import { TraceContext } from '../trace/trace-context';
import { InboundOverloadedError } from './inbound.failure';
import { InboundInterceptor } from './inbound.interceptor';
import { inboundShedPlan } from './inbound.resilience';
import { INBOUND_SPEC_METADATA, type InboundSpec } from './inbound.types';

function httpContext(spec: InboundSpec, headers: Record<string, string> = {}) {
  const handler = (): void => undefined;
  Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
  const response: Record<string, string> = {};
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ headers, body: { order: 1 } }),
      getResponse: () => ({ setHeader: (name: string, value: string) => (response[name] = value) }),
    }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
  return { context, response };
}

const next = (value: unknown = undefined): CallHandler => ({ handle: () => of(value) });

function world(options: ResilienceModuleOptions = {}, enabled = true) {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  registry.create({ name: 'orders.in', type: 'direct' });
  const store = new MemoryIdempotencyStore();
  const idempotency = new IdempotencyService({ store });
  const runtime = new ResilienceRuntime(
    { clock: manualResilienceClock(), ...options },
    { enabled },
  );
  const replyGateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 500 });
  const interceptor = new InboundInterceptor({
    registry,
    trace,
    idempotency,
    replyGateway,
    resilience: runtime,
  });
  return { registry, store, interceptor, runtime };
}

describe('inbound load shedding and budget', () => {
  it('RU-37 inbound accepts only bulkhead and rateLimit and refuses Rabbit', () => {
    const runtime = new ResilienceRuntime();
    const base = { channel: 'orders.in', transport: 'rest' as const };
    expect(() =>
      inboundShedPlan({ ...base, resilience: { retry: {} } as never }, undefined, runtime),
    ).toThrow(ResilienceDefinitionError);
    expect(() =>
      inboundShedPlan(
        { ...base, transport: 'rabbit', resilience: { bulkhead: { maxConcurrent: 1 } } },
        undefined,
        runtime,
      ),
    ).toThrow('orders.in: resilience.transport is not allowed on @InboundRabbit');
    expect(
      inboundShedPlan(
        { ...base, transport: 'rabbit' },
        { resilience: { bulkhead: { maxConcurrent: 1 } } },
        runtime,
      ),
    ).toBeUndefined();
    expect(inboundShedPlan(base, undefined, runtime)).toBeUndefined();
    expect(
      inboundShedPlan(base, { resilience: { bulkhead: { maxConcurrent: 2 } } }, runtime)?.bulkhead
        ?.maxConcurrent,
    ).toBe(2);
  });

  it('sheds over the rate limit with 429 and Retry-After before the idempotency claim', async () => {
    const w = world();
    w.registry.get('orders.in').subscribe(() => undefined);
    const spec: InboundSpec = {
      channel: 'orders.in',
      transport: 'rest',
      idempotency: {},
      resilience: { rateLimit: { limitPerSec: 1, burst: 1 } },
    };
    const first = httpContext(spec, { 'idempotency-key': 'a' });
    await lastValueFrom(await w.interceptor.intercept(first.context, next()));
    const second = httpContext(spec, { 'idempotency-key': 'b' });
    const error = await w.interceptor.intercept(second.context, next()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboundOverloadedError);
    expect((error as InboundOverloadedError).getStatus()).toBe(429);
    expect((error as InboundOverloadedError).grpcCode).toBe(8);
    expect(second.response['Retry-After']).toBe('1');
    expect(await w.store.get('inbound:orders.in', 'b')).toBeUndefined();
    expect((await w.store.get('inbound:orders.in', 'a'))?.status).toBe('completed');
  });

  it('holds the bulkhead slot until the reply observable completes', async () => {
    const w = world();
    w.registry.get('orders.in').subscribe(() => undefined);
    const spec: InboundSpec = {
      channel: 'orders.in',
      transport: 'rest',
      resilience: { bulkhead: { maxConcurrent: 1 } },
    };
    const pending = new Subject<unknown>();
    const firstObservable = await w.interceptor.intercept(httpContext(spec).context, {
      handle: () => pending,
    });
    const result = lastValueFrom(firstObservable);
    const shed = await w.interceptor
      .intercept(httpContext(spec).context, next())
      .catch((e: unknown) => e);
    expect((shed as InboundOverloadedError).reason).toBe('bulkhead-full');
    pending.next({});
    pending.complete();
    await result;
    await new Promise((resolve) => setImmediate(resolve));
    await expect(w.interceptor.intercept(httpContext(spec).context, next())).resolves.toBeDefined();
  });

  it('RE-02 (unit) reads x-retry-budget into the message only when resilience is enabled', async () => {
    for (const enabled of [true, false]) {
      const w = world({}, enabled);
      const seen: IntegrationMessage[] = [];
      w.registry.get('orders.in').subscribe((msg) => {
        seen.push(msg);
      });
      const { context } = httpContext(
        { channel: 'orders.in', transport: 'rest' },
        { 'x-retry-budget': '0' },
      );
      await lastValueFrom(await w.interceptor.intercept(context, next()));
      expect(seen[0]!.headers.retryBudget).toBe(enabled ? 0 : undefined);
    }
  });

  it('RU-27 a degraded reply releases the inbound claim so a replay key re-executes', async () => {
    const w = world();
    let runs = 0;
    w.registry.get('orders.in').subscribe(async (msg) => {
      runs += 1;
      await w.registry.send(msg.headers.replyChannel!, 'fallback', { [DEGRADED_HEADER]: true });
    });
    const spec: InboundSpec = {
      channel: 'orders.in',
      transport: 'rest',
      requestReply: true,
      idempotency: { onDuplicate: 'replay' },
    };
    for (let i = 0; i < 2; i += 1) {
      const { context } = httpContext(spec, { 'idempotency-key': 'same' });
      await lastValueFrom(await w.interceptor.intercept(context, next()));
    }
    expect(runs).toBe(2);
    expect(await w.store.get('inbound:orders.in', 'same')).toBeUndefined();
  });
});
