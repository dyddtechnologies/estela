import type { MessageHandlerFn, Unsubscribe } from '../channel';
import { ChannelRegistry } from '../channel-registry';
import type { AmqpLikeChannel } from './amqp-like.channel';
import { AmqpHeaderMapper } from './header-mapper';

export interface RabbitOutTarget {
  queue?: string;
  exchange?: string;
  routingKey?: string;
  /** persistent default true (spec §9). */
  persistent?: boolean;
}

const mapper = new AmqpHeaderMapper();

/** Rabbit outbound (spec §9): queue o exchange+routingKey, persistent, headers de traza. */
export function bindRabbitOutbound(
  amqp: AmqpLikeChannel,
  registry: ChannelRegistry,
  fromChannel: string,
  target: RabbitOutTarget,
): Unsubscribe {
  const handler: MessageHandlerFn = async (msg) => {
    const content = Buffer.from(JSON.stringify(msg.payload), 'utf8');
    const props = {
      contentType: 'application/json',
      deliveryMode: target.persistent === false ? 1 : 2,
      headers: mapper.mapOut(msg.headers),
      messageId: msg.headers.id,
    };
    if (target.exchange !== undefined) {
      if (amqp.publish === undefined) {
        throw new Error('AmqpLikeChannel.publish no soportado por el implementador');
      }
      amqp.publish(target.exchange, target.routingKey ?? '', content, props);
    } else {
      amqp.sendToQueue(target.queue ?? '', content, props);
    }
  };
  return registry.get(fromChannel).subscribe(handler);
}
