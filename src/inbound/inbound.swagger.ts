import { ApiProperty } from '@nestjs/swagger';

/**
 * DTOs del envelope inbound para Swagger (spec §7.3). El body lo documenta el
 * consumidor con @ApiBody + su DTO.
 */
export class InboundAcceptedDto {
  @ApiProperty({ example: 'accepted' })
  status!: 'accepted';

  @ApiProperty()
  id!: string;

  @ApiProperty()
  traceId!: string;

  @ApiProperty()
  correlationId!: string;
}

export class InboundReplyDto {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty()
  result!: unknown;

  @ApiProperty()
  id!: string;

  @ApiProperty()
  traceId!: string;

  @ApiProperty()
  correlationId!: string;

  @ApiProperty({ type: 'object' })
  headers!: Record<string, string>;
}

export class InboundDuplicateDto {
  @ApiProperty({ example: 'duplicate' })
  status!: 'duplicate';

  @ApiProperty()
  idempotencyKey!: string;

  @ApiProperty({ example: true })
  replayed!: boolean;

  @ApiProperty()
  result!: unknown;

  @ApiProperty()
  traceId!: string;
}

export interface SetupIntegrationSwaggerOptions {
  title?: string;
  description?: string;
  version?: string;
  /** default '/docs' — solo se monta si el consumidor llama (spec §7.3). */
  path?: string;
}

/**
 * Registra extraModels + tags del grafo y monta Swagger UI **solo si** el
 * consumidor lo llama (spec §15/§7.3).
 */
export function setupIntegrationSwagger(
  app: object,
  options: SetupIntegrationSwaggerOptions = {},
): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const swagger = require('@nestjs/swagger') as typeof import('@nestjs/swagger');
  const { DocumentBuilder, SwaggerModule } = swagger;
  const config = new DocumentBuilder()
    .setTitle(options.title ?? 'API')
    .setDescription(options.description ?? '')
    .setVersion(options.version ?? '1.0')
    .addTag('integration-graph')
    .build();
  const document = SwaggerModule.createDocument(app as never, config, { deepScanRoutes: true });
  SwaggerModule.setup(options.path ?? '/docs', app as never, document);
}
