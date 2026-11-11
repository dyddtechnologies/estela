import type { ChannelRegistry } from '../channel-registry';
import type { BuiltFlow } from '../flow/integration-flow';
import { carriedHeaderNames } from '../inbound/inbound.carry';
import type { GraphqlOperation, InboundSpec, InboundTransport } from '../inbound/inbound.types';

export interface GraphInboundRef {
  transport: InboundTransport;
  requestReply: boolean;
  operation?: GraphqlOperation;
  /** Inbound care summary (RS-42); absent without care. */
  care?: string;
  /** Message header names the endpoint copies from transport headers (`carryHeaders`). */
  carries?: string[];
}

/** Outbound transports a channel can be bound to. */
export type OutboundTransport = 'rest';

export interface GraphOutboundRef {
  transport: OutboundTransport;
  /** `POST https://host/path` or `dynamic`; never a query string or credentials. */
  target: string;
  /** Care summary (RS-42); absent without care. */
  care?: string;
}

export interface GraphNode {
  channel: string;
  kind: string;
  bindings: readonly string[];
  inbounds: GraphInboundRef[];
  outbounds: GraphOutboundRef[];
  activators: string[];
  flowsFrom: string[];
  /** Summary of the channel's `care` reference (RS-66); absent without one. */
  care?: string;
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
  | 'outbound'
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
  /** Module-wide names (RS-66); present only when `care.profiles` is non-empty. */
  module?: { careProfiles: string[] };
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

/** ` [summary]` for Mermaid labels, empty without care. */
function careSuffix(care: string | undefined): string {
  return care === undefined ? '' : ` [${care}]`;
}

function sanitizeId(value: string): string {
  return value.replace(/\W/g, '_');
}

/**
 * Topology read model (spec sec.12), the Memento of the graph. No runtime logic:
 * observers (registry, flows, activators, inbounds) feed it.
 */
export class ChannelGraph {
  private readonly inbounds = new Map<string, GraphInboundRef[]>();
  private readonly outbounds = new Map<string, GraphOutboundRef[]>();
  private readonly activators = new Map<string, string[]>();
  private readonly flows: GraphFlowEntry[] = [];
  private readonly flowEdges: GraphEdge[] = [];
  private readonly channelCare = new Map<string, string>();
  private careProfiles: string[] = [];

  /** RS-66: summary of a channel declared with `care`. */
  recordChannelCare(channel: string, care: string): void {
    this.channelCare.set(channel, care);
  }

  /** RS-66: names of the module's care profiles (names only, never values). */
  recordCareProfiles(names: readonly string[]): void {
    this.careProfiles = [...names].sort((a, b) => a.localeCompare(b));
  }

  recordActivator(channel: string, label: string): void {
    const labels = this.activators.get(channel) ?? [];
    if (!labels.includes(label)) labels.push(label);
    this.activators.set(channel, labels);
  }

  recordInbound(spec: InboundSpec, care?: string): void {
    const refs = this.inbounds.get(spec.channel) ?? [];
    const ref: GraphInboundRef = {
      transport: spec.transport,
      requestReply: spec.requestReply === true,
    };
    if (spec.operation !== undefined) ref.operation = spec.operation;
    if (care !== undefined) ref.care = care;
    const carries = carriedHeaderNames(spec);
    if (carries !== undefined) ref.carries = carries;
    refs.push(ref);
    this.inbounds.set(spec.channel, refs);
  }

  /** Records an outbound adapter bound to `channel` (declared bindings and `@OutboundRest`). */
  recordOutbound(channel: string, ref: GraphOutboundRef): void {
    const refs = this.outbounds.get(channel) ?? [];
    refs.push(
      ref.care === undefined
        ? { transport: ref.transport, target: ref.target }
        : { transport: ref.transport, target: ref.target, care: ref.care },
    );
    this.outbounds.set(channel, refs);
  }

  /** `described` replaces `describe()` of each step with its RS-66 annotations. */
  recordFlow(name: string, built: BuiltFlow, described?: readonly Record<string, unknown>[]): void {
    const steps =
      described === undefined ? built.steps.map((step) => step.describe()) : [...described];
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
      const node: GraphNode = {
        channel: channel.name,
        kind: channel.kind,
        bindings,
        inbounds: this.inbounds.get(channel.name) ?? [],
        outbounds: this.outbounds.get(channel.name) ?? [],
        activators: this.activators.get(channel.name) ?? [],
        flowsFrom: this.flows
          .filter((flow) => flow.source === channel.name)
          .map((flow) => flow.name),
      };
      const care = this.channelCare.get(channel.name);
      if (care !== undefined) node.care = care;
      nodes.push(node);
      edges.push(...this.channelEdges(channel.name, bindings));
    }
    edges.push(...this.flowEdges);
    const mermaid = this.renderMermaid(nodes, edges);
    const snapshot: GraphSnapshot = {
      nodes,
      edges,
      flows: this.flows.map((flow) => ({ ...flow, steps: [...flow.steps] })),
      mermaid,
    };
    if (this.careProfiles.length > 0) snapshot.module = { careProfiles: [...this.careProfiles] };
    return snapshot;
  }

  /** Edges that hang off one channel: fanout bindings, inbounds, outbounds and activators. */
  private channelEdges(name: string, bindings: readonly string[]): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const binding of bindings) {
      edges.push({ from: name, to: binding, via: 'binding' });
    }
    for (const ref of this.inbounds.get(name) ?? []) {
      edges.push({ from: `inbound:${ref.transport}`, to: name, via: 'inbound' });
    }
    for (const ref of this.outbounds.get(name) ?? []) {
      edges.push({ from: name, to: `outbound:${ref.transport}`, via: 'outbound' });
    }
    for (const label of this.activators.get(name) ?? []) {
      edges.push({ from: name, to: `activator:${label}`, via: 'activator' });
    }
    return edges;
  }

  private renderMermaid(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
    const lines: string[] = ['flowchart LR'];
    this.appendNodeLines(lines, nodes);
    this.appendEdgeLines(lines, edges);
    return lines.join('\n');
  }

  private appendNodeLines(lines: string[], nodes: readonly GraphNode[]): void {
    let inboundIndex = 0;
    let outboundIndex = 0;
    for (const node of nodes) {
      lines.push(
        `  ${sanitizeId(node.channel)}["${node.kind}: ${node.channel}${careSuffix(node.care)}"]`,
      );
      for (const ref of node.inbounds) {
        inboundIndex += 1;
        lines.push(
          `  in_${inboundIndex}_${sanitizeId(ref.transport)}["inbound ${ref.transport}${ref.requestReply ? ' (reply)' : ''}${careSuffix(ref.care)}"] --> ${sanitizeId(node.channel)}`,
        );
      }
      for (const ref of node.outbounds) {
        outboundIndex += 1;
        lines.push(
          `  ${sanitizeId(node.channel)} --> out_${outboundIndex}_${sanitizeId(ref.transport)}["outbound ${ref.transport}: ${ref.target.replace(/"/g, "'")}${careSuffix(ref.care)}"]`,
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
