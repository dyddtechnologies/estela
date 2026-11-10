import { ChannelRegistry } from '../channel-registry';
import type { CareEvent } from '../resilience/resilience.types';
import { DEFAULT_CARE_EVENTS_CHANNEL } from '../resilience/runtime';

/**
 * Collects the care events published on the events channel (RS-47). Pass the module's
 * `ChannelRegistry` (or a testing module whose `get(ChannelRegistry)` returns it).
 */
export function collectCareEvents(
  source: ChannelRegistry | { get(token: typeof ChannelRegistry): unknown },
  channel = DEFAULT_CARE_EVENTS_CHANNEL,
): { events: CareEvent[]; types(): string[]; unsubscribe(): void } {
  const registry =
    source instanceof ChannelRegistry ? source : (source.get(ChannelRegistry) as ChannelRegistry);
  const events: CareEvent[] = [];
  const unsubscribe = registry.get(channel).subscribe((msg) => {
    events.push(msg.payload as CareEvent);
  });
  return { events, types: () => events.map((event) => event.type), unsubscribe };
}
