import { ChannelRegistry } from '../channel-registry';
import { createMessage, type IntegrationMessage } from '../message';
import { TraceContext } from '../trace/trace-context';
import { FlowDefinitionError } from './flow-definition-error';
import { FlowExecutor } from './flow-executor';
import { IntegrationFlow, stepIdOf } from './integration-flow';

function definitionError(fn: () => unknown): FlowDefinitionError {
  try {
    fn();
  } catch (error) {
    if (error instanceof FlowDefinitionError) return error;
    throw error;
  }
  throw new Error('expected a FlowDefinitionError');
}

describe('flow DSL options (RS-55, RS-57, RS-58 shape)', () => {
  it('RU-57 step ids default to <kind>#<index> and an explicit id wins', () => {
    const built = IntegrationFlow.from('in')
      .filter(() => true)
      .handle((p) => p, { id: 'enrich' })
      .to('out')
      .build();
    expect(built.steps.map((step, index) => stepIdOf(step, index))).toEqual([
      'filter#0',
      'enrich',
      'to#2',
    ]);
  });

  it('RU-57 two steps with the same id fail the build with DUPLICATE_STEP_ID', () => {
    const error = definitionError(() =>
      IntegrationFlow.from('in')
        .handle((p) => p, { id: 'x' })
        .publish('a', { id: 'x' })
        .build(),
    );
    expect(error.codes).toEqual(['DUPLICATE_STEP_ID']);
    expect(error.findings[0]).toMatchObject({ concern: 'flow', severity: 'error', path: 'id' });
    expect(error.message).toContain("step 'x'");
  });

  it('RU-57 care on filter, transform or reply fails the build with CARE_PART_NOT_ALLOWED', () => {
    const policy = { care: { tries: { max: 2 } } } as never;
    const error = definitionError(() =>
      IntegrationFlow.from('in')
        .filter(() => true, policy)
        .transform((p) => p, policy)
        .reply(policy)
        .build(),
    );
    expect(error.codes).toEqual([
      'CARE_PART_NOT_ALLOWED',
      'CARE_PART_NOT_ALLOWED',
      'CARE_PART_NOT_ALLOWED',
    ]);
    expect(error.findings.map((finding) => finding.subject)).toEqual([
      "step 'filter#0'",
      "step 'transform#1'",
      "step 'reply#2'",
    ]);
  });

  it('RU-58 care on wireTap fails the build with WIRETAP_CARE', () => {
    const error = definitionError(() =>
      IntegrationFlow.from('in')
        .wireTap('tap', { care: { tries: { max: 2 } } } as never)
        .build(),
    );
    expect(error.codes).toEqual(['WIRETAP_CARE']);
    expect(error.findings[0]?.path).toBe('care');
  });

  it('RU-57 publish(channel, opts) sets no routing key and publish(channel, key, opts) does', () => {
    const flow = IntegrationFlow.from('in')
      .publish('a', { id: 'p1' })
      .publish('b', 'rk.1', { id: 'p2' })
      .publish('c', 'rk.2');
    expect(flow.inspect().steps).toEqual([
      { kind: 'publish', channel: 'a', routingKey: undefined },
      { kind: 'publish', channel: 'b', routingKey: 'rk.1' },
      { kind: 'publish', channel: 'c', routingKey: 'rk.2' },
    ]);
  });

  it('RU-55 from(source, options) carries the flow options in BuiltFlow.options', () => {
    const options = { care: { send: { tries: { max: 2 } } } };
    expect(IntegrationFlow.from('in', options).to('out').build().options).toBe(options);
    expect('options' in IntegrationFlow.from('in').to('out').build()).toBe(false);
  });

  it('RU-66 describe() never shows a target care reference', () => {
    const flow = IntegrationFlow.from('in')
      .jumpTo(['a', { channel: 'b', wait: false, care: { tries: false } }])
      .fanoutTo([{ channel: 'c', care: 'p' }]);
    expect(flow.inspect().steps).toEqual([
      { kind: 'jump', dests: [{ channel: 'a' }, { channel: 'b', wait: false }] },
      { kind: 'fanout', dests: [{ channel: 'c' }] },
    ]);
  });

  it('RU-70 steps with only an id or a reply id run exactly as without options', async () => {
    const registry = new ChannelRegistry({ trace: new TraceContext() });
    registry.create({ name: 'error.channel', type: 'pubsub' });
    registry.create({ name: 'in', type: 'direct' });
    const replies: IntegrationMessage[] = [];
    registry.create({ name: 'caller', type: 'direct' }).subscribe(async (msg) => {
      replies.push(msg);
    });
    const built = IntegrationFlow.from('in')
      .transform((p) => `${String(p)}!`, { id: 't' })
      .reply({ id: 'r', payload: 'current' })
      .build();
    new FlowExecutor('f', built, {
      registry,
      trace: registry.trace,
      errorChannel: 'error.channel',
    }).attachTo(registry);
    await registry.sendMessage('in', createMessage('hi', { replyChannel: 'caller' }));
    expect(replies.map((msg) => msg.payload)).toEqual(['hi!']);
    expect(replies[0]?.headers).not.toHaveProperty('planB');
  });
});
