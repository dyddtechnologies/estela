import 'reflect-metadata';

import { subscribeActivators, discoverActivators } from '../activator/activator-wrapper';
import { ChannelRegistry } from '../channel-registry';
import { ServiceActivator } from '../decorators';
import { ReplyGateway } from '../gateway/reply-gateway';
import { JUMP_REPLY_HEADER, type IntegrationMessage } from '../message';
import { bindFlow } from '../testing';
import { TraceContext } from '../trace/trace-context';
import { IntegrationFlow, type FlowDefinition } from './integration-flow';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** An audit consumer that answers: before the fix its answer reached the caller. */
class AuditActivator {
  readonly seen: IntegrationMessage[] = [];

  @ServiceActivator('audit')
  record(_payload: unknown, msg: IntegrationMessage): unknown {
    this.seen.push(msg);
    return { audited: true };
  }
}

/** The real service: it answers a little later than the audit, so a leaked audit answer wins. */
class ServiceActivatorImpl {
  @ServiceActivator('svc')
  async serve(payload: unknown): Promise<unknown> {
    await delay(20);
    return { served: payload };
  }
}

interface World {
  registry: ChannelRegistry;
  gateway: ReplyGateway;
  audit: AuditActivator;
  errors: unknown[];
  inbox(channel: string): IntegrationMessage[];
}

function world(): World {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  const errors: unknown[] = [];
  registry.get('error.channel').subscribe((msg) => {
    errors.push(msg.payload);
  });
  registry.create({ name: 'audit', type: 'direct' });
  registry.create({ name: 'svc', type: 'direct' });
  const audit = new AuditActivator();
  subscribeActivators(discoverActivators([audit, new ServiceActivatorImpl()]), {
    registry,
    trace: registry.trace,
    errorChannel: 'error.channel',
  });
  return {
    registry,
    gateway: new ReplyGateway({ registry, trace: registry.trace }),
    audit,
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

const tappedFlow = (): IntegrationFlow =>
  IntegrationFlow.from('in').wireTap('audit', { id: 'audit' }).to('svc');

describe('flow wireTap sends with no reply channel (SPI-448 gap wiretap-reply)', () => {
  it('an audit activator that returns a value never answers the caller; the real reply arrives once', async () => {
    const w = world();
    bindFlow(definition('f', tappedFlow()), w.registry);

    await expect(w.gateway.sendAndReceive('in', { n: 1 }, {}, 1_000)).resolves.toEqual({
      served: { n: 1 },
    });

    const replies = w.inbox('caller.reply');
    await w.registry.send('in', { n: 2 }, { replyChannel: 'caller.reply' });
    await delay(50);
    expect(replies.map((r) => r.payload)).toEqual([{ served: { n: 2 } }]);
    expect(w.audit.seen).toHaveLength(2);
    expect(w.errors).toEqual([]);
  });

  it('the tap copy has no reply routing; it keeps the trace, the custom headers and the jump replies', async () => {
    const w = world();
    bindFlow(definition('f', tappedFlow()), w.registry);
    w.inbox('caller.reply');

    await w.registry.send(
      'in',
      { n: 1 },
      {
        replyChannel: 'caller.reply',
        traceId: 't-1',
        correlationId: 'c-1',
        tenant: 'acme',
        jumpReplies: { earlier: { ok: true } },
      },
    );
    await delay(50);

    const tap = w.audit.seen[0]!;
    expect(tap.headers).not.toHaveProperty('replyChannel');
    expect(tap.headers).not.toHaveProperty(JUMP_REPLY_HEADER);
    expect(tap.headers).toMatchObject({
      traceId: 't-1',
      correlationId: 'c-1',
      tenant: 'acme',
      jumpReplies: { earlier: { ok: true } },
    });
  });

  it('a tap in a jump target flow never answers the jump; the jump gets the real reply', async () => {
    const w = world();
    const out = w.inbox('out');
    bindFlow(
      definition('target', IntegrationFlow.from('check').wireTap('audit').to('svc')),
      w.registry,
    );
    bindFlow(
      definition(
        'parent',
        IntegrationFlow.from('in').jump('check', { timeoutMs: 1_000 }).to('out'),
      ),
      w.registry,
    );

    await w.registry.send('in', { n: 3 });
    await delay(50);

    expect(out).toHaveLength(1);
    expect(out[0]?.headers.jumpReplies).toEqual({ check: { served: { n: 3 } } });
    const tap = w.audit.seen[0]!;
    expect(tap.headers).not.toHaveProperty('replyChannel');
    expect(tap.headers).not.toHaveProperty(JUMP_REPLY_HEADER);
    expect(w.errors).toEqual([]);
  });

  it('the main message keeps its reply channel after the tap', async () => {
    const w = world();
    bindFlow(
      definition(
        'f',
        IntegrationFlow.from('in')
          .wireTap('audit')
          .transform((payload) => ({ echoed: payload }))
          .reply(),
      ),
      w.registry,
    );

    await expect(w.gateway.sendAndReceive('in', 'hola', {}, 1_000)).resolves.toEqual({
      echoed: 'hola',
    });
  });
});
