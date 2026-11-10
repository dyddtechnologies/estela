import 'reflect-metadata';

import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator } from '../decorators';
import { ReplyGateway } from '../gateway/reply-gateway';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { MemoryIdempotencyStore } from '../idempotency/memory-idempotency.store';
import { createMessage } from '../message';
import { currentTrySignal } from '../resilience/executor';
import { CareConfigError } from '../resilience/resilience.errors';
import type { CareEvent, CareModuleOptions } from '../resilience/resilience.types';
import { CareScope, PLAN_B_HEADER } from '../resilience/retry-budget';
import { CareEngine } from '../resilience/runtime';
import { TraceContext } from '../trace/trace-context';
import { discoverActivators, subscribeActivators, type ActivatorDeps } from './activator-wrapper';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

class RetryingActivator {
  calls = 0;

  @ServiceActivator('retry.plain', { care: { tries: { max: 2, spacing: 0 } } })
  plain(): string {
    this.calls += 1;
    throw flaky();
  }

  @ServiceActivator('retry.idempotent', {
    care: { tries: { max: 2, spacing: 0, idempotent: true } },
  })
  idempotent(): string {
    this.calls += 1;
    if (this.calls === 1) throw flaky();
    return 'ok';
  }
}

class SignalActivator {
  signal: AbortSignal | undefined;

  @ServiceActivator('signal.in', { care: { patience: { eachTryMs: 1000 } } })
  run(): string {
    this.signal = currentTrySignal();
    return 'done';
  }
}

class FallbackActivator {
  calls = 0;

  @ServiceActivator('fb.in', {
    care: { planB: { value: () => 'plan-b', on: ['transient'] } },
  })
  run(): string {
    this.calls += 1;
    throw flaky();
  }
}

class ScopeProbe {
  scoped: boolean[] = [];

  @ServiceActivator('probe.in')
  run(): void {
    this.scoped.push(CareScope.current() !== undefined);
  }
}

function world(options: CareModuleOptions = {}) {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  for (const name of ['error.channel']) registry.create({ name, type: 'pubsub' });
  for (const name of ['retry.plain', 'retry.idempotent', 'signal.in', 'fb.in'])
    registry.create({ name, type: 'direct' });
  const store = new MemoryIdempotencyStore();
  const idempotency = new IdempotencyService({ store });
  const events: CareEvent[] = [];
  const runtime = new CareEngine({ ...options, events: { onEvent: (e) => events.push(e) } });
  const gateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 500 });
  const deps: ActivatorDeps = {
    registry,
    trace,
    errorChannel: 'error.channel',
    idempotency,
    care: runtime,
  };
  return { registry, store, idempotency, events, deps, gateway, runtime };
}

describe('@ServiceActivator care', () => {
  it('RU-70 an activator opens a message scope only when the module has care configuration', async () => {
    for (const enabled of [false, true]) {
      const registry = new ChannelRegistry({ trace: new TraceContext() });
      registry.create({ name: 'error.channel', type: 'pubsub' });
      registry.create({ name: 'probe.in', type: 'direct' });
      const care = new CareEngine({}, { enabled });
      const instance = new ScopeProbe();
      subscribeActivators(discoverActivators([instance]), {
        registry,
        trace: registry.trace,
        errorChannel: 'error.channel',
        care,
      });
      await registry.send('probe.in', {});
      expect(care.configured).toBe(enabled);
      expect(instance.scoped).toEqual([enabled]);
    }
  });

  it('RU-36a activator extra tries only when idempotent or keyed, inside one idempotency claim', async () => {
    const w = world();
    const instance = new RetryingActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await expect(w.registry.send('retry.plain', {})).rejects.toThrow('flaky');
    expect(instance.calls).toBe(1);
    expect(w.events.map((e) => e.type)).toEqual(['try.held']);

    instance.calls = 0;
    const begin = jest.spyOn(w.idempotency, 'begin');
    await w.registry.send('retry.plain', {}, { idempotencyKey: 'k-1' }).catch(() => undefined);
    expect(instance.calls).toBe(2);
    expect(begin).toHaveBeenCalledTimes(1);

    instance.calls = 0;
    await expect(w.gateway.sendAndReceive('retry.idempotent', {})).resolves.toBe('ok');
    expect(instance.calls).toBe(2);
  });

  it('RU-36b exposes the try signal through currentTrySignal', async () => {
    const w = world();
    const instance = new SignalActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await w.registry.send('signal.in', {});
    expect(instance.signal).toBeInstanceOf(AbortSignal);
  });

  it('RU-27 activator claims are released, not completed, when a plan B ran during the message', async () => {
    const w = world();
    const instance = new FallbackActivator();
    subscribeActivators(discoverActivators([instance]), w.deps);
    const replies: unknown[] = [];
    const replyChannel = w.registry.create({ name: 'replies', type: 'direct' });
    replyChannel.subscribe((msg) => {
      replies.push({ payload: msg.payload, degraded: msg.headers[PLAN_B_HEADER] });
    });
    const msg = createMessage({}, { idempotencyKey: 'dup', replyChannel: 'replies' });
    await w.registry.sendMessage('fb.in', msg);
    await w.registry.sendMessage(
      'fb.in',
      createMessage({}, { idempotencyKey: 'dup', replyChannel: 'replies' }),
    );
    expect(instance.calls).toBe(2);
    expect(replies).toEqual([
      { payload: 'plan-b', degraded: true },
      { payload: 'plan-b', degraded: true },
    ]);
    const record = await w.store.get('activator:FallbackActivator.run', 'dup');
    expect(record?.status).not.toBe('completed');
  });

  it('refuses an invalid or unknown care when the activator is subscribed', () => {
    class Bad {
      @ServiceActivator('fb.in', { care: 'missing' })
      run(): void {}
    }
    const w = world();
    expect(() => subscribeActivators(discoverActivators([new Bad()]), w.deps)).toThrow(
      CareConfigError,
    );
  });

  it('uses named profiles of the runtime', async () => {
    class Named {
      calls = 0;

      @ServiceActivator('retry.plain', { care: { use: 'twice', tries: { spacing: 0 } } })
      run(): void {
        this.calls += 1;
        throw flaky();
      }
    }
    const w = world({ profiles: { twice: { tries: { max: 2, idempotent: true } } } });
    const instance = new Named();
    subscribeActivators(discoverActivators([instance]), w.deps);
    await w.registry.send('retry.plain', {}).catch(() => undefined);
    expect(instance.calls).toBe(2);
  });
});
