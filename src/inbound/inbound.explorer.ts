import { AmqpHeaderMapper } from '../adapters/header-mapper';
import {
  AMQP_CHANNEL,
  type AmqpLikeChannel,
  type AmqpMessage,
} from '../adapters/amqp-like.channel';
import type { ChannelRegistry } from '../channel-registry';
import { recordHop } from '../message';
import { createMessage } from '../message';
import type { TraceContext } from '../trace/trace-context';

export interface RabbitInboundMapping {
  queue: string;
  channel: string;
}

export interface InboundExplorerOptions {
  registry: ChannelRegistry;
  trace: TraceContext;
  /** Token `AMQP_CHANNEL` opcional (spec §7.2/§9). */
  amqp?: AmqpLikeChannel;
  mappings?: readonly RabbitInboundMapping[];
  log?: (message: string) => void;
  onError?: (error: unknown) => void;
}

/** Bindea rabbit en `onModuleInit` solo si el token existe; si no → warn (spec §7.2). */
export class InboundExplorer {
  constructor(private readonly options: InboundExplorerOptions) {}

  get amqpToken(): typeof AMQP_CHANNEL {
    return AMQP_CHANNEL;
  }

  async onModuleInit(): Promise<void> {
    if (this.options.amqp === undefined) {
      this.options.log?.(
        'AMQP_CHANNEL ausente — inbound rabbit declarado pero no bindeado (warn, no throw)',
      );
      return;
    }
    for (const mapping of this.options.mappings ?? []) {
      await bindRabbitInbound(this.options.amqp, mapping, {
        registry: this.options.registry,
        trace: this.options.trace,
        ...(this.options.onError !== undefined ? { onError: this.options.onError } : {}),
      });
    }
  }
}

const mapper = new AmqpHeaderMapper();

export async function bindRabbitInbound(
  amqp: AmqpLikeChannel,
  mapping: RabbitInboundMapping,
  deps: {
    registry: ChannelRegistry;
    trace: TraceContext;
    onError?: (error: unknown) => void;
  },
): Promise<void> {
  await amqp.assertQueue(mapping.queue, { durable: true });
  await amqp.consume(mapping.queue, (raw: AmqpMessage | null) => {
    if (raw === null) return;
    void (async (): Promise<void> => {
      try {
        const parsed = JSON.parse(raw.content.toString('utf8')) as Record<string, unknown>;
        const headers = mapper.mapIn(raw.properties?.headers ?? {});
        const routingKey = raw.fields?.routingKey;
        const msg = createMessage(parsed, {
          ...headers,
          ...(typeof routingKey === 'string' ? { routingKey } : {}),
          source: 'rabbit',
        });
        await deps.registry.sendMessage(
          mapping.channel,
          recordHop(msg, { channel: mapping.queue, adapter: 'rabbit-inbound' }),
        );
        amqp.ack(raw);
      } catch (error) {
        amqp.nack(raw, false, false); // fail → nack requeue:false (spec §9)
        deps.onError?.(error);
      }
    })();
  });
}
