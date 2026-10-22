import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TeamContextService } from '../../common/services/team-context.service';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';
import { AnalyticsCacheService } from './analytics-cache.service';
import { resolveMappingDisplayNames } from '../workflows/utils/product-mapping-key';
import type { SalesAttributionOverviewContract } from './contracts/sales-attribution-overview.contract';
import { GetSalesAttributionOverviewQueryDto } from './dto/get-sales-attribution-overview-query.dto';
import { AnalyticsRequestCoordinatorService } from './analytics-request-coordinator.service';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TIMEZONE = 'Asia/Manila';
const NULL_MAPPING_FILTER_KEY = '__null__';
const UNASSIGNED_MAPPING_KEY = '__unassigned_mapping__';
const UNASSIGNED_TEAM_CODE_KEY = '__unassigned_team_code__';

type SalesAttributionKpis = SalesAttributionOverviewContract['kpis'];
type SalesAttributionCounts = SalesAttributionOverviewContract['counts'];
type SalesAttributionProductRow = SalesAttributionOverviewContract['products'][number];
type SalesAttributionDeliveryRow = NonNullable<SalesAttributionOverviewContract['deliveryStatuses']>[number];

@Injectable()
export class SalesAttributionAnalyticsService {
  private readonly logger = new Logger(SalesAttributionAnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamContext: TeamContextService,
    private readonly analyticsCache: AnalyticsCacheService,
    private readonly analyticsRequestCoordinator: AnalyticsRequestCoordinatorService,
  ) {}

  private normalize(value?: string | null): string {
    return (value || '').trim().toLowerCase();
  }

  private toNumber(value: unknown): number {
    const numeric = typeof value === 'string' ? parseFloat(value) : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private shiftDate(dateStr: string, days: number): string {
    return dayjs(dateStr, 'YYYY-MM-DD').add(days, 'day').format('YYYY-MM-DD');
  }

  private diffDays(startStr: string, endStr: string): number {
    const start = dayjs(startStr, 'YYYY-MM-DD');
    const end = dayjs(endStr, 'YYYY-MM-DD');
    return end.diff(start, 'day');
  }

  private computeKpis(
    sum: any,
    opts: {
      excludeCancel: boolean;
      excludeRestocking: boolean;
      excludeAbandoned: boolean;
      excludeRts: boolean;
      includeTax12: boolean;
      includeTax1: boolean;
      rtsForecastPct?: number;
      processedSalesValue?: number;
    },
  ): SalesAttributionKpis {
    const spendBase = this.toNumber(sum?._sum?.spend);
    const spendMultiplier = 1 + (opts.includeTax12 ? 0.12 : 0) + (opts.includeTax1 ? 0.01 : 0);
    const spend = spendBase * spendMultiplier;
    const cod = this.toNumber(sum?._sum?.codPos);
    const canceledCod = this.toNumber(sum?._sum?.canceledCodPos);
    const restockingCod = this.toNumber(sum?._sum?.restockingCodPos);
    const abandonedCod = this.toNumber(sum?._sum?.abandonedCodPos);
    const rtsCod = this.toNumber(sum?._sum?.rtsCodPos);
    const codFee = this.toNumber(sum?._sum?.codFeePos);

    const revenue =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      - (opts.excludeRts ? rtsCod : 0);

    const cogs = this.toNumber(sum?._sum?.cogsPos);
    const cogsCanceled = this.toNumber(sum?._sum?.cogsCanceledPos);
    const cogsRestocking = this.toNumber(sum?._sum?.cogsRestockingPos);
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsDelivered = this.toNumber(sum?._sum?.cogsDeliveredPos);
    const sf = this.toNumber(sum?._sum?.sfPos);
    const ff = this.toNumber(sum?._sum?.ffPos);
    const iF = this.toNumber(sum?._sum?.ifPos);
    const sfSdr = this.toNumber(sum?._sum?.sfSdrPos);
    const ffSdr = this.toNumber(sum?._sum?.ffSdrPos);
    const ifSdr = this.toNumber(sum?._sum?.ifSdrPos);
    const cogsBeforeRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0);
    const cogsAdjusted = cogsBeforeRts - (opts.excludeRts ? cogsRts : 0);
    // A returned item's cost is credited only while it is still in COGS.
    // Excluding it above and crediting it again would inflate contribution.
    const cogsRtsCredit = opts.excludeRts ? 0 : cogsRts;
    const arPct = revenue > 0 ? (spend / revenue) * 100 : 0;

    const contributionMargin =
      revenue
      - cogsAdjusted
      - sf
      - ff
      - iF
      - spend
      - codFee
      + cogsRtsCredit;

    const delivered = this.toNumber(sum?._sum?.deliveredCodPos);
    const codFeeDelivered = this.toNumber(sum?._sum?.codFeeDeliveredPos);
    const netMargin =
      delivered
      - sfSdr
      - ffSdr
      - ifSdr
      - codFeeDelivered
      - cogsDelivered
      - spend;

    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdjCount = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdjCount = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdjCount = opts.excludeAbandoned ? this.toNumber(sum?._sum?.abandonedCount) : 0;
    const rtsAdjCount = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const purchasesAdj = Math.max(0, purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount - rtsAdjCount);
    const processedPurchases = this.toNumber(sum?._sum?.processedPurchasesPos);
    const cpp = purchasesAdj > 0 ? spend / purchasesAdj : 0;
    const processedCpp = processedPurchases > 0 ? spend / processedPurchases : 0;
    const leads = this.toNumber(sum?._sum?.leads);
    const conversionRate = leads > 0 ? (purchasesAdj / leads) * 100 : 0;
    const profitEfficiency = spend > 0 ? (contributionMargin / spend) * 100 : 0;

    const grossCodAdjusted =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0);
    const cogsAdjustedForCmRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0);
    const purchasesAdjForCmRts = Math.max(0, purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount);
    const aovForCmRts = purchasesAdjForCmRts > 0 ? grossCodAdjusted / purchasesAdjForCmRts : 0;
    const revenueBaseForCmRts = aovForCmRts * purchasesAdjForCmRts;
    const rtsForecast = typeof opts.rtsForecastPct === 'number' ? opts.rtsForecastPct : 20;
    const rtsFraction = rtsForecast / 100;
    const cmRtsForecast =
      (1 - rtsFraction) * revenueBaseForCmRts -
      spend -
      sf -
      ff -
      iF -
      this.toNumber(sum?._sum?.codFeeDeliveredPos) -
      cogsAdjustedForCmRts +
      cogsRts;

    return {
      revenue,
      delivered: this.toNumber(sum?._sum?.deliveredCodPos),
      shipped: this.toNumber(sum?._sum?.shippedCodPos),
      waiting_pickup: this.toNumber(sum?._sum?.waitingPickupCodPos),
      rts: this.toNumber(sum?._sum?.rtsCodPos),
      ad_spend: spend,
      processed: this.toNumber(opts.processedSalesValue),
      cancellation_rate_pct: 0,
      aov: purchasesAdj > 0 ? revenue / purchasesAdj : 0,
      ar_pct: arPct,
      cpp,
      processed_cpp: processedCpp,
      conversion_rate: conversionRate,
      profit_efficiency: profitEfficiency,
      confirmed: this.toNumber(sum?._sum?.confirmedCodPos),
      unconfirmed: this.toNumber(sum?._sum?.unconfirmedCodPos),
      canceled: this.toNumber(sum?._sum?.canceledCodPos),
      contribution_margin: contributionMargin,
      net_margin: netMargin,
      cogs,
      cogs_adjusted: cogsAdjusted,
      cogs_rts_credit: cogsRtsCredit,
      cogs_forecast_basis: cogsBeforeRts,
      cogs_canceled: cogsCanceled,
      cogs_restocking: cogsRestocking,
      cogs_rts: cogsRts,
      cogs_delivered: cogsDelivered,
      cod_fee: this.toNumber(sum?._sum?.codFeePos),
      cod_fee_delivered: this.toNumber(sum?._sum?.codFeeDeliveredPos),
      sf_sdr_fees: sfSdr,
      ff_sdr_fees: ffSdr,
      if_sdr_fees: ifSdr,
      gross_cod: cod,
      canceled_cod: canceledCod,
      restocking_cod: restockingCod,
      rts_cod: rtsCod,
      abandoned_cod: abandonedCod,
      sf_fees: sf,
      ff_fees: ff,
      if_fees: iF,
      cm_rts_forecast: cmRtsForecast,
      rts_pct: 0,
    };
  }

  private computeCounts(
    sum: any,
    opts: {
      excludeCancel: boolean;
      excludeRestocking: boolean;
      excludeAbandoned: boolean;
      excludeRts: boolean;
    },
    stageCounts?: {
      undelivered?: number;
      returned?: number;
    },
  ): SalesAttributionCounts {
    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdj = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdj = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdj = opts.excludeAbandoned ? this.toNumber(sum?._sum?.abandonedCount) : 0;
    const rtsAdj = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const adjustment = Math.min(purchasesRaw, cancelAdj + restockAdj + abandonedAdj + rtsAdj);
    const purchases = Math.max(0, purchasesRaw - adjustment);
    return {
      purchases,
      delivered: this.toNumber(sum?._sum?.deliveredCount),
      shipped: this.toNumber(sum?._sum?.shippedCount),
      waiting_pickup: this.toNumber(sum?._sum?.waitingPickupCount),
      rts: this.toNumber(sum?._sum?.rtsCount),
      undelivered: this.toNumber(stageCounts?.undelivered),
      returned: this.toNumber(stageCounts?.returned),
      restocking: this.toNumber(sum?._sum?.restockingCount),
      confirmed: this.toNumber(sum?._sum?.confirmedCount),
      unconfirmed: this.toNumber(sum?._sum?.unconfirmedCount),
      canceled: this.toNumber(sum?._sum?.canceledCount),
    };
  }

  private computeProductRow(
    sum: any,
    opts: {
      excludeCancel: boolean;
      excludeRestocking: boolean;
      excludeAbandoned: boolean;
      excludeRts: boolean;
      includeTax12: boolean;
      includeTax1: boolean;
      rtsForecastPct?: number;
    },
  ): SalesAttributionProductRow {
    const spendBase = this.toNumber(sum?._sum?.spend);
    const spendMultiplier = 1 + (opts.includeTax12 ? 0.12 : 0) + (opts.includeTax1 ? 0.01 : 0);
    const spend = spendBase * spendMultiplier;
    const cod = this.toNumber(sum?._sum?.codPos);
    const canceledCod = this.toNumber(sum?._sum?.canceledCodPos);
    const restockingCod = this.toNumber(sum?._sum?.restockingCodPos);
    const abandonedCod = this.toNumber(sum?._sum?.abandonedCodPos);
    const rtsCod = this.toNumber(sum?._sum?.rtsCodPos);
    const revenue =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      - (opts.excludeRts ? rtsCod : 0);

    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdjCount = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdjCount = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdjCount = opts.excludeAbandoned ? this.toNumber(sum?._sum?.abandonedCount) : 0;
    const rtsAdjCount = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const purchasesAdj = Math.max(0, purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount - rtsAdjCount);
    const processedPurchases = this.toNumber(sum?._sum?.processedPurchasesPos);

    const cogs = this.toNumber(sum?._sum?.cogsPos);
    const cogsCanceled = this.toNumber(sum?._sum?.cogsCanceledPos);
    const cogsRestocking = this.toNumber(sum?._sum?.cogsRestockingPos);
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsBeforeRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0);
    const cogsAdjusted = cogsBeforeRts - (opts.excludeRts ? cogsRts : 0);
    // A returned item's cost is credited only while it is still in COGS.
    // Excluding it above and crediting it again would inflate contribution.
    const cogsRtsCredit = opts.excludeRts ? 0 : cogsRts;

    const sf = this.toNumber(sum?._sum?.sfPos);
    const ff = this.toNumber(sum?._sum?.ffPos);
    const iF = this.toNumber(sum?._sum?.ifPos);
    const codFee = this.toNumber(sum?._sum?.codFeePos);

    const contributionMargin =
      revenue
      - cogsAdjusted
      - sf
      - ff
      - iF
      - spend
      - codFee
      + cogsRtsCredit;

    const delivered = this.toNumber(sum?._sum?.deliveredCodPos);
    const sfSdr = this.toNumber(sum?._sum?.sfSdrPos);
    const ffSdr = this.toNumber(sum?._sum?.ffSdrPos);
    const ifSdr = this.toNumber(sum?._sum?.ifSdrPos);
    const codFeeDelivered = this.toNumber(sum?._sum?.codFeeDeliveredPos);
    const cogsDelivered = this.toNumber(sum?._sum?.cogsDeliveredPos);
    const netMargin =
      delivered
      - sfSdr
      - ffSdr
      - ifSdr
      - codFeeDelivered
      - cogsDelivered
      - spend;

    const arPct = revenue > 0 ? (spend / revenue) * 100 : 0;
    const profitEfficiency = spend > 0 ? (contributionMargin / spend) * 100 : 0;
    const aov = purchasesAdj > 0 ? revenue / purchasesAdj : 0;
    const cpp = purchasesAdj > 0 ? spend / purchasesAdj : 0;
    const processedCpp = processedPurchases > 0 ? spend / processedPurchases : 0;
    const purchasesAdjForCmRts = Math.max(0, purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount);
    const grossCodAdjusted =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0);
    const aovForCmRts = purchasesAdjForCmRts > 0 ? grossCodAdjusted / purchasesAdjForCmRts : 0;
    const revenueBaseForCmRts = aovForCmRts * purchasesAdjForCmRts;
    const rtsForecast = typeof opts.rtsForecastPct === 'number' ? opts.rtsForecastPct : 20;
    const rtsFraction = rtsForecast / 100;
    const cmRtsForecast =
      (1 - rtsFraction) * revenueBaseForCmRts -
      spend -
      sf -
      ff -
      iF -
      codFeeDelivered -
      cogsBeforeRts +
      cogsRts;

    return {
      mapping: sum.mapping ?? null,
      revenue,
      gross_sales: purchasesAdj,
      cogs: cogsAdjusted,
      cogs_raw: cogs,
      cogs_canceled: cogsCanceled,
      cogs_rts_credit: cogsRtsCredit,
      cogs_forecast_basis: cogsBeforeRts,
      aov,
      cpp,
      processed_cpp: processedCpp,
      ad_spend: spend,
      ar_pct: arPct,
      profit_efficiency: profitEfficiency,
      contribution_margin: contributionMargin,
      cm_rts_forecast: cmRtsForecast,
      net_margin: netMargin,
      rts_count: this.toNumber(sum?._sum?.rtsCount),
      delivered_count: this.toNumber(sum?._sum?.deliveredCount),
      cod_raw: cod,
      purchases_raw: purchasesRaw,
      sf_raw: sf,
      ff_raw: ff,
      if_raw: iF,
      cod_fee_delivered_raw: this.toNumber(sum?._sum?.codFeeDeliveredPos),
      cogs_ec: cogs - cogsCanceled,
      cogs_rts: cogsRts,
      cogs_restocking: this.toNumber(sum?._sum?.cogsRestockingPos),
      canceled_cod: canceledCod,
      restocking_cod: restockingCod,
      rts_cod: rtsCod,
      abandoned_cod: abandonedCod,
    };
  }

  private buildRollupWhere(params: {
    tenantId: string;
    range: { gte: Date; lte: Date };
    normalizedMappings: string[];
    normalizedTeamCode?: string | null;
  }) {
    const includeNull = params.normalizedMappings.includes(NULL_MAPPING_FILTER_KEY);
    const nonNullMappings = params.normalizedMappings.filter(
      (mapping) => mapping !== NULL_MAPPING_FILTER_KEY,
    );

    const where: any = {
      tenantId: params.tenantId,
      date: params.range,
    };

    if (params.normalizedTeamCode) {
      where.teamCodeKey = params.normalizedTeamCode;
    }

    if (nonNullMappings.length > 0 || includeNull) {
      where.OR = [
        ...(nonNullMappings.length > 0 ? [{ mappingKey: { in: nonNullMappings } }] : []),
        ...(includeNull ? [{ mappingKey: UNASSIGNED_MAPPING_KEY }] : []),
      ];
    }

    return where;
  }

  async getOverview(
    query: GetSalesAttributionOverviewQueryDto,
  ): Promise<SalesAttributionOverviewContract> {
    const tenantId = this.teamContext.getTenantId();
    const normalizedTeamCode = this.normalize(query.team_code) || null;
    const requestKey = `sales-attribution:${tenantId}:${this.analyticsCache.hashObject({
      ...query,
      mapping: [...(query.mapping || [])].map((value) => this.normalize(value)).sort(),
      team_code: normalizedTeamCode,
    })}`;

    return this.analyticsRequestCoordinator.run(
      tenantId,
      requestKey,
      () => this.calculateOverview(query),
    );
  }

  private async calculateOverview(
    query: GetSalesAttributionOverviewQueryDto,
  ): Promise<SalesAttributionOverviewContract> {
    const excludeAbandoned = true;
    const startStr = (query.start_date && query.start_date.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (query.end_date && query.end_date.trim()) || startStr;

    if (!dayjs(startStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid start_date format. Expected YYYY-MM-DD');
    }
    if (!dayjs(endStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid end_date format. Expected YYYY-MM-DD');
    }
    if (endStr < startStr) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }

    const rangeDays = this.diffDays(startStr, endStr) + 1;
    const prevEndStr = this.shiftDate(startStr, -1);
    const prevStartStr = this.shiftDate(startStr, -rangeDays);

    const startDate = new Date(`${startStr}T00:00:00.000Z`);
    const endDate = new Date(`${endStr}T00:00:00.000Z`);
    const prevStartDate = new Date(`${prevStartStr}T00:00:00.000Z`);
    const prevEndDate = new Date(`${prevEndStr}T00:00:00.000Z`);

    const normalizedMappings = (query.mapping || [])
      .map((mapping) => this.normalize(mapping))
      .filter((mapping) => mapping.length > 0);
    const normalizedTeamCode = this.normalize(query.team_code) || null;
    const tenantId = this.teamContext.getTenantId();

    const currentBaseWhere = this.buildRollupWhere({
      tenantId,
      range: { gte: startDate, lte: endDate },
      normalizedMappings,
      normalizedTeamCode,
    });

    const previousBaseWhere = this.buildRollupWhere({
      tenantId,
      range: { gte: prevStartDate, lte: prevEndDate },
      normalizedMappings,
      normalizedTeamCode,
    });

    const currentTeamFilterWhere = this.buildRollupWhere({
      tenantId,
      range: { gte: startDate, lte: endDate },
      normalizedMappings: [],
    });

    const currentMappingFilterWhere = this.buildRollupWhere({
      tenantId,
      range: { gte: startDate, lte: endDate },
      normalizedMappings: [],
      normalizedTeamCode,
    });

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cachePayload = {
      calculationVersion: 'sales-attribution-cogs-basis-v1',
      tenantId,
      analyticsScope: 'tenant',
      start: startStr,
      end: endStr,
      teamCode: normalizedTeamCode,
      mappings: [...normalizedMappings].sort(),
      flags: {
        excludeCancel: query.exclude_cancel,
        excludeRestocking: query.exclude_restocking,
        excludeAbandoned,
        excludeRts: query.exclude_rts,
        includeTax12: query.include_tax_12,
        includeTax1: query.include_tax_1,
      },
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales-attribution:${this.analyticsCache.hashObject(cachePayload)}`;
    const cached = await this.analyticsCache.get<SalesAttributionOverviewContract>(cacheKey);
    if (cached) {
      this.logger.log(`CACHE HIT ${cacheKey}`);
      return cached;
    }
    this.logger.log(`CACHE MISS ${cacheKey}`);

    const [
      aggregate,
      previousAggregate,
      teamRows,
      mappingRows,
      nullMappingCount,
      productGroups,
      lastUpdatedAgg,
    ] = await Promise.all([
      this.prisma.reconcileSalesAttribution.aggregate({
        where: currentBaseWhere,
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          abandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          abandonedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
        },
      }),
      this.prisma.reconcileSalesAttribution.aggregate({
        where: previousBaseWhere,
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          abandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          abandonedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
        },
      }),
      this.prisma.reconcileSalesAttribution.groupBy({
        where: currentTeamFilterWhere,
        by: ['teamCodeKey', 'teamCode'],
      }),
      this.prisma.reconcileSalesAttribution.findMany({
        where: {
          ...currentMappingFilterWhere,
          mapping: { not: null },
        },
        distinct: ['mappingKey'],
        select: {
          mappingKey: true,
          mapping: true,
        },
      }),
      this.prisma.reconcileSalesAttribution.count({
        where: {
          ...currentMappingFilterWhere,
          mapping: null,
        },
      }),
      this.prisma.reconcileSalesAttribution.groupBy({
        by: ['mapping', 'mappingKey'],
        where: currentBaseWhere,
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          abandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          abandonedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
        },
      }),
      this.prisma.reconcileSalesAttribution.aggregate({
        where: currentBaseWhere,
        _max: { updatedAt: true },
      }),
    ]);

    const teamCodes: string[] = [];
    const teamCodeDisplayMap: Record<string, string> = {};
    teamRows.forEach((row) => {
      if (row.teamCodeKey === UNASSIGNED_TEAM_CODE_KEY) {
        teamCodeDisplayMap[UNASSIGNED_TEAM_CODE_KEY] = 'Unassigned team';
        teamCodes.push(UNASSIGNED_TEAM_CODE_KEY);
        return;
      }
      if (!row.teamCode) return;
      const normalized = row.teamCodeKey || this.normalize(row.teamCode);
      if (!normalized || teamCodeDisplayMap[normalized]) return;
      teamCodeDisplayMap[normalized] = row.teamCode;
      teamCodes.push(normalized);
    });
    teamCodes.sort((a, b) =>
      (teamCodeDisplayMap[a] || a).localeCompare(teamCodeDisplayMap[b] || b),
    );

    const mappingOptions: string[] = [];
    const mappingDisplayMap: Record<string, string> = {};
    mappingRows.forEach((row) => {
      if (!row.mapping) return;
      const normalized = row.mappingKey || this.normalize(row.mapping);
      if (!mappingDisplayMap[normalized]) {
        mappingDisplayMap[normalized] = row.mapping;
        mappingOptions.push(normalized);
      }
    });
    // pv:: keys -> product names, ua:: keys -> "Unassigned — {store}"; coarse
    // labels pass through untouched. Same resolver as the sales page, so both
    // screens name the same buckets identically.
    await resolveMappingDisplayNames(this.prisma, mappingDisplayMap);
    if (nullMappingCount > 0) {
      mappingDisplayMap[NULL_MAPPING_FILTER_KEY] = `Unassigned (${nullMappingCount})`;
      mappingOptions.push(NULL_MAPPING_FILTER_KEY);
    }
    mappingOptions.sort((a, b) => (mappingDisplayMap[a] || a).localeCompare(mappingDisplayMap[b] || b));

    const rtsForecastPct = 20;
    const products = productGroups.map((group) => {
      const row = this.computeProductRow(
        { _sum: group._sum, mapping: group.mapping },
        {
          excludeCancel: query.exclude_cancel,
          excludeRestocking: query.exclude_restocking,
          excludeAbandoned,
          excludeRts: query.exclude_rts,
          includeTax12: query.include_tax_12,
          includeTax1: query.include_tax_1,
          rtsForecastPct,
        },
      );
      return {
        ...row,
        mapping: group.mapping,
      };
    });

    const deliveryStatuses: SalesAttributionDeliveryRow[] = productGroups.map((group) => ({
      mapping: group.mapping,
      total_orders: this.toNumber(group._sum?.purchasesPos),
      new_orders: this.toNumber(group._sum?.unconfirmedCount),
      restocking: this.toNumber(group._sum?.restockingCount),
      confirmed: this.toNumber(group._sum?.confirmedCount),
      printed: this.toNumber(group._sum?.printedCount),
      waiting_pickup: this.toNumber(group._sum?.waitingPickupCount),
      shipped: this.toNumber(group._sum?.shippedCount),
      delivered: this.toNumber(group._sum?.deliveredCount),
      rts: this.toNumber(group._sum?.rtsCount),
      canceled: this.toNumber(group._sum?.canceledCount),
      deleted: this.toNumber(group._sum?.deletedCount),
    }));

    const processedSalesValue =
      this.toNumber(aggregate?._sum?.confirmedCodPos) +
      this.toNumber(aggregate?._sum?.waitingPickupCodPos) +
      this.toNumber(aggregate?._sum?.shippedCodPos) +
      this.toNumber(aggregate?._sum?.deliveredCodPos);
    const previousProcessedSalesValue =
      this.toNumber(previousAggregate?._sum?.confirmedCodPos) +
      this.toNumber(previousAggregate?._sum?.waitingPickupCodPos) +
      this.toNumber(previousAggregate?._sum?.shippedCodPos) +
      this.toNumber(previousAggregate?._sum?.deliveredCodPos);
    const totalOrdersCount = this.toNumber(aggregate?._sum?.purchasesPos);
    const cancelledOrdersCount = this.toNumber(aggregate?._sum?.canceledCount);
    const prevTotalOrdersCount = this.toNumber(previousAggregate?._sum?.purchasesPos);
    const prevCancelledOrdersCount = this.toNumber(previousAggregate?._sum?.canceledCount);

    const kpis = {
      ...this.computeKpis(aggregate, {
        excludeCancel: query.exclude_cancel,
        excludeRestocking: query.exclude_restocking,
        excludeAbandoned,
        excludeRts: query.exclude_rts,
        includeTax12: query.include_tax_12,
        includeTax1: query.include_tax_1,
        rtsForecastPct,
        processedSalesValue,
      }),
      cancellation_rate_pct:
        totalOrdersCount > 0 ? (cancelledOrdersCount / totalOrdersCount) * 100 : 0,
    };
    const prevKpis = {
      ...this.computeKpis(previousAggregate, {
        excludeCancel: query.exclude_cancel,
        excludeRestocking: query.exclude_restocking,
        excludeAbandoned,
        excludeRts: query.exclude_rts,
        includeTax12: query.include_tax_12,
        includeTax1: query.include_tax_1,
        rtsForecastPct,
        processedSalesValue: previousProcessedSalesValue,
      }),
      cancellation_rate_pct:
        prevTotalOrdersCount > 0
          ? (prevCancelledOrdersCount / prevTotalOrdersCount) * 100
          : 0,
    };
    const counts = this.computeCounts(aggregate, {
      excludeCancel: query.exclude_cancel,
      excludeRestocking: query.exclude_restocking,
      excludeAbandoned,
      excludeRts: query.exclude_rts,
    });
    const prevCounts = this.computeCounts(previousAggregate, {
      excludeCancel: query.exclude_cancel,
      excludeRestocking: query.exclude_restocking,
      excludeAbandoned,
      excludeRts: query.exclude_rts,
    });

    const response: SalesAttributionOverviewContract = {
      kpis,
      prevKpis,
      counts,
      prevCounts,
      filters: {
        teamCodes,
        teamCodeDisplayMap,
        mappings: mappingOptions,
        mappingsDisplayMap: mappingDisplayMap,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        teamCode: normalizedTeamCode,
        mappings: normalizedMappings,
      },
      rangeDays,
      lastUpdatedAt: lastUpdatedAgg?._max?.updatedAt || null,
      products,
      deliveryStatuses,
    };

    this.logger.log(`CACHE SET ${cacheKey}`);
    await this.analyticsCache.set(cacheKey, response);
    return response;
  }
}
