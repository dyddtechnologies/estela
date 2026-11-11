import { copyMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from '../../message';

/**
 * Headers that route an answer back to a caller: activators, the outbound REST gateway and jumps
 * read them. A message sent with no answer expected never carries them.
 */
const REPLY_ROUTING_HEADERS = ['replyChannel', JUMP_REPLY_HEADER] as const;

/**
 * Same id, trace and custom headers as `msg`, without any reply routing, so its consumer cannot
 * answer the caller or a jump (a `wireTap` copy, D38; a message left by plan B, D39).
 */
export function withoutReplyRouting(msg: IntegrationMessage): IntegrationMessage {
  const copy = copyMessage(msg);
  const headers = copy.headers as Record<string, unknown>;
  for (const name of REPLY_ROUTING_HEADERS) delete headers[name];
  return copy;
}
