import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ChannelRegistry } from '../channel-registry';
import { ReplyGateway } from '../gateway/reply-gateway';
import { ChannelGraph } from '../graph/channel-graph';
import { IntegrationModule, type IntegrationModuleOptions } from '../integration.module';
import { saga } from '../saga/saga';
import { SagaRunner } from '../saga/saga-runner';
import { OutboundRestGateway } from './outbound-rest.gateway';
import { OutboundRest } from './outbound.decorators';
import { OutboundHttpError, type OutboundRestError } from './outbound.errors';
import type {
  OutboundCallContext,
  OutboundErrorMapper,
  OutboundFetch,
  OutboundFetchInit,
  OutboundKeyResolver,
  OutboundRestTarget,
} from './outbound.types';

interface PaymentCommand {
  tenantId: string;
  orderId: string;
  amount: number;
}

class PaymentRejectedError extends Error {
  constructor(
    readonly upstreamStatus: number,
    readonly detail: unknown,
  ) {
    super('payment rejected');
  }
}

@Injectable()
class PaymentErrors implements OutboundErrorMapper {
  mapError(error: OutboundRestError): unknown {
    return error instanceof OutboundHttpError
      ? new PaymentRejectedError(error.status, error.body)
      : error;
  }
}

@Injectable()
class PaymentKeys implements OutboundKeyResolver<PaymentCommand> {
  resolveKey({ payload }: OutboundCallContext<PaymentCommand>): (string | number)[] {
    return ['pay', payload.tenantId, payload.orderId];
  }
}

@Injectable()
class CatalogTargets {
  readonly base = 'https://catalog.example';

  @OutboundRest({ channel: 'catalog.lookup', method: 'GET', response: 'body' })
  lookup(payload: { sku: string }): OutboundRestTarget {
    return { url: `${this.base}/items/${payload.sku}`, query: { fields: ['price', 'stock'] } };
  }
}

@Injectable()
class CheckoutService {
  constructor(readonly outbound: OutboundRestGateway) {}
}

describe('IntegrationModule: outbound REST bindings', () => {
  const closers: (() => Promise<void>)[] = [];
  const calls: { url: string; init: OutboundFetchInit }[] = [];
  let status = 200;
  let log: jest.SpyInstance;

  const fetchFn: OutboundFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status < 300,
      status,
      headers: { 'content-type': 'application/json' },
      text: async () => JSON.stringify(status < 300 ? { ok: true, url } : { reason: 'declined' }),
    };
  };

  const channels: IntegrationModuleOptions['channels'] = [
    { name: 'payments.http', type: 'direct' },
    { name: 'catalog.lookup', type: 'direct' },
  ];

  const outbound: IntegrationModuleOptions['outbound'] = {
    rest: {
      defaults: { fetchFn, timeoutMs: 2000, headers: { 'x-app': 'checkout' } },
      bindings: [
        {
          channel: 'payments.http',
          url: 'https://pay.example/charges?apiKey=s3cret',
          idempotency: { header: 'X-Idempotency-Key', key: { useExisting: PaymentKeys } },
          mapError: { useExisting: PaymentErrors },
        },
        { name: 'audit', url: 'https://audit.example/events', response: 'body' },
      ],
    },
  };

  const boot = async (options: IntegrationModuleOptions): Promise<TestingModule> => {
    const module = await Test.createTestingModule({
      imports: [IntegrationModule.forRoot(options)],
      providers: [PaymentErrors, PaymentKeys, CatalogTargets, CheckoutService],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    closers.push(() => app.close());
    return module;
  };

  const lines = (prefix: string): string[] =>
    log.mock.calls.map(([message]) => String(message)).filter((line) => line.startsWith(prefix));

  beforeEach(() => {
    calls.length = 0;
    status = 200;
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    jest.restoreAllMocks();
  });

  it('logs one boot line per declared binding and records channel bindings in the graph', async () => {
    const module = await boot({ channels, outbound });
    expect(lines('outbound ')).toEqual([
      'outbound rest: payments.http -> POST https://pay.example/charges',
      'outbound rest: audit -> POST https://audit.example/events',
      'outbound rest: catalog.lookup -> dynamic',
    ]);
    const snapshot = module.get(ChannelGraph).snapshot(module.get(ChannelRegistry));
    expect(snapshot.nodes.find((node) => node.channel === 'payments.http')?.outbounds).toEqual([
      { transport: 'rest', target: 'POST https://pay.example/charges' },
    ]);
    expect(snapshot.nodes.find((node) => node.channel === 'catalog.lookup')?.outbounds).toEqual([
      { transport: 'rest', target: 'dynamic' },
    ]);
    expect(snapshot.edges.filter((edge) => edge.via === 'outbound')).toEqual([
      { from: 'payments.http', to: 'outbound:rest', via: 'outbound' },
      { from: 'catalog.lookup', to: 'outbound:rest', via: 'outbound' },
    ]);
    expect(snapshot.mermaid).not.toContain('s3cret');
    expect(snapshot.mermaid).not.toContain('audit');
  });

  it('delivers a channel message as an HTTP call with DI strategies and module defaults', async () => {
    const module = await boot({ channels, outbound });
    const reply = await module
      .get(ReplyGateway)
      .sendAndReceive('payments.http', { tenantId: 't-1', orderId: 'o-7', amount: 10 });
    expect(reply).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { ok: true, url: 'https://pay.example/charges?apiKey=s3cret' },
    });
    expect(calls[0]?.init.headers['X-Idempotency-Key']).toBe('pay:t-1:o-7');
    expect(calls[0]?.init.headers['x-app']).toBe('checkout');
    expect(calls[0]?.init.body).toBe('{"tenantId":"t-1","orderId":"o-7","amount":10}');
  });

  it('an @OutboundRest method resolves the target of each message', async () => {
    const module = await boot({ channels, outbound });
    const reply = await module.get(ReplyGateway).sendAndReceive('catalog.lookup', { sku: 'A-1' });
    expect(calls[0]?.url).toBe('https://catalog.example/items/A-1?fields=price&fields=stock');
    expect(calls[0]?.init.method).toBe('GET');
    expect(reply).toEqual({ ok: true, url: calls[0]?.url });
  });

  it('injects the gateway: a saga outbound step calls a declared binding and maps its failure', async () => {
    const module = await boot({ channels, outbound });
    const { outbound: gateway } = module.get(CheckoutService);
    expect(gateway).toBe(module.get(OutboundRestGateway));

    interface Ctx {
      command: PaymentCommand;
      charge?: unknown;
      compensated?: boolean;
    }
    const checkout = saga<Ctx, null, unknown>('checkout')
      .outbound(
        'charge',
        async (ctx) => {
          ctx.charge = await gateway.request('payments.http', { payload: ctx.command });
        },
        {
          compensate: (ctx) => {
            ctx.compensated = true;
          },
        },
      )
      .reply((ctx) => ctx.charge);
    const runner = new SagaRunner<null>({ transactions: { run: (work) => work(null) } });
    const command = { tenantId: 't-2', orderId: 'o-9', amount: 5 };

    const charged = await runner.run(checkout, { command });
    expect(charged).toMatchObject({ status: 200 });

    status = 402;
    const failed: Ctx = { command };
    const error: unknown = await runner.run(checkout, failed).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentRejectedError);
    expect((error as PaymentRejectedError).upstreamStatus).toBe(402);
    expect((error as PaymentRejectedError).detail).toEqual({ reason: 'declined' });
    expect(failed.compensated).toBe(true);
    expect(calls.map((call) => call.init.headers['X-Idempotency-Key'])).toEqual([
      'pay:t-2:o-9',
      'pay:t-2:o-9',
    ]);
  });

  it('logs outbound hops when logging.hops is on, without query values', async () => {
    const module = await boot({ channels, outbound, logging: { hops: true, banner: false } });
    await module.get(OutboundRestGateway).request('audit', { payload: { event: 'x' } });
    await module.get(ReplyGateway).sendAndReceive('payments.http', {
      tenantId: 't',
      orderId: 'o',
      amount: 1,
    });
    const hops = [...lines('→ hop'), ...lines('← hop')].join('\n');
    expect(hops).toContain('→ hop audit outbound:rest POST https://audit.example/events');
    expect(hops).toContain('← hop payments.http outbound:rest POST https://pay.example/charges ok');
    expect(hops).not.toContain('s3cret');
  });

  it('logs no hop by default', async () => {
    const module = await boot({ channels, outbound });
    await module.get(OutboundRestGateway).request('audit', { payload: 1 });
    expect(lines('→ hop')).toEqual([]);
  });

  it('without outbound options only the annotated bindings exist and the gateway is injectable', async () => {
    const module = await boot({ channels });
    expect(lines('outbound ')).toEqual(['outbound rest: catalog.lookup -> dynamic']);
    expect(
      module
        .get(OutboundRestGateway)
        .bindings()
        .map((info) => info.name),
    ).toEqual(['catalog.lookup']);
  });

  it('fails the boot when a declared binding points to a channel that does not exist', async () => {
    await expect(
      boot({
        channels,
        outbound: { rest: { bindings: [{ channel: 'missing.http', url: 'https://x.example' }] } },
      }),
    ).rejects.toThrow("'missing.http'");
  });
});
