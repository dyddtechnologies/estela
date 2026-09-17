import { ChannelRegistry } from '../channel-registry';
import { IntegrationFlow } from '../flow/integration-flow';
import { TraceContext } from '../trace/trace-context';
import { ChannelGraph } from './channel-graph';
import { ChannelGraphController } from './channel-graph.controller';

const makeWorld = () => {
  const registry = new ChannelRegistry({ trace: new TraceContext() });
  registry.create({ name: 'orders.place', type: 'direct' });
  registry.create({ name: 'orders.persist', type: 'direct' });
  registry.create({ name: 'orders.audit', type: 'queue' });
  registry.create({ name: 'inventory.reserve', type: 'direct' });
  registry.create({ name: 'billing.charge', type: 'direct' });
  registry.create({ name: 'domain.events', type: 'pubsub' });
  registry.create({ name: 'orders.local', type: 'queue' });
  registry.fanout('ops.fanout', ['inventory.reserve', 'billing.charge']);
  const graph = new ChannelGraph();
  return { registry, graph };
};

describe('ChannelGraph (spec §12)', () => {
  it('snapshot: nodes con kind/bindings/inbounds/activators/flowsFrom', () => {
    const { registry, graph } = makeWorld();
    graph.recordInbound({ channel: 'orders.place', transport: 'rest', requestReply: true });
    graph.recordActivator('inventory.reserve', 'InventoryActivator.reserve');
    const flow = IntegrationFlow.from('orders.place')
      .wireTap('orders.audit')
      .jumpTo([{ channel: 'inventory.reserve' }, { channel: 'billing.charge' }])
      .publish('domain.events', 'order.placed')
      .reply()
      .to('orders.persist');
    graph.recordFlow('place-order', flow.build());
    const snapshot = graph.snapshot(registry);

    const place = snapshot.nodes.find((n) => n.channel === 'orders.place');
    expect(place?.kind).toBe('direct');
    expect(place?.inbounds).toEqual([{ transport: 'rest', requestReply: true }]);
    expect(place?.flowsFrom).toEqual(['place-order']);

    const fanout = snapshot.nodes.find((n) => n.channel === 'ops.fanout');
    expect(fanout?.bindings).toEqual(['inventory.reserve', 'billing.charge']);

    const edges = snapshot.edges;
    expect(edges).toContainEqual({ from: 'ops.fanout', to: 'inventory.reserve', via: 'binding' });
    expect(edges).toContainEqual({
      from: 'orders.place',
      to: 'inventory.reserve',
      via: 'jump',
      flow: 'place-order',
    });
    expect(edges).toContainEqual({
      from: 'orders.place',
      to: 'domain.events',
      via: 'publish',
      flow: 'place-order',
      routingKey: 'order.placed',
    });
    expect(edges).toContainEqual({
      from: 'orders.place',
      to: 'orders.audit',
      via: 'wireTap',
      flow: 'place-order',
    });
    expect(edges).toContainEqual({
      from: 'orders.place',
      to: 'orders.persist',
      via: 'to',
      flow: 'place-order',
    });
    expect(edges).toContainEqual({
      from: 'inbound:rest',
      to: 'orders.place',
      via: 'inbound',
    });
    expect(edges).toContainEqual({
      from: 'inventory.reserve',
      to: 'activator:InventoryActivator.reserve',
      via: 'activator',
    });
    expect(snapshot.flows).toHaveLength(1);
    expect(snapshot.flows[0]?.steps.map((s) => s.kind)).toEqual([
      'wireTap',
      'jump',
      'publish',
      'reply',
      'to',
    ]);
  });

  it('jump wait:false marca forget; route genera edge dinámico', () => {
    const { registry, graph } = makeWorld();
    graph.recordFlow(
      'fan',
      IntegrationFlow.from('orders.place')
        .fanoutTo([{ channel: 'orders.local', wait: false }])
        .build(),
    );
    graph.recordFlow(
      'route-flow',
      IntegrationFlow.from('orders.persist')
        .route(() => 'orders.local')
        .build(),
    );
    const snapshot = graph.snapshot(registry);
    expect(snapshot.edges).toContainEqual({
      from: 'orders.place',
      to: 'orders.local',
      via: 'fanout',
      flow: 'fan',
      wait: false,
    });
    expect(snapshot.edges).toContainEqual({
      from: 'orders.persist',
      to: '*',
      via: 'route',
      flow: 'route-flow',
    });
  });

  it('mermaid: determinista, con nodos, inbounds y edges etiquetados', () => {
    const { registry, graph } = makeWorld();
    graph.recordInbound({ channel: 'orders.place', transport: 'rest', requestReply: false });
    graph.recordFlow(
      'route-flow',
      IntegrationFlow.from('orders.persist')
        .route(() => 'orders.local')
        .build(),
    );
    const first = graph.snapshot(registry).mermaid;
    const second = graph.snapshot(registry).mermaid;
    expect(first).toBe(second); // deterministic
    expect(first.startsWith('flowchart LR')).toBe(true);
    expect(first).toContain('"direct: orders.place"');
    expect(first).toContain('"queue: orders.local"');
    expect(first).toContain('inbound rest');
    expect(first).toContain('|route · route-flow|');
  });

  it('controller: /graph devuelve snapshot; /mermaid devuelve texto', () => {
    const { registry, graph } = makeWorld();
    const controller = new ChannelGraphController(graph, registry);
    const snapshot = controller.graphSnapshot();
    expect(Array.isArray(snapshot.nodes)).toBe(true);
    expect(snapshot.nodes).toHaveLength(8);
    expect(controller.mermaid()).toContain('flowchart LR');
  });
});
