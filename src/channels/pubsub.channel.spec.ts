import { createMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import type { ChannelDeps } from './channel-deps';
import { PubSubChannel } from './pubsub.channel';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeChannel = (onError?: (error: unknown) => void) => {
  const deps: ChannelDeps = { trace: new TraceContext() };
  if (onError !== undefined) deps.onError = onError;
  return new PubSubChannel('domain.events', deps);
};

const send = (channel: PubSubChannel, payload: string, routingKey?: string) => {
  const msg = createMessage(payload, routingKey !== undefined ? { routingKey } : {});
  return channel.send(msg);
};

describe('PubSubChannel (spec §5, plan §8.5)', () => {
  it('broadcast a todos los subscribers', async () => {
    const channel = makeChannel();
    const a: string[] = [];
    const b: string[] = [];
    channel.subscribe(async (msg) => {
      a.push(String(msg.payload));
    });
    channel.subscribe(async (msg) => {
      b.push(String(msg.payload));
    });
    await send(channel, 'evt');
    expect(a).toEqual(['evt']);
    expect(b).toEqual(['evt']);
  });

  it('glob routingKey: `*` 1 segmento, `#` resto', async () => {
    const channel = makeChannel();
    const star: string[] = [];
    const hash: string[] = [];
    channel.subscribe(
      async (msg) => {
        star.push(String(msg.payload));
      },
      { routingKey: 'order.*' },
    );
    channel.subscribe(
      async (msg) => {
        hash.push(String(msg.payload));
      },
      { routingKey: 'order.#' },
    );
    await send(channel, 'one', 'order.created');
    await send(channel, 'two', 'order.created.v2');
    await send(channel, 'three', 'order');
    await delay(10);
    expect(star).toEqual(['one']);
    expect(hash).toEqual(['one', 'two', 'three']);
  });

  it('grupo = round-robin: un consumidor del grupo por mensaje; sin grupo recibe todo', async () => {
    const channel = makeChannel();
    const g1: number[] = [];
    const g2: number[] = [];
    const solo: number[] = [];
    channel.subscribe(
      async (msg) => {
        g1.push(msg.payload as number);
      },
      { group: 'workers' },
    );
    channel.subscribe(
      async (msg) => {
        g2.push(msg.payload as number);
      },
      { group: 'workers' },
    );
    channel.subscribe(async (msg) => {
      solo.push(msg.payload as number);
    });
    for (const n of [1, 2, 3, 4]) await channel.send(createMessage(n));
    await delay(20);
    expect([...g1, ...g2].sort()).toEqual([1, 2, 3, 4]);
    expect(g1).toEqual([1, 3]);
    expect(g2).toEqual([2, 4]);
    expect(solo).toEqual([1, 2, 3, 4]);
  });

  it('aislamiento: fallo de un subscriber no afecta a los demás; onError reporta', async () => {
    const errors: unknown[] = [];
    const channel = makeChannel((error) => {
      errors.push(error);
    });
    const ok: string[] = [];
    channel.subscribe(async () => {
      throw new Error('subscriber roto');
    });
    channel.subscribe(async (msg) => {
      ok.push(String(msg.payload));
    });
    await send(channel, 'evt');
    expect(ok).toEqual(['evt']);
    expect(errors).toHaveLength(1);
  });

  it('reconstruye contexto ALS desde headers aunque el send venga fuera de run (plan §8.5 regla 1)', async () => {
    const trace = new TraceContext();
    const channel = new PubSubChannel('ps', { trace });
    let seenTraceId: string | undefined;
    let seenSpanId: string | undefined;
    channel.subscribe(async (msg) => {
      seenTraceId = trace.current()?.traceId;
      seenSpanId = trace.current()?.spanId;
      expect(msg.headers.traceId).toBe('t-header');
    });
    await channel.send(createMessage('p', { traceId: 't-header', spanId: 's-header' }));
    expect(seenTraceId).toBe('t-header');
    expect(seenSpanId).toBe('s-header');
  });
});
