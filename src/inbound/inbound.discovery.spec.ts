import 'reflect-metadata';

import { Controller, Get, Post } from '@nestjs/common';
import {
  Inbound,
  InboundGraphQL,
  InboundGrpc,
  InboundRabbit,
  InboundRest,
} from './inbound.decorators';
import { describeInbound, discoverInbounds } from './inbound.discovery';
import type { InboundSpec } from './inbound.types';

const methodNames = (proto: object): string[] =>
  Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');

const lines = (...instances: unknown[]): string[] =>
  discoverInbounds(
    instances.map((instance) => ({ instance })),
    { methodNames },
  ).map((inbound) => inbound.line);

const GrpcPattern =
  (pattern: unknown): MethodDecorator =>
  (_target, _key, descriptor) => {
    Reflect.defineMetadata('microservices:pattern', pattern, descriptor.value as object);
  };

const GraphqlResolver =
  (type: string, name?: string): MethodDecorator =>
  (_target, _key, descriptor) => {
    Reflect.defineMetadata('graphql:resolver_type', type, descriptor.value as object);
    if (name !== undefined) {
      Reflect.defineMetadata('graphql:resolver_name', name, descriptor.value as object);
    }
  };

describe('discoverInbounds: REST', () => {
  it('joins controller path and handler path with the HTTP verb', () => {
    @Controller('V1/Workflows')
    class WorkflowController {
      @Post(':id/Start')
      @InboundRest({ channel: 'wf.start', requestReply: true })
      start(): void {}

      @Get()
      @InboundRest({ channel: 'wf.list' })
      list(): void {}
    }
    expect(lines(new WorkflowController())).toEqual([
      'inbound rest: POST /V1/Workflows/:id/Start -> wf.start (request-reply)',
      'inbound rest: GET /V1/Workflows -> wf.list',
    ]);
  });

  it('lists every combination of array paths and tolerates a missing controller path', () => {
    @Controller(['a', '/b/'])
    class MultiController {
      @Post(['x', 'y'])
      @InboundRest({ channel: 'multi' })
      create(): void {}
    }
    class BareHost {
      @Post()
      @InboundRest({ channel: 'bare' })
      create(): void {}
    }
    expect(lines(new MultiController(), new BareHost())).toEqual([
      'inbound rest: POST /a/x | /a/y | /b/x | /b/y -> multi',
      'inbound rest: POST / -> bare',
    ]);
  });

  it('falls back to Class.method without route metadata or with an unknown verb', () => {
    class NoRoute {
      @InboundRest({ channel: 'no.route' })
      handle(): void {}

      @InboundRest({ channel: 'odd.verb', requestReply: true })
      odd(): void {}
    }
    Reflect.defineMetadata('method', 99, NoRoute.prototype.odd);
    expect(lines(new NoRoute())).toEqual([
      'inbound rest: NoRoute.handle -> no.route',
      'inbound rest: NoRoute.odd -> odd.verb (request-reply)',
    ]);
  });

  it('describes a handler inherited from a base class with the concrete controller path', () => {
    class BaseController {
      @Post('start')
      @InboundRest({ channel: 'base.start' })
      start(): void {}
    }
    @Controller('child')
    class ChildController extends BaseController {}
    const found = discoverInbounds([{ instance: new ChildController() }], { methodNames });
    expect(found).toEqual([
      {
        spec: { channel: 'base.start', transport: 'rest' },
        handler: 'ChildController.start',
        line: 'inbound rest: POST /child/start -> base.start',
      },
    ]);
  });
});

describe('discoverInbounds: gRPC, GraphQL and rabbit', () => {
  it('reads the @GrpcMethod pattern, as an array or as a single object', () => {
    class LifecycleController {
      @GrpcPattern([{ service: 'WorkflowLifecycleService', rpc: 'Start', streaming: 'no_stream' }])
      @InboundGrpc({ channel: 'wf.start', requestReply: true })
      start(): void {}

      @GrpcPattern({ service: 'WorkflowLifecycleService', rpc: 'Stop' })
      @InboundGrpc({ channel: 'wf.stop' })
      stop(): void {}
    }
    expect(lines(new LifecycleController())).toEqual([
      'inbound grpc: WorkflowLifecycleService/Start -> wf.start (request-reply)',
      'inbound grpc: WorkflowLifecycleService/Stop -> wf.stop',
    ]);
  });

  it('falls back to Class.method when the gRPC pattern is missing or malformed', () => {
    class LooseGrpc {
      @InboundGrpc({ channel: 'g.none' })
      none(): void {}

      @GrpcPattern('plain-string')
      @InboundGrpc({ channel: 'g.text' })
      text(): void {}

      @GrpcPattern([null])
      @InboundGrpc({ channel: 'g.null' })
      nil(): void {}

      @GrpcPattern({ service: 'OnlyService' })
      @InboundGrpc({ channel: 'g.partial' })
      partial(): void {}

      @GrpcPattern({ service: 7, rpc: 'Rpc' })
      @InboundGrpc({ channel: 'g.typed' })
      typed(): void {}
    }
    expect(lines(new LooseGrpc())).toEqual([
      'inbound grpc: LooseGrpc.none -> g.none',
      'inbound grpc: LooseGrpc.text -> g.text',
      'inbound grpc: LooseGrpc.nil -> g.null',
      'inbound grpc: LooseGrpc.partial -> g.partial',
      'inbound grpc: LooseGrpc.typed -> g.typed',
    ]);
  });

  it('describes GraphQL with the operation and the field name', () => {
    class OrdersResolver {
      @InboundGraphQL({ channel: 'orders.place', operation: 'mutation' })
      placeOrder(): void {}

      @GraphqlResolver('Query', 'ordersByCustomer')
      @InboundGraphQL({ channel: 'orders.query', requestReply: true })
      find(): void {}

      @GraphqlResolver('Subscription', '')
      @InboundGraphQL({ channel: 'orders.events' })
      events(): void {}

      @InboundGraphQL({ channel: 'orders.plain' })
      plain(): void {}
    }
    expect(lines(new OrdersResolver())).toEqual([
      'inbound graphql: mutation placeOrder -> orders.place',
      'inbound graphql: query ordersByCustomer -> orders.query (request-reply)',
      'inbound graphql: subscription events -> orders.events',
      'inbound graphql: plain -> orders.plain',
    ]);
  });

  it('describes rabbit metadata and generic @Inbound with Class.method', () => {
    class Consumers {
      @InboundRabbit({ channel: 'orders.in' })
      onOrder(): void {}

      @Inbound({ channel: 'generic.in', transport: 'rabbit' })
      onGeneric(): void {}
    }
    expect(lines(new Consumers())).toEqual([
      'inbound rabbit: Consumers.onOrder -> orders.in',
      'inbound rabbit: Consumers.onGeneric -> generic.in',
    ]);
  });
});

describe('discoverInbounds: resilience and privacy', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns nothing when no inbound is annotated or the instance is not an object', () => {
    class Plain {
      run(): void {}
    }
    expect(lines(new Plain(), null, undefined, 'text', 42)).toEqual([]);
  });

  it('ignores names that do not resolve to an own method', () => {
    class Host {
      @Post('ok')
      @InboundRest({ channel: 'ok' })
      ok(): void {}

      get computed(): number {
        return Date.now();
      }
    }
    const found = discoverInbounds([{ instance: new Host() }], {
      methodNames: () => ['ok', 'computed', 'missing'],
    });
    expect(found.map((inbound) => inbound.line)).toEqual(['inbound rest: POST /ok -> ok']);
  });

  it('falls back to Class.method when reading the route metadata throws', () => {
    class Host {
      handle(): void {}
    }
    const spec: InboundSpec = { channel: 'safe', transport: 'rest', requestReply: true };
    jest.spyOn(Reflect, 'getMetadata').mockImplementation(() => {
      throw new Error('metadata exploded');
    });
    expect(describeInbound(Host, 'handle', Host.prototype.handle, spec)).toBe(
      'inbound rest: Host.handle -> safe (request-reply)',
    );
  });

  it('reports and skips a source that cannot be inspected, with or without onError', () => {
    class Healthy {
      @Post('h')
      @InboundRest({ channel: 'healthy' })
      handle(): void {}
    }
    const broken = {
      get instance(): unknown {
        throw new Error('wrapper exploded');
      },
    };
    const onError = jest.fn();
    const found = discoverInbounds([broken, { instance: new Healthy() }], { methodNames, onError });
    expect(found.map((inbound) => inbound.line)).toEqual(['inbound rest: POST /h -> healthy']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'wrapper exploded' }));
    expect(() => discoverInbounds([broken], { methodNames })).not.toThrow();
  });

  it('never prints option values such as reply mappers, scopes or timeouts', () => {
    class Secretive {
      @Post('s')
      @InboundRest({
        channel: 'secret.in',
        timeoutMs: 4321,
        reply: () => 'mapper-secret',
        idempotency: { scope: 'scope-secret', clientKey: 'x-secret-header' },
      })
      handle(): void {}
    }
    expect(lines(new Secretive())).toEqual(['inbound rest: POST /s -> secret.in']);
  });
});
