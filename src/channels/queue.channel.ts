import {
  CapacityExceededError,
  ChannelError,
  type ChannelKind,
  type IntegrationMessage,
  type MessageChannel,
  type MessageHandlerFn,
  type SubscribeOptions,
  type Unsubscribe,
} from '../channel';
import type { ChannelDeps } from './channel-deps';

interface Consumer {
  id: number;
  handler: MessageHandlerFn;
}

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Buffer FIFO + round-robin con capacity (spec §5, plan §8.5 regla 5).
 * `send` resuelve al bufferizar (no espera handlers); el pump cede el event
 * loop con `setImmediate`. Overflow → `CapacityExceededError` (nunca drop
 * silencioso). `close()` hace drain (shutdown-safe, plan §8.6).
 */
export class QueueChannel implements MessageChannel {
  readonly kind: ChannelKind = 'queue';
  private readonly buffer: IntegrationMessage[] = [];
  private consumers: Consumer[] = [];
  private nextConsumerId = 1;
  private rrCursor = 0;
  private pumpScheduled = false;
  private pumping = false;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly deps: ChannelDeps,
    private readonly capacity = 10_000,
  ) {}

  subscribe(handler: MessageHandlerFn, _options?: SubscribeOptions): Unsubscribe {
    const id = this.nextConsumerId;
    this.nextConsumerId += 1;
    this.consumers = [...this.consumers, { id, handler }];
    this.schedulePump();
    return () => {
      this.consumers = this.consumers.filter((consumer) => consumer.id !== id);
    };
  }

  send(msg: IntegrationMessage): Promise<void> {
    if (this.closed) return Promise.reject(new ChannelError(`queue '${this.name}' cerrada`));
    if (this.buffer.length >= this.capacity) {
      return Promise.reject(new CapacityExceededError(this.name, this.capacity));
    }
    this.buffer.push(msg);
    this.schedulePump();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    // Drain determinista: el pump normal se detiene con `closed`; este loop
    // procesa el remanente respetando FIFO y round-robin.
    while (this.buffer.length > 0 && this.consumers.length > 0) {
      await this.processNext();
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.buffer.length > 0 && this.consumers.length > 0) {
        const processed = await this.processNext();
        if (!processed) break;
        await yieldToEventLoop();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async processNext(): Promise<boolean> {
    const msg = this.buffer.shift();
    if (msg === undefined) return false;
    const consumer = this.pickConsumer();
    if (consumer === undefined) {
      this.buffer.unshift(msg);
      return false;
    }
    try {
      await this.deps.trace.runWithMessage(msg, () => consumer.handler(msg));
    } catch (error) {
      this.deps.onError?.(error, msg);
    }
    return true;
  }

  private pickConsumer(): Consumer | undefined {
    if (this.consumers.length === 0) return undefined;
    const consumer = this.consumers[this.rrCursor % this.consumers.length];
    this.rrCursor = (this.rrCursor + 1) % Number.MAX_SAFE_INTEGER;
    return consumer;
  }
}
