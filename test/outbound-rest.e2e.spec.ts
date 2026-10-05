import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OutboundHttpError,
  OutboundNetworkError,
  OutboundRestGateway,
  OutboundTimeoutError,
  type OutboundRestResponse,
} from '../src/index';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** Real HTTP round trips with the global fetch against a loopback server. */
describe('outbound REST e2e (real fetch, loopback server)', () => {
  let server: Server;
  let base: string;
  const seen: Seen[] = [];
  const aborted: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = req.url ?? '';
        seen.push({
          method: req.method ?? '',
          url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        if (url.startsWith('/slow')) {
          res.on('close', () => aborted.push(url));
          return; // never answers
        }
        if (url.startsWith('/fail')) {
          res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
          res.end(JSON.stringify({ message: 'maintenance' }));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'x-served': 'yes',
        });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ echoed: url }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
  });

  it('sends method, query, headers and JSON body, and replies the parsed response', async () => {
    const gateway = new OutboundRestGateway();
    const reply = await gateway.request(
      {
        url: `${base}/orders`,
        method: 'PUT',
        query: { tenant: 't-1' },
        idempotency: { key: ({ payload }) => ['order', (payload as { id: string }).id] },
        mapHeaders: () => ({ authorization: 'Bearer tk' }),
      },
      { payload: { id: 'o-1' }, headers: { traceId: 't-e2e', correlationId: 'c-e2e' } },
    );
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(reply.headers['x-served']).toBe('yes');
    expect(reply.body).toEqual({ echoed: '/orders?tenant=t-1' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.body).toBe('{"id":"o-1"}');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.headers['x-trace-id']).toBe('t-e2e');
    expect(seen[0]?.headers['x-correlation-id']).toBe('c-e2e');
    expect(seen[0]?.headers['idempotency-key']).toBe('order:o-1');
    expect(seen[0]?.headers.authorization).toBe('Bearer tk');
  });

  it('a HEAD request has no body in either direction', async () => {
    const reply: OutboundRestResponse = await new OutboundRestGateway().request(
      { url: `${base}/ping`, method: 'HEAD' },
      { payload: { ignored: true } },
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toBeNull();
    expect(seen[0]?.method).toBe('HEAD');
    expect(seen[0]?.body).toBe('');
  });

  it('a 503 becomes an OutboundHttpError with the upstream body, headers and status text', async () => {
    const error: unknown = await new OutboundRestGateway()
      .request({ name: 'erp', url: `${base}/fail?token=s3cret` }, { payload: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundHttpError);
    const http = error as OutboundHttpError;
    expect(http.status).toBe(503);
    expect(http.statusText).toBe('Service Unavailable');
    expect(http.body).toEqual({ message: 'maintenance' });
    expect(http.headers['retry-after']).toBe('1');
    expect(http.message).toBe(`outbound rest 'erp' POST ${base}/fail -> HTTP 503`);
  });

  it('retries a GET against the real server until attempts run out', async () => {
    const error: unknown = await new OutboundRestGateway()
      .request(
        { url: `${base}/fail`, method: 'GET', retry: { maxAttempts: 3, backoff: 1 } },
        { payload: null },
      )
      .catch((caught: unknown) => caught);
    expect((error as OutboundHttpError).attempts).toBe(3);
    expect(seen.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('a slow upstream is aborted: OutboundTimeoutError, and the server sees the connection close', async () => {
    const error: unknown = await new OutboundRestGateway()
      .request({ url: `${base}/slow`, timeoutMs: 80 }, { payload: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundTimeoutError);
    expect((error as OutboundTimeoutError).timeoutMs).toBe(80);
    for (let waited = 0; aborted.length === 0 && waited < 50; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(aborted).toEqual(['/slow']);
  });

  it('a refused connection becomes an OutboundNetworkError with the system code', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error: unknown = await new OutboundRestGateway()
      .request({ url: `http://127.0.0.1:${port}/down` }, { payload: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundNetworkError);
    expect((error as OutboundNetworkError).code).toBe('ECONNREFUSED');
  });
});
