import 'reflect-metadata';

import { Controller, Injectable, Logger, Post, type INestApplication } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { lastValueFrom, of } from 'rxjs';
import {
  ChannelGraph,
  ChannelRegistry,
  INBOUND_DEPS,
  InboundGrpc,
  InboundInterceptor,
  InboundRest,
  IntegrationFlow,
  IntegrationModule,
  MemoryIdempotencyStore,
  type FlowDefinition,
  type InboundInterceptorDeps,
} from '../src/index';

/**
 * Gap "filter-reply" (SPI-448): a filter in a request/reply flow answers the inbound caller at
 * once when it drops the message, so a webhook gets its 2xx without waiting for the reply timeout.
 */

interface Submit {
  messageSid: string;
  body: string;
}

const hasText = (payload: unknown): boolean => (payload as Submit).body.trim().length > 0;

const webhookFlow: FlowDefinition = {
  name: 'webhook',
  build: () =>
    IntegrationFlow.from('webhook.in')
      .filter(hasText, { id: 'skip-empty', whenDropped: { reply: { status: 'ignored' } } })
      .transform((payload) => ({ status: 'processed', sid: (payload as Submit).messageSid }))
      .reply(),
};

const grpcFlow: FlowDefinition = {
  name: 'submit',
  build: () =>
    IntegrationFlow.from('submit.in')
      .filter(hasText, {
        id: 'skip-empty',
        whenDropped: {
          reply: (payload) => ({ status: 'ignored', inReplyTo: (payload as Submit).messageSid }),
        },
      })
      .transform((payload) => ({ status: 'queued', inReplyTo: (payload as Submit).messageSid }))
      .reply(),
};

const silentFlow: FlowDefinition = {
  name: 'silent',
  build: () =>
    IntegrationFlow.from('silent.in')
      .filter(hasText, { id: 'skip-empty' })
      .transform(() => ({ status: 'processed' }))
      .reply(),
};

@Controller('webhooks')
class WebhookController {
  @Post('whatsapp')
  @InboundRest({ channel: 'webhook.in', requestReply: true, timeoutMs: 15_000 })
  whatsapp(): void {}

  @Post('silent')
  @InboundRest({ channel: 'silent.in', requestReply: true, timeoutMs: 150 })
  silent(): void {}
}

@Injectable()
class SubmitEndpoint {
  @InboundGrpc({
    channel: 'submit.in',
    requestReply: true,
    reply: 'raw',
    timeoutMs: 15_000,
    idempotency: { clientKey: (ctx) => (ctx.payload as Submit).messageSid, onDuplicate: 'replay' },
  })
  submit(request: Submit): Submit {
    return request;
  }
}

describe('filter whenDropped reply over inbound request/reply (SPI-448 gap filter-reply)', () => {
  let app: INestApplication;
  let url: string;
  let submit: (request: Submit) => Promise<unknown>;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        IntegrationModule.forRoot(
          {
            logging: { banner: false },
            idempotency: { store: new MemoryIdempotencyStore() },
            channels: [
              { name: 'webhook.in', type: 'direct' },
              { name: 'submit.in', type: 'direct' },
              { name: 'silent.in', type: 'direct' },
            ],
          },
          [webhookFlow, grpcFlow, silentFlow],
        ),
      ],
      controllers: [WebhookController],
      providers: [SubmitEndpoint],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    const interceptor = new InboundInterceptor(app.get<InboundInterceptorDeps>(INBOUND_DEPS));
    const endpoint = app.get(SubmitEndpoint);
    submit = async (request) => {
      const handler = SubmitEndpoint.prototype.submit;
      const metadata = { toJSON: () => ({ 'x-trace-id': [`t-${request.messageSid}`] }) };
      const context = new ExecutionContextHost([request, metadata, {}], SubmitEndpoint, handler);
      context.setType('rpc');
      const stream = await interceptor.intercept(context, {
        handle: () => of(handler.call(endpoint, request)),
      });
      return lastValueFrom(stream);
    };
  }, 20_000);

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('REST: a dropped webhook gets its 2xx answer at once, not after the 15 s timeout', async () => {
    const startedAt = Date.now();
    const response = await post('/webhooks/whatsapp', { messageSid: 'SM1', body: '   ' });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: 'ok', result: { status: 'ignored' } });
  });

  it('REST: a kept webhook still gets the flow reply', async () => {
    const response = await post('/webhooks/whatsapp', { messageSid: 'SM2', body: 'hola' });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      result: { status: 'processed', sid: 'SM2' },
    });
  });

  it('REST: without whenDropped the drop stays silent and the caller times out (0.9.0)', async () => {
    const response = await post('/webhooks/silent', { messageSid: 'SM3', body: '' });

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it('gRPC: a dropped submit is answered at once with the computed value; a repeat replays it', async () => {
    const startedAt = Date.now();
    await expect(submit({ messageSid: 'SM4', body: '' })).resolves.toEqual({
      status: 'ignored',
      inReplyTo: 'SM4',
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(submit({ messageSid: 'SM4', body: '' })).resolves.toEqual({
      status: 'ignored',
      inReplyTo: 'SM4',
    });
    await expect(submit({ messageSid: 'SM5', body: 'hola' })).resolves.toEqual({
      status: 'queued',
      inReplyTo: 'SM5',
    });
  });

  it('the graph shows the option of each filter, never the reply value', () => {
    const graph = app.get(ChannelGraph).snapshot(app.get(ChannelRegistry));
    const steps = (name: string) => graph.flows.find((flow) => flow.name === name)?.steps;

    expect(steps('webhook')?.[0]).toEqual({
      kind: 'filter',
      id: 'skip-empty',
      whenDropped: 'reply',
    });
    expect(steps('submit')?.[0]).toEqual({
      kind: 'filter',
      id: 'skip-empty',
      whenDropped: 'reply',
    });
    expect(steps('silent')?.[0]).toEqual({ kind: 'filter', id: 'skip-empty' });
    expect(JSON.stringify(graph)).not.toContain('ignored');
  });
});
