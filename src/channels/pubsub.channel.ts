import {
  type ChannelKind,
  type IntegrationMessage,
  type MessageChannel,
  type MessageHandlerFn,
  type SubscribeOptions,
  type Unsubscribe,
} from '../channel';
import type { ChannelDeps } from './channel-deps';
import { compileGlob } from './glob';

interface Subscriber {
  id: number;
  handler: MessageHandlerFn;
  group?: string;
  match?: (key: string) => boolean;
}

/**
 * Broadcast con glob `*`/`#` y grupos round-robin (spec sec.5, plan sec.8.5 rule 3).
 * Dispatch `Promise.allSettled`: el failure de un subscriber no afecta a los
 * demas y se reporta por `deps.onError` — never tumba el send.
 */
export class PubSubChannel implements MessageChannel {
  readonly kind: ChannelKind = 'pubsub';
  private readonly subscribers = new Map<number, Subscriber>();
  private readonly groups = new Map<string, number[]>();
  private readonly groupCursor = new Map<string, number>();
  private nextId = 1;

  constructor(
    readonly name: string,
    private readonly deps: ChannelDeps,
  ) {}

  subscribe(handler: MessageHandlerFn, options?: SubscribeOptions): Unsubscribe {
    const id = this.nextId;
    this.nextId += 1;
    const subscriber: Subscriber = { id, handler };
    if (options?.group !== undefined) {
      subscriber.group = options.group;
      const members = this.groups.get(options.group) ?? [];
      this.groups.set(options.group, [...members, id]);
    }
    if (options?.routingKey !== undefined) {
      subscriber.match = compileGlob(options.routingKey);
    }
    this.subscribers.set(id, subscriber);
    return () => {
      this.subscribers.delete(id);
      if (subscriber.group !== undefined) {
        const members = this.groups.get(subscriber.group);
        if (members !== undefined) {
          this.groups.set(
            subscriber.group,
            members.filter((member) => member !== id),
          );
        }
      }
    };
  }

  async send(msg: IntegrationMessage): Promise<void> {
    const routingKey = typeof msg.headers.routingKey === 'string' ? msg.headers.routingKey : '';
    const targets: Subscriber[] = [];
    for (const [group, memberIds] of this.groups) {
      const matching = memberIds
        .map((id) => this.subscribers.get(id))
        .filter((s): s is Subscriber => s !== undefined && this.matches(s, routingKey));
      if (matching.length === 0) continue;
      const cursor = this.groupCursor.get(group) ?? 0;
      const picked = matching[cursor % matching.length];
      this.groupCursor.set(group, cursor + 1);
      if (picked !== undefined) targets.push(picked);
    }
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.group === undefined && this.matches(subscriber, routingKey)) {
        targets.push(subscriber);
      }
    }
    const results = await Promise.allSettled(
      targets.map((target) => this.deps.trace.runWithMessage(msg, async () => target.handler(msg))),
    );
    for (const result of results) {
      if (result.status === 'rejected') this.deps.onError?.(result.reason, msg);
    }
  }

  private matches(subscriber: Subscriber, routingKey: string): boolean {
    return subscriber.match !== undefined ? subscriber.match(routingKey) : true;
  }
}
