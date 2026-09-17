import type { IntegrationMessage } from './message';

export type { IntegrationMessage };

/**
 * Domain puro de channels (spec sec.5). Sin dependencies npm (enforced por
 * dependency-cruiser): solo tipos del message y errores de domain.
 */

export type ChannelKind = 'direct' | 'queue' | 'pubsub' | 'fanout';

export type MessageHandlerFn = (msg: IntegrationMessage) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface SubscribeOptions {
  group?: string;
  routingKey?: string;
}

export interface MessageChannel {
  readonly name: string;
  readonly kind: ChannelKind;
  send(msg: IntegrationMessage): Promise<void>;
  subscribe(handler: MessageHandlerFn, options?: SubscribeOptions): Unsubscribe;
  /** Shutdown limpio (drain); opcional — ver plan sec.8.6. */
  close?(): Promise<void>;
}

/** Port de resolution de channels (lo implementa ChannelRegistry en Fase 3). */
export interface ChannelResolver {
  get(name: string): MessageChannel | undefined;
}

// ---------- Errores de domain (plan sec.8.2) ----------

export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NoSubscriberError extends ChannelError {
  constructor(channel: string) {
    super(`direct channel '${channel}' no tiene subscriber`);
  }
}

export class ChannelNotFoundError extends ChannelError {
  constructor(channel: string) {
    super(`canal no encontrado: '${channel}'`);
  }
}

export class CapacityExceededError extends ChannelError {
  constructor(channel: string, capacity: number) {
    super(`queue '${channel}' llena (capacity=${capacity})`);
  }
}

export class FanoutCycleError extends ChannelError {}

// ---------- Cycle guard (plan sec.8.6 / ADR-019) ----------

export const MAX_HOP_DEPTH = 50;

/**
 * Verifica ANTES de despachar un fanout hacia `targetChannel`:
 * - profundidad de history bajo `MAX_HOP_DEPTH`;
 * - `targetChannel` no aparezca ya 2+ veces (un tercer cruce = cycle A<->B).
 * Sin esto, dos fanouts linked mutuamente = loop infinite.
 */
export function assertNoFanoutCycle(msg: IntegrationMessage, targetChannel: string): void {
  const depth = msg.headers.history.length + 1;
  if (depth > MAX_HOP_DEPTH) {
    throw new FanoutCycleError(
      `fanout: profundidad de hops ${depth} excede ${MAX_HOP_DEPTH} antes de '${targetChannel}'`,
    );
  }
  let hits = 0;
  for (const hop of msg.headers.history) {
    if (hop.channel === targetChannel) {
      hits += 1;
      if (hits >= 2) {
        throw new FanoutCycleError(
          `fanout: ciclo detectado — '${targetChannel}' ya aparece ${hits} veces en history`,
        );
      }
    }
  }
}
