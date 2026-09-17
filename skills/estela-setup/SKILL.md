---
name: estela-setup
description: Wire the ESTELA EIP runtime (IntegrationModule.forRoot) into a NestJS app — channels, flows, activators, inbound adapters and error handling. Use when adding ESTELA to a NestJS project or bootstrapping message-driven features.
---

# estela-setup — adopt ESTELA in a NestJS app

## Install

```bash
npm install @acme/nest-integration
# peers: @nestjs/common/core ^10||^11, @nestjs/swagger ^7||^8, reflect-metadata, rxjs
```

## Wire the module (global — do this once, in AppModule)

```ts
IntegrationModule.forRoot(
  {
    channels: [
      { name: 'orders.place', type: 'direct' },
      { name: 'orders.audit', type: 'queue', capacity: 10_000 },
      { name: 'inventory.reserve', type: 'direct' },
      { name: 'domain.events', type: 'pubsub' },
      { name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] },
    ],
    errorChannel: 'error.channel',
    idempotency: { enabled: true },
    rabbitChannel,
    rabbitMappings: [{ queue: 'orders.q', channel: 'orders.place' }],
  },
  [PlaceOrderFlow, RouteByCountryFlow],
)
```

## Rules while wiring

1. Inbound is declared on controller methods with `@InboundRest/@InboundGrpc/@InboundGraphQL/@InboundRabbit` — **never** as channels in `forRoot`.
2. A `direct` channel must have exactly one consumer: either ONE flow source or ONE `@ServiceActivator`. If both are needed, forward via the activator to a new channel (pattern: `orders.persist` activator → sends to `orders.country` → next flow `from('orders.country')`).
3. `error.channel` (pubsub) is auto-created; envelope shape: `{ flow? | activator?, error, causedBy }`.
4. The module is `global: true` — feature modules can inject `ChannelRegistry`, `TraceContext`, `ReplyGateway`, `ChannelGraph` without importing.
5. Init order is fixed: channels → activators (discovered) → flows (`graph.recordFlow` + attach) → Rabbit explorer.

## Verify adoption

- `moduleRef.get(ChannelRegistry).get('error.channel')` exists.
- `ChannelGraph.snapshot(registry)` shows your channels/flows/activators.
- Send a message through the entry channel; the flow runs end-to-end.
