/**
 * Keeps the README "Privacy" section true (spec section 11): the PCI checkout and WhatsApp examples
 * run here with the README's options, and the trail lines the README prints are asserted verbatim.
 * A README edit that changes an example or a trail line must change this spec too.
 */
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from '../src/channel-registry';
import { IntegrationFlow, type FlowDefinition } from '../src/flow/integration-flow';
import { IntegrationModule, type IntegrationModuleOptions } from '../src/integration.module';
import type { IntegrationMessage } from '../src/message';
import { envFingerprintSecret } from '../src/sensitive/fingerprint-secret';
import { PrivacyEngine } from '../src/sensitive/privacy-engine';
import { Pack, Show } from '../src/sensitive/privacy.types';
import type { SealKey, SealKeyProvider } from '../src/sensitive/seal-key';

// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path under the repo root
const README = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');

const FP_ENV = {
  ESTELA_FP_SECRET: randomBytes(32).toString('base64'),
  ESTELA_FP_SECRET_ID: 'k1',
};

const sealKey: SealKey = { id: 'kms-1', key: randomBytes(32) };
const kmsSealKeys: SealKeyProvider = {
  current: () => Promise.resolve(sealKey),
  byId: (id) => Promise.resolve(id === sealKey.id ? sealKey : undefined),
};

async function boot(
  options: IntegrationModuleOptions,
  flows: FlowDefinition[],
): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [IntegrationModule.forRoot(options, flows)],
  }).compile();
  await mod.init();
  return mod;
}

function tapPayloads(registry: ChannelRegistry, channel: string): unknown[] {
  const seen: unknown[] = [];
  registry.get(channel).subscribe((msg: IntegrationMessage) => {
    seen.push(msg.payload);
  });
  return seen;
}

describe('README Privacy section examples (spec section 11)', () => {
  it('README PCI example: the audit copy shows the last 4 of the card and drops the cvv', async () => {
    const mod = await boot(
      {
        privacy: {
          packs: [Pack.SecretsV1],
          fingerprintSecret: envFingerprintSecret(
            'ESTELA_FP_SECRET',
            'ESTELA_FP_SECRET_ID',
            FP_ENV,
          ),
          sealKeys: kmsSealKeys,
          profiles: {
            card: {
              packs: [Pack.PersonalV1],
              fields: [
                { path: '**.pan', name: 'card.pan', show: Show.Ends, showLast: 4 },
                { path: '**.cvv', name: 'card.cvv', show: Show.Omitted },
                { path: '**.expiry', name: 'card.expiry' },
              ],
            },
          },
        },
        channels: [
          { name: 'checkout.pay', type: 'direct', privacy: 'card' },
          { name: 'psp.charges', type: 'direct', privacy: 'card' },
          { name: 'checkout.audit', type: 'pubsub' },
        ],
      },
      [
        {
          name: 'checkout',
          build: () =>
            IntegrationFlow.from('checkout.pay')
              .handle((order: unknown) => order, { id: 'price' })
              .wireTap('checkout.audit', { id: 'audit' })
              .to('psp.charges', { id: 'charge' }),
        },
      ],
    );
    const registry = mod.get(ChannelRegistry);
    const audit = tapPayloads(registry, 'checkout.audit');
    const charged: unknown[] = [];
    registry.get('psp.charges').subscribe((msg: IntegrationMessage) => {
      charged.push(msg.payload);
    });
    const order = { pan: '4111111111111111', cvv: '123', expiry: '12/29', token: 'tok_canary' };
    await registry.send('checkout.pay', order);

    const line = JSON.stringify(audit[0]);
    expect(line).toBe(
      '{"pan":"***1111","expiry":"[HIDDEN:card.expiry]","token":"[HIDDEN:secrets.keys]"}',
    );
    expect(README).toContain(`Trail line: \`${line}\``);
    // The PSP receives the real order: only the trail is hidden.
    expect(charged).toEqual([order]);
    await mod.close();
  });

  it('README WhatsApp example: customer numbers are fingerprinted, our sender shows its ends', async () => {
    const options = (env: Record<string, string | undefined>): IntegrationModuleOptions => ({
      privacy: {
        packs: [Pack.SecretsV1, Pack.PersonalV1],
        fingerprintSecret: envFingerprintSecret('ESTELA_FP_SECRET', 'ESTELA_FP_SECRET_ID', env),
        profiles: {
          'wa-customer': {
            fields: [
              { path: '**.contacts[*].wa_id', name: 'wa.customer', show: Show.Fingerprint },
              { path: '**.messages[*].from', name: 'wa.customer', show: Show.Fingerprint },
              { path: '**.contacts[*].profile.name', name: 'wa.name' },
            ],
            exempt: [
              {
                path: '**.metadata.display_phone_number',
                show: Show.Ends,
                reason: 'our own WhatsApp sender number',
              },
            ],
          },
        },
      },
      channels: [
        { name: 'wa.inbound', type: 'direct', privacy: 'wa-customer' },
        { name: 'wa.audit', type: 'pubsub' },
        { name: 'wa.agent-inbox', type: 'pubsub' },
        { name: 'wa.analytics', type: 'pubsub' },
      ],
    });
    const flow: FlowDefinition = {
      name: 'wa-inbound',
      build: () =>
        IntegrationFlow.from('wa.inbound')
          .wireTap('wa.audit', { id: 'audit' })
          .fanoutTo([{ channel: 'wa.agent-inbox' }, { channel: 'wa.analytics', wait: false }], {
            id: 'spread',
          }),
    };
    const webhook = {
      metadata: { display_phone_number: '+50255512678' },
      contacts: [{ wa_id: '50255501234', profile: { name: 'Ana Canary' } }],
      messages: [{ from: '50255501234', text: { body: 'hola' } }],
    };

    const mod = await boot(options(FP_ENV), [flow]);
    const audit = tapPayloads(mod.get(ChannelRegistry), 'wa.audit');
    const inbox = tapPayloads(mod.get(ChannelRegistry), 'wa.agent-inbox');
    await mod.get(ChannelRegistry).send('wa.inbound', webhook);
    const copy = audit[0] as typeof webhook;
    expect(copy.messages[0]?.from).toMatch(/^fp:k1:[0-9a-f]{16}$/);
    expect(copy.contacts[0]?.wa_id).toBe(copy.messages[0]?.from);
    expect(copy.metadata.display_phone_number).toBe('***2678');
    expect(copy.contacts[0]?.profile.name).toBe('[HIDDEN:wa.name]');
    expect(copy.messages[0]?.text.body).toBe('hola');
    expect(inbox).toEqual([webhook]);
    expect(README).toContain('`display_phone_number: "***2678"`');
    expect(README).toContain('`name: "[HIDDEN:wa.name]"`');

    // A new fingerprint secret changes every token (R14).
    const before = copy.messages[0]?.from;
    FP_ENV.ESTELA_FP_SECRET = randomBytes(32).toString('base64');
    await mod.get(PrivacyEngine).refreshFingerprintSecret();
    await mod.get(ChannelRegistry).send('wa.inbound', webhook);
    expect((audit[1] as typeof webhook).messages[0]?.from).not.toBe(before);
    await mod.close();

    // Without a fingerprint secret, the explicit Show.Fingerprint rules fail boot (D8).
    const noSecret = options({});
    if (noSecret.privacy) delete noSecret.privacy.fingerprintSecret;
    await expect(boot(noSecret, [flow])).rejects.toMatchObject({ kind: 'config' });
    expect(README).toContain('FINGERPRINT_WITHOUT_SECRET');
  });
});
