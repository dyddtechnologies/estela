import 'reflect-metadata';

import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { lastValueFrom, of } from 'rxjs';
import { ChannelRegistry } from '../channel-registry';
import { IntegrationFlow, type FlowDefinition } from '../flow/integration-flow';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import type { IntegrationMessage } from '../message';
import { TrailOutput } from '../sensitive/privacy-engine';
import { captureTrail, type TrailCapture } from '../testing/capture-trail';
import { expectNoLeak } from '../testing/expect-no-leak';
import { INBOUND_DEPS, InboundInterceptor } from './inbound.interceptor';
import { INBOUND_SPEC_METADATA, type InboundSpec } from './inbound.types';

const PARTNER = 'CANARYPARTNER0042';
const BEARER = 'CANARYBEARER0043';

const SPEC: InboundSpec = {
  channel: 'in',
  transport: 'rest',
  carryHeaders: { 'x-partner-token': 'partnerRef', 'x-organization-id': 'organizationId' },
};

/** Header values the flow handler received (the delivered message, never hidden). */
const handled: unknown[] = [];

const TapFlow: FlowDefinition = {
  name: 'carried',
  build: () =>
    IntegrationFlow.from('in')
      .wireTap('audit', { id: 'audit' })
      .handle(
        (payload, msg) => {
          handled.push(msg.headers.partnerRef);
          throw new Error(`refused ${JSON.stringify(payload)}`);
        },
        { id: 'refuse' },
      ),
};

async function boot(options: Partial<IntegrationModuleOptions>): Promise<TestingModule> {
  const mod = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot(
        {
          channels: [
            { name: 'in', type: 'direct' },
            { name: 'audit', type: 'pubsub' },
          ],
          logging: { hops: true, level: 'debug', banner: false },
          ...options,
        },
        [TapFlow],
      ),
    ],
  }).compile();
  await mod.init();
  return mod;
}

function restContext(headers: Record<string, unknown>): ExecutionContext {
  const handler = function handle(): void {};
  Reflect.defineMetadata(INBOUND_SPEC_METADATA, SPEC, handler);
  return {
    switchToHttp: () => ({ getRequest: () => ({ body: { n: 1 }, headers }) }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

async function receive(mod: TestingModule, capture: TrailCapture): Promise<IntegrationMessage[]> {
  const delivered: IntegrationMessage[] = [];
  mod
    .get(ChannelRegistry)
    .get('audit')
    .subscribe((msg) => {
      delivered.push(msg);
    });
  capture.channel(mod.get(ChannelRegistry), 'audit');
  capture.channel(mod.get(ChannelRegistry), 'error.channel');
  const interceptor = new InboundInterceptor(mod.get(INBOUND_DEPS));
  const next: CallHandler = { handle: () => of(undefined) };
  const spies = (['log', 'debug', 'verbose', 'warn', 'error'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      capture.logger[level]?.(args[0]);
    }),
  );
  const context = restContext({
    'X-Partner-Token': PARTNER,
    'x-organization-id': 'org-acme',
    authorization: `Bearer ${BEARER}`,
  });
  await lastValueFrom(await interceptor.intercept(context, next)).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  for (const spy of spies) spy.mockRestore();
  return delivered;
}

describe('inbound carryHeaders under privacy (SPI-448 gap headers, SD-27)', () => {
  it('carried transport headers pass the privacy header rules on every trail output', async () => {
    const mod = await boot({ privacy: { headers: ['partnerRef'] } });
    const capture = captureTrail();
    const delivered = await receive(mod, capture);
    const tap = capture.writes.find((w) => w.where === 'channel audit');
    expect(tap?.text).toContain('[HIDDEN:header]');
    // A carried header no rule names stays visible: the rules hide by name, not by origin.
    expect(tap?.text).toContain('org-acme');
    expect(capture.writes.some((w) => w.where === 'channel error.channel')).toBe(true);
    expect(capture.writes.some((w) => w.output === TrailOutput.Log)).toBe(true);
    expectNoLeak(capture, [PARTNER, BEARER]);
    expect(delivered[0]?.headers.partnerRef).toBe('[HIDDEN:header]');
    // Only the trail is hidden: the flow handler gets the real value (SD-02).
    expect(handled.at(-1)).toBe(PARTNER);
    await mod.close();
  });

  it('compat: without privacy the tap copy keeps the carried header values', async () => {
    const mod = await boot({});
    const capture = captureTrail();
    const delivered = await receive(mod, capture);
    expect(delivered[0]?.headers.partnerRef).toBe(PARTNER);
    expect(delivered[0]?.headers.organizationId).toBe('org-acme');
    expect(handled.at(-1)).toBe(PARTNER);
    await mod.close();
  });
});
