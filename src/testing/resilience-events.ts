import { ChannelRegistry } from '../channel-registry';
import type { ResilienceEvent } from '../resilience/resilience.types';
import { DEFAULT_RESILIENCE_EVENTS_CHANNEL } from '../resilience/runtime';

/**
 * Collects the resilience events published on the events channel (RS-47). Pass the module's
 * `ChannelRegistry` (or a testing module whose `get(ChannelRegistry)` returns it).
 */
export function collectResilienceEvents(
  source: ChannelRegistry | { get(token: typeof ChannelRegistry): unknown },
  channel = DEFAULT_RESILIENCE_EVENTS_CHANNEL,
): { events: ResilienceEvent[]; types(): string[]; unsubscribe(): void } {
  const registry =
    source instanceof ChannelRegistry ? source : (source.get(ChannelRegistry) as ChannelRegistry);
  const events: ResilienceEvent[] = [];
  const unsubscribe = registry.get(channel).subscribe((msg) => {
    events.push(msg.payload as ResilienceEvent);
  });
  return { events, types: () => events.map((event) => event.type), unsubscribe };
}
