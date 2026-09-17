import { IntegrationFlow, type FlowDefinition } from '../../flow/integration-flow';
import type { ChannelSpec } from '../../channel-factory';

/**
 * Esqueleto ESTELA del dominio SEGUROS (replica ms-asg-core):
 * `quote.service.create()` (12 pasos) y `policy.service.create()` (6 bloques).
 * Cada paso real de ms-asg-core mapea a un canal + activator esqueleto.
 */

export const INSURANCE_CHANNELS: readonly ChannelSpec[] = [
  // ---- Quote creation pipeline (quote.service.create §STEPS 1-12) ----
  { name: 'insurance.quotes.create', type: 'direct' }, // HTTP entry (requestReply)
  { name: 'insurance.quotes.s1.validate-rules', type: 'direct' }, // STEP_1 validateQuoteRules()
  { name: 'insurance.quotes.s2.content-validate', type: 'direct' }, // STEP_2 quoteHandlerService.validate()
  { name: 'insurance.quotes.s3.person-upsert', type: 'direct' }, // STEP_3 creteOrUpdatePerson()
  { name: 'insurance.quotes.s4.quote-record', type: 'direct' }, // STEP_4 createQuote() + stepAudit
  { name: 'insurance.quotes.s5.content-handler', type: 'direct' }, // STEP_5 quoteHandlerService.handle()
  { name: 'insurance.quotes.s6.contractor', type: 'direct' }, // STEP_6 createContractor()
  { name: 'insurance.quotes.s7.insured', type: 'direct' }, // STEP_7 createInsured() (condicional)
  { name: 'insurance.quotes.s8.merge-response', type: 'direct' }, // STEP_8 createResponse()
  { name: 'insurance.quotes.s9.finalizer', type: 'direct' }, // STEP_9 finalizerService.execute()
  { name: 'insurance.quotes.s10.finalizer-status', type: 'direct' }, // STEP_10 saveFinalizerStatus()
  { name: 'insurance.quotes.s11.price', type: 'direct' }, // STEP_11 planService.getPrice() (bloquea si 0)
  { name: 'insurance.quotes.s12.update-price', type: 'direct' }, // STEP_12 updatePrice() → created
  { name: 'insurance.quotes.created', type: 'pubsub' }, // evento de dominio: quote lista
  // ---- Policy creation pipeline (policy.service.create §STEPS 1-6) ----
  { name: 'insurance.policies.create', type: 'direct' }, // HTTP entry (requestReply)
  { name: 'insurance.policies.p1.validate-quote', type: 'direct' }, // STEP_1/1B quote no-failed + voucher
  { name: 'insurance.policies.p2.business-validations', type: 'direct' }, // STEP_2 businessValidations()
  { name: 'insurance.policies.p3.catalog-status', type: 'direct' }, // STEP_3 getActiveStatusPolicy()
  { name: 'insurance.policies.p4.quote-context', type: 'direct' }, // STEP_4/4A/4B/4C quote + rules
  { name: 'insurance.policies.p5.prepare-data', type: 'direct' }, // STEP_5 quoteSimpleData
  { name: 'insurance.policies.p6.policy-record', type: 'direct' }, // STEP_6+ record + external + billing
  { name: 'insurance.policies.created', type: 'pubsub' }, // evento de dominio: policy emitida
];

/** El entry delega al primer canal del pipeline; los activators encadenan el resto. */
export const CreateQuoteFlow: FlowDefinition = {
  name: 'create-quote',
  build: () =>
    IntegrationFlow.from('insurance.quotes.create').to('insurance.quotes.s1.validate-rules'),
};

export const CreatePolicyFlow: FlowDefinition = {
  name: 'create-policy',
  build: () =>
    IntegrationFlow.from('insurance.policies.create').to('insurance.policies.p1.validate-quote'),
};

export const INSURANCE_FLOWS: readonly FlowDefinition[] = [CreateQuoteFlow, CreatePolicyFlow];
