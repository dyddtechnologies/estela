import { OutboundError } from './outbound.errors';
import type {
  OutboundBodySerializerFn,
  OutboundQuery,
  OutboundSerialized,
  OutboundSerializedBody,
} from './outbound.types';

/** Flattens a record into name/value pairs: nullish entries are skipped, arrays repeat the name. */
export function toPairs(record: OutboundQuery): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    const items = Array.isArray(value) ? (value as readonly unknown[]) : [value];
    for (const item of items) pairs.push([name, String(item)]);
  }
  return pairs;
}

/** Built-in `'json'` serializer (default); an `undefined` body sends nothing. */
export const jsonSerializer: OutboundBodySerializerFn = (body) => {
  const text = JSON.stringify(body) as string | undefined;
  return text === undefined ? undefined : { body: text, contentType: 'application/json' };
};

/** Built-in `'text'` serializer: a string body, sent verbatim. */
export const textSerializer: OutboundBodySerializerFn = (body, ctx) => {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') {
    throw new OutboundError(
      `outbound rest '${ctx.name}': the 'text' serializer needs a string body`,
    );
  }
  return { body, contentType: 'text/plain; charset=utf-8' };
};

/** Built-in `'form'` serializer: a record (or a ready string) as `x-www-form-urlencoded`. */
export const formSerializer: OutboundBodySerializerFn = (body, ctx) => {
  if (body === undefined || body === null) return undefined;
  const contentType = 'application/x-www-form-urlencoded';
  if (typeof body === 'string') return { body, contentType };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new OutboundError(`outbound rest '${ctx.name}': the 'form' serializer needs a record`);
  }
  return { body: new URLSearchParams(toPairs(body as OutboundQuery)).toString(), contentType };
};

/** Normalizes what a serializer returns; a bare string is a body without a content type. */
export function toSerializedBody(serialized: OutboundSerialized): OutboundSerializedBody {
  if (typeof serialized === 'string') return { body: serialized };
  return serialized ?? {};
}
