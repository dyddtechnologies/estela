/**
 * Minimal consumer of the packed @estela/nest tarball, shaped like the README quick start: one flow,
 * one activator and one request/reply REST inbound. scripts/consumer-smoke.sh compiles it with plain
 * tsc and boots it against a given Nest major. It lives outside the repo's tsconfig, lint and jest
 * on purpose: it must resolve @estela/nest from the installed tarball, never from the sources.
 */
import 'reflect-metadata';
import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  IntegrationFlow,
  IntegrationModule,
  InboundRest,
  ServiceActivator,
  type FlowDefinition,
} from '@estela/nest';

const GreetFlow: FlowDefinition = {
  name: 'greet',
  build: () =>
    IntegrationFlow.from('greet.in')
      .transform((p) => ({ name: (p as { name: string }).name.toUpperCase() }))
      .jumpTo([{ channel: 'greet.render', timeoutMs: 2_000 }])
      .reply({ payload: 'jumpMerge' })
      .to('greet.done'),
};

@Injectable()
export class GreetingActivator {
  @ServiceActivator('greet.render')
  render(payload: unknown): string {
    return `hello ${(payload as { name: string }).name}`;
  }

  @ServiceActivator('greet.done')
  done(): void {
    // The flow has already replied; the last channel of the flow only needs a subscriber.
  }
}

@Controller('greet')
export class GreetController {
  @Post()
  @InboundRest({ channel: 'greet.in', requestReply: true, timeoutMs: 5_000 })
  greet(@Body() _body: { name: string }): void {
    // The flow's reply closes the HTTP response.
  }
}

@Module({
  imports: [
    IntegrationModule.forRoot(
      {
        channels: [
          { name: 'greet.in', type: 'direct' },
          { name: 'greet.render', type: 'direct' },
          { name: 'greet.done', type: 'direct' },
        ],
      },
      [GreetFlow],
    ),
  ],
  controllers: [GreetController],
  providers: [GreetingActivator],
})
export class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  await app.listen(Number(process.env.PORT ?? 3112), '127.0.0.1');
  console.log('[consumer] ready');
}

void bootstrap().catch((error: unknown) => {
  console.error('[consumer] boot failed:', error);
  process.exit(1);
});
