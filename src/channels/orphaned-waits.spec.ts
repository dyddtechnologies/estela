import { ChannelRegistry } from '../channel-registry';
import { FlowExecutor } from '../flow/flow-executor';
import { JumpTimeoutError } from '../flow/flow-step';
import { IntegrationFlow } from '../flow/integration-flow';
import { ReplyGateway, ReplyTimeoutError } from '../gateway/reply-gateway';
import { TraceContext } from '../trace/trace-context';
import { OneShotCancelledError, OneShotTimeoutError, openFirstMessageWait } from './one-shot';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeRegistry = (): ChannelRegistry => {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  return registry;
};

const failingChannel = (registry: ChannelRegistry, name: string): void => {
  registry.create({ name, type: 'direct' }).subscribe(async () => {
    throw new Error('boom');
  });
};

const bindJumpFlow = (registry: ChannelRegistry, source: string, target: string, ms: number) => {
  registry.create({ name: source, type: 'direct' });
  const built = IntegrationFlow.from(source)
    .jumpTo([{ channel: target, timeoutMs: ms }])
    .build();
  new FlowExecutor('jump-flow', built, {
    registry,
    trace: registry.trace,
    errorChannel: 'error.channel',
  }).attachTo(registry);
};

/** Collects unhandled rejections raised while `fn` runs plus a grace period. */
const captureUnhandled = async (fn: () => Promise<void>, graceMs: number): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await fn();
    await delay(graceMs);
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
};

describe('one-shot waits abandoned by a failed send (regression)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ReplyGateway: a failed send leaves no unhandled ReplyTimeoutError behind', async () => {
    const registry = makeRegistry();
    failingChannel(registry, 'saga.step');
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    const seen = await captureUnhandled(async () => {
      await expect(gateway.sendAndReceive('saga.step', 'p', {}, 20)).rejects.toThrow('boom');
    }, 80);
    expect(seen).toEqual([]);
  });

  it('jumpTo: a failed hop send leaves no unhandled JumpTimeoutError behind', async () => {
    const registry = makeRegistry();
    failingChannel(registry, 'hop.target');
    bindJumpFlow(registry, 'flow.in', 'hop.target', 20);
    const seen = await captureUnhandled(async () => {
      await expect(registry.send('flow.in', 'x')).rejects.toThrow('boom');
    }, 80);
    expect(seen).toEqual([]);
  });

  it('ReplyGateway: a send outlasting the timeout leaves no unhandled rejection', async () => {
    const registry = makeRegistry();
    registry.create({ name: 'slow', type: 'direct' }).subscribe(async () => {
      await delay(60);
      throw new Error('boom');
    });
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    const seen = await captureUnhandled(async () => {
      await expect(gateway.sendAndReceive('slow', 'p', {}, 20)).rejects.toThrow('boom');
    }, 40);
    expect(seen).toEqual([]);
  });

  it('jumpTo: a hop send outlasting the timeout still fails with JumpTimeoutError, handled', async () => {
    const registry = makeRegistry();
    registry.create({ name: 'slow.hop', type: 'direct' }).subscribe(async () => {
      await delay(60);
    });
    bindJumpFlow(registry, 'flow.in', 'slow.hop', 20);
    const seen = await captureUnhandled(async () => {
      await expect(registry.send('flow.in', 'x')).rejects.toBeInstanceOf(JumpTimeoutError);
    }, 40);
    expect(seen).toEqual([]);
  });

  it('ReplyGateway: a failed send leaves no pending timer', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    failingChannel(registry, 'saga.step');
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    await expect(gateway.sendAndReceive('saga.step', 'p', {}, 120_000)).rejects.toThrow('boom');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('jumpTo: a failed hop send leaves no pending timer', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    failingChannel(registry, 'hop.target');
    bindJumpFlow(registry, 'flow.in', 'hop.target', 120_000);
    await expect(registry.send('flow.in', 'x')).rejects.toThrow('boom');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('genuine timeouts still reject with the typed error and release the timer', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    registry.create({ name: 'silent', type: 'direct' }).subscribe(async () => undefined);
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    const reply = gateway.sendAndReceive('silent', 'p', {}, 20);
    reply.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(20);
    await expect(reply).rejects.toBeInstanceOf(ReplyTimeoutError);
    expect(jest.getTimerCount()).toBe(0);

    bindJumpFlow(registry, 'flow.in', 'silent', 20);
    const jump = registry.send('flow.in', 'x');
    jump.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(20);
    await expect(jump).rejects.toBeInstanceOf(JumpTimeoutError);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ReplyGateway: a responder that replies twice still resolves with the first reply', async () => {
    const registry = makeRegistry();
    registry.create({ name: 'twice', type: 'direct' }).subscribe(async (msg) => {
      await registry.send(msg.headers.replyChannel!, 'first');
      await registry.send(msg.headers.replyChannel!, 'second');
    });
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    await expect(gateway.sendAndReceive('twice', 'p', {}, 1_000)).resolves.toBe('first');
  });

  it('jumpTo: a hop that replies twice still continues with the first reply', async () => {
    const registry = makeRegistry();
    registry.create({ name: 'twice.hop', type: 'direct' }).subscribe(async (msg) => {
      await registry.send(msg.headers.replyChannel!, 'first');
      await registry.send(msg.headers.replyChannel!, 'second');
    });
    registry.create({ name: 'flow.in', type: 'direct' });
    const seen: unknown[] = [];
    const built = IntegrationFlow.from('flow.in')
      .jumpTo([{ channel: 'twice.hop', timeoutMs: 1_000 }])
      .handle((payload, msg) => {
        seen.push(msg.headers.jumpReplies);
        return payload;
      })
      .build();
    new FlowExecutor('jump-flow', built, {
      registry,
      trace: registry.trace,
      errorChannel: 'error.channel',
    }).attachTo(registry);
    await expect(registry.send('flow.in', 'x')).resolves.toBeUndefined();
    expect(seen).toEqual([{ 'twice.hop': 'first' }]);
  });

  it('successful replies clear the timer', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    registry.create({ name: 'echo', type: 'direct' }).subscribe(async (msg) => {
      await registry.send(msg.headers.replyChannel!, { echoed: msg.payload });
    });
    const gateway = new ReplyGateway({ registry, trace: registry.trace });
    await expect(gateway.sendAndReceive('echo', 1, {}, 120_000)).resolves.toEqual({ echoed: 1 });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('openFirstMessageWait', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('cancel() rejects a pending wait as handled, clears the timer and unsubscribes', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    const channel = registry.create({ name: 'one', type: 'direct' });
    const wait = openFirstMessageWait(channel, { timeoutMs: 1_000, name: 'one' });
    expect(jest.getTimerCount()).toBe(1);
    wait.cancel();
    expect(jest.getTimerCount()).toBe(0);
    await expect(wait.promise).rejects.toBeInstanceOf(OneShotCancelledError);
    await expect(registry.send('one', 'late')).rejects.toThrow();
  });

  it('keeps the subscription after the first message and ignores later ones', async () => {
    const registry = makeRegistry();
    const channel = registry.create({ name: 'one', type: 'direct' });
    const wait = openFirstMessageWait(channel, { timeoutMs: 1_000, name: 'one' });
    await registry.send('one', 'hello');
    await expect(registry.send('one', 'again')).resolves.toBeUndefined();
    await expect(wait.promise).resolves.toMatchObject({ payload: 'hello' });
  });

  it('cancel() after a message keeps the result and releases the subscription', async () => {
    const registry = makeRegistry();
    const channel = registry.create({ name: 'one', type: 'direct' });
    const wait = openFirstMessageWait(channel, { timeoutMs: 1_000, name: 'one' });
    await registry.send('one', 'hello');
    wait.cancel();
    await expect(wait.promise).resolves.toMatchObject({ payload: 'hello' });
    await expect(registry.send('one', 'late')).rejects.toThrow();
  });

  it('times out with OneShotTimeoutError by default', async () => {
    jest.useFakeTimers();
    const registry = makeRegistry();
    const channel = registry.create({ name: 'one', type: 'direct' });
    const wait = openFirstMessageWait(channel, { timeoutMs: 50, name: 'one' });
    jest.advanceTimersByTime(50);
    await expect(wait.promise).rejects.toBeInstanceOf(OneShotTimeoutError);
    expect(jest.getTimerCount()).toBe(0);
  });
});
