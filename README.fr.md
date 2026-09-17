<div align="center">
  <img src="assets/estela-banner.svg" alt="ESTELA — EIP runtime pour NestJS" width="100%" />

  **Le runtime Enterprise Integration Patterns pour NestJS.**
  *Le flow parle aux canaux, pas aux classes.*

  [![tests](https://img.shields.io/badge/tests-110%2F110-brightgreen)](#statut)
  [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](#architecture)
  [![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](#installation)
  [![NestJS](https://img.shields.io/badge/NestJS-10%20%7C%2011-E0234E?logo=nestjs&logoColor=white)](#installation)
  [![license](https://img.shields.io/badge/license-MIT-blue)](#licence)
  [![website](https://img.shields.io/badge/DYDD_Technologies-dyddtech.com-0A66C2)](https://www.dyddtech.com)
  [![LinkedIn](https://img.shields.io/badge/LinkedIn-eliudiaz-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/eliudiaz)
  [![maintainer](https://img.shields.io/badge/maintainer-eliudiaz--dydd-181717?logo=github)](https://github.com/eliudiaz-dydd)

  [English](./README.md) · [Español](./README.es.md) · [Português](./README.pt.md) · **Français**

  [Installation](#installation) · [Quick start](#quick-start) · [Canaux](#canaux) · [DSL](#dsl-de-flows) · [Traçage](#traçage-et-idempotence) · [Observabilité](#observabilité) · [Architecture](#architecture)
</div>

---

## Pourquoi ESTELA

**Estela** *(espagnol : la traînée laissée par une comète)* : chaque message qui traverse
le runtime laisse une trace — `traceId`, `spanId`, `history` de hops — et chaque hop est
un point dans cette traînée. Sémantique Spring Integration, natif Node :

- **4 canaux in-memory** avec une vraie sémantique EIP : `direct` · `queue` · `pubsub` · `fanout`.
- **DSL de flows fluide** avec 10 patterns : `filter → transform → wireTap → fanoutTo → jumpTo → publish → route → to → reply`.
- **Request/reply** avec canaux éphémères et timeouts race-free (`AbortSignal.timeout`).
- **Traçage** via `AsyncLocalStorage` + reconstruction du contexte depuis les headers à chaque hop.
- **Idempotence** avec scopes `flow:*` / `activator:*` et store interchangeable (mémoire ou Redis).
- **Inbound REST / gRPC / Rabbit / GraphQL** déclaré dans les controllers, jamais dans `forRoot`.
- **Graphe vivant** de votre topologie : JSON + Mermaid sur deux endpoints.
- **100% natif** : messagerie sans brokers ni dépendances de runtime. Les brokers sont des ports.

## Installation

```bash
npm install @acme/nest-integration
```

Peers : `@nestjs/common/core` ^10‖^11 · `@nestjs/swagger` ^7‖^8 · `reflect-metadata` · `rxjs`.
Optionnels (types/adapters uniquement, **jamais** dans le barrel) : `amqplib` · `@grpc/grpc-js` · `@nestjs/graphql`.

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
      .wireTap('orders.audit')                                      // fire-and-forget, n'échoue jamais
      .jumpTo([{ channel: 'inventory.reserve', timeoutMs: 3_000 }]) // wait → jumpReplies
      .publish('domain.events', 'order.placed')
      .reply()                                                      // clôt la réponse HTTP si présente
      .to('orders.persist'),
};
```

```ts
@Injectable()
export class InventoryActivator {
  @ServiceActivator('inventory.reserve')
  reserve(payload: unknown): string {
    return 'reserved'; // le wrapper répond au replyChannel du hop (jump inclus)
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

## Canaux

| Kind | Sémantique |
|---|---|
| `direct` | 1 subscriber · `send` attend le handler · sans subscriber → throw |
| `queue` | buffer FIFO + round-robin · capacity · overflow → erreur (jamais de drop silencieux) |
| `pubsub` | broadcast · glob `*`/`#` sur routingKey · groupes round-robin · isolation par subscriber |
| `fanout` | Composite : copie vers bindings + subscribers · awaited ou forget · **cycle guard A↔B** |

## DSL de flows

| Step | Sémantique |
|---|---|
| `filter` | sortie avec succès (idempotence `{filtered:true}`) |
| `transform` / `handle` | remplacent le payload ; `handle` ne déclenche pas de reply |
| `wireTap` | copie sans bloquer ; ignore les erreurs |
| `fanoutTo` | groupe awaited en parallèle ; `wait:false` → forget vers `error.channel` |
| `jumpTo` / `jump` | canal éphémère propre · await reply + timeout · `jumpReplies[channel]` |
| `publish` | `nextHop` + routingKey · ne coupe pas |
| `route` | dynamique `string \| string[]` · termine |
| `to` | envoie et **termine** |
| `reply({payload})` | `'current'` \| `'jumpMerge'` → répond au `replyChannel` |

**Précédence du `replyChannel`** (invariant du runtime) : `wireTap/fanout/publish → none` ·
`to/route → inherit` · `jump → éphémère propre`. Le parent conserve toujours le reply de l'inbound.

## Traçage et idempotence

| Header | Message |
|---|---|
| `x-trace-id` / `x-span-id` / `x-parent-span-id` | `traceId` · `spanId` · `parentSpanId` |
| `x-correlation-id` / `x-causation-id` | `correlationId` · `causationId` |
| `idempotency-key` / `x-idempotency-key` | `idempotencyKey` |

Scopes : `flow:${name}` · `activator:${Class}.${method}` · clé `${scope}::${key}` ·
sans key → no-op · `enabled:false` → Null Object.

<details>
<summary><strong>Implémenter <code>IdempotencyStore</code> avec Redis (contrat uniquement)</strong></summary>

```ts
export class RedisIdempotencyStore implements IdempotencyStore {
  private k = (scope: string, key: string) => `${scope}::${key}`;
  async begin(scope: string, key: string, ttlMs: number) {
    return (await this.redis.set(this.k(scope, key), 'in-flight', 'PX', ttlMs, 'NX')) === 'OK';
  }
  async complete(scope: string, key: string, result: Record<string, unknown>) {
    await this.redis.set(this.k(scope, key), JSON.stringify({ status: 'completed', result }), 'KEEPTTL');
  }
  // fail / get / purgeExpired : même contrat — voir README.en
}

forRoot({ channels, idempotency: { store: new RedisIdempotencyStore(redis) } });
```
</details>

## Observabilité

```bash
curl localhost:3000/integration/graph          # nodes · edges · flows (JSON)
curl localhost:3000/integration/graph/mermaid  # topologie en Mermaid
```

## Architecture

Hexagonale (ports & adaptateurs) avec SOLID et GoF explicites :
`FlowStep` = **Command** · `FlowExecutor` = **Template Method** · `IntegrationFlow` = **Builder** ·
`FanoutChannel` = **Composite** · `ChannelRegistry` = **Mediator** · canaux/stores = **Strategy** ·
`nextHop` = **Prototype** · `NoopIdempotencyStore` = **Null Object** · canaux éphémères = **Proxy**.

Moteur event-driven 100% natif Node ≥ 18 : `node:events` · `AsyncLocalStorage` ·
`AbortSignal.timeout` · `Promise.all/allSettled` · `OnApplicationShutdown` (drain des queues).
**Design complet et ADRs : [PLAN-arquitectura.md](./PLAN-arquitectura.md)** (espagnol) · Contrat : [SPEC](./SPEC-nest-integration.md).

## Testing

```ts
import { bindFlow, waitFor, MemoryIdempotencyStore } from '@acme/nest-integration/testing';

bindFlow(PlaceOrderFlow, registry, { idempotency: new IdempotencyService({ store: new MemoryIdempotencyStore() }) });
await registry.send('orders.place', { qty: 2, sku: 'A' });
const reply = await waitFor(registry, 'reply.http-1', 2_000);
```

## Statut

| | |
|---|---|
| Tests | **110/110** · 18 suites · e2e HTTP réel |
| Spec | 10/10 tests minimaux · DoD §15 complet |
| Boundaries | domaine pur · barrel sans brokers · testing sans inbound (0 violations) |
| Build | ESM + CJS + d.ts · Node ≥ 18 |

Exemple exécutable : [`src/example/`](./src/example) · Scripts : `npm run verify`.

---

<div align="center">

<sub>**ESTELA** — construite avec ☄️ par [**DYDD Technologies**](https://www.dyddtech.com) · créée et maintenue par [**Eliu Diaz**](https://www.linkedin.com/in/eliudiaz) · mainteneur unique [@eliudiaz-dydd](https://github.com/eliudiaz-dydd)</sub>

</div>

## Licence

MIT
