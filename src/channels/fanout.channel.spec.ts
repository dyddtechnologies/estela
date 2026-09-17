import {
  ChannelError,
  ChannelNotFoundError,
  FanoutCycleError,
  type ChannelResolver,
  type MessageChannel,
} from '../channel';
import { createMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { DirectChannel } from './direct.channel';
import { FanoutChannel } from './fanout.channel';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('FanoutChannel (spec §5, plan §8.6)', () => {
  it('copía a bindings + locals; el msg original no muta', async () => {
    const trace = new TraceContext();
    const inventory = new DirectChannel('inventory.reserve', { trace });
    const receivedInventory: unknown[] = [];
    inventory.subscribe(async (msg) => {
      receivedInventory.push(msg.payload);
    });
    const resolver: ChannelResolver = {
      get: (name) => (name === 'inventory.reserve' ? inventory : (undefined as never)),
    };
    const fanout = new FanoutChannel('ops.fanout', { trace, resolver }, {
      bindings: ['inventory.reserve'],
    });
    const local: unknown[] = [];
    fanout.subscribe(async (msg) => {
      local.push(msg.payload);
    });
    const msg = createMessage({ sku: 'A1' }, { traceId: 't-1' });
    await fanout.send(msg);
    expect(receivedInventory).toEqual([{ sku: 'A1' }]);
    expect(local).toEqual([{ sku: 'A1' }]);
    expect(msg.headers.history).toHaveLength(0); // inmutabilidad
  });

  it('awaited: send espera el handler del binding (spec §17.3)', async () => {
    const trace = new TraceContext();
    const slow = new DirectChannel('slow', { trace });
    let done = false;
    slow.subscribe(async () => {
      await delay(30);
      done = true;
    });
    const resolver: ChannelResolver = {
      get: (name) => (name === 'slow' ? slow : (undefined as never)),
    };
    const fanout = new FanoutChannel('f', { trace, resolver }, { bindings: ['slow'] });
    await fanout.send(createMessage('p'));
    expect(done).toBe(true);
  });

  it('cycle guard: A↔B enlazados → FanoutCycleError, no cuelga', async () => {
    const trace = new TraceContext();
    const channels = new Map<string, MessageChannel>();
    const resolver: ChannelResolver = {
      get: (name) => {
        const found = channels.get(name);
        if (found === undefined) throw new ChannelNotFoundError(name);
        return found;
      },
    };
    const a = new FanoutChannel('a', { trace, resolver }, { bindings: ['b'] });
    const b = new FanoutChannel('b', { trace, resolver }, { bindings: ['a'] });
    channels.set('a', a);
    channels.set('b', b);
    await expect(a.send(createMessage('p'))).rejects.toBeInstanceOf(FanoutCycleError);
  });

  it('binding inexistente → ChannelNotFoundError', async () => {
    const trace = new TraceContext();
    const resolver: ChannelResolver = {
      get: () => undefined as never,
    };
    const fanout = new FanoutChannel('f', { trace, resolver }, { bindings: ['nope'] });
    await expect(fanout.send(createMessage('p'))).rejects.toBeInstanceOf(ChannelNotFoundError);
  });

  it('sin resolver en deps → error de construcción', () => {
    expect(() => new FanoutChannel('f', { trace: new TraceContext() })).toThrow(ChannelError);
  });
});
