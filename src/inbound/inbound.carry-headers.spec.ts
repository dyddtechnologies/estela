import 'reflect-metadata';

import { Injectable, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ChannelRegistry } from '../channel-registry';
import { ChannelGraph } from '../graph/channel-graph';
import { IntegrationModule } from '../integration.module';
import type { IntegrationMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { InboundGrpc, InboundRabbit, InboundRest } from './inbound.decorators';
import { InboundInterceptor } from './inbound.interceptor';
import { InboundError, INBOUND_SPEC_METADATA, type InboundSpec } from './inbound.types';

interface World {
  interceptor: InboundInterceptor;
  received: IntegrationMessage[];
}

function world(): World {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  const received: IntegrationMessage[] = [];
  registry.create({ name: 'in', type: 'direct' }).subscribe((msg) => {
    received.push(msg);
  });
  return { interceptor: new InboundInterceptor({ registry, trace: registry.trace }), received };
}

function handlerWith(spec: InboundSpec): () => void {
  const handler = function handle(): void {};
  Reflect.defineMetadata(INBOUND_SPEC_METADATA, spec, handler);
  return handler;
}

function grpcContext(spec: InboundSpec, metadata: Record<string, unknown>): ExecutionContext {
  const handler = handlerWith(spec);
  return {
    switchToRpc: () => ({
      getData: () => ({ body: 'hola' }),
      getContext: () => ({
        toJSON: () =>
          Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, [value]])),
      }),
    }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function restContext(spec: InboundSpec, headers: Record<string, unknown>): ExecutionContext {
  const handler = handlerWith(spec);
  return {
    switchToHttp: () => ({ getRequest: () => ({ body: { n: 1 }, headers }) }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

async function run(w: World, context: ExecutionContext): Promise<unknown> {
  const next: CallHandler = { handle: () => of(undefined) };
  return lastValueFrom(await w.interceptor.intercept(context, next));
}

const METADATA = {
  'x-trace-id': 't-1',
  'x-organization-id': 'org-farmacro',
  'x-business-number': '+50224618427',
  authorization: 'Bearer secret',
  'user-agent': 'grpc-go/1.68.1',
};

describe('inbound carryHeaders (SPI-448 gap headers)', () => {
  it('copies nothing from transport metadata by default', async () => {
    const w = world();
    await run(w, grpcContext({ channel: 'in', transport: 'grpc' }, METADATA));
    const headers: Record<string, unknown> = w.received[0]?.headers ?? {};
    expect(headers.traceId).toBe('t-1');
    for (const name of Object.keys(METADATA).filter((n) => n !== 'x-trace-id')) {
      expect(headers).not.toHaveProperty(name);
    }
    expect(JSON.stringify(headers)).not.toContain('secret');
  });

  it('gRPC: a name list copies only those metadata entries, under the same name', async () => {
    const w = world();
    const spec: InboundSpec = {
      channel: 'in',
      transport: 'grpc',
      carryHeaders: ['x-organization-id', 'x-missing'],
    };
    await run(w, grpcContext(spec, METADATA));
    const headers = w.received[0]?.headers;
    expect(headers?.['x-organization-id']).toBe('org-farmacro');
    expect(headers).not.toHaveProperty('x-missing');
    expect(headers).not.toHaveProperty('x-business-number');
    expect(headers).not.toHaveProperty('authorization');
  });

  it('gRPC: a map renames metadata entries to message header names', async () => {
    const w = world();
    const spec: InboundSpec = {
      channel: 'in',
      transport: 'grpc',
      carryHeaders: {
        'x-organization-id': 'organizationId',
        'x-business-number': 'businessNumber',
      },
    };
    await run(w, grpcContext(spec, METADATA));
    expect(w.received[0]?.headers).toMatchObject({
      organizationId: 'org-farmacro',
      businessNumber: '+50224618427',
      traceId: 't-1',
    });
    expect(w.received[0]?.headers).not.toHaveProperty('x-organization-id');
  });

  it('REST: header names match case-insensitively; array values give their first entry', async () => {
    const w = world();
    const spec: InboundSpec = {
      channel: 'in',
      transport: 'rest',
      carryHeaders: { 'X-Tenant-Id': 'tenantId' },
    };
    await run(w, restContext(spec, { 'x-tenant-id': ['acme', 'other'] }));
    expect(w.received[0]?.headers.tenantId).toBe('acme');
  });

  it('refuses a reserved target name, an empty name and two names onto one target', async () => {
    const reserved: InboundSpec = {
      channel: 'in',
      transport: 'grpc',
      carryHeaders: { 'x-trace': 'traceId' },
    };
    await expect(run(world(), grpcContext(reserved, METADATA))).rejects.toThrow(
      "inbound 'in': carryHeaders target 'traceId' is a reserved header",
    );
    const empty: InboundSpec = { channel: 'in', transport: 'grpc', carryHeaders: [''] };
    await expect(run(world(), grpcContext(empty, METADATA))).rejects.toThrow(InboundError);
    const twice: InboundSpec = {
      channel: 'in',
      transport: 'grpc',
      carryHeaders: { 'x-a': 'tenant', 'x-b': 'tenant' },
    };
    await expect(run(world(), grpcContext(twice, METADATA))).rejects.toThrow(
      "inbound 'in': carryHeaders target 'tenant' is used twice",
    );
  });

  describe('module boot', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    @Injectable()
    class TenantEndpoints {
      @InboundGrpc({
        channel: 'wa.inbound',
        carryHeaders: { 'x-organization-id': 'organizationId' },
      })
      grpc(): void {}

      @InboundRest({ channel: 'orders.in', carryHeaders: ['x-tenant'] })
      rest(): void {}
    }

    @Injectable()
    class RabbitEndpoint {
      @InboundRabbit({ channel: 'orders.rabbit', carryHeaders: ['x-tenant'] })
      consume(): void {}
    }

    async function boot(providers: unknown[]) {
      const moduleRef = await Test.createTestingModule({
        imports: [
          IntegrationModule.forRoot({
            channels: [
              { name: 'wa.inbound', type: 'direct' },
              { name: 'orders.in', type: 'direct' },
            ],
            logging: { banner: false },
          }),
        ],
        providers: providers as never[],
      }).compile();
      await moduleRef.init();
      return moduleRef;
    }

    it('shows the carried header names in the graph, never values', async () => {
      const moduleRef = await boot([TenantEndpoints]);
      const graph = moduleRef.get(ChannelGraph).snapshot(moduleRef.get(ChannelRegistry));
      const wa = graph.nodes.find((node) => node.channel === 'wa.inbound');
      expect(wa?.inbounds).toEqual([
        { transport: 'grpc', requestReply: false, carries: ['organizationId'] },
      ]);
      const orders = graph.nodes.find((node) => node.channel === 'orders.in');
      expect(orders?.inbounds).toEqual([
        { transport: 'rest', requestReply: false, carries: ['x-tenant'] },
      ]);
      await moduleRef.close();
    });

    it('fails the boot on @InboundRabbit', async () => {
      await expect(boot([RabbitEndpoint])).rejects.toThrow(
        "inbound 'orders.rabbit': carryHeaders is not supported on @InboundRabbit",
      );
    });
  });
});
