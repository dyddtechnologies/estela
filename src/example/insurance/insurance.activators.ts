import { Injectable } from '@nestjs/common';
import { ServiceActivator } from '../../decorators';
import type { IntegrationMessage } from '../../message';
import { ChannelRegistry } from '../../channel-registry';

/**
 * Skeleton 1:1 de `quote.service.create()` (ms-asg-core, 5804 lines -> 12 steps).
 * Cada activator = un STEP_N del original. Logica real: pending de migration.
 * Los steps intermedios forward el Same message (`sendMessage` preserves
 * replyChannel/trace); el step terminal retorna -> auto-reply al HTTP (spec sec.7.1).
 */
@Injectable()
export class QuoteCreationActivators {
  executed: string[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  private async forward(channel: string, msg: IntegrationMessage): Promise<void> {
    this.executed.push(channel);
    await this.registry.sendMessage(channel, msg);
  }

  /** STEP_1 — ms-asg-core: `validateQuoteRules(dto, clientId, authorization)`. */
  @ServiceActivator('insurance.quotes.s1.validate-rules')
  async s1ValidateRules(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s2.content-validate', msg);
  }

  /** STEP_2 — ms-asg-core: `quoteHandlerService.validate(contentType, contentMap)` (solo si contentType). */
  @ServiceActivator('insurance.quotes.s2.content-validate')
  async s2ContentValidate(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s3.person-upsert', msg);
  }

  /** STEP_3 — ms-asg-core: `creteOrUpdatePerson(dto, validations, authorization)`. */
  @ServiceActivator('insurance.quotes.s3.person-upsert')
  async s3PersonUpsert(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s4.quote-record', msg);
  }

  /** STEP_4 — ms-asg-core: `createQuote(dto, clientId, authorization)` + `createQuoteStepAudit()`. */
  @ServiceActivator('insurance.quotes.s4.quote-record')
  async s4QuoteRecord(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s5.content-handler', msg);
  }

  /** STEP_5 — ms-asg-core: `quoteHandlerService.handle(contentType, contentMap, CREATE)` (external, flag). */
  @ServiceActivator('insurance.quotes.s5.content-handler')
  async s5ContentHandler(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s6.contractor', msg);
  }

  /** STEP_6 — ms-asg-core: `createContractor(personId, quoteId, createdBy)` + audit. */
  @ServiceActivator('insurance.quotes.s6.contractor')
  async s6Contractor(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s7.insured', msg);
  }

  /** STEP_7 — ms-asg-core: `createInsured(...)` condicional (`defaultMainInsured !== false`). */
  @ServiceActivator('insurance.quotes.s7.insured')
  async s7Insured(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s8.merge-response', msg);
  }

  /** STEP_8 — ms-asg-core: `createResponse(person, quote, contractor, insured, contentMap)`. */
  @ServiceActivator('insurance.quotes.s8.merge-response')
  async s8MergeResponse(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s9.finalizer', msg);
  }

  /** STEP_9 — ms-asg-core: `finalizerService.execute(merged, QUOTE_FINALIZER_TARGET, ...)` (FAILED -> throw). */
  @ServiceActivator('insurance.quotes.s9.finalizer')
  async s9Finalizer(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s10.finalizer-status', msg);
  }

  /** STEP_10 — ms-asg-core: `saveFinalizerStatus(responseFinalizer, quoteId)` + audit. */
  @ServiceActivator('insurance.quotes.s10.finalizer-status')
  async s10FinalizerStatus(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s11.price', msg);
  }

  /** STEP_11 — ms-asg-core: `planService.getPrice(...)` por edad; **precio 0 -> softDelete + throw**. */
  @ServiceActivator('insurance.quotes.s11.price')
  async s11Price(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.quotes.s12.update-price', msg);
  }

  /** STEP_12 — ms-asg-core: `updatePrice(merged.id, lastPrice)`. Terminal: publishes + auto-reply HTTP. */
  @ServiceActivator('insurance.quotes.s12.update-price')
  async s12UpdatePrice(payload: unknown, msg: IntegrationMessage): Promise<unknown> {
    const response = { ...(payload as Record<string, unknown>), status: 'QUOTED' };
    await this.registry.sendMessage('insurance.quotes.created', {
      ...msg,
      payload: response,
    });
    this.executed.push('insurance.quotes.created');
    return response;
  }
}

/**
 * Skeleton 1:1 de `policy.service.create()` (ms-asg-core, 2223 lines -> 6 blocks).
 */
@Injectable()
export class PolicyCreationActivators {
  executed: string[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  private async forward(channel: string, msg: IntegrationMessage): Promise<void> {
    this.executed.push(channel);
    await this.registry.sendMessage(channel, msg);
  }

  /** STEP_1/1B — ms-asg-core: `validateIfQuoteIsFailed()` + `validateApapVoucherNotDuplicated()`. */
  @ServiceActivator('insurance.policies.p1.validate-quote')
  async p1ValidateQuote(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.policies.p2.business-validations', msg);
  }

  /** STEP_2 — ms-asg-core: `businessValidations(dto, 'POLICY', true, ...)`. */
  @ServiceActivator('insurance.policies.p2.business-validations')
  async p2BusinessValidations(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.policies.p3.catalog-status', msg);
  }

  /** STEP_3 — ms-asg-core: `getActiveStatusPolicy(clientId)` (defaultStateId opcional). */
  @ServiceActivator('insurance.policies.p3.catalog-status')
  async p3CatalogStatus(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.policies.p4.quote-context', msg);
  }

  /** STEP_4/4A/4B/4C — findOne + no-existing-policy + main-insured + projectRules.validate(). */
  @ServiceActivator('insurance.policies.p4.quote-context')
  async p4QuoteContext(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.policies.p5.prepare-data', msg);
  }

  /** STEP_5 — ms-asg-core: preparar `quoteSimpleData` (flatten plan/paymentMode/client). */
  @ServiceActivator('insurance.policies.p5.prepare-data')
  async p5PrepareData(_payload: unknown, msg: IntegrationMessage): Promise<void> {
    await this.forward('insurance.policies.p6.policy-record', msg);
  }

  /** STEP_6+ — ms-asg-core: policy record + external services + billing. Terminal: auto-reply HTTP. */
  @ServiceActivator('insurance.policies.p6.policy-record')
  async p6PolicyRecord(payload: unknown, msg: IntegrationMessage): Promise<unknown> {
    const response = { ...(payload as Record<string, unknown>), status: 'POLICIED' };
    await this.registry.sendMessage('insurance.policies.created', {
      ...msg,
      payload: response,
    });
    this.executed.push('insurance.policies.created');
    return response;
  }
}
