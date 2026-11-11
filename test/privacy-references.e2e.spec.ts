import 'reflect-metadata';

import {
  Body,
  Controller,
  Injectable,
  Logger,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ServiceActivator } from '../src/decorators';
import { MemoryIdempotencyStore } from '../src/idempotency/memory-idempotency.store';
import { InboundRest } from '../src/inbound/inbound.decorators';
import { IntegrationModule } from '../src/integration.module';
import { OutboundRest } from '../src/outbound/outbound.decorators';
import type { OutboundFetch, OutboundRestTarget } from '../src/outbound/outbound.types';
import { PrivacyEngine, TrailOutput } from '../src/sensitive/privacy-engine';
import { Pack, Remember } from '../src/sensitive/privacy.types';
import { captureTrail } from '../src/testing/capture-trail';
import { expectNoLeak } from '../src/testing/expect-no-leak';

const EMAIL = 'canary.reference@example.com';
const IDEM_KEY = 'idem-references-0001';

const capture = captureTrail();
const fetchFn: OutboundFetch = async () => ({
  ok: true,
  status: 200,
  headers: {},
  text: async () => '',
});

@Injectable()
class Contacts {
  @ServiceActivator('contact.lookup', { privacy: 'personal' })
  lookup(payload: { id: string }): unknown {
    return { id: payload.id, email: EMAIL };
  }

  @OutboundRest({ channel: 'crm.push', privacy: 'personal' })
  push(payload: { id: string }): OutboundRestTarget {
    return { url: `https://crm.example/contacts/${payload.id}` };
  }
}

@Controller()
class ContactApi {
  // No `privacy` of its own: the inbound defaults reach it by name.
  @Post('contacts')
  @InboundRest({
    channel: 'contact.lookup',
    requestReply: true,
    timeoutMs: 2000,
    idempotency: { remember: Remember.AsShown, onDuplicate: 'envelope' },
  })
  lookup(@Body() body: unknown): unknown {
    return body;
  }
}

@Module({
  imports: [
    IntegrationModule.forRoot({
      channels: [
        { name: 'contact.lookup', type: 'direct' },
        { name: 'crm.push', type: 'direct' },
      ],
      idempotency: { store: capture.store(new MemoryIdempotencyStore()) },
      logging: { banner: false },
      privacy: { profiles: { personal: { packs: [Pack.PersonalV1] } } },
      inbound: { privacy: 'personal' },
      outbound: { rest: { defaults: { fetchFn } } },
    }),
  ],
  controllers: [ContactApi],
  providers: [Contacts],
})
class ReferencesModule {}

describe('privacy references outside flows resolve by name (SD-64)', () => {
  let app: INestApplication | undefined;
  let url: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ReferencesModule] }).compile();
    app = moduleRef.createNestApplication({ logger: capture.logger });
    Logger.overrideLogger(capture.logger);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }, 20_000);

  afterAll(async () => {
    await app?.close();
  });

  it('inbound defaults, activator and binding references resolve by name', async () => {
    const response = await fetch(`${url}/contacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': IDEM_KEY },
      body: JSON.stringify({ id: 'c-1' }),
    });
    expect(response.status).toBe(201);
    // The caller's reply holds the email intact; only the stored record is hidden.
    expect(JSON.stringify(await response.json())).toContain(EMAIL);

    const stored = capture.writes.filter((write) => write.output === TrailOutput.Store);
    expect(stored.some((write) => write.text.includes('c-1'))).toBe(true);
    expect(stored.some((write) => write.text.includes('[HIDDEN:personal.email]'))).toBe(true);
    expectNoLeak(capture, [EMAIL]);

    const engine = app!.get(PrivacyEngine);
    for (const scope of [
      'inbound:contact.lookup',
      'activator:Contacts.lookup',
      'outbound:crm.push',
    ]) {
      expect(engine.planOfScope(scope)?.names).toContain('personal');
    }
    expect(engine.rememberOf('inbound:contact.lookup')).toBe(Remember.AsShown);
  }, 20_000);
});
