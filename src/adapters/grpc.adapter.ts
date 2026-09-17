import type { MessageHandlerFn, Unsubscribe } from '../channel';
import type { ChannelRegistry } from '../channel-registry';
import { GrpcHeaderMapper } from './header-mapper';
import type { RequestReplyPort } from '../inbound/inbound.interceptor';
import type { TraceContext } from '../trace/trace-context';

const mapper = new GrpcHeaderMapper();

export type GrpcStubFn = (payload: unknown, metadata: Record<string, string>) => unknown;

/** gRPC outbound (spec sec.9): stub inyectado — cero imports de @grpc/grpc-js. */
export function bindGrpcOut(
  registry: ChannelRegistry,
  fromChannel: string,
  stub: GrpcStubFn,
  options: { replyChannel?: string } = {},
): Unsubscribe {
  const handler: MessageHandlerFn = async (msg) => {
    const metadata = mapper.mapOut(msg.headers);
    const result = await stub(msg.payload, metadata);
    if (options.replyChannel !== undefined && result !== undefined) {
      await registry.send(options.replyChannel, result, {
        correlationId: msg.headers.correlationId,
        traceId: msg.headers.traceId,
        causationId: msg.headers.id,
        parentSpanId: msg.headers.spanId,
      });
    }
  };
  return registry.get(fromChannel).subscribe(handler);
}

export interface GrpcInboundDeps {
  registry: ChannelRegistry;
  trace: TraceContext;
  replyGateway?: RequestReplyPort;
  defaultTimeoutMs?: number;
}

/** `grpcIn.handleInbound(channel, data, metadata, requestReply?)` — spec sec.9. */
export async function handleGrpcInbound(
  deps: GrpcInboundDeps,
  channel: string,
  data: unknown,
  metadata: Record<string, unknown>,
  requestReply = false,
  timeoutMs?: number,
): Promise<unknown> {
  const headers = mapper.mapIn(metadata);
  if (requestReply) {
    if (deps.replyGateway === undefined) {
      throw new Error('grpcIn requestReply requiere ReplyGateway');
    }
    return deps.replyGateway.sendAndReceive(
      channel,
      data,
      headers,
      timeoutMs ?? deps.defaultTimeoutMs,
    );
  }
  await deps.registry.send(channel, data, headers);
  return undefined;
}
