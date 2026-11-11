import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { bindGrpcOut } from '../adapters/grpc.adapter';
import { ChannelRegistry } from '../channel-registry';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { PrivacyEngine } from '../sensitive/privacy-engine';
import { PrivacyConfigError } from '../sensitive/privacy-errors';
import { Pack, type PrivacyModuleOptions } from '../sensitive/privacy.types';
import { TraceContext } from '../trace/trace-context';
import { OutboundRestGateway } from './outbound-rest.gateway';
import { OutboundRest } from './outbound.decorators';
import type { OutboundFetch, OutboundModuleOptions, OutboundRestTarget } from './outbound.types';

const PROFILES: PrivacyModuleOptions = {
  profiles: {
    personal: { packs: [Pack.PersonalV1] },
    card: { fields: ['**.pan'] },
    tenant: { fields: ['**.tenantId'] },
  },
};

@Injectable()
class CrmTargets {
  @OutboundRest({ channel: 'crm.lookup', method: 'GET', privacy: 'card' })
  lookup(payload: { id: string }): OutboundRestTarget {
    return { url: `https://crm.example/items/${payload.id}` };
  }
}

@Injectable()
class MissingTargets {
  @OutboundRest({ channel: 'crm.lookup', method: 'GET', privacy: 'missing-annotated' })
  lookup(): OutboundRestTarget {
    return { url: 'https://crm.example/items' };
  }
}

function codes(error: unknown): string[] {
  expect(error).toBeInstanceOf(PrivacyConfigError);
  return (error as PrivacyConfigError).findings.map((finding) => finding.code);
}

describe('SPI-433 outbound bindings and call-level privacy (SD-56, SD-64)', () => {
  const closers: (() => Promise<void>)[] = [];
  const sent: string[] = [];

  const fetchFn: OutboundFetch = async (url) => {
    sent.push(url);
    return {
      ok: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: async () => '{"ok":true}',
    };
  };

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  async function boot(
    options: Partial<IntegrationModuleOptions>,
    providers: (new (...args: never[]) => unknown)[] = [],
  ): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot({
          channels: [{ name: 'crm.lookup', type: 'direct' }],
          ...options,
        }),
      ],
      providers,
    }).compile();
    await moduleRef.init();
    closers.push(() => moduleRef.close());
    return moduleRef;
  }

  const crmOutbound = (privacy?: unknown): OutboundModuleOptions => ({
    rest: {
      defaults: { fetchFn },
      bindings: [
        {
          name: 'crm',
          url: 'https://crm.example/customers',
          ...(privacy === undefined ? {} : { privacy: privacy as 'card' }),
        },
      ],
    },
  });

  it('call-level privacy names are validated before the request is sent', async () => {
    const moduleRef = await boot({ privacy: PROFILES, outbound: crmOutbound() });
    const gateway = moduleRef.get(OutboundRestGateway);
    const message = { payload: { id: 'c-1' } };

    const unknown = await gateway
      .request('crm', message, { privacy: 'nope' })
      .catch((error: unknown) => error);
    expect(codes(unknown)).toEqual(['UNKNOWN_PROFILE']);
    expect((unknown as Error).message).toContain("outbound rest 'crm' call");
    expect(sent).toEqual([]);

    // A refused reference is never remembered as valid: the next call fails the same way.
    const again = await gateway
      .request('crm', message, { privacy: 'nope' })
      .catch((error: unknown) => error);
    expect(codes(again)).toEqual(['UNKNOWN_PROFILE']);

    const off = await gateway
      .request('crm', message, { privacy: false as never })
      .catch((error: unknown) => error);
    expect(codes(off)).toEqual(['PRIVACY_FALSE_BELOW_MODULE']);
    expect(sent).toEqual([]);

    const adHoc = await gateway
      .request({ url: 'https://crm.example/adhoc', fetchFn }, message, {
        privacy: ['personal', 'nope'],
      })
      .catch((error: unknown) => error);
    expect(codes(adHoc)).toEqual(['UNKNOWN_PROFILE']);
    expect(sent).toEqual([]);

    await gateway.request('crm', message, { privacy: 'personal' });
    await gateway.request('crm', message, { privacy: ['personal', 'card'] });
    await gateway.request('crm', message, { privacy: { use: 'card', fields: ['**.ssn'] } });
    expect(sent).toHaveLength(3);
  });

  it('SD-56 a call reference under forRoot({ privacy: false }) fails its first call', async () => {
    const moduleRef = await boot({ privacy: false, outbound: crmOutbound() });
    const gateway = moduleRef.get(OutboundRestGateway);
    const error = await gateway
      .request('crm', { payload: {} }, { privacy: { fields: ['x'] } })
      .catch((caught: unknown) => caught);
    expect(codes(error)).toEqual(['PRIVACY_OFF_WITH_REFS']);
    expect(sent).toEqual([]);
    // A call without a reference keeps 0.9.0 behaviour.
    await gateway.request('crm', { payload: {} });
    expect(sent).toHaveLength(1);
  });

  it('SD-64 a binding scope unions module, bound channel, defaults and binding by name', async () => {
    const moduleRef = await boot(
      {
        channels: [{ name: 'crm.lookup', type: 'direct', privacy: 'tenant' }],
        privacy: PROFILES,
        outbound: { rest: { defaults: { fetchFn, privacy: 'personal' } } },
      },
      [CrmTargets],
    );
    const engine = moduleRef.get(PrivacyEngine);
    const names = engine.planOfScope('outbound:crm.lookup')?.names ?? [];
    expect(names).toEqual(expect.arrayContaining(['tenant', 'personal', 'card']));
    // The binding still delivers channel messages as before.
    const registry = moduleRef.get(ChannelRegistry);
    await registry.send('crm.lookup', { id: '7' });
    expect(sent).toEqual(['https://crm.example/items/7']);
  });

  it('SD-64 an unknown profile on a binding fails boot before any binding is subscribed', async () => {
    const error = await boot({ privacy: PROFILES, outbound: crmOutbound('missing-declared') }, [
      MissingTargets,
    ]).catch((caught: unknown) => caught);
    expect(codes(error)).toEqual(['UNKNOWN_PROFILE', 'UNKNOWN_PROFILE']);
    const message = (error as Error).message;
    expect(message).toContain("outbound rest 'crm'");
    expect(message).toContain("outbound rest 'crm.lookup'");
  });

  it('SD-64 a standalone gateway validates binding references when the binding is declared', async () => {
    const gateway = new OutboundRestGateway({ fetchFn, trace: new TraceContext() });
    expect(() =>
      gateway.bind({ name: 'crm', url: 'https://crm.example/x', privacy: 'nope' }),
    ).toThrow(PrivacyConfigError);
    expect(gateway.bindings()).toEqual([]);
    gateway.bind({ name: 'crm', url: 'https://crm.example/x', privacy: { fields: ['**.pan'] } });
    await gateway.request('crm', { payload: { pan: '4111111111111111' } });
    expect(sent).toEqual(['https://crm.example/x']);
  });

  it('SD-64 bindGrpcOut accepts a privacy reference and keeps its delivery', async () => {
    const moduleRef = await boot({ privacy: PROFILES });
    const registry = moduleRef.get(ChannelRegistry);
    registry.create({ name: 'grpc.out', type: 'direct' });
    const payloads: unknown[] = [];
    const stop = bindGrpcOut(
      registry,
      'grpc.out',
      (payload) => {
        payloads.push(payload);
        return undefined;
      },
      { privacy: 'personal' },
    );
    await registry.send('grpc.out', { email: 'a@example.com' });
    stop();
    expect(payloads).toEqual([{ email: 'a@example.com' }]);
  });
});
