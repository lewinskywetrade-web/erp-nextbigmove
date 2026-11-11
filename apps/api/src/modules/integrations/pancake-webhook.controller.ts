import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { IntegrationService } from './integration.service';

@Controller('webhooks/pancake')
export class PancakeWebhookController {
  constructor(private readonly integrationService: IntegrationService) {}

  /**
   * Public Pancake webhook receiver for order events.
   * Auth: x-api-key header (tenant-level key).
   */
  @Post([':tenantId', ':tenantId/orders'])
  @HttpCode(HttpStatus.ACCEPTED)
  async receiveOrderWebhook(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() payload: any,
    @Headers('x-api-key') apiKeyHeader?: string,
    @Query('api_key') apiKeyQuery?: string,
    @Req() req?: Request,
  ) {
    const apiKey = apiKeyHeader || apiKeyQuery;
    return this.integrationService.receivePancakeOrderWebhook(
      tenantId,
      apiKey,
      payload,
      (req?.headers || {}) as Record<string, any>,
    );
  }
}
