import 'reflect-metadata';

import { ChannelRegistry } from '../channel-registry';
import { TraceContext } from '../trace/trace-context';
import { IntegrationFlow, type FlowDefinition } from '../flow/integration-flow';
import { createTestMessage, bindFlow, waitFor, collect, MemoryIdempotencyStore } from './index';
import { IdempotencyService } from '../idempotency/idempotency.service';

describe('testing subpath (spec §14)', () => {
  it('createTestMessage: mismas invariantes que createMessage', () => {
    const msg = createTestMessage({ qty: 1 }, { traceId: 't-t' });
    expect(msg.headers.traceId).toBe('t-t');
    expect(msg.headers.correlationId).toBe(msg.headers.id);
    expect(msg.headers.history).toEqual([]);
  });

  it('bindFlow: end-to-end mini con error.channel auto y waitFor', async () => {
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    registry.create({ name: 'out', type: 'direct' });
    const def: FlowDefinition = {
      name: 'mini',
      build: () => IntegrationFlow.from('mini.in').transform((p) => `x:${String(p)}`).to('out'),
    };
    bindFlow(def, registry);
    expect(registry.tryGet('error.channel')?.kind).toBe('pubsub');
    const done = waitFor(registry, 'out', 500);
    await registry.send('mini.in', 'payload');
    const reply = await done;
    expect(reply.payload).toBe('x:payload');
  });

  it('waitFor: timeout rechaza; collect acumula', async () => {
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    registry.create({ name: 'empty', type: 'direct' });
    await expect(waitFor(registry, 'empty', 40)).rejects.toThrow("waitFor('empty')");
    registry.create({ name: 'busy', type: 'pubsub' });
    const collector = collect<string>(registry, 'busy');
    await registry.send('busy', 'a', { routingKey: 'r' });
    await registry.send('busy', 'b', { routingKey: 'r' });
    expect(collector.received).toEqual(['a', 'b']);
    collector.unsubscribe();
  });

  it('bindFlow con idempotencia inyectada (MemoryIdempotencyStore reexport)', async () => {
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    const calls: unknown[] = [];
    const def: FlowDefinition = {
      name: 'idem',
      build: () => IntegrationFlow.from('idem.in').transform((p) => { calls.push(p); return p; }).to('void-out'),
    };
    registry.create({ name: 'void-out', type: 'direct' });
    registry.get('void-out').subscribe(async () => undefined);
    bindFlow(def, registry, { idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }) });
    await registry.send('idem.in', 'm1', { idempotencyKey: 'k' });
    await registry.send('idem.in', 'm2', { idempotencyKey: 'k' });
    expect(calls).toEqual(['m1']);
  });
});
