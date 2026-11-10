import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { ReportsService } from './reports.service';
import { GetPosOrdersReportQueryDto } from './dto/get-pos-orders-report-query.dto';
import { GetWmsDailyInventoryMovementsDto } from '../wms-reports/dto/get-wms-daily-inventory-movements.dto';
import {
  SendWmsDailyInventoryEmailDto,
  UpdateWmsDailyInventoryEmailSubscriptionDto,
} from '../wms-reports/dto/wms-daily-inventory-email.dto';
import { WmsReportsService } from '../wms-reports/wms-reports.service';
import { WmsDailyInventoryEmailService } from '../wms-reports/wms-daily-inventory-email.service';

@Controller('reports')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly wmsReportsService: WmsReportsService,
    private readonly wmsDailyInventoryEmailService: WmsDailyInventoryEmailService,
  ) {}

  @Get('pos-orders-summary')
  @Permissions('reports.pos_orders.read')
  async getPosOrdersSummary(@Query() query: GetPosOrdersReportQueryDto) {
    return this.reportsService.getPosOrdersSummary({
      startDate: query.start_date,
      endDate: query.end_date,
    });
  }

  @Get('daily-inventory-movements')
  @Permissions('reports.pos_orders.read')
  async getDailyInventoryMovements(@Query() query: GetWmsDailyInventoryMovementsDto) {
    return this.wmsReportsService.getDailyInventoryMovementsReport(query);
  }

  @Patch('daily-inventory-subscription')
  @Permissions('reports.pos_orders.read')
  async updateDailyInventorySubscription(
    @Body() dto: UpdateWmsDailyInventoryEmailSubscriptionDto,
  ) {
    return this.wmsReportsService.updateDailyEmailSubscription(dto);
  }

  @Post('daily-inventory-send')
  @Permissions('reports.pos_orders.read')
  async sendDailyInventoryEmail(@Body() dto: SendWmsDailyInventoryEmailDto) {
    return this.wmsDailyInventoryEmailService.sendNow(dto);
  }
}
