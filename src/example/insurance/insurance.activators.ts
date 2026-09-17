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

type CancelStep = 'save-db' | 'email' | 'billing' | 'audit' | 'policy-log';

/**
 * Cancel-policy chain (activator-chain example mode): each activator forwards
 * the same message (`sendMessage` keeps replyChannel/trace). Last-step return
 * auto-replies. `failAt` on the payload is a demo hook to exercise the error flow.
 */
@Injectable()
export class CancelPolicyActivators {
  executed: string[] = [];
  saved: Record<string, unknown>[] = [];
  emails: Record<string, unknown>[] = [];
  billingQueued: Record<string, unknown>[] = [];
  audits: Record<string, unknown>[] = [];
  logs: Record<string, unknown>[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  private asRecord(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : { value: payload };
  }

  private async forward(channel: string, msg: IntegrationMessage): Promise<void> {
    this.executed.push(channel);
    await this.registry.sendMessage(channel, msg);
  }

  private async reportError(
    step: CancelStep,
    msg: IntegrationMessage,
    error: unknown,
  ): Promise<void> {
    const payload = this.asRecord(msg.payload);
    await this.registry.send('insurance.policies.cancel.errors', {
      step,
      policyId: payload.policyId,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
  }

  private async maybeFail(
    step: CancelStep,
    payload: unknown,
    msg: IntegrationMessage,
  ): Promise<void> {
    if (this.asRecord(payload).failAt !== step) return;
    const error = new Error(`cancel ${step} failed`);
    await this.reportError(step, msg, error);
    throw error;
  }

  @ServiceActivator('insurance.policies.cancel.s1.save-db')
  async saveDb(payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.maybeFail('save-db', payload, msg);
    const saved = { ...this.asRecord(payload), status: 'CANCELLED' };
    this.saved.push(saved);
    await this.forward('insurance.policies.cancel.s2.email', { ...msg, payload: saved });
  }

  @ServiceActivator('insurance.policies.cancel.s2.email')
  async sendEmail(payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.maybeFail('email', payload, msg);
    this.emails.push(this.asRecord(payload));
    await this.forward('insurance.policies.cancel.s3.enqueue-billing', msg);
  }

  @ServiceActivator('insurance.policies.cancel.s3.enqueue-billing')
  async enqueueBilling(payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.maybeFail('billing', payload, msg);
    await this.registry.send('insurance.policies.cancel.billing', payload);
    await this.forward('insurance.policies.cancel.s4.audit', msg);
  }

  @ServiceActivator('insurance.policies.cancel.billing')
  onBillingQueue(payload: unknown): void {
    this.billingQueued.push(this.asRecord(payload));
  }

  @ServiceActivator('insurance.policies.cancel.s4.audit')
  async saveAudit(payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.maybeFail('audit', payload, msg);
    this.audits.push(this.asRecord(payload));
    await this.forward('insurance.policies.cancel.s5.policy-log', msg);
  }

  @ServiceActivator('insurance.policies.cancel.s5.policy-log')
  async savePolicyLog(payload: unknown, msg: IntegrationMessage): Promise<unknown> {
    await this.maybeFail('policy-log', payload, msg);
    const response = { ...this.asRecord(payload), status: 'CANCELLED' };
    this.logs.push(response);
    this.executed.push('insurance.policies.cancel.done');
    return response;
  }
}

@Injectable()
export class CancelPolicyErrorActivators {
  routed: { step: string; payload: unknown }[] = [];

  private record(step: string, payload: unknown): void {
    this.routed.push({ step, payload });
  }

  @ServiceActivator('insurance.policies.cancel.errors.save-db')
  onSaveDb(payload: unknown): void {
    this.record('save-db', payload);
  }

  @ServiceActivator('insurance.policies.cancel.errors.email')
  onEmail(payload: unknown): void {
    this.record('email', payload);
  }

  @ServiceActivator('insurance.policies.cancel.errors.billing')
  onBilling(payload: unknown): void {
    this.record('billing', payload);
  }

  @ServiceActivator('insurance.policies.cancel.errors.audit')
  onAudit(payload: unknown): void {
    this.record('audit', payload);
  }

  @ServiceActivator('insurance.policies.cancel.errors.policy-log')
  onPolicyLog(payload: unknown): void {
    this.record('policy-log', payload);
  }

  @ServiceActivator('insurance.policies.cancel.errors.generic')
  onGeneric(payload: unknown): void {
    this.record('generic', payload);
  }
}
