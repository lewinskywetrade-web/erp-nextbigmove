import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WmsAccessGuard } from '../../common/guards/wms-access.guard';
import { WmsIntegrationsService } from './wms-integrations.service';
import {
  BulkCreatePosIntegrationDto,
  UpdatePancakeWebhookDto,
  UpdatePancakeWebhookRelayDto,
} from '../integrations/dto';
import { UpdateWmsPosStoreDto } from './dto/update-wms-pos-store.dto';

@Controller('wms/partners/:tenantId/integrations')
@UseGuards(JwtAuthGuard, WmsAccessGuard)
export class WmsIntegrationsController {
  constructor(private readonly wmsIntegrationsService: WmsIntegrationsService) {}

  private getBaseUrl(req: Request): string {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = typeof forwardedProto === 'string'
      ? forwardedProto.split(',')[0].trim()
      : req.protocol || 'https';
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = typeof forwardedHost === 'string'
      ? forwardedHost.split(',')[0].trim()
      : req.get('host') || '';
    return `${proto}://${host}`;
  }

  @Get()
  @Permissions('wms.integrations.read')
  async getPartnerIntegrations(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.getPartnerIntegrations(tenantId, this.getBaseUrl(req));
  }

  @Post('pos-stores/bulk-import')
  @Permissions('wms.integrations.write')
  async bulkImportPosStores(
    @Param('tenantId') tenantId: string,
    @Body() body: BulkCreatePosIntegrationDto,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.bulkImportPosStores(tenantId, body, this.getBaseUrl(req));
  }

  @Post('pos-stores/:storeId/sync-products')
  @Permissions('wms.integrations.sync')
  async syncStoreProducts(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.syncStoreProducts(tenantId, storeId, this.getBaseUrl(req));
  }

  @Post('pos-stores/:storeId/sync-tags')
  @Permissions('wms.integrations.sync')
  async syncStoreTags(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.syncStoreTags(tenantId, storeId, this.getBaseUrl(req));
  }

  @Post('pos-stores/:storeId/sync-warehouses')
  @Permissions('wms.integrations.sync')
  async syncStoreWarehouses(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.syncStoreWarehouses(tenantId, storeId, this.getBaseUrl(req));
  }

  @Post('pos-stores/:storeId/sync-orders')
  @Permissions('wms.integrations.sync')
  async syncStoreOrders(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.syncStoreOrders(tenantId, storeId, this.getBaseUrl(req));
  }

  @Post('pos-stores/:storeId/sync-all')
  @Permissions('wms.integrations.sync')
  async syncStoreAll(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.syncStoreAll(tenantId, storeId, this.getBaseUrl(req));
  }

  @Patch('pos-stores/:storeId')
  @Permissions('wms.integrations.edit')
  async updatePosStore(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Body() body: UpdateWmsPosStoreDto,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.updatePosStore(
      tenantId,
      storeId,
      body,
      this.getBaseUrl(req),
    );
  }

  @Delete('pos-stores/:storeId')
  @Permissions('wms.integrations.write')
  async removePosStore(
    @Param('tenantId') tenantId: string,
    @Param('storeId') storeId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.removePosStore(
      tenantId,
      storeId,
      this.getBaseUrl(req),
    );
  }

  @Patch('webhook')
  @Permissions('wms.integrations.webhook.update')
  async updateWebhook(
    @Param('tenantId') tenantId: string,
    @Body() body: UpdatePancakeWebhookDto,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.updateWebhook(tenantId, body, this.getBaseUrl(req));
  }

  @Post('webhook/rotate-key')
  @Permissions('wms.integrations.webhook.rotate')
  async rotateWebhookApiKey(
    @Param('tenantId') tenantId: string,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.rotateWebhookApiKey(tenantId, this.getBaseUrl(req));
  }

  @Patch('webhook/relay')
  @Permissions('wms.integrations.webhook.update')
  async updateWebhookRelay(
    @Param('tenantId') tenantId: string,
    @Body() body: UpdatePancakeWebhookRelayDto,
    @Req() req: Request,
  ) {
    return this.wmsIntegrationsService.updateWebhookRelay(tenantId, body, this.getBaseUrl(req));
  }
}
