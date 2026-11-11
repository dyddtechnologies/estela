import { ChannelRegistry } from '../channel-registry';
import { RESERVED_HEADER_NAMES, type IntegrationMessage } from '../message';
import { PLAN_B_HEADER, TRIES_LEFT_MESSAGE_HEADER } from '../resilience/retry-budget';
import { CareEngine } from '../resilience/runtime';
import { manualCareClock } from '../testing/manual-resilience-clock';
import { bindFlow } from '../testing';
import { TraceContext } from '../trace/trace-context';
import { FlowDefinitionError, FLOW_SHAPE_CODES } from './flow-definition-error';
import { FlowParameterResolver } from './flow-parameter-resolver';
import { FlowHeadersError } from './flow-step';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

interface World {
  registry: ChannelRegistry;
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

describe('flow step headers (SPI-448 gap headers)', () => {
  it('merges a fixed object into the message headers and keeps the payload and trace', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition('f', IntegrationFlow.from('in').headers({ tenant: 'acme', lane: 2 }).to('out')),
      w.registry,
    );

    await w.registry.send('in', { n: 1 }, { traceId: 't-1', region: 'gt' });

    expect(out).toHaveLength(1);
    expect(out[0]?.payload).toEqual({ n: 1 });
    expect(out[0]?.headers).toMatchObject({
      tenant: 'acme',
      lane: 2,
      region: 'gt',
      traceId: 't-1',
    });
  });

  it('merges what a function returns, sync or async, computed from payload and headers', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .headers((payload) => ({ organizationId: (payload as { org: string }).org }))
          .headers(async (_payload, msg) =>
            Promise.resolve({ route: `${String(msg.headers.organizationId)}:wa` }),
          )
          .to('out'),
      ),
      w.registry,
    );

    await w.registry.send('in', { org: 'org-1' });

    expect(out[0]?.headers).toMatchObject({ organizationId: 'org-1', route: 'org-1:wa' });
  });

  it('overwrites a custom header and skips undefined values', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .headers(() => ({ tenant: 'new', gone: undefined }))
          .to('out'),
      ),
      w.registry,
    );

    await w.registry.send('in', 'x', { tenant: 'old' });

    expect(out[0]?.headers.tenant).toBe('new');
    expect(out[0]?.headers).not.toHaveProperty('gone');
  });

  it('refuses a reserved name in a fixed object when the flow is built', () => {
    const build = (): unknown =>
      IntegrationFlow.from('in')
        .headers({ traceId: 'forged', tenant: 'a' }, { id: 'stamp' })
        .to('out')
        .build();
    expect(build).toThrow(FlowDefinitionError);
    try {
      build();
    } catch (error) {
      expect((error as FlowDefinitionError).codes).toEqual([FLOW_SHAPE_CODES.reservedHeader]);
      expect((error as Error).message).toBe(
        "step 'stamp': headers.traceId is a reserved header and cannot be set by a flow",
      );
    }
  });

  it('fails the flow and reports to error.channel when a function returns a reserved name', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .headers(() => ({ idempotencyKey: 'forged', replyChannel: 'x' }))
          .to('out'),
      ),
      w.registry,
    );

    const failure = await w.registry.send('in', 'x').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FlowHeadersError);
    expect((failure as FlowHeadersError).names).toEqual(['idempotencyKey', 'replyChannel']);
    expect(out).toHaveLength(0);
    expect(w.errors).toHaveLength(1);
    expect(w.errors[0]?.flow).toBe('f');
  });

  it('fails the flow when a function returns something that is not a plain object', async () => {
    const w = world();
    w.inbox('out');
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .headers(() => ['a'] as unknown as Record<string, unknown>)
          .to('out'),
      ),
      w.registry,
    );

    await expect(w.registry.send('in', 'x')).rejects.toThrow(FlowHeadersError);
  });

  it('protects trace, reply, care and jump headers', () => {
    expect([...RESERVED_HEADER_NAMES].sort()).toEqual(
      [
        'id',
        'timestamp',
        'correlationId',
        'causationId',
        'traceId',
        'spanId',
        'parentSpanId',
        'replyChannel',
        'errorChannel',
        'idempotencyKey',
        'history',
        'jumpReplies',
        'jumpPlanB',
        TRIES_LEFT_MESSAGE_HEADER,
        PLAN_B_HEADER,
        'x-integration-jump-reply',
      ].sort(),
    );
  });

  it('shows header names in inspect() and the graph, never their values', () => {
    const flow = (): IntegrationFlow =>
      IntegrationFlow.from('in')
        .headers({ tenant: 'secret-value', lane: 2 }, { id: 'stamp' })
        .headers(() => ({ other: 'x' }))
        .to('out');
    expect(flow().inspect().steps.slice(0, 2)).toEqual([
      { kind: 'headers', names: ['lane', 'tenant'] },
      { kind: 'headers', computed: true },
    ]);
    const runtime = new CareEngine({ clock: manualCareClock() }, { enabled: true });
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    const described = new FlowParameterResolver(runtime, registry).resolve([
      definition('f', flow()),
    ]).flows[0]?.described;
    expect(described?.slice(0, 2)).toEqual([
      { kind: 'headers', id: 'stamp', names: ['lane', 'tenant'] },
      { kind: 'headers', computed: true },
    ]);
    expect(JSON.stringify(described)).not.toContain('secret-value');
  });

  it('refuses care on the step', () => {
    const build = (): unknown =>
      IntegrationFlow.from('in')
        .headers({ a: 1 }, { care: { tries: { max: 2 } } } as never)
        .build();
    expect(build).toThrow("step 'headers#0': care is not accepted on headers");
  });

  it('feeds a care key function of a later step', async () => {
    const w = world();
    w.inbox('wa.send');
    const seen: unknown[] = [];
    const runtime = new CareEngine({ clock: manualCareClock() }, { enabled: true });
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .headers((payload) => ({ businessNumber: (payload as { to: string }).to }))
          .to('wa.send', {
            care: {
              pace: {
                perSecond: 10,
                burst: 10,
                key: (ctx) => {
                  seen.push(ctx.message?.headers.businessNumber);
                  return String(ctx.message?.headers.businessNumber);
                },
              },
            },
          }),
      ),
      w.registry,
      { care: runtime },
    );

    await w.registry.send('in', { to: '+50224618427' });

    expect(seen).toContain('+50224618427');
  });
});
