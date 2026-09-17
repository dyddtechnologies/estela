import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { IntegrationMessage } from '../message';
import { IntegrationModule } from '../integration.module';
import { InboundRest } from '../inbound/inbound.decorators';
import { PubSub, ServiceActivator } from '../decorators';
import { IntegrationFlow, type FlowDefinition } from '../flow/integration-flow';
import { ChannelRegistry } from '../channel-registry';
import { INSURANCE_CHANNELS, INSURANCE_FLOWS } from './insurance/insurance.channels';
import { InsuranceController } from './insurance/insurance.controller';
import {
  PolicyCreationActivators,
  QuoteCreationActivators,
} from './insurance/insurance.activators';

/** DTO de ejemplo — el body lo documenta el usuario (spec sec.7.3). */
export class PlaceOrderDto {
  @ApiProperty({ example: 2 })
  qty!: number;

  @ApiProperty({ example: 'SKU-A' })
  sku!: string;

  @ApiProperty({ required: false, example: 'GT' })
  country?: string;
}

export class FanoutDto {
  @ApiProperty({ example: 'SKU-FANOUT' })
  sku!: string;
}

@Injectable()
export class InventoryActivator {
  calls = 0;

  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    this.calls += 1;
    return `reserved:${JSON.stringify(payload)}`;
  }
}

@Injectable()
export class BillingActivator {
  calls = 0;

  @ServiceActivator('billing.charge')
  charge(payload: unknown): string {
    this.calls += 1;
    return `charged:${JSON.stringify(payload)}`;
  }
}

@Injectable()
export class DomainEventsCollector {
  seen: { routingKey?: unknown; payload: unknown }[] = [];

  @PubSub('domain.events')
  onEvent(payload: unknown, msg: IntegrationMessage): void {
    this.seen.push({ routingKey: msg.headers.routingKey, payload });
  }
}

@Injectable()
export class OrderPersistence {
  persisted: Record<string, unknown>[] = [];

  constructor(private readonly registry: ChannelRegistry) {}

  /** sec.17.8: persist forward a 'orders.country' (direct 1-subscriber). */
  @ServiceActivator('orders.persist')
  async persist(payload: unknown): Promise<void> {
    this.persisted.push(payload as Record<string, unknown>);
    await this.registry.send('orders.country', payload);
  }
}

@Controller('orders')
@ApiTags('orders')
export class OrdersController {
  /** requestReply:true -> el flow responde al HTTP con `{status:'ok', result}` (spec sec.6.3/sec.7.2). */
  @Post()
  @InboundRest({ channel: 'orders.place', requestReply: true, timeoutMs: 5_000 })
  @ApiBody({ type: PlaceOrderDto })
  place(@Body() _dto: PlaceOrderDto): void {
    // payload = body (handler void); el reply lo cierra el flow (.reply())
  }

  /** Fanout (sec.5): copy a inventory.reserve + billing.charge via bindings; accepted sin esperar. */
  @Post('fanout')
  @InboundRest({ channel: 'ops.fanout' })
  @ApiBody({ type: FanoutDto })
  fanout(@Body() _dto: FanoutDto): void {
    // fire-into-fanout: bindings awaited por el channel; respuesta accepted
  }
}

export const PlaceOrderFlow: FlowDefinition = {
  name: 'place-order',
  build: () =>
    IntegrationFlow.from('orders.place')
      .filter((payload) => {
        const cmd = payload as { qty: number; sku?: string };
        return cmd.qty > 0 && typeof cmd.sku === 'string';
      })
      .transform((payload) => {
        const cmd = payload as { qty: number; sku: string; country?: string };
        return { orderId: `ord-${cmd.sku}`, ...cmd, total: cmd.qty * 10 };
      })
      .wireTap('orders.audit')
      .jumpTo([
        { channel: 'inventory.reserve', timeoutMs: 3_000 },
        { channel: 'billing.charge', timeoutMs: 3_000 },
      ])
      .publish('domain.events', 'order.placed')
      .reply()
      .to('orders.persist'),
};

export const RouteByCountryFlow: FlowDefinition = {
  name: 'route-by-country',
  build: () =>
    IntegrationFlow.from('orders.country').route((payload) => {
      const country = (payload as { country?: string }).country;
      if (country === 'GT') return 'orders.local';
      if (country === 'US') return 'orders.us';
      return 'orders.intl';
    }),
};

@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'orders.place', type: 'direct' },
          { name: 'orders.persist', type: 'direct' },
          { name: 'orders.country', type: 'direct' },
          { name: 'orders.audit', type: 'queue', capacity: 10_000 },
          { name: 'inventory.reserve', type: 'direct' },
          { name: 'billing.charge', type: 'direct' },
          { name: 'domain.events', type: 'pubsub' },
          { name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] },
          { name: 'orders.local', type: 'queue' },
          { name: 'orders.us', type: 'queue' },
          { name: 'orders.intl', type: 'queue' },
          { name: 'http.out.erp', type: 'direct' },
          ...INSURANCE_CHANNELS,
        ],
        idempotency: { enabled: true },
      },
      [PlaceOrderFlow, RouteByCountryFlow, ...INSURANCE_FLOWS],
    ),
  ],
  controllers: [OrdersController, InsuranceController],
  providers: [
    InventoryActivator,
    BillingActivator,
    DomainEventsCollector,
    OrderPersistence,
    QuoteCreationActivators,
    PolicyCreationActivators,
  ],
})
export class OrdersApplicationModule {}

export { InsuranceController };
