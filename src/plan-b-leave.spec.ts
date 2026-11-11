import 'reflect-metadata';

import { discoverActivators, subscribeActivators } from './activator/activator-wrapper';
import { ChannelRegistry } from './channel-registry';
import { ServiceActivator } from './decorators';
import { FlowParameterResolver } from './flow/flow-parameter-resolver';
import { IntegrationFlow, type FlowDefinition } from './flow/integration-flow';
import { ReplyGateway } from './gateway/reply-gateway';
import { IdempotencyService } from './idempotency/idempotency.service';
import { MemoryIdempotencyStore } from './idempotency/memory-idempotency.store';
import { createMessage, JUMP_REPLY_HEADER, type IntegrationMessage } from './message';
import { OutboundRestGateway } from './outbound/outbound-rest.gateway';
import type { OutboundFetch } from './outbound/outbound.types';
import { CareConfigError, PlanBFailedError } from './resilience/resilience.errors';
import { describeCare, resolveCarePlan } from './resilience/resilience.plan';
import {
  PlanBMode,
  type Care,
  type CareEvent,
  type CareModuleOptions,
} from './resilience/resilience.types';
import { PLAN_B_HEADER } from './resilience/retry-budget';
import { CareEngine } from './resilience/runtime';
import { SagaDefinitionError } from './saga/concurrency-errors';
import { saga } from './saga/saga';
import { bindFlow } from './testing';
import { TraceContext } from './trace/trace-context';

const flaky = (): Error => Object.assign(new Error('flaky'), { retryable: true });

function configError(fn: () => unknown): CareConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CareConfigError);
    return error as CareConfigError;
  }
  throw new Error('expected a CareConfigError');
}

interface World {
  registry: ChannelRegistry;
  runtime: CareEngine;
  events: CareEvent[];
  errors: unknown[];
  store: MemoryIdempotencyStore;
  idempotency: IdempotencyService;
  gateway: ReplyGateway;
}

function world(options: CareModuleOptions = {}): World {
  const trace = new TraceContext();
  const registry = new ChannelRegistry({ trace });
  registry.create({ name: 'error.channel', type: 'pubsub' });
  const errors: unknown[] = [];
  registry.get('error.channel').subscribe((msg) => {
    errors.push(msg.payload);
  });
  // Parked replies: a queue nobody consumes until a drain subscribes.
  registry.create({ name: 'wa.reply.parked', type: 'queue' });
  const events: CareEvent[] = [];
  const runtime = new CareEngine({ ...options, events: { onEvent: (e) => events.push(e) } });
  const store = new MemoryIdempotencyStore();
  const idempotency = new IdempotencyService({ store });
  const gateway = new ReplyGateway({ registry, trace, defaultTimeoutMs: 500 });
  return {
    registry,
    runtime,
    events,
    errors,
    store,
    idempotency,
    gateway,
  };
}

/** Subscribes a drain consumer to the parked queue and returns what it collects. */
function drain(registry: ChannelRegistry, channel = 'wa.reply.parked'): IntegrationMessage[] {
  const drained: IntegrationMessage[] = [];
  registry.get(channel).subscribe((msg) => {
    drained.push(msg);
  });
  return drained;
}

/** Lets the queue pump hand every buffered message to the drain (one per turn). */
async function tick(turns = 5): Promise<void> {
  for (let n = 0; n < turns; n += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('planB mode Leave (SPI-448 gap planb-park)', () => {
  describe('care plan', () => {
    const resolve = (care: Care) => resolveCarePlan('wa.send', [care], 'activator');

    it('resolves the mode: Ask by default with a channel, Leave when set, none with a value', () => {
      expect(resolve({ planB: { channel: 'p' } }).planB?.mode).toBe(PlanBMode.Ask);
      expect(resolve({ planB: { channel: 'p', mode: PlanBMode.Ask } }).planB?.mode).toBe(
        PlanBMode.Ask,
      );
      const leave = resolve({ planB: { channel: 'p', mode: PlanBMode.Leave } });
      expect(leave.planB?.mode).toBe(PlanBMode.Leave);
      expect(resolve({ planB: { value: () => 1 } }).planB).not.toHaveProperty('mode');
      // A JavaScript caller may pass the raw string value.
      expect(resolve({ planB: { channel: 'p', mode: 'leave' as PlanBMode } }).planB?.mode).toBe(
        PlanBMode.Leave,
      );
    });

    it('Leave may carry a value: the answer given after the message is left', () => {
      const plan = resolve({
        planB: { channel: 'p', mode: PlanBMode.Leave, value: () => ({ status: 'parked' }) },
      });
      expect(plan.planB?.channel).toBe('p');
      expect(plan.planB?.value).toBeInstanceOf(Function);
    });

    it('refuses invalid combinations with CareConfigError and the option path', () => {
      const cases: [Care, string, string][] = [
        [
          { planB: { value: () => 1, mode: PlanBMode.Leave } },
          'planB.mode',
          'wa.send: care.planB.mode needs a channel',
        ],
        [
          { planB: { channel: 'p', mode: 'park' as PlanBMode } },
          'planB.mode',
          'wa.send: care.planB.mode must be PlanBMode.Ask or PlanBMode.Leave',
        ],
        [
          { planB: { channel: 'p', value: () => 1 } },
          'planB',
          'wa.send: care.planB must set exactly one of value or channel, or both with mode PlanBMode.Leave',
        ],
        [
          { planB: { channel: 'p', value: () => 1, mode: PlanBMode.Ask } },
          'planB',
          'wa.send: care.planB must set exactly one of value or channel, or both with mode PlanBMode.Leave',
        ],
        [
          { planB: { channel: 'p', mode: PlanBMode.Leave, cacheable: true } },
          'planB.cacheable',
          'wa.send: care.planB.cacheable is not allowed with mode PlanBMode.Leave',
        ],
      ];
      for (const [care, path, message] of cases) {
        const error = configError(() => resolve(care));
        expect(error.path).toBe(path);
        expect(error.message).toBe(message);
      }
    });

    it('a profile override that sets a new channel or value also decides the mode', () => {
      const profiles = { parked: { planB: { channel: 'p', mode: PlanBMode.Leave } } };
      const plan = (care: Care & { use: string }) =>
        resolveCarePlan('wa.send', [care], 'activator', { profiles }).planB;
      expect(plan({ use: 'parked' })?.mode).toBe(PlanBMode.Leave);
      expect(plan({ use: 'parked', planB: { channel: 'q' } })?.mode).toBe(PlanBMode.Ask);
      expect(plan({ use: 'parked', planB: { value: () => 1 } })).not.toHaveProperty('channel');
      expect(plan({ use: 'parked', planB: { on: ['transient'] } })?.mode).toBe(PlanBMode.Leave);
    });

    it('shows the mode in the care summary only when the message is left', () => {
      expect(describeCare(resolve({ planB: { channel: 'p' } }))).toBe('plan-b');
      expect(describeCare(resolve({ planB: { channel: 'p', mode: PlanBMode.Leave } }))).toBe(
        'plan-b leave',
      );
    });
  });

  describe('activator', () => {
    class SendActivator {
      calls = 0;

      @ServiceActivator('wa.send', {
        care: {
          tries: { max: 1 },
          planB: {
            channel: 'wa.reply.parked',
            mode: PlanBMode.Leave,
            value: (_error, ctx) => ({
              status: 'parked',
              inReplyTo: (ctx.message?.payload as { inReplyTo: string }).inReplyTo,
            }),
          },
        },
      })
      send(): never {
        this.calls += 1;
        throw flaky();
      }
    }

    class SilentLeaveActivator {
      @ServiceActivator('wa.notify', {
        care: { planB: { channel: 'wa.reply.parked', mode: PlanBMode.Leave } },
      })
      notify(): never {
        throw flaky();
      }
    }

    function subscribe(w: World, ...instances: object[]): void {
      for (const name of ['wa.send', 'wa.notify']) {
        if (w.registry.tryGet(name) === undefined) w.registry.create({ name, type: 'direct' });
      }
      subscribeActivators(discoverActivators(instances), {
        registry: w.registry,
        trace: w.registry.trace,
        errorChannel: 'error.channel',
        idempotency: w.idempotency,
        care: w.runtime,
      });
    }

    it('leaves the message on the channel and answers the caller with the value, marked plan B', async () => {
      const w = world();
      const instance = new SendActivator();
      subscribe(w, instance);
      const replies: IntegrationMessage[] = [];
      w.registry.create({ name: 'caller', type: 'direct' }).subscribe((msg) => {
        replies.push(msg);
      });
      const request = { inReplyTo: 'SM01', body: 'Hola' };
      const msg = createMessage(request, {
        replyChannel: 'caller',
        idempotencyKey: 'SM01',
        traceId: 'trace-1',
        organizationId: 'org-1',
      });
      await w.registry.sendMessage('wa.send', msg);

      expect(replies.map((r) => r.payload)).toEqual([{ status: 'parked', inReplyTo: 'SM01' }]);
      expect(replies[0]?.headers[PLAN_B_HEADER]).toBe(true);
      const parked = drain(w.registry);
      await tick();
      expect(parked).toHaveLength(1);
      expect(parked[0]?.payload).toEqual(request);
      expect(parked[0]?.headers).toMatchObject({
        idempotencyKey: 'SM01',
        traceId: 'trace-1',
        causationId: msg.headers.id,
        organizationId: 'org-1',
      });
      expect(parked[0]?.headers).not.toHaveProperty('replyChannel');
      expect(parked[0]?.headers).not.toHaveProperty(JUMP_REPLY_HEADER);
      expect(parked[0]?.headers).not.toHaveProperty(PLAN_B_HEADER);
      expect(w.events.filter((e) => e.type.startsWith('plan-b'))).toEqual([
        expect.objectContaining({ type: 'plan-b.used', edge: 'activator', class: 'transient' }),
      ]);
      expect(w.errors).toEqual([]);
    });

    it('a request/reply caller gets the answer at once; plan B is never stored as the result', async () => {
      const w = world();
      const instance = new SendActivator();
      subscribe(w, instance);
      const ask = () =>
        w.gateway.sendAndReceive('wa.send', { inReplyTo: 'SM02' }, { idempotencyKey: 'SM02' });
      await expect(ask()).resolves.toEqual({ status: 'parked', inReplyTo: 'SM02' });
      // The claim was not completed with the plan B answer: the redelivery runs the call again.
      await expect(ask()).resolves.toEqual({ status: 'parked', inReplyTo: 'SM02' });
      expect(instance.calls).toBe(2);
      const record = await w.store.get('activator:SendActivator.send', 'SM02');
      expect(record?.status).not.toBe('completed');
      const parked = drain(w.registry);
      await tick();
      expect(parked).toHaveLength(2);
    });

    it('without a value the message is left and nobody is answered', async () => {
      const w = world();
      subscribe(w, new SilentLeaveActivator());
      const replies: unknown[] = [];
      w.registry.create({ name: 'caller', type: 'direct' }).subscribe((msg) => {
        replies.push(msg.payload);
      });
      await w.registry.send('wa.notify', { body: 'x' }, { replyChannel: 'caller' });
      expect(replies).toEqual([]);
      const parked = drain(w.registry);
      await tick();
      expect(parked.map((m) => m.payload)).toEqual([{ body: 'x' }]);
      expect(w.events.map((e) => e.type)).toContain('plan-b.used');
    });

    it('a send that fails on the channel fails plan B, emits plan-b.failed and reports to error.channel', async () => {
      const instance = new SendActivator();
      // The parked channel is a direct channel whose consumer is down.
      const registry = new ChannelRegistry({ trace: new TraceContext() });
      registry.create({ name: 'error.channel', type: 'pubsub' });
      const errors: unknown[] = [];
      registry.get('error.channel').subscribe((msg) => {
        errors.push(msg.payload);
      });
      registry.create({ name: 'wa.send', type: 'direct' });
      registry.create({ name: 'wa.reply.parked', type: 'direct' }).subscribe(() => {
        throw new Error('park store down');
      });
      const events: CareEvent[] = [];
      subscribeActivators(discoverActivators([instance]), {
        registry,
        trace: registry.trace,
        errorChannel: 'error.channel',
        care: new CareEngine({ events: { onEvent: (e) => events.push(e) } }),
      });
      await expect(registry.send('wa.send', { inReplyTo: 'SM03' })).rejects.toBeInstanceOf(
        PlanBFailedError,
      );
      expect(events.map((e) => e.type)).toContain('plan-b.failed');
      expect(errors).toHaveLength(1);
    });

    it('refuses an unknown Leave channel when the activator subscribes', () => {
      class UnknownChannel {
        @ServiceActivator('wa.send', {
          care: { planB: { channel: 'nowhere', mode: PlanBMode.Leave } },
        })
        send(): string {
          return 'ok';
        }
      }
      const w = world();
      w.registry.create({ name: 'wa.send', type: 'direct' });
      const error = configError(() =>
        subscribeActivators(discoverActivators([new UnknownChannel()]), {
          registry: w.registry,
          trace: w.registry.trace,
          errorChannel: 'error.channel',
          care: w.runtime,
        }),
      );
      expect(error.path).toBe('planB.channel');
      expect(error.message).toContain("names an unknown channel 'nowhere'");
    });
  });

  describe('outbound REST', () => {
    const down: OutboundFetch = () =>
      Promise.resolve({
        ok: false,
        status: 503,
        headers: {},
        text: () => Promise.resolve('{}'),
      });

    it('leaves the request message on the channel and answers with the value', async () => {
      const w = world();
      const gateway = new OutboundRestGateway({
        registry: w.registry,
        care: w.runtime,
        fetchFn: down,
      });
      gateway.bind({
        name: 'wa.http',
        url: 'https://wa.example/messages',
        care: {
          tries: { max: 1 },
          planB: {
            channel: 'wa.reply.parked',
            mode: PlanBMode.Leave,
            value: () => ({ status: 'parked' }),
          },
        },
      });
      const result = await gateway.request('wa.http', {
        payload: { body: 'Hola' },
        headers: { idempotencyKey: 'SM04', organizationId: 'org-1' },
      });
      expect(result).toEqual({ status: 'parked' });
      const parked = drain(w.registry);
      await tick();
      expect(parked.map((m) => m.payload)).toEqual([{ body: 'Hola' }]);
      expect(parked[0]?.headers).toMatchObject({
        idempotencyKey: 'SM04',
        organizationId: 'org-1',
      });
      expect(w.events.map((e) => e.type)).toContain('plan-b.used');
    });

    it('refuses an unknown Leave channel when the binding is declared', () => {
      const w = world();
      const gateway = new OutboundRestGateway({ registry: w.registry, care: w.runtime });
      const error = configError(() =>
        gateway.bind({
          name: 'wa.http',
          url: 'https://wa.example/messages',
          care: { planB: { channel: 'nowhere', mode: PlanBMode.Leave } },
        }),
      );
      expect(error.path).toBe('planB.channel');
    });
  });

  describe('flow steps', () => {
    const definition = (name: string, flow: IntegrationFlow): FlowDefinition => ({
      name,
      build: () => flow,
    });

    function inbox(registry: ChannelRegistry, channel: string, handler?: () => void) {
      const received: IntegrationMessage[] = [];
      if (registry.tryGet(channel) === undefined)
        registry.create({ name: channel, type: 'direct' });
      registry.get(channel).subscribe((msg) => {
        received.push(msg);
        handler?.();
      });
      return received;
    }

    it('handle: leaves the message and goes on with the value as the payload', async () => {
      const w = world();
      const out = inbox(w.registry, 'out');
      bindFlow(
        definition(
          'f',
          IntegrationFlow.from('in')
            .handle(
              () => {
                throw flaky();
              },
              {
                care: {
                  planB: {
                    channel: 'wa.reply.parked',
                    mode: PlanBMode.Leave,
                    value: () => 'holding',
                  },
                },
              },
            )
            .to('out'),
        ),
        w.registry,
        { care: w.runtime },
      );
      await w.registry.send('in', 'question', { replyChannel: 'caller', idempotencyKey: 'k-1' });
      expect(out.map((m) => m.payload)).toEqual(['holding']);
      const parked = drain(w.registry);
      await tick();
      expect(parked.map((m) => m.payload)).toEqual(['question']);
      expect(parked[0]?.headers).not.toHaveProperty('replyChannel');
      expect(parked[0]?.headers.idempotencyKey).toBe('k-1');
    });

    it('to: Leave sends the same hop without reply routing; the default re-send keeps it (0.9.0)', async () => {
      const w = world();
      inbox(w.registry, 'a', () => {
        throw flaky();
      });
      inbox(w.registry, 'b', () => {
        throw flaky();
      });
      const left = inbox(w.registry, 'left');
      const kept = inbox(w.registry, 'kept');
      bindFlow(
        definition(
          'leave',
          IntegrationFlow.from('in.leave').to('a', {
            care: { planB: { channel: 'left', mode: PlanBMode.Leave } },
          }),
        ),
        w.registry,
        { care: w.runtime },
      );
      bindFlow(
        definition(
          'resend',
          IntegrationFlow.from('in.resend').to('b', { care: { planB: { channel: 'kept' } } }),
        ),
        w.registry,
        { care: w.runtime },
      );
      const headers = { replyChannel: 'caller', [JUMP_REPLY_HEADER]: '1', organizationId: 'o' };
      await w.registry.send('in.leave', 'x', headers);
      await w.registry.send('in.resend', 'y', headers);
      expect(left.map((m) => m.payload)).toEqual(['x']);
      expect(left[0]?.headers).not.toHaveProperty('replyChannel');
      expect(left[0]?.headers).not.toHaveProperty(JUMP_REPLY_HEADER);
      expect(left[0]?.headers.organizationId).toBe('o');
      expect(kept[0]?.headers.replyChannel).toBe('caller');
      expect(w.events.filter((e) => e.type === 'plan-b.used')).toHaveLength(2);
    });

    it('to: refuses Ask and a Leave value; both have no answer to take on a send step', () => {
      const w = world();
      w.registry.create({ name: 'a', type: 'direct' });
      const findings = (care: Care) => {
        try {
          new FlowParameterResolver(w.runtime, w.registry).resolve([
            definition('f', IntegrationFlow.from('in').to('a', { care })),
          ]);
        } catch (error) {
          return (error as CareConfigError).findings.map((f) => [f.code, f.path]);
        }
        return [];
      };
      expect(findings({ planB: { channel: 'wa.reply.parked', mode: PlanBMode.Ask } })).toEqual([
        ['CARE_PART_NOT_ALLOWED', expect.stringContaining('care.planB')],
      ]);
      expect(
        findings({
          planB: { channel: 'wa.reply.parked', mode: PlanBMode.Leave, value: () => 1 },
        }),
      ).toEqual([['CARE_PART_NOT_ALLOWED', expect.stringContaining('care.planB')]]);
      expect(findings({ planB: { channel: 'nowhere', mode: PlanBMode.Leave } })).toEqual([
        ['PLAN_B_CHANNEL_MISSING', expect.stringContaining('care.planB.channel')],
      ]);
    });

    it('jump: the value becomes the jump reply, marked plan B', async () => {
      const w = world();
      inbox(w.registry, 'routing.resolve', () => {
        throw flaky();
      });
      const out = inbox(w.registry, 'out');
      bindFlow(
        definition(
          'f',
          IntegrationFlow.from('in')
            .jump('routing.resolve', {
              care: {
                planB: {
                  channel: 'wa.reply.parked',
                  mode: PlanBMode.Leave,
                  value: () => ({ agentId: null }),
                },
              },
            })
            .to('out'),
        ),
        w.registry,
        { care: w.runtime },
      );
      await w.registry.send('in', { text: 'hola' });
      expect(out).toHaveLength(1);
      expect(out[0]?.headers.jumpReplies?.['routing.resolve']).toEqual({ agentId: null });
      expect((out[0]?.headers.jumpPlanB as Record<string, boolean>)['routing.resolve']).toBe(true);
      const parked = drain(w.registry);
      await tick();
      expect(parked.map((m) => m.payload)).toEqual([{ text: 'hola' }]);
    });
  });

  it('saga outbound steps still refuse plan B, Leave included', () => {
    expect(() =>
      saga<object, unknown, unknown>('s').outbound('pay', () => undefined, {
        care: { planB: { channel: 'wa.reply.parked', mode: PlanBMode.Leave } },
      }),
    ).toThrow(SagaDefinitionError);
  });
});
