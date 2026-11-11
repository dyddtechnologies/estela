import { ChannelRegistry } from '../channel-registry';
import { ReplyGateway, ReplyTimeoutError } from '../gateway/reply-gateway';
import type { IntegrationMessage } from '../message';
import { bindFlow, MemoryIdempotencyStore } from '../testing';
import { TraceContext } from '../trace/trace-context';
import { FlowDefinitionError, FLOW_SHAPE_CODES } from './flow-definition-error';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

interface World {
  registry: ChannelRegistry;
  gateway: ReplyGateway;
  errors: Record<string, unknown>[];
  inbox(channel: string): IntegrationMessage[];
}

function world(): World {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  const errors: Record<string, unknown>[] = [];
  registry.get('error.channel').subscribe((msg) => {
    errors.push(msg.payload as Record<string, unknown>);
  });
  return {
    registry,
    gateway: new ReplyGateway({ registry, trace: registry.trace }),
    errors,
    inbox: (channel) => {
      const received: IntegrationMessage[] = [];
      registry.create({ name: channel, type: 'direct' }).subscribe((msg) => {
        received.push(msg);
      });
      return received;
    },
  };
}

const definition = (name: string, flow: IntegrationFlow): FlowDefinition => ({
  name,
  build: () => flow,
});

const hasText = (payload: unknown): boolean =>
  ((payload as { body?: string }).body ?? '').trim().length > 0;

/** A request/reply flow: the kept messages are answered by `reply()`. */
function echoFlow(flow: IntegrationFlow): IntegrationFlow {
  return flow.transform((payload) => ({ echoed: payload })).reply();
}

describe('flow filter whenDropped reply (SPI-448 gap filter-reply)', () => {
  it('drops silently by default: a request/reply caller waits until its timeout (0.9.0)', async () => {
    const w = world();
    bindFlow(
      definition('f', echoFlow(IntegrationFlow.from('in').filter(hasText, { id: 'skip-empty' }))),
      w.registry,
    );

    await expect(w.gateway.sendAndReceive('in', { body: '  ' }, {}, 30)).rejects.toThrow(
      ReplyTimeoutError,
    );
    expect(w.errors).toEqual([]);
    expect(w.registry.list().map((c) => c.name)).not.toContainEqual(
      expect.stringMatching(/^reply\./),
    );
  });

  it('answers the caller at once with a fixed value when the message is dropped', async () => {
    const w = world();
    const flow = IntegrationFlow.from('in').filter(hasText, {
      id: 'skip-empty',
      whenDropped: { reply: { status: 'ignored', reason: 'empty' } },
    });
    const executor = bindFlow(definition('f', echoFlow(flow)), w.registry);
    const run = jest.spyOn(executor, 'execute');

    const startedAt = Date.now();
    const reply = await w.gateway.sendAndReceive('in', { body: ' ' }, {}, 10_000);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(reply).toEqual({ status: 'ignored', reason: 'empty' });
    await expect(run.mock.results[0]?.value).resolves.toMatchObject({ status: 'filtered' });
    expect(w.errors).toEqual([]);
  });

  it('answers with what a function computes from the payload and message, sync or async', async () => {
    const w = world();
    const sync = IntegrationFlow.from('in').filter(hasText, {
      whenDropped: {
        reply: (payload, msg) => ({
          skipped: (payload as { id: string }).id,
          tenant: msg.headers.tenant,
        }),
      },
    });
    bindFlow(definition('sync', echoFlow(sync)), w.registry);
    const async = IntegrationFlow.from('in.async').filter(hasText, {
      whenDropped: {
        reply: (payload) => Promise.resolve(`dropped ${(payload as { id: string }).id}`),
      },
    });
    bindFlow(definition('async', echoFlow(async)), w.registry);

    await expect(
      w.gateway.sendAndReceive('in', { id: 'm-1', body: '' }, { tenant: 'acme' }, 1_000),
    ).resolves.toEqual({ skipped: 'm-1', tenant: 'acme' });
    await expect(
      w.gateway.sendAndReceive('in.async', { id: 'm-2', body: '' }, {}, 1_000),
    ).resolves.toBe('dropped m-2');
  });

  it('carries the trace of the dropped message on the reply', async () => {
    const w = world();
    const flow = IntegrationFlow.from('in').filter(() => false, { whenDropped: { reply: 'ok' } });
    bindFlow(definition('f', flow), w.registry);

    const reply = await w.gateway.sendAndReceiveMessage(
      'in',
      { body: '' },
      { traceId: 't-9', correlationId: 'c-9' },
      1_000,
    );

    expect(reply.payload).toBe('ok');
    expect(reply.headers).toMatchObject({ traceId: 't-9', correlationId: 'c-9' });
    expect(reply.headers).not.toHaveProperty('planB');
  });

  it('kept messages go on unchanged: the drop reply is never sent for them', async () => {
    const w = world();
    const reply = jest.fn(() => 'dropped');
    const flow = IntegrationFlow.from('in').filter(hasText, { whenDropped: { reply } });
    bindFlow(definition('f', echoFlow(flow)), w.registry);

    await expect(w.gateway.sendAndReceive('in', { body: 'hola' }, {}, 1_000)).resolves.toEqual({
      echoed: { body: 'hola' },
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it('a dropped message without a reply channel stays a silent drop', async () => {
    const w = world();
    const reply = jest.fn(() => 'dropped');
    const out = w.inbox('out');
    const flow = IntegrationFlow.from('in').filter(hasText, { whenDropped: { reply } }).to('out');
    const executor = bindFlow(definition('f', flow), w.registry);
    const run = jest.spyOn(executor, 'execute');

    await w.registry.send('in', { body: '' });

    expect(out).toEqual([]);
    expect(reply).not.toHaveBeenCalled();
    await expect(run.mock.results[0]?.value).resolves.toMatchObject({ status: 'filtered' });
    expect(w.errors).toEqual([]);
  });

  it('a drop reply function that throws fails the flow and reports to error.channel', async () => {
    const w = world();
    const flow = IntegrationFlow.from('in').filter(() => false, {
      whenDropped: {
        reply: () => {
          throw new Error('no reply for you');
        },
      },
    });
    bindFlow(definition('f', flow), w.registry);

    await expect(w.gateway.sendAndReceive('in', {}, {}, 1_000)).rejects.toThrow('no reply for you');
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]).toMatchObject({ flow: 'f' });
  });

  it('a filter in a jump target flow answers the jump at once', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition(
        'target',
        echoFlow(
          IntegrationFlow.from('check').filter(() => false, {
            whenDropped: { reply: { allowed: false } },
          }),
        ),
      ),
      w.registry,
    );
    bindFlow(
      definition(
        'parent',
        IntegrationFlow.from('in').jump('check', { timeoutMs: 10_000 }).to('out'),
      ),
      w.registry,
    );

    const startedAt = Date.now();
    await w.registry.send('in', { n: 1 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(out[0]?.headers.jumpReplies).toEqual({ check: { allowed: false } });
  });

  it('completes the flow claim as filtered; a repeat is a duplicate and gets no second reply', async () => {
    const w = world();
    const idempotency = new MemoryIdempotencyStore();
    const complete = jest.spyOn(idempotency, 'complete');
    const flow = IntegrationFlow.from('in').filter(() => false, {
      whenDropped: { reply: 'dropped' },
    });
    bindFlow(definition('f', flow), w.registry, { idempotency });

    await expect(
      w.gateway.sendAndReceive('in', {}, { idempotencyKey: 'k-1' }, 1_000),
    ).resolves.toBe('dropped');
    expect(complete).toHaveBeenCalledWith('flow:f', 'k-1', { filtered: true });
    await expect(w.gateway.sendAndReceive('in', {}, { idempotencyKey: 'k-1' }, 30)).rejects.toThrow(
      ReplyTimeoutError,
    );
  });

  it('shows the option in inspect(), never the value; the default description is unchanged', () => {
    const fixed = IntegrationFlow.from('in').filter(() => false, {
      whenDropped: { reply: { secret: 'sk-live-123' } },
    });
    const computed = IntegrationFlow.from('in').filter(() => false, {
      whenDropped: { reply: () => 'x' },
    });
    const plain = IntegrationFlow.from('in').filter(() => false);

    expect(fixed.inspect().steps).toEqual([{ kind: 'filter', whenDropped: 'reply' }]);
    expect(computed.inspect().steps).toEqual([{ kind: 'filter', whenDropped: 'reply' }]);
    expect(plain.inspect().steps).toEqual([{ kind: 'filter' }]);
    expect(JSON.stringify(fixed.inspect())).not.toContain('sk-live-123');
  });

  it('refuses a whenDropped without reply when the flow is built', () => {
    const flow = IntegrationFlow.from('in').filter(() => false, {
      id: 'skip',
      whenDropped: {} as never,
    });

    expect(() => flow.build()).toThrow(FlowDefinitionError);
    try {
      flow.build();
    } catch (error) {
      expect((error as FlowDefinitionError).codes).toEqual([FLOW_SHAPE_CODES.dropReplyMissing]);
      expect((error as Error).message).toBe("step 'skip': whenDropped.reply is required");
    }
  });
});
