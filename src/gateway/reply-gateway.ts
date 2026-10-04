import { openFirstMessageWait } from '../channels/one-shot';
import { ChannelError, NoSubscriberError } from '../channel';
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
 * Request/reply (spec sec.8): ephemeral channel `reply.<uuid>` registered and
 * **unregistered in `finally`**, no leaks (plan sec.8.3/sec.11).
 * Implements `RequestReplyPort` (inbound interceptor, phase 7).
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
    const timedOut: { error?: ReplyTimeoutError } = {};
    const wait = openFirstMessageWait(this.deps.registry.get(replyName), {
      timeoutMs: timeout,
      name: replyName,
      timeoutError: () => {
        timedOut.error = new ReplyTimeoutError(channel, timeout);
        return timedOut.error;
      },
    });
    try {
      await this.deps.registry
        .send(channel, payload, { ...headers, replyChannel: replyName })
        .catch((error: unknown) => {
          // An awaited flow that outlives the timeout finds nobody on its reply channel:
          // that late reply is the timeout, not a missing subscriber.
          const lateReply = error instanceof NoSubscriberError && error.message.includes(replyName);
          throw timedOut.error !== undefined && lateReply ? timedOut.error : error;
        });
      const reply = await wait.promise;
      return reply.payload;
    } finally {
      // A failed send abandons the wait: release its timer and subscription.
      wait.cancel();
      this.deps.registry.unregister(replyName);
    }
  }
}
