import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InboundRest } from '../../inbound/inbound.decorators';

export class CreateQuoteDto {
  @ApiProperty({ example: 'plan-apap-1' })
  planId!: string;

  @ApiProperty({ example: '12345678' })
  numberId!: string;

  @ApiProperty({ required: false, example: '1990-01-01' })
  dob?: string;

  @ApiProperty({ required: false, example: 'GT' })
  country?: string;
}

export class CreatePolicyDto {
  @ApiProperty({ example: 'qte-plan-apap-1' })
  quoteId!: string;
}

export class QuoteFanoutDto {
  @ApiProperty({ example: 'plan-apap-1' })
  planId!: string;
}

export class CancelPolicyDto {
  @ApiProperty({ example: 'pol-qte-plan-apap-1' })
  policyId!: string;

  @ApiProperty({ required: false, example: 'email', description: 'Demo hook: fail this step' })
  failAt?: string;
}

@Controller('insurance')
@ApiTags('insurance')
export class InsuranceController {
  @Post('quotes')
  @InboundRest({ channel: 'insurance.quotes.create', requestReply: true, timeoutMs: 5_000 })
  @ApiBody({ type: CreateQuoteDto })
  createQuote(@Body() _dto: CreateQuoteDto): void {
    // payload = body; the flow closes the HTTP reply via .reply()
  }

  @Post('quotes/fanout')
  @InboundRest({ channel: 'insurance.ops.fanout' })
  @ApiBody({ type: QuoteFanoutDto })
  fanout(@Body() _dto: QuoteFanoutDto): void {
    // fire-into-fanout: bindings awaited by the channel; response accepted
  }

  @Post('policies')
  @InboundRest({ channel: 'insurance.policies.create', requestReply: true, timeoutMs: 5_000 })
  @ApiBody({ type: CreatePolicyDto })
  createPolicy(@Body() _dto: CreatePolicyDto): void {
    // payload = body; CreatePolicyFlow.reply() closes HTTP
  }

  @Post('policies/cancel')
  @InboundRest({ channel: 'insurance.policies.cancel', requestReply: true, timeoutMs: 5_000 })
  @ApiBody({ type: CancelPolicyDto })
  cancelPolicy(@Body() _dto: CancelPolicyDto): void {
    // chain of activators; s5.policy-log return closes HTTP
  }
}
