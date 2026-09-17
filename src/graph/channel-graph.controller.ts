import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ChannelRegistry } from '../channel-registry';
import { ChannelGraph, type GraphSnapshot } from './channel-graph';

/** Único controller del módulo (spec §11) — observable del grafo (spec §12). */
@Controller('integration')
@ApiTags('integration-graph')
export class ChannelGraphController {
  constructor(
    private readonly graph: ChannelGraph,
    private readonly registry: ChannelRegistry,
  ) {}

  @Get('graph')
  graphSnapshot(): GraphSnapshot {
    return this.graph.snapshot(this.registry);
  }

  @Get('graph/mermaid')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  mermaid(): string {
    return this.graph.snapshot(this.registry).mermaid;
  }
}
