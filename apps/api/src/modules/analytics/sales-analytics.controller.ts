import { Body, Controller, Get, Post, Query, Headers, BadRequestException, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { SalesAnalyticsService } from './sales-analytics.service';

@Controller('analytics/sales')
@UseGuards(JwtAuthGuard, TenantGuard, PermissionsGuard)
export class SalesAnalyticsController {
  constructor(private readonly salesAnalyticsService: SalesAnalyticsService) {}

  private requestedTeams(value?: string): string[] {
    if (value === undefined || value === '') return [];
    if (typeof value !== 'string' || value.length > 4096) throw new BadRequestException('Select valid tenant teams.');
    const ids = value.split(',').map(id => id.trim()).filter(Boolean);
    if (!ids.length) throw new BadRequestException('Select valid tenant teams.');
    return ids;
  }

  @Get('overview')
  @Permissions('analytics.sales')
  async getOverview(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('mapping') mapping?: string | string[],
    @Query('exclude_cancel') excludeCancel?: string,
    @Query('exclude_restocking') excludeRestocking?: string,
    @Query('exclude_abandoned') excludeAbandoned?: string,
    @Query('exclude_rts') excludeRts?: string,
    @Query('exclude_repurchase') excludeRepurchase?: string,
    @Query('include_tax_12') includeTax12?: string,
    @Query('include_tax_1') includeTax1?: string,
    @Query('mapping_selection') mappingSelection?: string,
    @Headers('x-team-id') teamHeader?: string,
  ) {
    const mappings = Array.isArray(mapping)
      ? mapping
      : mapping
      ? [mapping]
      : [];
    const parseBool = (val: string | undefined, defaultVal = true) => {
      if (val === undefined) return defaultVal;
      return !['false', '0', 'no', 'off'].includes(val.toLowerCase());
    };

    return this.salesAnalyticsService.getOverview({
      startDate,
      endDate,
      mappings,
      emptySelection: mappingSelection === 'none',
      teamIds: this.requestedTeams(teamHeader),
      excludeCancel: parseBool(excludeCancel, true),
      excludeRestocking: parseBool(excludeRestocking, true),
      excludeAbandoned: parseBool(excludeAbandoned, true),
      excludeRts: parseBool(excludeRts, true),
      excludeRepurchase: parseBool(excludeRepurchase, true),
      includeTax12: parseBool(includeTax12, false),
      includeTax1: parseBool(includeTax1, false),
    });
  }

  @Get('store-overview')
  @Permissions('analytics.sales')
  async getStoreOverview(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('mapping') mapping?: string | string[],
    @Query('exclude_cancel') excludeCancel?: string,
    @Query('exclude_restocking') excludeRestocking?: string,
    @Query('exclude_abandoned') excludeAbandoned?: string,
    @Query('exclude_rts') excludeRts?: string,
    @Query('exclude_repurchase') excludeRepurchase?: string,
    @Query('include_tax_12') includeTax12?: string,
    @Query('include_tax_1') includeTax1?: string,
    @Query('mapping_selection') mappingSelection?: string,
    @Headers('x-team-id') teamHeader?: string,
  ) {
    const mappings = Array.isArray(mapping) ? mapping : mapping ? [mapping] : [];
    const parseBool = (val: string | undefined, defaultVal = true) => {
      if (val === undefined) return defaultVal;
      return !['false', '0', 'no', 'off'].includes(val.toLowerCase());
    };
    return this.salesAnalyticsService.getStoreOverview({
      startDate,
      endDate,
      mappings,
      emptySelection: mappingSelection === 'none',
      teamIds: this.requestedTeams(teamHeader),
      excludeCancel: parseBool(excludeCancel, true),
      excludeRestocking: parseBool(excludeRestocking, true),
      excludeAbandoned: parseBool(excludeAbandoned, true),
      excludeRts: parseBool(excludeRts, true),
      excludeRepurchase: parseBool(excludeRepurchase, true),
      includeTax12: parseBool(includeTax12, false),
      includeTax1: parseBool(includeTax1, false),
    });
  }

  @Get('executive-overview')
  @Permissions('dashboard.executives')
  async getExecutiveOverview(
    @Query('start_date') startDate?: string,
    @Query('end_date') endDate?: string,
    @Query('mapping') mapping?: string | string[],
    @Query('exclude_cancel') excludeCancel?: string,
    @Query('exclude_restocking') excludeRestocking?: string,
    @Query('exclude_abandoned') excludeAbandoned?: string,
    @Query('exclude_rts') excludeRts?: string,
    @Query('exclude_repurchase') excludeRepurchase?: string,
    @Query('include_tax_12') includeTax12?: string,
    @Query('include_tax_1') includeTax1?: string,
  ) {
    const mappings = Array.isArray(mapping)
      ? mapping
      : mapping
      ? [mapping]
      : [];
    const parseBool = (val: string | undefined, defaultVal = true) => {
      if (val === undefined) return defaultVal;
      return !['false', '0', 'no', 'off'].includes(val.toLowerCase());
    };

    return this.salesAnalyticsService.getOverview({
      startDate,
      endDate,
      mappings,
      excludeCancel: parseBool(excludeCancel, true),
      excludeRestocking: parseBool(excludeRestocking, true),
      excludeAbandoned: parseBool(excludeAbandoned, true),
      excludeRts: parseBool(excludeRts, true),
      excludeRepurchase: parseBool(excludeRepurchase, true),
      includeTax12: parseBool(includeTax12, false),
      includeTax1: parseBool(includeTax1, false),
    });
  }

  @Post('reconcile')
  @Permissions('analytics.sales')
  async reconcileRange(@Body() body: { start_date?: string; end_date?: string }) {
    return this.salesAnalyticsService.reconcileRange(body?.start_date, body?.end_date);
  }
}
