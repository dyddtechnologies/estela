<div align="center">
  <img src="assets/estela-banner.svg" alt="ESTELA — EIP runtime para NestJS" width="100%" />

  **O runtime de Enterprise Integration Patterns para NestJS.**
  *O flow fala com canais, não com classes.*

  [![tests](https://img.shields.io/badge/tests-110%2F110-brightgreen)](#status)
  [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#arquitetura)
  [![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](#instala%C3%A7%C3%A3o)
  [![NestJS](https://img.shields.io/badge/NestJS-10%20%7C%2011-E0234E?logo=nestjs&logoColor=white)](#instala%C3%A7%C3%A3o)
  [![license](https://img.shields.io/badge/license-MIT-blue)](#licen%C3%A7a)
  [![website](https://img.shields.io/badge/DYDD_Technologies-dyddtech.com-0A66C2)](https://www.dyddtech.com)
  [![LinkedIn](https://img.shields.io/badge/LinkedIn-eliudiaz-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/eliudiaz)
  [![maintainer](https://img.shields.io/badge/maintainer-eliudiaz--dydd-181717?logo=github)](https://github.com/eliudiaz-dydd)

  [English](./README.md) · [Español](./README.es.md) · **Português** · [Français](./README.fr.md)

  [Instalação](#instalação) · [Quick start](#quick-start) · [Canais](#canais) · [DSL](#dsl-de-flows) · [Rastreamento](#rastreamento-e-idempotência) · [Observabilidade](#observabilidade) · [Arquitetura](#arquitetura)
</div>

---

## Por que ESTELA

**Estela**: o rastro que um cometa deixa. Cada mensagem que viaja pelo runtime deixa
vestígio — `traceId`, `spanId`, `history` de hops — e cada hop é um ponto na estela.
Semântica do Spring Integration, nativa do Node:

- **4 canais in-memory** com semântica EIP real: `direct` · `queue` · `pubsub` · `fanout`.
- **DSL de flows fluida** com 10 padrões: `filter → transform → wireTap → fanoutTo → jumpTo → publish → route → to → reply`.
- **Request/reply** com canais efêmeros e timeouts race-free (`AbortSignal.timeout`).
- **Rastreamento** com `AsyncLocalStorage` + reconstrução de contexto a partir dos headers em cada hop.
- **Idempotência** com scopes `flow:*` / `activator:*` e store intercambiável (memória ou Redis).
- **Inbound REST / gRPC / Rabbit / GraphQL** declarado nos controllers, nunca no `forRoot`.
- **Grafo vivo** da sua topologia: JSON + Mermaid em dois endpoints.
- **100% nativo**: mensageria sem brokers nem dependências de runtime. Brokers são portas.

## Instalação

```bash
npm install @acme/nest-integration
```

Peers: `@nestjs/common/core` ^10‖^11 · `@nestjs/swagger` ^7‖^8 · `reflect-metadata` · `rxjs`.
Opcionais (apenas tipos/adapters, **nunca** no barrel): `amqplib` · `@grpc/grpc-js` · `@nestjs/graphql`.

## Quick start

```ts
@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'orders.place', type: 'direct' },
          { name: 'orders.audit', type: 'queue', capacity: 10_000 },
          { name: 'domain.events', type: 'pubsub' },
          { name: 'ops.fanout', type: 'fanout', bindings: ['inventory.reserve', 'billing.charge'] },
        ],
        idempotency: { enabled: true },
      },
      [PlaceOrderFlow],
    ),
  ],
  providers: [InventoryActivator],
})
export class AppModule {}
```

```ts
export const PlaceOrderFlow: FlowDefinition = {
  name: 'place-order',
  build: () =>
    IntegrationFlow.from('orders.place')
      .filter((p) => (p as { qty: number }).qty > 0)
      .transform((p) => ({ orderId: 'ord-1', ...(p as object), total: (p as { qty: number }).qty * 10 }))
      .wireTap('orders.audit')                                      // fire-and-forget, nunca falha
      .jumpTo([{ channel: 'inventory.reserve', timeoutMs: 3_000 }]) // wait → jumpReplies
      .publish('domain.events', 'order.placed')
      .reply()                                                      // fecha o HTTP se houver replyChannel
      .to('orders.persist'),
};
```

```ts
@Injectable()
export class InventoryActivator {
  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    return 'reserved'; // o wrapper responde ao replyChannel do hop (jump incluído)
  }
}
```

```ts
@Controller('orders')
export class OrdersController {
  @Post()
  @InboundRest({ channel: 'orders.place', requestReply: true, timeoutMs: 5_000 })
  place(@Body() dto: PlaceOrderDto): void {} // → { status:'ok', result, headers }
}
```

## Canais

| Kind | Semântica |
|---|---|
| `direct` | 1 subscriber · `send` aguarda o handler · sem subscriber → throw |
| `queue` | buffer FIFO + round-robin · capacity · overflow → error (nunca drop silencioso) |
| `pubsub` | broadcast · glob `*`/`#` na routingKey · grupos round-robin · falha isolada por subscriber |
| `fanout` | Composite: copia para bindings + subscribers · awaited ou forget · **cycle guard A↔B** |

## DSL de flows

| Step | Semântica |
|---|---|
| `filter` | descarta com sucesso (idempotência `{filtered:true}`) |
| `transform` / `handle` | trocam o payload; `handle` não dispara reply |
| `wireTap` | copia sem bloquear; ignora erros |
| `fanoutTo` | grupo awaited em paralelo; `wait:false` → forget para `error.channel` |
| `jumpTo` / `jump` | canal efêmero próprio · await reply + timeout · `jumpReplies[channel]` |
| `publish` | `nextHop` + routingKey · não corta |
| `route` | dinâmico `string \| string[]` · termina |
| `to` | envia e **termina** |
| `reply({payload})` | `'current'` \| `'jumpMerge'` → responde ao `replyChannel` |

**Precedência de `replyChannel`** (invariante do runtime): `wireTap/fanout/publish → none` ·
`to/route → inherit` · `jump → efêmero próprio`. O pai sempre mantém o reply do inbound.

## Rastreamento e idempotência

| Header | Mensagem |
|---|---|
| `x-trace-id` / `x-span-id` / `x-parent-span-id` | `traceId` · `spanId` · `parentSpanId` |
| `x-correlation-id` / `x-causation-id` | `correlationId` · `causationId` |
| `idempotency-key` / `x-idempotency-key` | `idempotencyKey` |

Scopes: `flow:${name}` · `activator:${Class}.${method}` · storage key `${scope}::${key}` ·
sem key → no-op · `enabled:false` → Null Object.

<details>
<summary><strong>Implementar <code>IdempotencyStore</code> com Redis (apenas contrato)</strong></summary>

```ts
export class RedisIdempotencyStore implements IdempotencyStore {
  private k = (scope: string, key: string) => `${scope}::${key}`;
  async begin(scope: string, key: string, ttlMs: number) {
    return (await this.redis.set(this.k(scope, key), 'in-flight', 'PX', ttlMs, 'NX')) === 'OK';
  }
  async complete(scope: string, key: string, result: Record<string, unknown>) {
    await this.redis.set(this.k(scope, key), JSON.stringify({ status: 'completed', result }), 'KEEPTTL');
  }
  // fail / get / purgeExpired: mesmo contrato — ver README.en
}

forRoot({ channels, idempotency: { store: new RedisIdempotencyStore(redis) } });
```
</details>

## Observabilidade

```bash
curl localhost:3000/integration/graph          # nodes · edges · flows (JSON)
curl localhost:3000/integration/graph/mermaid  # topologia em Mermaid
```

## Arquitetura

Hexagonal (portas e adaptadores) com SOLID e GoF explícitos:
`FlowStep` = **Command** · `FlowExecutor` = **Template Method** · `IntegrationFlow` = **Builder** ·
`FanoutChannel` = **Composite** · `ChannelRegistry` = **Mediator** · canais/stores = **Strategy** ·
`nextHop` = **Prototype** · `NoopIdempotencyStore` = **Null Object** · canais efêmeros = **Proxy**.

Motor event-driven 100% nativo Node ≥ 18: `node:events` · `AsyncLocalStorage` ·
`AbortSignal.timeout` · `Promise.all/allSettled` · `OnApplicationShutdown` (drain de queues).
**Design completo e ADRs: [PLAN-arquitectura.md](./PLAN-arquitectura.md)** (espanhol) · Contrato: [SPEC](./SPEC-nest-integration.md).

## Testing

```ts
import { bindFlow, waitFor, MemoryIdempotencyStore } from '@acme/nest-integration/testing';

bindFlow(PlaceOrderFlow, registry, { idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }) });
await registry.send('orders.place', { qty: 2, sku: 'A' });
const reply = await waitFor(registry, 'reply.http-1', 2_000);
```

## Status

| | |
|---|---|
| Testes | **110/110** · 18 suites · e2e HTTP real |
| Spec | 10/10 testes mínimos · DoD §15 completo |
| Boundaries | domínio puro · barrel sem brokers · testing sem inbound (0 violações) |
| Build | ESM + CJS + d.ts · Node ≥ 18 |

Exemplo executável: [`src/example/`](./src/example) · Scripts: `npm run verify`.

---

<div align="center">

<sub>**ESTELA** — construída com ☄️ por [**DYDD Technologies**](https://www.dyddtech.com) · criada e mantida por [**Eliu Diaz**](https://www.linkedin.com/in/eliudiaz) · único mantenedor [@eliudiaz-dydd](https://github.com/eliudiaz-dydd)</sub>

</div>

## Licença

MIT
