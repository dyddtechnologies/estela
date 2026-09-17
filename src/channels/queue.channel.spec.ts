import { CapacityExceededError, ChannelError } from '../channel';
import { createMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { QueueChannel } from './queue.channel';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const makeChannel = (capacity?: number) =>
  new QueueChannel('orders.audit', { trace: new TraceContext() }, capacity);

describe('QueueChannel (spec §5, plan §8.5)', () => {
  it('buffer FIFO + round-robin entre consumers', async () => {
    const channel = makeChannel();
    const got1: number[] = [];
    const got2: number[] = [];
    channel.subscribe(async (msg) => {
      got1.push(msg.payload as number);
    });
    channel.subscribe(async (msg) => {
      got2.push(msg.payload as number);
    });
    for (const n of [1, 2, 3, 4]) await channel.send(createMessage(n));
    await delay(40);
    expect(got1).toEqual([1, 3]);
    expect(got2).toEqual([2, 4]);
  });

  it('overflow de capacity → CapacityExceededError (nunca drop silencioso)', async () => {
    const channel = makeChannel(2);
    await channel.send(createMessage(1));
    await channel.send(createMessage(2));
    await expect(channel.send(createMessage(3))).rejects.toBeInstanceOf(CapacityExceededError);
  });

  it('send resuelve al bufferizar sin esperar el handler', async () => {
    const channel = makeChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let handled = false;
    channel.subscribe(async () => {
      await gate;
      handled = true;
    });
    await channel.send(createMessage('p'));
    expect(handled).toBe(false); // aun bufferizado / pump pending
    release();
    await delay(30);
    expect(handled).toBe(true);
  });

  it('close() hace drain del buffer (plan §8.6 shutdown)', async () => {
    const channel = makeChannel(10);
    const collected: number[] = [];
    channel.subscribe(async (msg) => {
      collected.push(msg.payload as number);
    });
    for (const n of [1, 2, 3]) await channel.send(createMessage(n));
    await channel.close();
    expect(collected).toEqual([1, 2, 3]);
    await expect(channel.send(createMessage(4))).rejects.toBeInstanceOf(ChannelError);
  });
});
