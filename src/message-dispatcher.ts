import { ChannelNotFoundError, type MessageChannel } from './channel';
import {
  createMessage,
  recordHop,
  type IntegrationMessage,
  type MessageHeadersInit,
} from './message';
import type { TraceContext } from './trace/trace-context';

/**
 * SRP (ADR-011): envio de high level — create/bind de trace + recordHop + dispatch.
 * El contexto ALS se reconstruye desde headers en cada channel destino (plan sec.8.5).
 */
export class MessageDispatcher {
  constructor(
    private readonly resolve: (name: string) => MessageChannel | undefined,
    private readonly trace: TraceContext,
  ) {}

  async send(channelName: string, payload: unknown, headers?: MessageHeadersInit): Promise<void> {
    const target = this.requireChannel(channelName);
    const msg = createMessage(payload, headers);
    await target.send(recordHop(this.trace.bindMessage(msg), { channel: channelName }));
  }

  async sendMessage(channelName: string, msg: IntegrationMessage): Promise<void> {
    const target = this.requireChannel(channelName);
    await target.send(recordHop(this.trace.bindMessage(msg), { channel: channelName }));
  }

  private requireChannel(channelName: string): MessageChannel {
    const target = this.resolve(channelName);
    if (target === undefined) throw new ChannelNotFoundError(channelName);
    return target;
  }
}
