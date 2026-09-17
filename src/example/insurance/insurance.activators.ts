import { Injectable } from '@nestjs/common';
import { PubSub, ServiceActivator } from '../../decorators';
import type { IntegrationMessage } from '../../message';
import { ChannelRegistry } from '../../channel-registry';

@Injectable()
export class QuoteRulesActivator {
  calls = 0;

  @ServiceActivator('insurance.quotes.validate-rules')
  validate(payload: unknown): string {
    this.calls += 1;
    return `rules-ok:${JSON.stringify(payload)}`;
  }
}

@Injectable()
export class QuotePriceActivator {
  calls = 0;

  @ServiceActivator('insurance.quotes.price')
  price(payload: unknown): string {
    this.calls += 1;
    return `priced:${JSON.stringify(payload)}`;
  }
}

@Injectable()
export class QuoteEventsCollector {
  seen: { routingKey?: unknown; payload: unknown }[] = [];

  @PubSub('insurance.quotes.created')
  onEvent(payload: unknown, msg: IntegrationMessage): void {
    this.seen.push({ routingKey: msg.headers.routingKey, payload });
  }
}

@Injectable()
export class QuotePersistence {
  persisted: Record<string, unknown>[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  /** sec.17.8: persist forwards to 'insurance.quotes.country' (direct 1-subscriber). */
  @ServiceActivator('insurance.quotes.persist')
  async persist(payload: unknown): Promise<void> {
    this.persisted.push(payload as Record<string, unknown>);
    await this.registry.send('insurance.quotes.country', payload);
  }
}

@Injectable()
export class PolicyValidateActivator {
  calls = 0;

  @ServiceActivator('insurance.policies.validate-quote')
  validate(payload: unknown): string {
    this.calls += 1;
    return `quote-ok:${JSON.stringify(payload)}`;
  }
}

@Injectable()
export class PolicyEventsCollector {
  seen: { routingKey?: unknown; payload: unknown }[] = [];

  @PubSub('insurance.policies.created')
  onEvent(payload: unknown, msg: IntegrationMessage): void {
    this.seen.push({ routingKey: msg.headers.routingKey, payload });
  }
}

@Injectable()
export class PolicyPersistence {
  persisted: Record<string, unknown>[] = [];

  @ServiceActivator('insurance.policies.persist')
  persist(payload: unknown): void {
    this.persisted.push(payload as Record<string, unknown>);
  }
}
