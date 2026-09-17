import { createMessage } from '../message';
import { NoSubscriberError } from '../channel';
import { TraceContext } from '../trace/trace-context';
import { DirectChannel } from './direct.channel';

const makeChannel = () => new DirectChannel('orders.place', { trace: new TraceContext() });

describe('DirectChannel (spec §5)', () => {
  it('sin subscriber → send rechaza con NoSubscriberError', async () => {
    const channel = makeChannel();
    await expect(channel.send(createMessage('p'))).rejects.toBeInstanceOf(NoSubscriberError);
  });

  it('send await el handler (semántica awaited)', async () => {
    const channel = makeChannel();
    let finished = false;
    channel.subscribe(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished = true;
    });
    await channel.send(createMessage('p'));
    expect(finished).toBe(true);
  });

  it('re-subscripción: el último gana; unsubscribe del nuevo → sin subscriber', async () => {
    const channel = makeChannel();
    const received: string[] = [];
    channel.subscribe(async (msg) => {
      received.push(`first:${String(msg.payload)}`);
    });
    const unsubSecond = channel.subscribe(async (msg) => {
      received.push(`second:${String(msg.payload)}`);
    });
    await channel.send(createMessage('m1'));
    expect(received).toEqual(['second:m1']);
    unsubSecond();
    await expect(channel.send(createMessage('m2'))).rejects.toBeInstanceOf(NoSubscriberError);
  });
});
