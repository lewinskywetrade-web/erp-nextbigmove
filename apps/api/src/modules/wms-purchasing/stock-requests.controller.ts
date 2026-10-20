import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { NotificationSystem } from '@prisma/client';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import type { UploadedImageFile } from '../../common/services/media-assets.service';
import { CreateWmsPurchasingBatchDto } from './dto/create-wms-purchasing-batch.dto';
import { GetWmsPurchasingOverviewDto } from './dto/get-wms-purchasing-overview.dto';
import { GetWmsPurchasingProductOptionsDto } from './dto/get-wms-purchasing-product-options.dto';
import { MarkWmsSelfBuyShipmentDto } from './dto/mark-wms-self-buy-shipment.dto';
import { RespondWmsPurchasingRevisionDto } from './dto/respond-wms-purchasing-revision.dto';
import { SubmitWmsPurchasingPaymentProofDto } from './dto/submit-wms-purchasing-payment-proof.dto';
import { WmsPurchasingService } from './wms-purchasing.service';

type TenantRequest = {
  user?: {
    tenantId?: string | null;
  };
};

@Controller('stock-requests')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class StockRequestsController {
  constructor(private readonly wmsPurchasingService: WmsPurchasingService) {}

  @Get('overview')
  @Permissions('stock_request.read')
  async getOverview(@Request() req: TenantRequest, @Query() query: GetWmsPurchasingOverviewDto) {
    return this.wmsPurchasingService.getOverview({
      ...query,
      tenantId: this.getTenantId(req),
    });
  }

  @Get('products')
  @Permissions('stock_request.read')
  async getProductOptions(
    @Request() req: TenantRequest,
    @Query() query: GetWmsPurchasingProductOptionsDto,
  ) {
    return this.wmsPurchasingService.getProductOptions({
      ...query,
      tenantId: this.getTenantId(req),
    });
  }

  @Get('notifications/unread-count')
  @Permissions('stock_request.read')
  async getUnreadNotificationCount(@Request() req: TenantRequest) {
    return this.wmsPurchasingService.getUnreadNotificationCount(
      NotificationSystem.ERP,
      this.getTenantId(req),
    );
  }

  @Get(':id')
  @Permissions('stock_request.read')
  async getBatchById(@Request() req: TenantRequest, @Param('id') id: string) {
    return this.wmsPurchasingService.getBatchById(id, this.getTenantId(req));
  }

  @Get(':id/invoice')
  @Permissions('stock_request.read')
  async getLinkedInvoice(@Request() req: TenantRequest, @Param('id') id: string) {
    return this.wmsPurchasingService.getProcurementInvoiceByBatchId(id, this.getTenantId(req));
  }

  @Get(':id/invoice/document')
  @Permissions('stock_request.read')
  async getLinkedInvoiceDocument(@Request() req: TenantRequest, @Param('id') id: string) {
    return this.wmsPurchasingService.getProcurementInvoiceDocumentByBatchId(
      id,
      this.getTenantId(req),
    );
  }

  @Post('batches')
  @Permissions('stock_request.write')
  async createBatch(@Request() req: TenantRequest, @Body() body: CreateWmsPurchasingBatchDto) {
    // Managed procurement prices are quoted by the server from current ERP
    // history. Self-buy retains the partner's explicit actual purchase price.
    return this.wmsPurchasingService.createBatch(body, this.getTenantId(req), true);
  }

  @Post(':id/payment-proof')
  @Permissions('stock_request.write')
  async submitPaymentProof(
    @Request() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: SubmitWmsPurchasingPaymentProofDto,
  ) {
    return this.wmsPurchasingService.submitPartnerPaymentProof(id, body, this.getTenantId(req));
  }

  @Post('payment-proof-upload')
  @Permissions('stock_request.write')
  @UseInterceptors(FileInterceptor('file', {
    limits: {
      fileSize: Math.max(
        1,
        Number(process.env.OBJECT_STORAGE_PAYMENT_PROOF_MAX_FILE_MB || '8'),
      ) * 1024 * 1024,
    },
  }))
  async uploadPaymentProofImage(
    @Request() req: TenantRequest,
    @UploadedFile() file: UploadedImageFile,
  ) {
    return {
      asset: await this.wmsPurchasingService.uploadPartnerPaymentProofImage(
        file,
        this.getTenantId(req),
      ),
    };
  }

  @Post(':id/revision-response')
  @Permissions('stock_request.write')
  async respondToRevision(
    @Request() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: RespondWmsPurchasingRevisionDto,
  ) {
    return this.wmsPurchasingService.respondToRevision(id, body, this.getTenantId(req));
  }

  @Post(':id/notifications/read')
  @HttpCode(200)
  @Permissions('stock_request.read')
  async markNotificationsRead(@Request() req: TenantRequest, @Param('id') id: string) {
    return this.wmsPurchasingService.markBatchNotificationsRead(
      id,
      NotificationSystem.ERP,
      this.getTenantId(req),
    );
  }

  @Post(':id/self-buy/shipped')
  @Permissions('stock_request.write')
  async markSelfBuyShipment(
    @Request() req: TenantRequest,
    @Param('id') id: string,
    @Body() body: MarkWmsSelfBuyShipmentDto,
  ) {
    return this.wmsPurchasingService.markSelfBuyShipment(id, body, this.getTenantId(req));
  }

  private getTenantId(req: TenantRequest) {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required for stock requests');
    }

    return tenantId;
  }
}
