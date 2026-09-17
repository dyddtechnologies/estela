import { awaitFirstMessage } from '../channels/one-shot';
import { ChannelError } from '../channel';
import { newId, type MessageHeadersInit } from '../message';
import type { ChannelRegistry } from '../channel-registry';
import type { TraceContext } from '../trace/trace-context';

export class ReplyTimeoutError extends ChannelError {
  constructor(channel: string, timeoutMs: number) {
    super(`reply a '${channel}' excedió el timeout (${timeoutMs}ms)`);
    this.name = 'ReplyTimeoutError';
  }
}

export interface ReplyGatewayDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  defaultTimeoutMs?: number;
}

/**
 * Request/reply (spec sec.8): channel efimero `reply.<uuid>` registrado y
 * **deregistrado en `finally`** — sin leaks (plan sec.8.3/sec.11).
 * Implementa `RequestReplyPort` (inbound interceptor, Fase 7).
 */
export class ReplyGateway {
  constructor(private readonly deps: ReplyGatewayDeps) {}

  async sendAndReceive(
    channel: string,
    payload: unknown,
    headers: MessageHeadersInit = {},
    timeoutMs?: number,
  ): Promise<unknown> {
    const timeout = timeoutMs ?? this.deps.defaultTimeoutMs ?? 10_000;
    const replyName = `reply.${newId()}`;
    this.deps.registry.create({ name: replyName, type: 'direct' });
    try {
      const replyChannel = this.deps.registry.get(replyName);
      const first = awaitFirstMessage(replyChannel, {
        timeoutMs: timeout,
        name: replyName,
        timeoutError: () => new ReplyTimeoutError(channel, timeout),
      });
      await this.deps.registry.send(channel, payload, { ...headers, replyChannel: replyName });
      const reply = await first;
      return reply.payload;
    } finally {
      this.deps.registry.unregister(replyName);
    }
  }
}
