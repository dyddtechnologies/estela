import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, Subject } from 'rxjs';
import { ChannelRegistry } from '../channel-registry';
import { ReplyGateway } from '../gateway/reply-gateway';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import type { IntegrationMessage } from '../message';
import { CareConfigError } from '../resilience/resilience.errors';
import type { CareModuleOptions } from '../resilience/resilience.types';
import { PLAN_B_HEADER } from '../resilience/retry-budget';
import { CareEngine } from '../resilience/runtime';
import { manualCareClock } from '../testing/manual-resilience-clock';
import { TraceContext } from '../trace/trace-context';
import { InboundBusyError } from './inbound.failure';
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

function world(options: CareModuleOptions = {}, enabled = true) {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  registry.create({ name: 'orders.in', type: 'direct' });
  const store = new MemoryIdempotencyStore();
  const idempotency = new IdempotencyService({ store });
  const runtime = new CareEngine({ clock: manualCareClock(), ...options }, { enabled });
  const replyGateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 500 });
  const interceptor = new InboundInterceptor({
    registry,
    trace,
    idempotency,
    replyGateway,
    care: runtime,
  });
  return { registry, store, interceptor, runtime };
}

describe('inbound load shedding and tries left', () => {
  it('RU-37 inbound accepts only lanes and pace and refuses Rabbit', () => {
    const runtime = new CareEngine();
    const base = { channel: 'orders.in', transport: 'rest' as const };
    expect(() =>
      inboundShedPlan({ ...base, care: { tries: {} } as never }, undefined, runtime),
    ).toThrow(CareConfigError);
    expect(() =>
      inboundShedPlan(
        { ...base, transport: 'rabbit', care: { lanes: { count: 1 } } },
        undefined,
        runtime,
      ),
    ).toThrow('orders.in: care.transport is not allowed on @InboundRabbit');
    expect(
      inboundShedPlan({ ...base, transport: 'rabbit' }, { care: { lanes: { count: 1 } } }, runtime),
    ).toBeUndefined();
    expect(inboundShedPlan(base, undefined, runtime)).toBeUndefined();
    expect(inboundShedPlan(base, { care: { lanes: { count: 2 } } }, runtime)?.lanes?.count).toBe(2);
  });

  it('sheds over the pace with 429 and Retry-After before the idempotency claim', async () => {
    const w = world();
    w.registry.get('orders.in').subscribe(() => undefined);
    const spec: InboundSpec = {
      channel: 'orders.in',
      transport: 'rest',
      idempotency: {},
      care: { pace: { perSecond: 1, burst: 1 } },
    };
    const first = httpContext(spec, { 'idempotency-key': 'a' });
    await lastValueFrom(await w.interceptor.intercept(first.context, next()));
    const second = httpContext(spec, { 'idempotency-key': 'b' });
    const error = await w.interceptor.intercept(second.context, next()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InboundBusyError);
    expect((error as InboundBusyError).getStatus()).toBe(429);
    expect((error as InboundBusyError).grpcCode).toBe(8);
    expect(second.response['Retry-After']).toBe('1');
    expect(await w.store.get('inbound:orders.in', 'b')).toBeUndefined();
    expect((await w.store.get('inbound:orders.in', 'a'))?.status).toBe('completed');
  });

  it('holds the lanes slot until the reply observable completes', async () => {
    const w = world();
    w.registry.get('orders.in').subscribe(() => undefined);
    const spec: InboundSpec = {
      channel: 'orders.in',
      transport: 'rest',
      care: { lanes: { count: 1 } },
    };
    const pending = new Subject<unknown>();
    const firstObservable = await w.interceptor.intercept(httpContext(spec).context, {
      handle: () => pending,
    });
    const result = lastValueFrom(firstObservable);
    const shed = await w.interceptor
      .intercept(httpContext(spec).context, next())
      .catch((e: unknown) => e);
    expect((shed as InboundBusyError).reason).toBe('lanes-full');
    pending.next({});
    pending.complete();
    await result;
    await new Promise((resolve) => setImmediate(resolve));
    await expect(w.interceptor.intercept(httpContext(spec).context, next())).resolves.toBeDefined();
  });

  it('RE-02 (unit) reads x-tries-left into the message only when care is enabled', async () => {
    for (const enabled of [true, false]) {
      const w = world({}, enabled);
      const seen: IntegrationMessage[] = [];
      w.registry.get('orders.in').subscribe((msg) => {
        seen.push(msg);
      });
      const { context } = httpContext(
        { channel: 'orders.in', transport: 'rest' },
        { 'x-tries-left': '0' },
      );
      await lastValueFrom(await w.interceptor.intercept(context, next()));
      expect(seen[0]!.headers.triesLeft).toBe(enabled ? 0 : undefined);
    }
  });

  it('RU-27 a plan-B-marked reply releases the inbound claim so a replay key re-executes', async () => {
    const w = world();
    let runs = 0;
    w.registry.get('orders.in').subscribe(async (msg) => {
      runs += 1;
      await w.registry.send(msg.headers.replyChannel!, 'plan-b', { [PLAN_B_HEADER]: true });
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
