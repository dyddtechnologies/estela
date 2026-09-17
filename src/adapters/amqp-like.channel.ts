/** Message crudo AMQP normalizado (ISP — plan sec.5.1). */
export interface AmqpMessage {
  content: Buffer;
  fields?: Record<string, unknown>;
  properties?: {
    headers?: Record<string, unknown>;
    messageId?: string;
    [key: string]: unknown;
  };
}

/**
 * Port AMQP (ISP, plan sec.5.1): solo lo que los adapters use — Never la
 * superficie completa de amqplib. Implementado por el consumidor via token.
 */
export interface AmqpLikeChannel {
  assertQueue(queue: string, options?: unknown): Promise<unknown>;
  consume(
    queue: string,
    handler: (msg: AmqpMessage | null) => void,
  ): Promise<{ consumerTag?: string }>;
  ack(msg: AmqpMessage): void;
  nack(msg: AmqpMessage, all: boolean, requeue: boolean): void;
  sendToQueue(queue: string, content: Buffer, options?: unknown): boolean;
  publish?(exchange: string, routingKey: string, content: Buffer, options?: unknown): boolean;
}

/** Token de injection opcional (spec sec.9): ausente -> warn, no throw. */
export const AMQP_CHANNEL = 'INTEGRATION_AMQP_CHANNEL';
