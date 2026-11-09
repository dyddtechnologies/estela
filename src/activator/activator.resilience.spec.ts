import 'reflect-metadata';

import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator } from '../decorators';
import { ReplyGateway } from '../gateway/reply-gateway';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { createMessage } from '../message';
import { currentResilienceSignal } from '../resilience/executor';
import { ResilienceDefinitionError } from '../resilience/resilience.errors';
import type { ResilienceEvent, ResilienceModuleOptions } from '../resilience/resilience.types';
import { DEGRADED_HEADER } from '../resilience/retry-budget';
import { ResilienceRuntime } from '../resilience/runtime';
import { TraceContext } from '../trace/trace-context';
import { discoverActivators, subscribeActivators, type ActivatorDeps } from './activator-wrapper';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

class RetryingActivator {
  calls = 0;

  @ServiceActivator('retry.plain', { resilience: { retry: { maxAttempts: 2, backoff: 0 } } })
  plain(): string {
    this.calls += 1;
    throw flaky();
  }

  @ServiceActivator('retry.idempotent', {
    resilience: { retry: { maxAttempts: 2, backoff: 0, idempotent: true } },
  })
  idempotent(): string {
    this.calls += 1;
    if (this.calls === 1) throw flaky();
    return 'ok';
  }
}

class SignalActivator {
  signal: AbortSignal | undefined;

  @ServiceActivator('signal.in', { resilience: { timeout: { perAttemptMs: 1000 } } })
  run(): string {
    this.signal = currentResilienceSignal();
    return 'done';
  }
}

class FallbackActivator {
  calls = 0;

  @ServiceActivator('fb.in', {
    resilience: { fallback: { value: () => 'fallback', on: ['transient'] } },
  })
  run(): string {
    this.calls += 1;
    throw flaky();
  }
}

function world(options: ResilienceModuleOptions = {}) {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  for (const name of ['error.channel']) registry.create({ name, type: 'pubsub' });
  for (const name of ['retry.plain', 'retry.idempotent', 'signal.in', 'fb.in'])
    registry.create({ name, type: 'direct' });
  const store = new MemoryIdempotencyStore();
  const idempotency = new IdempotencyService({ store });
  const events: ResilienceEvent[] = [];
  const runtime = new ResilienceRuntime({ ...options, events: { onEvent: (e) => events.push(e) } });
  const gateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 500 });
  const deps: ActivatorDeps = {
    registry,
    trace,
    errorChannel: 'error.channel',
    idempotency,
    resilience: runtime,
  };
  return { registry, store, idempotency, events, deps, gateway, runtime };
}

describe('@ServiceActivator resilience', () => {
  it('RU-36a activator retries only when idempotent or keyed, inside one idempotency claim', async () => {
    const w = world();
    const instance = new RetryingActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await expect(w.registry.send('retry.plain', {})).rejects.toThrow('flaky');
    expect(instance.calls).toBe(1);
    expect(w.events.map((e) => e.type)).toEqual(['retry.suppressed']);

    instance.calls = 0;
    const begin = jest.spyOn(w.idempotency, 'begin');
    await w.registry.send('retry.plain', {}, { idempotencyKey: 'k-1' }).catch(() => undefined);
    expect(instance.calls).toBe(2);
    expect(begin).toHaveBeenCalledTimes(1);

    instance.calls = 0;
    await expect(w.gateway.sendAndReceive('retry.idempotent', {})).resolves.toBe('ok');
    expect(instance.calls).toBe(2);
  });

  it('RU-36b exposes the attempt signal through currentResilienceSignal', async () => {
    const w = world();
    const instance = new SignalActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await w.registry.send('signal.in', {});
    expect(instance.signal).toBeInstanceOf(AbortSignal);
  });

  it('RU-27 activator claims are released, not completed, when a fallback ran during the message', async () => {
    const w = world();
    const instance = new FallbackActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    const replies: unknown[] = [];
    const replyChannel = w.registry.create({ name: 'replies', type: 'direct' });
    replyChannel.subscribe((msg) => {
      replies.push({ payload: msg.payload, degraded: msg.headers[DEGRADED_HEADER] });
    });
    const msg = createMessage({}, { idempotencyKey: 'dup', replyChannel: 'replies' });
    await w.registry.sendMessage('fb.in', msg);
    await w.registry.sendMessage(
      'fb.in',
      createMessage({}, { idempotencyKey: 'dup', replyChannel: 'replies' }),
    );
    expect(instance.calls).toBe(2);
    expect(replies).toEqual([
      { payload: 'fallback', degraded: true },
      { payload: 'fallback', degraded: true },
    ]);
    const record = await w.store.get('activator:FallbackActivator.run', 'dup');
    expect(record?.status).not.toBe('completed');
  });

  it('refuses an invalid or unknown policy when the activator is subscribed', () => {
    class Bad {
      @ServiceActivator('fb.in', { resilience: 'missing' })
      run(): void {}
    }
    const w = world();
    expect(() => subscribeActivators(discoverActivators([new Bad()]), w.deps)).toThrow(
      ResilienceDefinitionError,
    );
  });

  it('uses named policies of the runtime', async () => {
    class Named {
      calls = 0;

      @ServiceActivator('retry.plain', { resilience: { use: 'twice', retry: { backoff: 0 } } })
      run(): void {
        this.calls += 1;
        throw flaky();
      }
    }
    const w = world({ policies: { twice: { retry: { maxAttempts: 2, idempotent: true } } } });
    const instance = new Named();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await w.registry.send('retry.plain', {}).catch(() => undefined);
    expect(instance.calls).toBe(2);
  });
});
