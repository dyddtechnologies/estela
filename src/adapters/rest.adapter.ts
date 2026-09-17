import type { MessageHandlerFn, Unsubscribe } from '../channel';
import { HttpHeaderMapper } from './header-mapper';
import type { ChannelRegistry } from '../channel-registry';

/** fetch estructural — evita depender del lib DOM para el tipo global. */
export interface RestFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type RestFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<RestFetchResponse>;

export interface RestOutOptions {
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  /** Inyectable para tests — default `globalThis.fetch`. */
  fetchFn?: RestFetch;
}

const mapper = new HttpHeaderMapper();

/**
 * REST outbound (spec sec.9): fetch JSON + headers de trace (tabla sec.4).
 * `!ok` -> throw (el subscriber del channel propaga — awaited sec.8.2).
 */
export function bindRestOut(
  registry: ChannelRegistry,
  channel: string,
  options: RestOutOptions,
): Unsubscribe {
  const fetchFn: RestFetch = options.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const method = options.method ?? 'POST';
  const handler: MessageHandlerFn = async (msg) => {
    const response = await fetchFn(options.url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...options.headers,
        ...mapper.mapOut(msg.headers),
      },
      body: JSON.stringify(msg.payload),
    });
    if (!response.ok) {
      throw new Error(`restOut ${method} ${options.url} → HTTP ${response.status}`);
    }
    await response.text(); // drena el body; el resultado util viaja por channels
    return undefined;
  };
  return registry.get(channel).subscribe(handler);
}
