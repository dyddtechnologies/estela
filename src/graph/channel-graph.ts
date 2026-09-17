import type { ChannelRegistry } from '../channel-registry';
import type { BuiltFlow } from '../flow/integration-flow';
import type { GraphqlOperation, InboundSpec, InboundTransport } from '../inbound/inbound.types';

export interface GraphInboundRef {
  transport: InboundTransport;
  requestReply: boolean;
  operation?: GraphqlOperation;
}

export interface GraphNode {
  channel: string;
  kind: string;
  bindings: readonly string[];
  inbounds: GraphInboundRef[];
  activators: string[];
  flowsFrom: string[];
}

export type GraphEdgeVia =
  | 'source'
  | 'wireTap'
  | 'fanout'
  | 'jump'
  | 'publish'
  | 'to'
  | 'route'
  | 'binding'
  | 'inbound'
  | 'activator';

export interface GraphEdge {
  from: string;
  to: string;
  via: GraphEdgeVia;
  wait?: boolean;
  routingKey?: string;
  flow?: string;
}

export interface GraphFlowEntry {
  name: string;
  source: string;
  steps: Record<string, unknown>[];
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  flows: GraphFlowEntry[];
  mermaid: string;
}

interface DestLike {
  channel?: unknown;
  wait?: unknown;
}

function destChannels(step: Record<string, unknown>): { channel: string; wait?: boolean }[] {
  const out: { channel: string; wait?: boolean }[] = [];
  if (typeof step.channel === 'string') {
    out.push({ channel: step.channel });
  }
  const dests = step.dests;
  if (!Array.isArray(dests)) return out;
  for (const dest of dests as DestLike[]) {
    if (typeof dest?.channel === 'string') {
      if (dest.wait === false) out.push({ channel: dest.channel, wait: false });
      else out.push({ channel: dest.channel });
    }
  }
  return out;
}

function sanitizeId(value: string): string {
  return value.replace(/\W/g, '_');
}

/**
 * Read-model de topologia (spec sec.12) — Memento del graph. Sin logica de
 * runtime: observadores (registry/flows/activators/inbounds) lo alimentan.
 */
export class ChannelGraph {
  private readonly inbounds = new Map<string, GraphInboundRef[]>();
  private readonly activators = new Map<string, string[]>();
  private readonly flows: GraphFlowEntry[] = [];
  private readonly flowEdges: GraphEdge[] = [];

  recordActivator(channel: string, label: string): void {
    const labels = this.activators.get(channel) ?? [];
    if (!labels.includes(label)) labels.push(label);
    this.activators.set(channel, labels);
  }

  recordInbound(spec: InboundSpec): void {
    const refs = this.inbounds.get(spec.channel) ?? [];
    const ref: GraphInboundRef = {
      transport: spec.transport,
      requestReply: spec.requestReply === true,
    };
    if (spec.operation !== undefined) ref.operation = spec.operation;
    refs.push(ref);
    this.inbounds.set(spec.channel, refs);
  }

  recordFlow(name: string, built: BuiltFlow): void {
    const steps = built.steps.map((step) => step.describe());
    this.flows.push({ name, source: built.source, steps });
    this.flows.sort((a, b) => a.name.localeCompare(b.name));
    for (const step of steps) {
      const via = String(step.kind);
      if (via === 'route') {
        this.flowEdges.push({ from: built.source, to: '*', via: 'route', flow: name });
        continue;
      }
      const targets = destChannels(step);
      for (const target of targets) {
        const edge: GraphEdge = {
          from: built.source,
          to: target.channel,
          via: via as GraphEdge['via'],
          flow: name,
        };
        if (target.wait !== undefined) edge.wait = target.wait;
        if (typeof step.routingKey === 'string') edge.routingKey = step.routingKey;
        this.flowEdges.push(edge);
      }
    }
  }

  snapshot(registry: ChannelRegistry): GraphSnapshot {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (const channel of registry.list()) {
      const isFanout = channel.kind === 'fanout';
      let bindings: readonly string[] = [];
      if (isFanout) {
        bindings = (channel as { bindings?: readonly string[] }).bindings ?? [];
      }
      nodes.push({
        channel: channel.name,
        kind: channel.kind,
        bindings,
        inbounds: this.inbounds.get(channel.name) ?? [],
        activators: this.activators.get(channel.name) ?? [],
        flowsFrom: this.flows
          .filter((flow) => flow.source === channel.name)
          .map((flow) => flow.name),
      });
      if (isFanout) {
        for (const binding of bindings) {
          edges.push({ from: channel.name, to: binding, via: 'binding' });
        }
      }
      for (const ref of this.inbounds.get(channel.name) ?? []) {
        edges.push({ from: `inbound:${ref.transport}`, to: channel.name, via: 'inbound' });
      }
      for (const label of this.activators.get(channel.name) ?? []) {
        edges.push({ from: channel.name, to: `activator:${label}`, via: 'activator' });
      }
    }
    edges.push(...this.flowEdges);
    const mermaid = this.renderMermaid(nodes, edges);
    return {
      nodes,
      edges,
      flows: this.flows.map((flow) => ({ ...flow, steps: [...flow.steps] })),
      mermaid,
    };
  }

  private renderMermaid(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
    const lines: string[] = ['flowchart LR'];
    this.appendNodeLines(lines, nodes);
    this.appendEdgeLines(lines, edges);
    return lines.join('\n');
  }

  private appendNodeLines(lines: string[], nodes: readonly GraphNode[]): void {
    let inboundIndex = 0;
    for (const node of nodes) {
      lines.push(`  ${sanitizeId(node.channel)}["${node.kind}: ${node.channel}"]`);
      for (const ref of node.inbounds) {
        inboundIndex += 1;
        lines.push(
          `  in_${inboundIndex}_${sanitizeId(ref.transport)}["inbound ${ref.transport}${ref.requestReply ? ' (reply)' : ''}"] --> ${sanitizeId(node.channel)}`,
        );
      }
      for (const label of node.activators) {
        lines.push(
          `  ${sanitizeId(node.channel)} --> act_${sanitizeId(label)}["activator: ${label}"]`,
        );
      }
    }
  }

  private appendEdgeLines(lines: string[], edges: readonly GraphEdge[]): void {
    for (const edge of edges) {
      const labelParts: string[] = [edge.via];
      if (edge.flow !== undefined) labelParts.push(edge.flow);
      if (edge.wait === false) labelParts.push('forget');
      if (edge.routingKey !== undefined) labelParts.push(`rk:${edge.routingKey}`);
      const label = edge.via === 'binding' ? 'binding' : labelParts.join(' · ');
      lines.push(`  ${sanitizeId(edge.from)} -->|${label}| ${sanitizeId(edge.to)}`);
    }
  }
}
