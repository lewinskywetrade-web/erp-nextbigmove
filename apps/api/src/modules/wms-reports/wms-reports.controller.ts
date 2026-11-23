import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WmsAccessGuard } from '../../common/guards/wms-access.guard';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { GetWmsMonthEndStockReportDto } from './dto/get-wms-month-end-stock-report.dto';
import { GetWmsDailyInventoryMovementsDto } from './dto/get-wms-daily-inventory-movements.dto';
import {
  SendWmsDailyInventoryEmailDto,
  SendWmsWarehouseDailyInventoryEmailDto,
  UpdateWmsDailyInventoryEmailSubscriptionDto,
  UpdateWmsWarehouseDailyInventoryEmailSubscriptionDto,
} from './dto/wms-daily-inventory-email.dto';
import { WmsReportsService } from './wms-reports.service';
import { WmsDailyInventoryEmailService } from './wms-daily-inventory-email.service';

@Controller('wms/reports')
@UseGuards(JwtAuthGuard, WmsAccessGuard)
export class WmsReportsController {
  constructor(
    private readonly wmsReportsService: WmsReportsService,
    private readonly wmsDailyInventoryEmailService: WmsDailyInventoryEmailService,
  ) {}

  @Get('month-end-stock')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  getMonthEndStockReport(@Query() query: GetWmsMonthEndStockReportDto) {
    return this.wmsReportsService.getMonthEndStockReport(query);
  }

  @Get('daily-inventory-movements')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  getDailyInventoryMovementsReport(@Query() query: GetWmsDailyInventoryMovementsDto) {
    return this.wmsReportsService.getDailyInventoryMovementsReport(query);
  }

  @Patch('daily-inventory-subscription')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  updateDailyInventorySubscription(@Body() dto: UpdateWmsDailyInventoryEmailSubscriptionDto) {
    return this.wmsReportsService.updateDailyEmailSubscription(dto);
  }

  @Post('daily-inventory-send')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  sendDailyInventoryEmail(@Body() dto: SendWmsDailyInventoryEmailDto) {
    return this.wmsDailyInventoryEmailService.sendNow(dto);
  }

  @Get('daily-inventory-warehouse-subscription')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  getWarehouseDailyInventorySubscription() {
    this.wmsReportsService.assertGlobalWmsAccess();
    return this.wmsReportsService.getWarehouseDailyEmailSubscription();
  }

  @Patch('daily-inventory-warehouse-subscription')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  updateWarehouseDailyInventorySubscription(
    @Body() dto: UpdateWmsWarehouseDailyInventoryEmailSubscriptionDto,
  ) {
    return this.wmsReportsService.updateWarehouseDailyEmailSubscription(dto);
  }

  @Get('daily-inventory-warehouse-preview')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  previewWarehouseDailyInventoryEmail(@Query() query: GetWmsDailyInventoryMovementsDto) {
    return this.wmsDailyInventoryEmailService.previewWarehouseNow(query);
  }

  @Post('daily-inventory-warehouse-send')
  @Permissions('wms.reports.month_end_stock.read', 'wms.inventory.read', 'wms.partners.read')
  sendWarehouseDailyInventoryEmail(@Body() dto: SendWmsWarehouseDailyInventoryEmailDto) {
    return this.wmsDailyInventoryEmailService.sendWarehouseNow(dto);
  }
}
