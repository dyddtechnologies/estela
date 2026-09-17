import { IntegrationFlow, type FlowDefinition } from '../../flow/integration-flow';
import type { ChannelSpec } from '../../channel-factory';

/**
 * Insurance example — same EIP shape as the README `PlaceOrderFlow`,
 * mapped onto quotes/policies. Flows talk to channels by name only.
 */
export const INSURANCE_CHANNELS: readonly ChannelSpec[] = [
  { name: 'insurance.quotes.create', type: 'direct' },
  { name: 'insurance.quotes.persist', type: 'direct' },
  { name: 'insurance.quotes.country', type: 'direct' },
  { name: 'insurance.quotes.audit', type: 'queue', capacity: 10_000 },
  { name: 'insurance.quotes.validate-rules', type: 'direct' },
  { name: 'insurance.quotes.price', type: 'direct' },
  { name: 'insurance.quotes.created', type: 'pubsub' },
  {
    name: 'insurance.ops.fanout',
    type: 'fanout',
    bindings: ['insurance.quotes.validate-rules', 'insurance.quotes.price'],
  },
  { name: 'insurance.quotes.local', type: 'queue' },
  { name: 'insurance.quotes.us', type: 'queue' },
  { name: 'insurance.quotes.intl', type: 'queue' },
  { name: 'insurance.policies.create', type: 'direct' },
  { name: 'insurance.policies.persist', type: 'direct' },
  { name: 'insurance.policies.validate-quote', type: 'direct' },
  { name: 'insurance.policies.created', type: 'pubsub' },
];

export const CreateQuoteFlow: FlowDefinition = {
  name: 'create-quote',
  build: () =>
    IntegrationFlow.from('insurance.quotes.create')
      .filter((payload) => {
        const cmd = payload as { planId?: string; numberId?: string };
        return typeof cmd.planId === 'string' && typeof cmd.numberId === 'string';
      })
      .transform((payload) => {
        const cmd = payload as {
          planId: string;
          numberId: string;
          dob?: string;
          country?: string;
        };
        return { quoteId: `qte-${cmd.planId}`, ...cmd, premium: 250 };
      })
      .wireTap('insurance.quotes.audit')
      .jumpTo([
        { channel: 'insurance.quotes.validate-rules', timeoutMs: 3_000 },
        { channel: 'insurance.quotes.price', timeoutMs: 3_000 },
      ])
      .publish('insurance.quotes.created', 'quote.created')
      .reply()
      .to('insurance.quotes.persist'),
};

export const CreatePolicyFlow: FlowDefinition = {
  name: 'create-policy',
  build: () =>
    IntegrationFlow.from('insurance.policies.create')
      .filter((payload) => typeof (payload as { quoteId?: string }).quoteId === 'string')
      .transform((payload) => {
        const cmd = payload as { quoteId: string };
        return { policyId: `pol-${cmd.quoteId}`, ...cmd, status: 'ISSUED' };
      })
      .jumpTo([{ channel: 'insurance.policies.validate-quote', timeoutMs: 3_000 }])
      .publish('insurance.policies.created', 'policy.created')
      .reply()
      .to('insurance.policies.persist'),
};

/** sec.17.8: persist activator forwards here — direct cannot be activator + flow source. */
export const RouteQuoteByCountryFlow: FlowDefinition = {
  name: 'route-quote-by-country',
  build: () =>
    IntegrationFlow.from('insurance.quotes.country').route((payload) => {
      const country = (payload as { country?: string }).country;
      if (country === 'GT') return 'insurance.quotes.local';
      if (country === 'US') return 'insurance.quotes.us';
      return 'insurance.quotes.intl';
    }),
};

export const INSURANCE_FLOWS: readonly FlowDefinition[] = [
  CreateQuoteFlow,
  CreatePolicyFlow,
  RouteQuoteByCountryFlow,
];
