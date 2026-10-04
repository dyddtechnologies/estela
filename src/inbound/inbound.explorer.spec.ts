import type { AmqpLikeChannel, AmqpMessage } from '../adapters/amqp-like.channel';
import { AMQP_CHANNEL } from '../adapters/amqp-like.channel';
import { ChannelRegistry } from '../channel-registry';
import type { IntegrationMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { InboundExplorer, type RabbitInboundMapping } from './inbound.explorer';

const amqpStub = (): AmqpLikeChannel => ({
  assertQueue: jest.fn(async () => undefined),
  consume: jest.fn(async () => ({})),
  ack: jest.fn(),
  nack: jest.fn(),
  sendToQueue: jest.fn(() => true),
});

const mappings: RabbitInboundMapping[] = [
  { queue: 'orders.q', channel: 'orders.in' },
  { queue: 'billing.q', channel: 'billing.in' },
];

describe('InboundExplorer: rabbit warning matrix (mappings x channel)', () => {
  const build = (options: { amqp?: AmqpLikeChannel; mappings?: RabbitInboundMapping[] }) => {
    const log = jest.fn();
    const trace = new TraceContext();
    const explorer = new InboundExplorer({
      registry: new ChannelRegistry({ trace }),
      trace,
      log,
      onError: jest.fn(),
      ...options,
    });
    return { explorer, log };
  };

  it('no mappings and no channel: logs nothing', async () => {
    const { explorer, log } = build({});
    await explorer.onModuleInit();
    expect(log).not.toHaveBeenCalled();
  });

  it('empty mappings and no channel: logs nothing', async () => {
    const { explorer, log } = build({ mappings: [] });
    await explorer.onModuleInit();
    expect(log).not.toHaveBeenCalled();
  });

  it('mappings without a channel: warns once, in English, and does not throw', async () => {
    const { explorer, log } = build({ mappings });
    await expect(explorer.onModuleInit()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'AMQP_CHANNEL missing: 2 rabbit inbound mapping(s) declared but not bound (warn, no throw)',
    );
  });

  it('mappings without a channel and without a log sink: stays silent and does not throw', async () => {
    const trace = new TraceContext();
    const explorer = new InboundExplorer({
      registry: new ChannelRegistry({ trace }),
      trace,
      mappings,
    });
    await expect(explorer.onModuleInit()).resolves.toBeUndefined();
  });

  it('channel without mappings: binds nothing and logs nothing', async () => {
    const amqp = amqpStub();
    const { explorer, log } = build({ amqp });
    await explorer.onModuleInit();
    expect(amqp.assertQueue).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('channel with mappings: binds every queue and logs nothing', async () => {
    const amqp = amqpStub();
    const { explorer, log } = build({ amqp, mappings });
    await explorer.onModuleInit();
    expect(amqp.assertQueue).toHaveBeenCalledWith('orders.q', { durable: true });
    expect(amqp.assertQueue).toHaveBeenCalledWith('billing.q', { durable: true });
    expect(amqp.consume).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it('exposes the optional AMQP injection token', () => {
    expect(build({}).explorer.amqpToken).toBe(AMQP_CHANNEL);
  });
});

describe('InboundExplorer: rabbit consumer', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const bind = async (withOnError: boolean) => {
    const consumers = new Map<string, (msg: AmqpMessage | null) => void>();
    const amqp = amqpStub();
    amqp.consume = jest.fn(async (queue: string, handler: (msg: AmqpMessage | null) => void) => {
      consumers.set(queue, handler);
      return {};
    });
    const trace = new TraceContext();
    const registry = new ChannelRegistry({ trace });
    registry.create({ name: 'orders.in', type: 'direct' });
    const received: IntegrationMessage[] = [];
    registry.get('orders.in').subscribe(async (msg: IntegrationMessage) => {
      received.push(msg);
    });
    const onError = jest.fn();
    const explorer = new InboundExplorer({
      registry,
      trace,
      amqp,
      mappings: [{ queue: 'orders.q', channel: 'orders.in' }],
      ...(withOnError ? { onError } : {}),
    });
    await explorer.onModuleInit();
    const deliver = async (msg: AmqpMessage | null): Promise<void> => {
      consumers.get('orders.q')?.(msg);
      await delay(10);
    };
    return { amqp, received, onError, deliver };
  };

  it('maps broker headers and the routing key into the message and acks it', async () => {
    const { amqp, received, deliver } = await bind(true);
    const raw: AmqpMessage = {
      content: Buffer.from(JSON.stringify({ orderId: 'o-1' })),
      properties: { headers: { 'x-trace-id': 't-1' } },
      fields: { routingKey: 'order.placed' },
    };
    await deliver(raw);
    expect(received).toHaveLength(1);
    expect(received[0]!.payload).toEqual({ orderId: 'o-1' });
    expect(received[0]!.headers).toMatchObject({
      traceId: 't-1',
      routingKey: 'order.placed',
      source: 'rabbit',
    });
    expect(amqp.ack).toHaveBeenCalledWith(raw);
  });

  it('ignores a consumer cancellation (null message)', async () => {
    const { amqp, received, deliver } = await bind(true);
    await deliver(null);
    expect(received).toHaveLength(0);
    expect(amqp.ack).not.toHaveBeenCalled();
    expect(amqp.nack).not.toHaveBeenCalled();
  });

  it('nacks a poison message without requeue, with or without an error sink', async () => {
    const poison: AmqpMessage = { content: Buffer.from('{not json') };
    const reported = await bind(true);
    await reported.deliver(poison);
    expect(reported.amqp.nack).toHaveBeenCalledWith(poison, false, false);
    expect(reported.onError).toHaveBeenCalledTimes(1);

    const silent = await bind(false);
    await silent.deliver(poison);
    expect(silent.amqp.nack).toHaveBeenCalledWith(poison, false, false);
    expect(silent.amqp.ack).not.toHaveBeenCalled();
  });
});
