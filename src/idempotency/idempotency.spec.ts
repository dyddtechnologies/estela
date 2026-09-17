import { FlowExecutor } from '../flow/flow-executor';
import { IntegrationFlow } from '../flow/integration-flow';
import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';
import type { ChannelDeps } from '../channels/channel-deps';
import { createMessage } from '../message';
import { IdempotencyService } from './idempotency.service';
import { MemoryIdempotencyStore } from './memory-idempotency.store';
import { NoopIdempotencyStore } from './noop-idempotency.store';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('MemoryIdempotencyStore (spec §10)', () => {
  it('begin/complete/get: segundo begin con entrada viva → false', async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.begin('flow:x', 'k1', 60_000)).toBe(true);
    expect(await store.begin('flow:x', 'k1', 60_000)).toBe(false);
    await store.complete('flow:x', 'k1', { completed: true });
    expect(await store.begin('flow:x', 'k1', 60_000)).toBe(false); // vivo = duplicado
    const record = await store.get('flow:x', 'k1');
    expect(record?.status).toBe('completed');
    expect(record?.result).toEqual({ completed: true });
  });

  it('TTL: expira y permite re-adquirir; purgeExpired cuenta', async () => {
    const store = new MemoryIdempotencyStore();
    await store.begin('flow:x', 'k2', 10);
    await delay(25);
    expect(await store.get('flow:x', 'k2')).toBeUndefined(); // lazy expiry
    expect(await store.begin('flow:x', 'k2', 60_000)).toBe(true);
    await store.begin('flow:x', 'k3', 5);
    await delay(20);
    expect(await store.purgeExpired()).toBe(1);
  });

  it('scopes aislados: misma key en scope distinto no colisiona (key = scope::key)', async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.begin('flow:a', 'k', 60_000)).toBe(true);
    expect(await store.begin('flow:b', 'k', 60_000)).toBe(true);
    expect(await store.begin('flow:a', 'k', 60_000)).toBe(false);
  });

  it('NoopIdempotencyStore: siempre adquiere (Null Object — plan §7.3)', async () => {
    const store = new NoopIdempotencyStore();
    expect(await store.begin('s', 'k', 1)).toBe(true);
    expect(await store.begin('s', 'k', 1)).toBe(true);
    expect(await store.get('s', 'k')).toBeUndefined();
    await store.complete('s', 'k', {});
    await store.fail('s', 'k', new Error('x'));
    expect(await store.purgeExpired()).toBe(0);
  });

  it('IdempotencyService: enabled:false NO deduplica', async () => {
    const service = new IdempotencyService({ enabled: false });
    expect(await service.begin('flow:x', 'k', 60_000)).toBe(true);
    expect(await service.begin('flow:x', 'k', 60_000)).toBe(true);
  });
});

describe('test 8 del spec: idempotencia evita re-ejecutar el transform', () => {
  const makeFlow = () => {
    const deps: ChannelDeps = { trace: new TraceContext() };
    const registry = new ChannelRegistry(deps);
    registry.create({ name: 'error.channel', type: 'pubsub' });
    registry.create({ name: 'in', type: 'direct' });
    registry.create({ name: 'out', type: 'direct' });
    registry.get('out').subscribe(async () => undefined);
    const transformCalls: unknown[] = [];
    const flow = IntegrationFlow.from('in')
      .transform((payload) => {
        transformCalls.push(payload);
        return payload;
      })
      .to('out');
    const idempotency = new IdempotencyService({ store: new MemoryIdempotencyStore() });
    const executor = new FlowExecutor('place-order', flow.build(), {
      registry,
      trace: registry.trace,
      errorChannel: 'error.channel',
      idempotency,
    });
    executor.attachTo(registry);
    return { registry, transformCalls, executor };
  };

  it('mismo idempotencyKey → duplicate silencioso; el transform corre UNA sola vez', async () => {
    const { transformCalls, executor } = makeFlow();
    const r1 = await executor.execute(createMessage('m1', { idempotencyKey: 'key-1' }));
    expect(r1.status).toBe('completed');
    const r2 = await executor.execute(createMessage('m2', { idempotencyKey: 'key-1' }));
    expect(r2.status).toBe('duplicate');
    expect(transformCalls).toEqual(['m1']);
    const r3 = await executor.execute(createMessage('m3', { idempotencyKey: 'key-2' }));
    expect(r3.status).toBe('completed');
    expect(transformCalls).toEqual(['m1', 'm3']);
  });

  it('sin idempotencyKey → no-op (siempre ejecuta)', async () => {
    const { transformCalls, executor } = makeFlow();
    await executor.execute(createMessage('a'));
    await executor.execute(createMessage('b'));
    expect(transformCalls).toEqual(['a', 'b']);
  });

  it('filter out también hace succeed {filtered:true} (spec §6.4)', async () => {
    const deps: ChannelDeps = { trace: new TraceContext() };
    const registry = new ChannelRegistry(deps);
    registry.create({ name: 'error.channel', type: 'pubsub' });
    registry.create({ name: 'in', type: 'direct' });
    const store = new MemoryIdempotencyStore();
    const executor = new FlowExecutor('filtered-flow', IntegrationFlow.from('in').filter(() => false).build(), {
      registry,
      trace: registry.trace,
      errorChannel: 'error.channel',
      idempotency: new IdempotencyService({ store }),
    });
    const result = await executor.execute(createMessage('p', { idempotencyKey: 'kf' }));
    expect(result.status).toBe('filtered');
    const record = await store.get('flow:filtered-flow', 'kf');
    expect(record?.status).toBe('completed');
    expect(record?.result).toEqual({ filtered: true });
  });
});
