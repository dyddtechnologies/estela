import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InboundRest } from '../../inbound/inbound.decorators';

export class CreateQuoteSkeletonDto {
  @ApiProperty({ example: 'plan-apap-1' })
  planId!: string;

  @ApiProperty({ example: '12345678' })
  numberId!: string;

  @ApiProperty({ example: '1990-01-01' })
  dob!: string;

  @ApiProperty({ example: 'GT' })
  country!: string;
}

export class CreatePolicySkeletonDto {
  @ApiProperty({ example: 'quote-uuid' })
  quoteId!: string;
}

/** Endpoints espejo de `quotes/` de ms-asg-core — requestReply vía flows ESTELA. */
@Controller('insurance')
@ApiTags('insurance')
export class InsuranceController {
  @Post('quotes')
  @InboundRest({ channel: 'insurance.quotes.create', requestReply: true, timeoutMs: 15_000 })
  @ApiBody({ type: CreateQuoteSkeletonDto })
  createQuote(@Body() _dto: CreateQuoteSkeletonDto): void {
    // El reply lo cierra s12.update-price (terminal → return = auto-reply).
  }

  @Post('policies')
  @InboundRest({ channel: 'insurance.policies.create', requestReply: true, timeoutMs: 15_000 })
  @ApiBody({ type: CreatePolicySkeletonDto })
  createPolicy(@Body() _dto: CreatePolicySkeletonDto): void {
    // El reply lo cierra p6.policy-record (terminal).
  }
}
