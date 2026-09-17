import { NestFactory } from '@nestjs/core';
import { setupIntegrationSwagger } from '../inbound/inbound.swagger';
import { OrdersApplicationModule } from './orders.application';

export async function bootstrap(port = 3_000): Promise<void> {
  const app = await NestFactory.create(OrdersApplicationModule);
  setupIntegrationSwagger(app, {
    title: 'Orders — @acme/nest-integration example',
    description: 'EIP runtime: canales-no-clases',
  });
  await app.listen(port);
}

if (require.main === module) {
  void bootstrap();
}
