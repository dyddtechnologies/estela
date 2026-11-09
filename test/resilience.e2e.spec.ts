import 'reflect-metadata';

import { Body, Controller, Injectable, Logger, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HopLogger,
  InboundRest,
  IntegrationModule,
  MemoryIdempotencyStore,
  OutboundHttpError,
  OutboundRestGateway,
  ResilienceDefinitionError,
  ServiceActivator,
  type IntegrationModuleOptions,
  type OutboundRestBinding,
} from '../src/index';

/**
 * Resilience end to end (spec section 10.2): real Nest apps on loopback sockets, a real upstream
 * HTTP server and the global fetch. RE-04 and RE-05 need Redis and live in
 * `resilience-redis.e2e.spec.ts`.
 */

interface Upstream {
  base: string;
  /** Requests seen per path, with their headers. */
  seen: Map<string, IncomingMessage['headers'][]>;
  close(): Promise<void>;
}

/** `/fail*` answers 503 without Retry-After; anything else answers 200 with `{ ok: true }`. */
async function startUpstream(): Promise<Upstream> {
  const seen = new Map<string, IncomingMessage['headers'][]>();
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      seen.set(path, [...(seen.get(path) ?? []), req.headers]);
      const failing = path.startsWith('/fail');
      res.writeHead(failing ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(failing ? { message: 'down' } : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function calls(upstream: Upstream, path: string): number {
  return upstream.seen.get(path)?.length ?? 0;
}

/** POST bodies are not retried by the REST classifier without this (RS-09). */
const retry3 = { retry: { maxAttempts: 3, idempotent: true, backoff: 1 } } as const;

async function startApp(
  options: Partial<IntegrationModuleOptions>,
  controllers: unknown[],
  providers: unknown[],
): Promise<{ app: INestApplication; url: string }> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      IntegrationModule.forRoot({
        channels: [],
        logging: { banner: false },
        ...options,
      }),
    ],
    controllers: controllers as never[],
    providers: providers as never[],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: await app.getUrl() };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------- Endpoints and activators ----------

@Controller('shed')
class ShedController {
  @Post()
  @InboundRest({
    channel: 'shed.in',
    requestReply: true,
    idempotency: {},
    resilience: { rateLimit: { limitPerSec: 1, burst: 1 } },
  })
  shed(@Body() body: unknown): unknown {
    return body;
  }
}

@Controller('budget')
class BudgetController {
  @Post()
  @InboundRest({ channel: 'budget.in', requestReply: true })
  call(@Body() body: unknown): unknown {
    return body;
  }
}

@Injectable()
class EchoActivator {
  @ServiceActivator('shed.in')
  echo(payload: unknown): unknown {
    return { echoed: payload };
  }
}

/** Calls the `downstream` outbound binding for each message: one hop to the next layer. */
@Injectable()
class RelayActivator {
  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator('budget.in')
  async relay(payload: unknown): Promise<unknown> {
    return this.outbound.request('downstream', { payload });
  }
}

@Controller('quote')
class QuoteController {
  @Post()
  @InboundRest({
    channel: 'quote.in',
    requestReply: true,
    idempotency: { onDuplicate: 'replay' },
  })
  quote(@Body() body: unknown): unknown {
    return body;
  }
}

@Injectable()
class QuoteActivator {
  runs = 0;

  constructor(private readonly outbound: OutboundRestGateway) {}

  @ServiceActivator('quote.in')
  async quote(payload: unknown): Promise<unknown> {
    this.runs += 1;
    return this.outbound.request('pricing', { payload });
  }
}

describe('resilience e2e (loopback HTTP)', () => {
  let upstream: Upstream;
  const apps: INestApplication[] = [];

  beforeAll(async () => {
    upstream = await startUpstream();
  });

  afterAll(async () => {
    await upstream.close();
  });

  beforeEach(() => {
    upstream.seen.clear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    jest.restoreAllMocks();
  });

  const binding = (name: string, path: string, extra: Partial<OutboundRestBinding> = {}) => ({
    name,
    url: `${upstream.base}${path}`,
    ...extra,
  });

  it('RE-01 outbound rest binding retries 503s, calls mapError once and logs one hop', async () => {
    const hopStart = jest.spyOn(HopLogger.prototype, 'hopStart');
    const hopEnd = jest.spyOn(HopLogger.prototype, 'hopEnd');
    const mapped: unknown[] = [];
    const { app } = await startApp(
      {
        resilience: { events: { channel: false } },
        logging: { banner: false, hops: true },
        outbound: {
          rest: {
            bindings: [
              binding('erp', '/fail-erp', {
                resilience: {
                  ...retry3,
                  circuitBreaker: { minimumCalls: 10 },
                },
                mapError: (error) => {
                  mapped.push(error);
                  return new Error('erp unavailable');
                },
              }),
            ],
          },
        },
      },
      [],
      [],
    );
    apps.push(app);
    const error: unknown = await app
      .get(OutboundRestGateway)
      .request('erp', { payload: { id: 1 } })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('erp unavailable');
    expect(calls(upstream, '/fail-erp')).toBe(3);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toBeInstanceOf(OutboundHttpError);
    expect((mapped[0] as OutboundHttpError).status).toBe(503);
    expect((mapped[0] as OutboundHttpError).attempts).toBe(3);
    expect(hopStart.mock.calls.filter(([channel]) => channel === 'erp')).toHaveLength(1);
    const ends = hopEnd.mock.calls.filter(([channel]) => channel === 'erp');
    expect(ends).toHaveLength(1);
    expect(ends[0]?.[3]).toBe(false);
  });

  it('RE-02 inbound rate limit answers 429 with Retry-After before the idempotency claim', async () => {
    const store = new MemoryIdempotencyStore();
    const { app, url } = await startApp(
      {
        channels: [{ name: 'shed.in', type: 'direct' }],
        resilience: { events: { channel: false } },
        idempotency: { store },
      },
      [ShedController],
      [EchoActivator],
    );
    apps.push(app);
    const first = await post(`${url}/shed`, { n: 1 }, { 'idempotency-key': 'shed-a' });
    const second = await post(`${url}/shed`, { n: 2 }, { 'idempotency-key': 'shed-b' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('1');
    expect(await second.json()).toMatchObject({
      code: 'INBOUND_OVERLOADED',
      reason: 'rate-limited',
    });
    expect(await store.get('inbound:shed.in', 'shed-b')).toBeUndefined();
    expect((await store.get('inbound:shed.in', 'shed-a'))?.status).toBe('completed');
  });

  it('RE-02 an inbound x-retry-budget of 0 stops downstream retries', async () => {
    const { app, url } = await startApp(
      {
        channels: [{ name: 'budget.in', type: 'direct' }],
        resilience: { events: { channel: false } },
        outbound: {
          rest: { bindings: [binding('downstream', '/fail-budget', { resilience: retry3 })] },
        },
      },
      [BudgetController],
      [RelayActivator],
    );
    apps.push(app);
    const capped = await post(`${url}/budget`, { n: 1 }, { 'x-retry-budget': '0' });
    expect(capped.status).toBe(500);
    expect(calls(upstream, '/fail-budget')).toBe(1);
    expect(upstream.seen.get('/fail-budget')?.[0]?.['x-retry-budget']).toBe('0');
    upstream.seen.clear();
    const free = await post(`${url}/budget`, { n: 2 });
    expect(free.status).toBe(500);
    expect(calls(upstream, '/fail-budget')).toBe(3);
    expect(upstream.seen.get('/fail-budget')?.[0]?.['x-retry-budget']).toBe('0');
  });

  it('RE-03 two in-process apps chained over HTTP: the failing leaf receives at most maxAttempts calls', async () => {
    const resilience = { events: { channel: false as const } };
    const middle = await startApp(
      {
        channels: [{ name: 'budget.in', type: 'direct' }],
        resilience,
        outbound: {
          rest: { bindings: [binding('downstream', '/fail-leaf', { resilience: retry3 })] },
        },
      },
      [BudgetController],
      [RelayActivator],
    );
    apps.push(middle.app);
    const edge = await startApp(
      {
        resilience,
        outbound: {
          rest: {
            bindings: [{ name: 'middle', url: `${middle.url}/budget`, resilience: retry3 }],
          },
        },
      },
      [],
      [],
    );
    apps.push(edge.app);
    const error: unknown = await edge.app
      .get(OutboundRestGateway)
      .request('middle', { payload: { order: 1 } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect((error as OutboundHttpError).status).toBe(500);
    expect((error as OutboundHttpError).attempts).toBe(3);
    expect(calls(upstream, '/fail-leaf')).toBe(3);
  });

  it('RE-03 (control) without forRoot({ resilience }) on the middle app the leaf receives 9 calls', async () => {
    const middle = await startApp(
      {
        channels: [{ name: 'budget.in', type: 'direct' }],
        outbound: {
          rest: { bindings: [binding('downstream', '/fail-leaf', { resilience: retry3 })] },
        },
      },
      [BudgetController],
      [RelayActivator],
    );
    apps.push(middle.app);
    const edge = await startApp(
      {
        resilience: { events: { channel: false } },
        outbound: {
          rest: {
            bindings: [{ name: 'middle', url: `${middle.url}/budget`, resilience: retry3 }],
          },
        },
      },
      [],
      [],
    );
    apps.push(edge.app);
    await expect(
      edge.app.get(OutboundRestGateway).request('middle', { payload: { order: 1 } }),
    ).rejects.toBeInstanceOf(OutboundHttpError);
    expect(calls(upstream, '/fail-leaf')).toBe(9);
  });

  /** Boots the quote endpoint whose `pricing` binding always falls back, and posts one key twice. */
  async function quoteTwice(cacheable: boolean) {
    const store = new MemoryIdempotencyStore();
    const { app, url } = await startApp(
      {
        channels: [{ name: 'quote.in', type: 'direct' }],
        resilience: { events: { channel: false } },
        idempotency: { store },
        outbound: {
          rest: {
            bindings: [
              binding('pricing', '/fail-pricing', {
                resilience: {
                  fallback: { value: () => ({ price: 0, estimated: true }), cacheable },
                },
              }),
            ],
          },
        },
      },
      [QuoteController],
      [QuoteActivator],
    );
    apps.push(app);
    const bodies: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await post(`${url}/quote`, { sku: 'A' }, { 'idempotency-key': 'quote-1' });
      expect(response.status).toBe(201);
      bodies.push(await response.json());
    }
    return { store, bodies, runs: app.get(QuoteActivator).runs };
  }

  it('RE-06 a fallback answer is not replayed for a duplicate idempotency key', async () => {
    const { store, bodies, runs } = await quoteTwice(false);
    expect(runs).toBe(2);
    expect(calls(upstream, '/fail-pricing')).toBe(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ status: 'ok', result: { price: 0, estimated: true } });
    }
    expect((await store.get('inbound:quote.in', 'quote-1'))?.status).not.toBe('completed');
    const activatorRecord = await store.get('activator:QuoteActivator.quote', 'quote-1');
    expect(activatorRecord?.status).not.toBe('completed');
  });

  it('RE-06 (control) a cacheable fallback answer is replayed for the duplicate key', async () => {
    const { store, bodies, runs } = await quoteTwice(true);
    expect(runs).toBe(1);
    // onDuplicate 'replay' answers the duplicate in the endpoint's own reply shape.
    expect(bodies[1]).toMatchObject({ status: 'ok', result: { price: 0, estimated: true } });
    expect((await store.get('inbound:quote.in', 'quote-1'))?.status).toBe('completed');
    expect((await store.get('activator:QuoteActivator.quote', 'quote-1'))?.status).toBe(
      'completed',
    );
  });

  it('RE-07 an invalid resilience option fails module boot', async () => {
    const boot = startApp(
      {
        resilience: {},
        outbound: {
          rest: {
            bindings: [binding('bad', '/ok', { resilience: { retry: { maxAttempts: 0 } } })],
          },
        },
      },
      [],
      [],
    );
    await expect(boot).rejects.toThrow(ResilienceDefinitionError);
    await expect(boot).rejects.toThrow('bad: resilience.retry.maxAttempts');
    expect(calls(upstream, '/ok')).toBe(0);
  });
});
