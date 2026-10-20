import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TeamContextService } from '../../common/services/team-context.service';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import * as customParseFormat from 'dayjs/plugin/customParseFormat';
import { AnalyticsCacheService } from './analytics-cache.service';
import { ReconcileMarketingService } from '../workflows/services/reconcile-marketing.service';
import {
  resolveMappingDisplayNames,
} from '../workflows/utils/product-mapping-key';
import {
  createEmptyPosAggregateBucket, accumulatePosOrder, calculatePosFees,
} from '../workflows/utils/pos-reporting-components';
import { ReconcileSalesService } from '../workflows/services/reconcile-sales.service';
import { ReconcileSalesAttributionService } from '../workflows/services/reconcile-sales-attribution.service';
import { AnalyticsRequestCoordinatorService } from './analytics-request-coordinator.service';
import { readCurrentAbandonedCosts, attachCurrentAbandonedCosts } from './utils/current-abandoned-cogs';
import { enrichActualDeliveredUnits } from './utils/actual-delivered-units';
import { loadSalesStoreAttribution, partitionTeamAdSpend } from './utils/team-ad-spend';
import {
  UNATTRIBUTED_STORE_KEY,
} from './utils/store-attribution';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TIMEZONE = 'Asia/Manila';
const PROCESSED_SALES_STATUSES = [1, 2, 3, 9, 12, 13] as const;
// Separate calculation revisions from data-cache versions and response shapes:
// persisted responses from earlier math must not survive a calculation deploy.
const SALES_CALCULATION_VERSION = 4;

type SalesKpis = {
  revenue: number;
  delivered: number;
  shipped: number;
  waiting_pickup: number;
  rts: number;
  ad_spend: number;
  processed: number;   // amount (COD) of processed orders
  cancellation_rate_pct: number;
  confirmed: number;   // amount (COD) of confirmed orders
  unconfirmed: number; // amount (COD) of unconfirmed/pending orders
  canceled: number;    // amount (COD) of canceled orders
  aov: number;
  contribution_margin: number;
  net_margin: number;
  ar_pct: number;
  cpp: number;
  processed_cpp: number;
  conversion_rate: number;
  profit_efficiency: number;
  cogs: number;
  cogs_adjusted: number;
  cogs_abandoned: number | null;
  cogs_rts_credit: number;
  cogs_forecast_basis: number;
  cogs_canceled: number;
  cogs_restocking: number;
  cogs_rts: number;
  cogs_delivered: number;
  cod_fee: number;
  cod_fee_delivered: number;
  sf_sdr_fees: number;
  ff_sdr_fees: number;
  if_sdr_fees: number;
  gross_cod: number;
  canceled_cod: number;
  restocking_cod: number;
  rts_cod: number;
  abandoned_cod: number;
  sf_fees: number;
  ff_fees: number;
  if_fees: number;
  cm_rts_forecast?: number;
};

type SalesCounts = {
  purchases: number;
  delivered: number;
  shipped: number;
  waiting_pickup: number;
  rts: number;
  undelivered: number;
  returned: number;
  restocking: number;
  confirmed: number;
  unconfirmed: number;
  canceled: number;
};

type SalesStatusDistribution = {
  total: number;
  delivered: number;
  shipped: number;
  waiting_pickup: number;
  rts: number;
  restocking: number;
  confirmed: number;
  unconfirmed: number;
  canceled: number;
};

type ProductRow = {
  mapping: string | null;
  revenue: number;
  gross_sales: number;
  cogs: number;
  cogs_rts_credit: number;
  cogs_forecast_basis: number;
  cogs_abandoned: number | null;
  cogs_raw: number;
  cogs_canceled: number;
  aov: number;
  cpp: number;
  processed_cpp: number;
  ad_spend: number;
  ar_pct: number;
  profit_efficiency: number;
  contribution_margin: number;
  net_margin: number;
  rts_count: number;
  delivered_count: number;
  cod_raw: number;
  purchases_raw: number;
  sf_raw: number;
  ff_raw: number;
  if_raw: number;
  cod_fee_delivered_raw: number;
  cogs_ec: number; // COGS excluding canceled
  cogs_rts: number;
  cogs_restocking: number;
  canceled_cod: number;
  restocking_cod: number;
  rts_cod: number;
  abandoned_cod: number;
  cm_rts_forecast?: number;
};

type DeliveryStatusRow = {
  mapping: string | null;
  total_orders: number;
  new_orders: number;
  restocking: number;
  confirmed: number;
  printed: number;
  waiting_pickup: number;
  shipped: number;
  delivered: number;
  rts: number;
  canceled: number;
  deleted: number;
};

type SalesOverviewParams = {
  startDate?: string;
  endDate?: string;
  mappings?: string[];
  emptySelection?: boolean;
  teamIds?: string[];
  excludeCancel?: boolean;
  excludeRestocking?: boolean;
  excludeAbandoned?: boolean;
  excludeRts?: boolean;
  excludeRepurchase?: boolean;
  includeTax12?: boolean;
  includeTax1?: boolean;
};

@Injectable()
export class SalesAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teamContext: TeamContextService,
    private readonly analyticsCache: AnalyticsCacheService,
    private readonly analyticsRequestCoordinator: AnalyticsRequestCoordinatorService,
    private readonly reconcileMarketingService: ReconcileMarketingService,
    private readonly reconcileSalesService: ReconcileSalesService,
    private readonly reconcileSalesAttributionService: ReconcileSalesAttributionService,
  ) {}

  private readonly logger = new Logger(SalesAnalyticsService.name);

  private parseDate(input?: string): Date {
    if (!input) return new Date();
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return d;
  }

  private normalize(val?: string | null): string {
    return (val || '').trim().toLowerCase();
  }

  private toNumber(val: any): number {
    const n = typeof val === 'string' ? parseFloat(val) : Number(val);
    return Number.isFinite(n) ? n : 0;
  }

  private normalizeTeamIds(values: string[] = []): string[] {
    if (!Array.isArray(values) || values.length > 100 || values.some(id => typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))) {
      throw new BadRequestException('Select valid tenant teams.');
    }
    return [...new Set(values.map(id => id.toLowerCase()))].sort();
  }

  private async analyticsTeamWhere(db: any, tenantId: string, teamIds: string[]) {
    if (!teamIds.length) return {};
    const rows = await db.team.findMany({ where: { tenantId, id: { in: teamIds }, status: 'ACTIVE' }, select: { id: true } });
    if (rows.length !== teamIds.length || rows.some((row: any) => !teamIds.includes(row.id))) {
      throw new BadRequestException('Selected teams must be active teams in this tenant.');
    }
    return { teamId: { in: teamIds } };
  }

  private shiftDate(dateStr: string, days: number): string {
    return dayjs(dateStr, 'YYYY-MM-DD').add(days, 'day').format('YYYY-MM-DD');
  }

  private diffDays(startStr: string, endStr: string): number {
    const s = dayjs(startStr, 'YYYY-MM-DD');
    const e = dayjs(endStr, 'YYYY-MM-DD');
    return e.diff(s, 'day');
  }

  private getRepurchaseAdjustments(
    sum: any,
    opts: {
      excludeRepurchase: boolean;
      excludeCancel: boolean;
      excludeRestocking: boolean;
      excludeAbandoned: boolean;
      excludeRts: boolean;
    },
  ) {
    if (!opts.excludeRepurchase) {
      return {
        purchases: 0,
        codVisible: 0,
        codRaw: 0,
        processedPurchases: 0,
        cogsVisible: 0,
        cogsRaw: 0,
        cogsCanceled: 0,
        cogsRestocking: 0,
        cogsAbandoned: 0,
        cogsDelivered: 0,
        cogsRts: 0,
        deliveredCod: 0,
        shippedCod: 0,
        waitingPickupCod: 0,
        rtsCod: 0,
        canceledCod: 0,
        restockingCod: 0,
        abandonedCod: 0,
        confirmedCod: 0,
        unconfirmedCod: 0,
        deliveredCount: 0,
        shippedCount: 0,
        waitingPickupCount: 0,
        rtsCount: 0,
        canceledCount: 0,
        restockingCount: 0,
        abandonedCount: 0,
        confirmedCount: 0,
        unconfirmedCount: 0,
        sf: 0,
        ff: 0,
        inf: 0,
        sfSdr: 0,
        ffSdr: 0,
        ifSdr: 0,
        codFee: 0,
        codFeeDelivered: 0,
      };
    }

    const repurchaseCount = this.toNumber(sum?._sum?.repurchaseCount);
    const repurchaseCod = this.toNumber(sum?._sum?.repurchaseCodPos);
    const repurchaseCogs = this.toNumber(sum?._sum?.repurchaseCogsPos);

    return {
      purchases:
        repurchaseCount -
        (opts.excludeCancel ? this.toNumber(sum?._sum?.repurchaseCanceledCount) : 0) -
        (opts.excludeRestocking ? this.toNumber(sum?._sum?.repurchaseRestockingCount) : 0) -
        (opts.excludeAbandoned ? this.toNumber(sum?._sum?.repurchaseCurrentAbandonedCount) : 0) -
        (opts.excludeRts ? this.toNumber(sum?._sum?.repurchaseRtsCount) : 0),
      codVisible:
        repurchaseCod -
        (opts.excludeCancel ? this.toNumber(sum?._sum?.repurchaseCanceledCodPos) : 0) -
        (opts.excludeRestocking ? this.toNumber(sum?._sum?.repurchaseRestockingCodPos) : 0) -
        (opts.excludeAbandoned ? this.toNumber(sum?._sum?.repurchaseCurrentAbandonedCodPos) : 0) -
        (opts.excludeRts ? this.toNumber(sum?._sum?.repurchaseRtsCodPos) : 0),
      codRaw: repurchaseCod,
      processedPurchases: this.toNumber(sum?._sum?.repurchaseProcessedPurchasesPos),
      cogsVisible:
        repurchaseCogs -
        (opts.excludeCancel ? this.toNumber(sum?._sum?.repurchaseCogsCanceledPos) : 0) -
        (opts.excludeRestocking ? this.toNumber(sum?._sum?.repurchaseCogsRestockingPos) : 0) -
        (opts.excludeAbandoned ? this.toNumber(sum?._sum?.repurchaseCogsCurrentAbandonedPos) : 0),
      cogsRaw: repurchaseCogs,
      cogsCanceled: this.toNumber(sum?._sum?.repurchaseCogsCanceledPos),
      cogsRestocking: this.toNumber(sum?._sum?.repurchaseCogsRestockingPos),
      cogsAbandoned: this.toNumber(sum?._sum?.repurchaseCogsCurrentAbandonedPos),
      cogsDelivered: this.toNumber(sum?._sum?.repurchaseCogsDeliveredPos),
      cogsRts: this.toNumber(sum?._sum?.repurchaseCogsRtsPos),
      deliveredCod: this.toNumber(sum?._sum?.repurchaseDeliveredCodPos),
      shippedCod: this.toNumber(sum?._sum?.repurchaseShippedCodPos),
      waitingPickupCod: this.toNumber(sum?._sum?.repurchaseWaitingPickupCodPos),
      rtsCod: this.toNumber(sum?._sum?.repurchaseRtsCodPos),
      canceledCod: this.toNumber(sum?._sum?.repurchaseCanceledCodPos),
      restockingCod: this.toNumber(sum?._sum?.repurchaseRestockingCodPos),
      abandonedCod: this.toNumber(sum?._sum?.repurchaseCurrentAbandonedCodPos),
      confirmedCod: this.toNumber(sum?._sum?.repurchaseConfirmedCodPos),
      unconfirmedCod: this.toNumber(sum?._sum?.repurchaseUnconfirmedCodPos),
      deliveredCount: this.toNumber(sum?._sum?.repurchaseDeliveredCount),
      shippedCount: this.toNumber(sum?._sum?.repurchaseShippedCount),
      waitingPickupCount: this.toNumber(sum?._sum?.repurchaseWaitingPickupCount),
      rtsCount: this.toNumber(sum?._sum?.repurchaseRtsCount),
      canceledCount: this.toNumber(sum?._sum?.repurchaseCanceledCount),
      restockingCount: this.toNumber(sum?._sum?.repurchaseRestockingCount),
      abandonedCount: this.toNumber(sum?._sum?.repurchaseCurrentAbandonedCount),
      confirmedCount: this.toNumber(sum?._sum?.repurchaseConfirmedCount),
      unconfirmedCount: this.toNumber(sum?._sum?.repurchaseUnconfirmedCount),
      sf: this.toNumber(sum?._sum?.repurchaseSfPos),
      ff: this.toNumber(sum?._sum?.repurchaseFfPos),
      inf: this.toNumber(sum?._sum?.repurchaseIfPos),
      sfSdr: this.toNumber(sum?._sum?.repurchaseSfSdrPos),
      ffSdr: this.toNumber(sum?._sum?.repurchaseFfSdrPos),
      ifSdr: this.toNumber(sum?._sum?.repurchaseIfSdrPos),
      codFee: this.toNumber(sum?._sum?.repurchaseCodFeePos),
      codFeeDelivered: this.toNumber(sum?._sum?.repurchaseCodFeeDeliveredPos),
    };
  }

  private buildVolumeGrowthTrend(
    rows: Array<{
      date: string;
      shipped: number | null;
      delivered: number | null;
      rts: number | null;
    }>,
    startStr: string,
    endStr: string,
  ) {
    const byDate = new Map(
      rows.map((row) => [
        (row.date || '').toString(),
        {
          shipped: this.toNumber(row.shipped),
          delivered: this.toNumber(row.delivered),
          rts: this.toNumber(row.rts),
        },
      ]),
    );

    const totalDays = this.diffDays(startStr, endStr);
    return Array.from({ length: totalDays + 1 }, (_, index) => {
      const date = this.shiftDate(startStr, index);
      const values = byDate.get(date);
      return {
        date,
        shipped: values?.shipped ?? 0,
        delivered: values?.delivered ?? 0,
        rts: values?.rts ?? 0,
      };
    });
  }

  private computeKpis(sum: any, opts: { excludeCancel: boolean; excludeRestocking: boolean; excludeAbandoned: boolean; excludeRts: boolean; excludeRepurchase: boolean; includeTax12: boolean; includeTax1: boolean; rtsForecastPct?: number; processedSalesValue?: number }): SalesKpis {
    const spendBase = this.toNumber(sum?._sum?.spend);
    const spendMultiplier = 1 + (opts.includeTax12 ? 0.12 : 0) + (opts.includeTax1 ? 0.01 : 0);
    const spend = spendBase * spendMultiplier;
    const cod = this.toNumber(sum?._sum?.codPos);
    const canceledCod = this.toNumber(sum?._sum?.canceledCodPos);
    const restockingCod = this.toNumber(sum?._sum?.restockingCodPos);
    const abandonedCod = this.toNumber(sum?._sum?.currentAbandonedCodPos);
    const rtsCod = this.toNumber(sum?._sum?.rtsCodPos);
    const codFee = this.toNumber(sum?._sum?.codFeePos);
    const repurchaseAdj = this.getRepurchaseAdjustments(sum, opts);

    // Revenue after optional exclusions
    const revenue =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      - (opts.excludeRts ? rtsCod : 0)
      - repurchaseAdj.codVisible;

    const cogs = this.toNumber(sum?._sum?.cogsPos);
    const cogsCanceled = this.toNumber(sum?._sum?.cogsCanceledPos);
    const cogsRestocking = this.toNumber(sum?._sum?.cogsRestockingPos);
    const cogsAbandoned = this.toNumber(sum?._sum?.cogsCurrentAbandonedPos);
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsDelivered = this.toNumber(sum?._sum?.cogsDeliveredPos);
    const sf = this.toNumber(sum?._sum?.sfPos);
    const ff = this.toNumber(sum?._sum?.ffPos);
    const inf = this.toNumber(sum?._sum?.ifPos);
    const sfSdr = this.toNumber(sum?._sum?.sfSdrPos);
    const ffSdr = this.toNumber(sum?._sum?.ffSdrPos);
    const ifSdr = this.toNumber(sum?._sum?.ifSdrPos);
    // COGS after optional exclusions (remove excluded portions from the total once)
    const cogsBeforeRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0)
      - (opts.excludeAbandoned ? cogsAbandoned : 0)
      - repurchaseAdj.cogsVisible;
    const selectedRtsCogs = cogsRts - repurchaseAdj.cogsRts;
    const cogsAdjusted = cogsBeforeRts - (opts.excludeRts ? selectedRtsCogs : 0);
    // A returned item's cost is credited only while it is still in COGS.
    // Excluding it above and crediting it again would inflate contribution.
    const cogsRtsCredit = opts.excludeRts ? 0 : selectedRtsCogs;
    const cogsDeliveredAdj = cogsDelivered - repurchaseAdj.cogsDelivered;
    const cogsRtsAdj = cogsRts - repurchaseAdj.cogsRts;
    const sfAdj = sf - repurchaseAdj.sf;
    const ffAdj = ff - repurchaseAdj.ff;
    const ifAdj = inf - repurchaseAdj.inf;
    const sfSdrAdj = sfSdr - repurchaseAdj.sfSdr;
    const ffSdrAdj = ffSdr - repurchaseAdj.ffSdr;
    const ifSdrAdj = ifSdr - repurchaseAdj.ifSdr;
    const codFeeAdj = codFee - repurchaseAdj.codFee;
    const codFeeDeliveredAdj =
      this.toNumber(sum?._sum?.codFeeDeliveredPos) - repurchaseAdj.codFeeDelivered;
    const arPct = revenue > 0 ? (spend / revenue) * 100 : 0;

    const cm =
      revenue
      - cogsAdjusted
      - sfAdj
      - ffAdj
      - ifAdj
      - spend
      - codFeeAdj
      + cogsRtsCredit;
    const delivered =
      this.toNumber(sum?._sum?.deliveredCodPos) - repurchaseAdj.deliveredCod;
    const net =
      delivered
      - sfSdrAdj
      - ffSdrAdj
      - ifSdrAdj
      - codFeeDeliveredAdj
      - cogsDeliveredAdj
      - spend;

    // AOV uses adjusted purchases (respecting exclude flags for cancel/restocking/RTS)
    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdjCount = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdjCount = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdjCount = opts.excludeAbandoned ? this.toNumber(sum?._sum?.currentAbandonedCount) : 0;
    const rtsAdjCount = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const purchasesAdj = Math.max(
      0,
      purchasesRaw -
        cancelAdjCount -
        restockAdjCount -
        abandonedAdjCount -
        rtsAdjCount -
        repurchaseAdj.purchases,
    );
    const processedPurchases =
      this.toNumber(sum?._sum?.processedPurchasesPos) - repurchaseAdj.processedPurchases;
    const cpp = purchasesAdj > 0 ? spend / purchasesAdj : 0;
    const processedCpp = processedPurchases > 0 ? spend / processedPurchases : 0;
    const leads = this.toNumber(sum?._sum?.leads);
    const conversionRate = leads > 0 ? (purchasesAdj / leads) * 100 : 0;
    const profitEfficiency = spend > 0 ? (cm / spend) * 100 : 0;

    const grossCodAdjusted =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      // The forecast keeps RTS revenue before applying its scenario percentage,
      // so it must remove the repurchase RTS subset as well.
      - repurchaseAdj.codVisible
      - (opts.excludeRts ? repurchaseAdj.rtsCod : 0);
    const cogsAdjustedForCmRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0)
      - (opts.excludeAbandoned ? cogsAbandoned : 0)
      - repurchaseAdj.cogsVisible;
    const purchasesAdjForCmRts = Math.max(
      0,
      purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount
        - repurchaseAdj.purchases - (opts.excludeRts ? repurchaseAdj.rtsCount : 0),
    );
    const aovForCmRts = purchasesAdjForCmRts > 0 ? grossCodAdjusted / purchasesAdjForCmRts : 0;
    const revenueBaseForCmRts = aovForCmRts * purchasesAdjForCmRts;
    const rtsForecast = typeof opts.rtsForecastPct === 'number' ? opts.rtsForecastPct : 20;
    const rtsFraction = rtsForecast / 100;
    const cmRtsForecast =
      (1 - rtsFraction) * revenueBaseForCmRts -
      spend -
      sfAdj -
      ffAdj -
      ifAdj -
      codFeeDeliveredAdj -
      cogsAdjustedForCmRts +
      cogsRtsAdj;

    return {
      revenue,
      delivered,
      shipped: this.toNumber(sum?._sum?.shippedCodPos) - repurchaseAdj.shippedCod,
      waiting_pickup:
        this.toNumber(sum?._sum?.waitingPickupCodPos) - repurchaseAdj.waitingPickupCod,
      rts: this.toNumber(sum?._sum?.rtsCodPos) - repurchaseAdj.rtsCod,
      ad_spend: spend,
      processed: this.toNumber(opts.processedSalesValue),
      cancellation_rate_pct: 0,
      aov: purchasesAdj > 0 ? revenue / purchasesAdj : 0,
      ar_pct: arPct,
      cpp,
      processed_cpp: processedCpp,
      conversion_rate: conversionRate,
      profit_efficiency: profitEfficiency,
      confirmed: this.toNumber(sum?._sum?.confirmedCodPos) - repurchaseAdj.confirmedCod,
      unconfirmed:
        this.toNumber(sum?._sum?.unconfirmedCodPos) - repurchaseAdj.unconfirmedCod,
      // Show canceled COD regardless of exclude_cancel toggle for KPI display
      canceled: this.toNumber(sum?._sum?.canceledCodPos) - repurchaseAdj.canceledCod,
      contribution_margin: cm,
      net_margin: net,
      cogs: cogs - repurchaseAdj.cogsRaw,
      cogs_adjusted: cogsAdjusted,
      cogs_abandoned: sum?._sum?.cogsCurrentAbandonedPos === undefined ? null : cogsAbandoned - repurchaseAdj.cogsAbandoned,
      cogs_rts_credit: cogsRtsCredit,
      cogs_forecast_basis: cogsBeforeRts,
      cogs_canceled: cogsCanceled - repurchaseAdj.cogsCanceled,
      cogs_restocking: cogsRestocking - repurchaseAdj.cogsRestocking,
      cogs_rts: cogsRtsAdj,
      cogs_delivered: cogsDeliveredAdj,
      cod_fee: codFeeAdj,
      cod_fee_delivered: codFeeDeliveredAdj,
      sf_sdr_fees: sfSdrAdj,
      ff_sdr_fees: ffSdrAdj,
      if_sdr_fees: ifSdrAdj,
      gross_cod: cod - repurchaseAdj.codRaw,
      canceled_cod: canceledCod - repurchaseAdj.canceledCod,
      restocking_cod: restockingCod - repurchaseAdj.restockingCod,
      rts_cod: rtsCod - repurchaseAdj.rtsCod,
      abandoned_cod: abandonedCod - repurchaseAdj.abandonedCod,
      sf_fees: sfAdj,
      ff_fees: ffAdj,
      if_fees: ifAdj,
      cm_rts_forecast: cmRtsForecast,
    };
  }

  private computeCounts(
    sum: any,
    opts: { excludeCancel: boolean; excludeRestocking: boolean; excludeAbandoned: boolean; excludeRts: boolean; excludeRepurchase: boolean },
    stageCounts?: { undelivered?: number; returned?: number },
  ): SalesCounts {
    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdj = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdj = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdj = opts.excludeAbandoned ? this.toNumber(sum?._sum?.currentAbandonedCount) : 0;
    const rtsAdj = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const repurchaseAdj = this.getRepurchaseAdjustments(sum, opts);
    const adj = Math.min(
      purchasesRaw,
      cancelAdj + restockAdj + abandonedAdj + rtsAdj + repurchaseAdj.purchases,
    );
    const purchases = Math.max(0, purchasesRaw - adj);
    return {
      purchases,
      delivered: this.toNumber(sum?._sum?.deliveredCount) - repurchaseAdj.deliveredCount,
      shipped: this.toNumber(sum?._sum?.shippedCount) - repurchaseAdj.shippedCount,
      waiting_pickup:
        this.toNumber(sum?._sum?.waitingPickupCount) - repurchaseAdj.waitingPickupCount,
      // Keep RTS count constant regardless of excludeRts toggle so KPI remains comparable
      rts: this.toNumber(sum?._sum?.rtsCount) - repurchaseAdj.rtsCount,
      undelivered: this.toNumber(stageCounts?.undelivered),
      returned: this.toNumber(stageCounts?.returned),
      restocking: this.toNumber(sum?._sum?.restockingCount) - repurchaseAdj.restockingCount,
      confirmed: this.toNumber(sum?._sum?.confirmedCount) - repurchaseAdj.confirmedCount,
      unconfirmed:
        this.toNumber(sum?._sum?.unconfirmedCount) - repurchaseAdj.unconfirmedCount,
      // Show canceled count regardless of exclude_cancel toggle for KPI display
      canceled: this.toNumber(sum?._sum?.canceledCount) - repurchaseAdj.canceledCount,
    };
  }

  private computeStatusDistribution(sum: any, excludeRepurchase = true): SalesStatusDistribution {
    const withoutRepurchase = (countKey: string, repurchaseCountKey: string) =>
      Math.max(
        0,
        this.toNumber(sum?._sum?.[countKey]) -
          (excludeRepurchase ? this.toNumber(sum?._sum?.[repurchaseCountKey]) : 0),
      );

    return {
      total: withoutRepurchase('purchasesPos', 'repurchaseCount'),
      delivered: withoutRepurchase('deliveredCount', 'repurchaseDeliveredCount'),
      shipped: withoutRepurchase('shippedCount', 'repurchaseShippedCount'),
      waiting_pickup: withoutRepurchase(
        'waitingPickupCount',
        'repurchaseWaitingPickupCount',
      ),
      rts: withoutRepurchase('rtsCount', 'repurchaseRtsCount'),
      restocking: withoutRepurchase('restockingCount', 'repurchaseRestockingCount'),
      confirmed: withoutRepurchase('confirmedCount', 'repurchaseConfirmedCount'),
      unconfirmed: withoutRepurchase('unconfirmedCount', 'repurchaseUnconfirmedCount'),
      canceled: withoutRepurchase('canceledCount', 'repurchaseCanceledCount'),
    };
  }

  private computeDeliveryRow(sum: any, mapping: string | null, excludeRepurchase: boolean): DeliveryStatusRow {
    const value = (field: string, repeat: string) => this.toNumber(sum?.[field])
      - (excludeRepurchase ? this.toNumber(sum?.[repeat]) : 0);
    return {
      mapping,
      total_orders: value('purchasesPos', 'repurchaseCount'),
      new_orders: value('unconfirmedCount', 'repurchaseUnconfirmedCount'),
      restocking: value('restockingCount', 'repurchaseRestockingCount'),
      confirmed: value('confirmedCount', 'repurchaseConfirmedCount'),
      printed: value('printedCount', 'repurchasePrintedCount'),
      waiting_pickup: value('waitingPickupCount', 'repurchaseWaitingPickupCount'),
      shipped: value('shippedCount', 'repurchaseShippedCount'),
      delivered: value('deliveredCount', 'repurchaseDeliveredCount'),
      rts: value('rtsCount', 'repurchaseRtsCount'),
      canceled: value('canceledCount', 'repurchaseCanceledCount'),
      deleted: value('deletedCount', 'repurchaseDeletedCount'),
    };
  }

  private computeProductRow(sum: any, opts: { excludeCancel: boolean; excludeRestocking: boolean; excludeAbandoned: boolean; excludeRts: boolean; excludeRepurchase: boolean; includeTax12: boolean; includeTax1: boolean; rtsForecastPct?: number }): ProductRow {
    const spendBase = this.toNumber(sum?._sum?.spend);
    const spendMultiplier = 1 + (opts.includeTax12 ? 0.12 : 0) + (opts.includeTax1 ? 0.01 : 0);
    const spend = spendBase * spendMultiplier;
    const cod = this.toNumber(sum?._sum?.codPos);
    const canceledCod = this.toNumber(sum?._sum?.canceledCodPos);
    const restockingCod = this.toNumber(sum?._sum?.restockingCodPos);
    const abandonedCod = this.toNumber(sum?._sum?.currentAbandonedCodPos);
    const rtsCod = this.toNumber(sum?._sum?.rtsCodPos);
    const repurchaseAdj = this.getRepurchaseAdjustments(sum, opts);
    const revenue =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      - (opts.excludeRts ? rtsCod : 0)
      - repurchaseAdj.codVisible;

    const purchasesRaw = this.toNumber(sum?._sum?.purchasesPos);
    const cancelAdjCount = opts.excludeCancel ? this.toNumber(sum?._sum?.canceledCount) : 0;
    const restockAdjCount = opts.excludeRestocking ? this.toNumber(sum?._sum?.restockingCount) : 0;
    const abandonedAdjCount = opts.excludeAbandoned ? this.toNumber(sum?._sum?.currentAbandonedCount) : 0;
    const rtsAdjCount = opts.excludeRts ? this.toNumber(sum?._sum?.rtsCount) : 0;
    const purchasesAdj = Math.max(
      0,
      purchasesRaw -
        cancelAdjCount -
        restockAdjCount -
        abandonedAdjCount -
        rtsAdjCount -
        repurchaseAdj.purchases,
    );
    const processedPurchases =
      this.toNumber(sum?._sum?.processedPurchasesPos) - repurchaseAdj.processedPurchases;

    const cogs = this.toNumber(sum?._sum?.cogsPos);
    const cogsCanceled = this.toNumber(sum?._sum?.cogsCanceledPos);
    const cogsRestocking = this.toNumber(sum?._sum?.cogsRestockingPos);
    const cogsAbandoned = this.toNumber(sum?._sum?.cogsCurrentAbandonedPos);
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsBeforeRts =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0)
      - (opts.excludeAbandoned ? cogsAbandoned : 0)
      - repurchaseAdj.cogsVisible;
    const selectedRtsCogs = cogsRts - repurchaseAdj.cogsRts;
    const cogsAdjusted = cogsBeforeRts - (opts.excludeRts ? selectedRtsCogs : 0);
    // A returned item's cost is credited only while it is still in COGS.
    // Excluding it above and crediting it again would inflate contribution.
    const cogsRtsCredit = opts.excludeRts ? 0 : selectedRtsCogs;

    const sf = this.toNumber(sum?._sum?.sfPos);
    const ff = this.toNumber(sum?._sum?.ffPos);
    const inf = this.toNumber(sum?._sum?.ifPos);
    const codFee = this.toNumber(sum?._sum?.codFeePos);

    const cm =
      revenue
      - cogsAdjusted
      - (sf - repurchaseAdj.sf)
      - (ff - repurchaseAdj.ff)
      - (inf - repurchaseAdj.inf)
      - spend
      - (codFee - repurchaseAdj.codFee)
      + cogsRtsCredit;

    const delivered = this.toNumber(sum?._sum?.deliveredCodPos) - repurchaseAdj.deliveredCod;
    const sfSdr = this.toNumber(sum?._sum?.sfSdrPos);
    const ffSdr = this.toNumber(sum?._sum?.ffSdrPos);
    const ifSdr = this.toNumber(sum?._sum?.ifSdrPos);
    const codFeeDelivered = this.toNumber(sum?._sum?.codFeeDeliveredPos);
    const cogsDelivered = this.toNumber(sum?._sum?.cogsDeliveredPos);
    const net =
      delivered
      - (sfSdr - repurchaseAdj.sfSdr)
      - (ffSdr - repurchaseAdj.ffSdr)
      - (ifSdr - repurchaseAdj.ifSdr)
      - (codFeeDelivered - repurchaseAdj.codFeeDelivered)
      - (cogsDelivered - repurchaseAdj.cogsDelivered)
      - spend;

    const arPct = revenue > 0 ? (spend / revenue) * 100 : 0;
    const profitEfficiency = spend > 0 ? (cm / spend) * 100 : 0;
    const aov = purchasesAdj > 0 ? revenue / purchasesAdj : 0;
    const cpp = purchasesAdj > 0 ? spend / purchasesAdj : 0;
    const processedCpp = processedPurchases > 0 ? spend / processedPurchases : 0;
    const purchasesAdjForCmRts = Math.max(
      0,
      purchasesRaw - cancelAdjCount - restockAdjCount - abandonedAdjCount
        - repurchaseAdj.purchases - (opts.excludeRts ? repurchaseAdj.rtsCount : 0),
    );
    const grossCodAdjusted =
      cod
      - (opts.excludeCancel ? canceledCod : 0)
      - (opts.excludeRestocking ? restockingCod : 0)
      - (opts.excludeAbandoned ? abandonedCod : 0)
      - repurchaseAdj.codVisible
      - (opts.excludeRts ? repurchaseAdj.rtsCod : 0);
    const aovForCmRts = purchasesAdjForCmRts > 0 ? grossCodAdjusted / purchasesAdjForCmRts : 0;
    const revenueBaseForCmRts = aovForCmRts * purchasesAdjForCmRts;
    const rtsForecast = typeof opts.rtsForecastPct === 'number' ? opts.rtsForecastPct : 20;
    const rtsFraction = rtsForecast / 100;
    const cmRtsForecast =
      (1 - rtsFraction) * revenueBaseForCmRts -
      spend -
      (sf - repurchaseAdj.sf) -
      (ff - repurchaseAdj.ff) -
      (inf - repurchaseAdj.inf) -
      (codFeeDelivered - repurchaseAdj.codFeeDelivered) -
      cogsBeforeRts +
      (cogsRts - repurchaseAdj.cogsRts);

    return {
      mapping: sum.mapping ?? null,
      revenue,
      gross_sales: purchasesAdj,
      cogs: cogsAdjusted,
      cogs_abandoned: sum?._sum?.cogsCurrentAbandonedPos === undefined ? null : cogsAbandoned - repurchaseAdj.cogsAbandoned,
      cogs_rts_credit: cogsRtsCredit,
      cogs_forecast_basis: cogsBeforeRts,
      cogs_raw: cogs - repurchaseAdj.cogsRaw,
      cogs_canceled: cogsCanceled - repurchaseAdj.cogsCanceled,
      aov,
      cpp,
      processed_cpp: processedCpp,
      ad_spend: spend,
      ar_pct: arPct,
      profit_efficiency: profitEfficiency,
      contribution_margin: cm,
      net_margin: net,
      rts_count: this.toNumber(sum?._sum?.rtsCount) - repurchaseAdj.rtsCount,
      delivered_count: this.toNumber(sum?._sum?.deliveredCount) - repurchaseAdj.deliveredCount,
      // Repurchase-adjusted like its siblings below, so the per-product
      // CM (RTS %) revenue base matches the KPI/Total (which use gross_cod =
      // cod - repurchaseAdj.codRaw). Leaving this raw inflated the product
      // row's forecast by the repurchase COD.
      cod_raw: cod - repurchaseAdj.codRaw,
      purchases_raw: purchasesRaw,
      sf_raw: sf - repurchaseAdj.sf,
      ff_raw: ff - repurchaseAdj.ff,
      if_raw: inf - repurchaseAdj.inf,
      cod_fee_delivered_raw:
        this.toNumber(sum?._sum?.codFeeDeliveredPos) - repurchaseAdj.codFeeDelivered,
      cogs_ec: cogs - repurchaseAdj.cogsRaw - (cogsCanceled - repurchaseAdj.cogsCanceled),
      cogs_rts: cogsRts - repurchaseAdj.cogsRts,
      cogs_restocking: cogsRestocking - repurchaseAdj.cogsRestocking,
      canceled_cod: canceledCod - repurchaseAdj.canceledCod,
      restocking_cod: restockingCod - repurchaseAdj.restockingCod,
      rts_cod: rtsCod - repurchaseAdj.rtsCod,
      abandoned_cod: abandonedCod - repurchaseAdj.abandonedCod,
      cm_rts_forecast: cmRtsForecast,
    };
  }

  async getOverview(params: SalesOverviewParams, requestingUser?: { role?: string }) {
    params = { ...params, teamIds: this.normalizeTeamIds(params.teamIds) };
    const tenantId = this.teamContext.getTenantId();
    const requestKey = `sales-overview:${tenantId}:${this.analyticsCache.hashObject({
      ...params,
      sourceRevision: 'PER_AD_MAPPING_V1',
      readConsistency: 'READ_ONLY_REPEATABLE_READ',
      mappings: [...(params.mappings || [])].map((value) => this.normalize(value)).sort(),
    })}`;

    const response = await this.analyticsRequestCoordinator.run(
      tenantId,
      requestKey,
      () => this.calculateOverview(params),
    );
    return this.attachDeliveredUnits(response, params, requestingUser, 'product', tenantId);
  }

  private async attachDeliveredUnits(
    response: any, params: SalesOverviewParams, requestingUser: { role?: string } | undefined,
    mode: 'product' | 'store', tenantId: string,
  ) {
    // Authorization is the current authenticated identity, including View As.
    // This decoration runs AFTER both caches and never mutates their public
    // response. No original-actor role or client include flag grants access.
    if (requestingUser?.role !== 'SUPER_ADMIN') return response;
    const scope = {
      tenantId, start: response.selected.start_date, end: response.selected.end_date,
      teamIds: params.teamIds ?? [], excludeRepurchase: params.excludeRepurchase !== false,
      emptySelection: params.emptySelection === true,
      allSelected: !(params.mappings ?? []).some(value => this.normalize(value).length > 0),
    };
    // The public operation has finished, so this does not hold a coordinator
    // slot while waiting for another one. Bound/coalesce protected SQL reads
    // too; include the base response so concurrent snapshots cannot cross.
    const key = `sales-actual-delivered-units:${tenantId}:${this.analyticsCache.hashObject({ scope, mode, response })}`;
    return this.analyticsRequestCoordinator.run(tenantId, key,
      () => enrichActualDeliveredUnits(this.prisma, response, scope, mode));
  }

  private async calculateOverview(params: SalesOverviewParams) {
    return this.prisma.$transaction(async (db) => {
      await db.$executeRaw`SET TRANSACTION READ ONLY`;
      return this.calculateOverviewSnapshot(params, db);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 60000 });
  }

  private async calculateOverviewSnapshot(params: SalesOverviewParams, db: Prisma.TransactionClient) {
    const { startDate, endDate, mappings = [], excludeCancel = true, excludeRestocking = true, excludeAbandoned = true, excludeRts = true, excludeRepurchase = true, includeTax12 = false, includeTax1 = false } = params;

    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;

    // Validate date formats
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

    // Convert to Date objects for Prisma queries (date column stores calendar dates, no time component)
    const startDate_dt = new Date(`${startStr}T00:00:00.000Z`);
    const endDate_dt = new Date(`${endStr}T00:00:00.000Z`);
    const prevStartDate_dt = new Date(`${prevStartStr}T00:00:00.000Z`);
    const prevEndDate_dt = new Date(`${prevEndStr}T00:00:00.000Z`);

    const normalizedMappings = mappings.map((m) => this.normalize(m)).filter((v) => v.length > 0);
    const includeNull = normalizedMappings.includes(this.normalize('__null__'));

    const tenantId = this.teamContext.getTenantId();
    const teamIds = params.teamIds || [];
    const teamWhere = await this.analyticsTeamWhere(db, tenantId, teamIds);
    const activeStores = await db.posStore.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [{ enabled: true }, { enabled: null }],
      },
      select: { id: true, shopId: true, teamId: true },
    });
    const activeShopIds = Array.from(new Set(activeStores.map((store) => store.shopId)));

    const mappingFilter =
      params.emptySelection ? { id: { in: [] as string[] } } : normalizedMappings.length > 0
        ? {
            OR: [
              ...normalizedMappings
                .filter((m) => m !== this.normalize('__null__'))
                .map((m) => ({
                  mapping: { equals: m, mode: 'insensitive' as const },
                })),
              ...(includeNull ? [{ mapping: null as any }] : []),
            ],
          }
        : {};

    const baseWhere = this.teamContext.buildTenantWhereClause({
      ...teamWhere,
      date: { gte: startDate_dt, lte: endDate_dt },
    });

    const where = {
      ...baseWhere,
      ...mappingFilter,
    };
    const processedSalesWhere = this.teamContext.buildTenantWhereClause({
      ...teamWhere,
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const prevProcessedSalesWhere = this.teamContext.buildTenantWhereClause({
      ...teamWhere,
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const cancellationRateWhere = this.teamContext.buildTenantWhereClause({
      ...teamWhere,
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const prevCancellationRateWhere = this.teamContext.buildTenantWhereClause({
      ...teamWhere,
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      responseShapeVersion: 9,
      emptySelection: params.emptySelection === true,
      sourceRevision: 'PER_AD_MAPPING_V1',
      readConsistency: 'READ_ONLY_REPEATABLE_READ',
      calculationVersion: SALES_CALCULATION_VERSION,
      tenantId,
      analyticsScope: 'tenant',
      teamIds,
      activeShopIds: [...activeShopIds].sort(),
      adTeamStores: teamIds.length ? activeStores.map(store => `${store.id}:${store.shopId}:${store.teamId ?? ''}`).sort() : [],
      start: startStr,
      end: endStr,
      mappings: normalizedMappings.sort(),
      includeNull,
      processedSalesStatuses: PROCESSED_SALES_STATUSES,
      cancellationRateFormula: 'status_6_over_status_not_7',
      flags: { excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase, includeTax12, includeTax1 },
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales:${this.analyticsCache.hashObject(cacheKeyPayload)}`;
    const cached = await this.analyticsCache.get<any>(cacheKey);
    if (cached) {
      this.logger.log(`CACHE HIT ${cacheKey}`);
      return cached;
    }
    this.logger.log(`CACHE MISS ${cacheKey}`);

    const volumeGrowthWhere: Prisma.Sql[] = [
      Prisma.sql`"tenantId" = ${tenantId}::uuid`,
      Prisma.sql`"status" IS DISTINCT FROM 7`,
      Prisma.sql`"isVoid" = false`,
      activeShopIds.length > 0
        ? Prisma.sql`"shopId" IN (${Prisma.join(activeShopIds)})`
        : Prisma.sql`FALSE`,
    ];
    if (teamIds.length) volumeGrowthWhere.push(Prisma.sql`"teamId" IN (${Prisma.join(teamIds.map(id => Prisma.sql`${id}::uuid`))})`);
    if (params.emptySelection) volumeGrowthWhere.push(Prisma.sql`FALSE`);
    if (normalizedMappings.length > 0) {
      const mappingConditions = normalizedMappings
        .filter((m) => m !== this.normalize('__null__'))
        .map((m) => Prisma.sql`LOWER(BTRIM(COALESCE("mapping", ''))) = LOWER(BTRIM(${m}))`);
      if (includeNull) {
        mappingConditions.push(Prisma.sql`"mapping" IS NULL`);
      }
      volumeGrowthWhere.push(Prisma.sql`(${Prisma.join(mappingConditions, ' OR ')})`);
    }
    if (excludeRepurchase) {
      volumeGrowthWhere.push(Prisma.sql`COALESCE("isRepurchase", false) = false`);
    }
    const volumeGrowthWhereClause = Prisma.sql`WHERE ${Prisma.join(volumeGrowthWhere, ' AND ')}`;

    const [
      agg,
      prevAgg,
      processedSalesAgg,
      prevProcessedSalesAgg,
      totalOrdersCount,
      cancelledOrdersCount,
      prevTotalOrdersCount,
      prevCancelledOrdersCount,
      undeliveredOrdersCount,
      returnedOrdersCount,
      prevUndeliveredOrdersCount,
      prevReturnedOrdersCount,
      volumeGrowthTrendRows,
      mappingRows,
      nullCount,
      productGroups,
      lastUpdatedAgg,
    ] = await Promise.all([
      db.reconcileMarketing.aggregate({
        where,
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          repurchaseCount: true,
          repurchaseProcessedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          currentAbandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          currentAbandonedCount: true,
          repurchaseDeliveredCount: true,
          repurchaseShippedCount: true,
          repurchaseWaitingPickupCount: true,
          repurchaseRtsCount: true,
          repurchaseCanceledCount: true,
          repurchaseRestockingCount: true,
          repurchaseCurrentAbandonedCount: true,
          repurchaseConfirmedCount: true,
          repurchaseUnconfirmedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          repurchasePrintedCount: true,
          repurchaseDeletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          repurchaseCodPos: true,
          repurchaseDeliveredCodPos: true,
          repurchaseShippedCodPos: true,
          repurchaseWaitingPickupCodPos: true,
          repurchaseRtsCodPos: true,
          repurchaseCanceledCodPos: true,
          repurchaseRestockingCodPos: true,
          repurchaseCurrentAbandonedCodPos: true,
          repurchaseConfirmedCodPos: true,
          repurchaseUnconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          repurchaseCogsPos: true,
          repurchaseCogsCanceledPos: true,
          repurchaseCogsRestockingPos: true,
          repurchaseCogsRtsPos: true,
          repurchaseCogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
          repurchaseCodFeePos: true,
          repurchaseCodFeeDeliveredPos: true,
          repurchaseSfPos: true,
          repurchaseFfPos: true,
          repurchaseIfPos: true,
          repurchaseSfSdrPos: true,
          repurchaseFfSdrPos: true,
          repurchaseIfSdrPos: true,
        },
      }),
      db.reconcileMarketing.aggregate({
        where: {
          ...baseWhere,
          ...mappingFilter,
          date: { gte: prevStartDate_dt, lte: prevEndDate_dt },
          ...teamWhere,
        },
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          repurchaseCount: true,
          repurchaseProcessedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          currentAbandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          currentAbandonedCount: true,
          repurchaseDeliveredCount: true,
          repurchaseShippedCount: true,
          repurchaseWaitingPickupCount: true,
          repurchaseRtsCount: true,
          repurchaseCanceledCount: true,
          repurchaseRestockingCount: true,
          repurchaseCurrentAbandonedCount: true,
          repurchaseConfirmedCount: true,
          repurchaseUnconfirmedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          repurchasePrintedCount: true,
          repurchaseDeletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          repurchaseCodPos: true,
          repurchaseDeliveredCodPos: true,
          repurchaseShippedCodPos: true,
          repurchaseWaitingPickupCodPos: true,
          repurchaseRtsCodPos: true,
          repurchaseCanceledCodPos: true,
          repurchaseRestockingCodPos: true,
          repurchaseCurrentAbandonedCodPos: true,
          repurchaseConfirmedCodPos: true,
          repurchaseUnconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          repurchaseCogsPos: true,
          repurchaseCogsCanceledPos: true,
          repurchaseCogsRestockingPos: true,
          repurchaseCogsRtsPos: true,
          repurchaseCogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
          repurchaseCodFeePos: true,
          repurchaseCodFeeDeliveredPos: true,
          repurchaseSfPos: true,
          repurchaseFfPos: true,
          repurchaseIfPos: true,
          repurchaseSfSdrPos: true,
          repurchaseFfSdrPos: true,
          repurchaseIfSdrPos: true,
        },
      }),
      db.posOrder.aggregate({
        where: processedSalesWhere,
        _sum: {
          cod: true,
        },
      }),
      db.posOrder.aggregate({
        where: prevProcessedSalesWhere,
        _sum: {
          cod: true,
        },
      }),
      db.posOrder.count({
        where: {
          ...cancellationRateWhere,
          OR: [{ status: { not: 7 } }, { status: null }],
        },
      }),
      db.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 6,
        },
      }),
      db.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          OR: [{ status: { not: 7 } }, { status: null }],
        },
      }),
      db.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 6,
        },
      }),
      db.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 4,
        },
      }),
      db.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 5,
        },
      }),
      db.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 4,
        },
      }),
      db.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 5,
        },
      }),
      db.$queryRaw<Array<{ date: string; shipped: number; delivered: number; rts: number }>>(Prisma.sql`
        WITH dates AS (
          SELECT generate_series(${startStr}::date, ${endStr}::date, interval '1 day')::date AS d
        ),
        scoped_orders AS (
          SELECT
            id,
            "statusHistory",
            "deliveredAt",
            "rtsAt"
          FROM "pos_orders"
          ${volumeGrowthWhereClause}
        ),
        shipped_events AS (
          SELECT
            so.id,
            MIN((entry.value->>'updated_at')::timestamptz) AS shipped_at
          FROM scoped_orders so
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(so."statusHistory"::jsonb, '[]'::jsonb)) AS entry(value)
          WHERE entry.value->>'status' = '2'
            AND COALESCE(entry.value->>'updated_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
          GROUP BY so.id
        ),
        movement_events AS (
          SELECT
            (shipped_at AT TIME ZONE ${TIMEZONE})::date AS d,
            'shipped'::text AS kind
          FROM shipped_events
          WHERE shipped_at IS NOT NULL

          UNION ALL

          SELECT
            (("deliveredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE})::date AS d,
            'delivered'::text AS kind
          FROM scoped_orders
          WHERE "deliveredAt" IS NOT NULL

          UNION ALL

          SELECT
            (("rtsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE})::date AS d,
            'rts'::text AS kind
          FROM scoped_orders
          WHERE "rtsAt" IS NOT NULL
        ),
        counts AS (
          SELECT
            d,
            COUNT(*) FILTER (WHERE kind = 'shipped')::int AS shipped,
            COUNT(*) FILTER (WHERE kind = 'delivered')::int AS delivered,
            COUNT(*) FILTER (WHERE kind = 'rts')::int AS rts
          FROM movement_events
          WHERE d BETWEEN ${startStr}::date AND ${endStr}::date
          GROUP BY d
        )
        SELECT
          TO_CHAR(dates.d, 'YYYY-MM-DD') AS date,
          COALESCE(counts.shipped, 0)::int AS shipped,
          COALESCE(counts.delivered, 0)::int AS delivered,
          COALESCE(counts.rts, 0)::int AS rts
        FROM dates
        LEFT JOIN counts ON counts.d = dates.d
        ORDER BY dates.d
      `),
      db.reconcileMarketing.findMany({
        where: {
          ...baseWhere,
          mapping: { not: null },
        },
        distinct: ['mapping'],
        select: { mapping: true },
      }),
      db.reconcileMarketing.count({
        where: {
          ...baseWhere,
          mapping: null,
        },
      }),
      db.reconcileMarketing.groupBy({
        by: ['mapping'],
        where,
        _sum: {
          spend: true,
          codPos: true,
          purchasesPos: true,
          processedPurchasesPos: true,
          repurchaseCount: true,
          repurchaseProcessedPurchasesPos: true,
          leads: true,
          deliveredCodPos: true,
          shippedCodPos: true,
          waitingPickupCodPos: true,
          rtsCodPos: true,
          canceledCodPos: true,
          restockingCodPos: true,
          currentAbandonedCodPos: true,
          deliveredCount: true,
          shippedCount: true,
          waitingPickupCount: true,
          rtsCount: true,
          canceledCount: true,
          restockingCount: true,
          currentAbandonedCount: true,
          repurchaseDeliveredCount: true,
          repurchaseShippedCount: true,
          repurchaseWaitingPickupCount: true,
          repurchaseRtsCount: true,
          repurchaseCanceledCount: true,
          repurchaseRestockingCount: true,
          repurchaseCurrentAbandonedCount: true,
          repurchaseConfirmedCount: true,
          repurchaseUnconfirmedCount: true,
          confirmedCount: true,
          unconfirmedCount: true,
          printedCount: true,
          deletedCount: true,
          repurchasePrintedCount: true,
          repurchaseDeletedCount: true,
          confirmedCodPos: true,
          unconfirmedCodPos: true,
          repurchaseCodPos: true,
          repurchaseDeliveredCodPos: true,
          repurchaseShippedCodPos: true,
          repurchaseWaitingPickupCodPos: true,
          repurchaseRtsCodPos: true,
          repurchaseCanceledCodPos: true,
          repurchaseRestockingCodPos: true,
          repurchaseCurrentAbandonedCodPos: true,
          repurchaseConfirmedCodPos: true,
          repurchaseUnconfirmedCodPos: true,
          cogsPos: true,
          cogsCanceledPos: true,
          cogsRestockingPos: true,
          cogsRtsPos: true,
          cogsDeliveredPos: true,
          repurchaseCogsPos: true,
          repurchaseCogsCanceledPos: true,
          repurchaseCogsRestockingPos: true,
          repurchaseCogsRtsPos: true,
          repurchaseCogsDeliveredPos: true,
          codFeePos: true,
          codFeeDeliveredPos: true,
          sfPos: true,
          ffPos: true,
          ifPos: true,
          sfSdrPos: true,
          ffSdrPos: true,
          ifSdrPos: true,
          repurchaseCodFeePos: true,
          repurchaseCodFeeDeliveredPos: true,
          repurchaseSfPos: true,
          repurchaseFfPos: true,
          repurchaseIfPos: true,
          repurchaseSfSdrPos: true,
          repurchaseFfSdrPos: true,
          repurchaseIfSdrPos: true,
        },
      }),
      db.reconcileMarketing.aggregate({
        where,
        _max: { updatedAt: true },
      }),
    ]);

    // Ad import rows can have a missing teamId even when their exact owning
    // store is known. Keep historical POS team scope intact, but resolve the
    // spend independently so a team cannot report its revenue with zero ads.
    let teamSpendCoverage: ReturnType<typeof partitionTeamAdSpend>['coverage'] | null = null;
    let additionalNullSpendMapping = false;
    let spendUpdatedAt: Date | null = null;
    if (teamIds.length) {
      const spendRows = await db.reconcileMarketing.findMany({
        where: { tenantId, date: { gte: prevStartDate_dt, lte: endDate_dt }, ...mappingFilter },
        select: { teamId: true, adId: true, adName: true, mapping: true, shops: true,
          date: true, spend: true, leads: true, updatedAt: true },
      });
      const spendIndex = await loadSalesStoreAttribution(db, tenantId, spendRows, activeStores);
      const allocation = partitionTeamAdSpend(spendRows, activeStores, spendIndex, teamIds, startDate_dt);
      teamSpendCoverage = allocation.coverage;
      (agg._sum as any).spend = 0; (agg._sum as any).leads = 0;
      (prevAgg._sum as any).spend = 0; (prevAgg._sum as any).leads = 0;
      for (const group of productGroups) { (group._sum as any).spend = 0; (group._sum as any).leads = 0; }
      for (const { row, included, period } of allocation.rows) {
        if (!included) continue;
        const spend = this.toNumber(row.spend), leads = this.toNumber(row.leads);
        const sum = period === 'current' ? agg._sum : prevAgg._sum;
        (sum as any).spend += spend; (sum as any).leads += leads;
        if (period !== 'current' || (!spend && !leads)) continue;
        let group = productGroups.find(value => value.mapping === row.mapping);
        if (!group) {
          group = { mapping: row.mapping ?? null, _sum: {} } as any;
          productGroups.push(group!);
        }
        (group!._sum as any).spend = this.toNumber(group!._sum.spend) + spend;
        (group!._sum as any).leads = this.toNumber(group!._sum.leads) + leads;
        if (row.mapping === null) additionalNullSpendMapping = true;
        else if (row.mapping && !mappingRows.some(value => value.mapping === row.mapping)) mappingRows.push({ mapping: row.mapping });
        if (row.updatedAt && (!spendUpdatedAt || row.updatedAt > spendUpdatedAt)) spendUpdatedAt = row.updatedAt;
      }
    }

    // Only the nonzero abandoned buckets need an exact live cost lookup.
    // Match their persisted per-ad memberships, not the unrelated order mapping.
    if (excludeAbandoned) {
      const hasAbandonedBucket = [agg._sum, prevAgg._sum].some(sum =>
        this.toNumber(sum.currentAbandonedCount) !== 0 || this.toNumber(sum.repurchaseCurrentAbandonedCount) !== 0);
      const groups = hasAbandonedBucket ? await readCurrentAbandonedCosts(db, {
        tenantId, previousStart: prevStartStr, currentStart: startStr, end: endStr,
        activeShopIds, mappings: normalizedMappings, includeNull, emptySelection: params.emptySelection, teamIds,
      }) : [];
      attachCurrentAbandonedCosts(agg._sum, groups.filter(row => row.period === 'current'));
      attachCurrentAbandonedCosts(prevAgg._sum, groups.filter(row => row.period === 'previous'));
      for (const group of productGroups) attachCurrentAbandonedCosts(group._sum,
        groups.filter(row => row.period === 'current' && row.mapping === group.mapping));
    }

    const mappingOptions: string[] = [];
    const mappingDisplayMap: Record<string, string> = {};
    mappingRows.forEach((r) => {
      if (!r.mapping) return;
      const norm = this.normalize(r.mapping);
      if (!mappingDisplayMap[norm]) {
        mappingDisplayMap[norm] = r.mapping;
        mappingOptions.push(norm);
      }
    });

    // pv:: keys -> product names, ua:: keys -> "Unassigned — {store}"; coarse
    // labels pass through untouched.
    await resolveMappingDisplayNames(db, mappingDisplayMap);

    if (nullCount > 0 || additionalNullSpendMapping) {
      const key = this.normalize('__null__');
      mappingDisplayMap[key] = nullCount > 0 ? `Unassigned (${nullCount})` : 'Unassigned';
      mappingOptions.push(key);
    }
    mappingOptions.sort((a, b) => (mappingDisplayMap[a] || a).localeCompare(mappingDisplayMap[b] || b));

    const rtsForecastPct = 20;
    const products = productGroups.map((g) => {
      const row = this.computeProductRow(
        { _sum: g._sum, mapping: g.mapping },
        {
          excludeCancel,
          excludeRestocking,
          excludeAbandoned,
          excludeRts,
          excludeRepurchase,
          includeTax12,
          includeTax1,
          rtsForecastPct,
        },
      );
      return {
        ...row,
        mapping: g.mapping,
      };
    });

    const deliveryStatuses = productGroups.map(g => this.computeDeliveryRow(g._sum, g.mapping, excludeRepurchase));

    const kpis = {
      ...this.computeKpis(agg, {
        excludeCancel,
        excludeRestocking,
        excludeAbandoned,
        excludeRts,
        excludeRepurchase,
        includeTax12,
        includeTax1,
        rtsForecastPct,
        processedSalesValue: this.toNumber(processedSalesAgg?._sum?.cod),
      }),
      cancellation_rate_pct:
        totalOrdersCount > 0 ? (cancelledOrdersCount / totalOrdersCount) * 100 : 0,
    };
    const prevKpis = {
      ...this.computeKpis(prevAgg, {
        excludeCancel,
        excludeRestocking,
        excludeAbandoned,
        excludeRts,
        excludeRepurchase,
        includeTax12,
        includeTax1,
        rtsForecastPct,
        processedSalesValue: this.toNumber(prevProcessedSalesAgg?._sum?.cod),
      }),
      cancellation_rate_pct:
        prevTotalOrdersCount > 0
          ? (prevCancelledOrdersCount / prevTotalOrdersCount) * 100
          : 0,
    };
    const counts = this.computeCounts(
      agg,
      { excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase },
      {
        undelivered: undeliveredOrdersCount,
        returned: returnedOrdersCount,
      },
    );
    const statusDistribution = this.computeStatusDistribution(agg, excludeRepurchase);
    const prevCounts = this.computeCounts(
      prevAgg,
      { excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase },
      {
        undelivered: prevUndeliveredOrdersCount,
        returned: prevReturnedOrdersCount,
      },
    );
    const volumeGrowthTrend = this.buildVolumeGrowthTrend(
      volumeGrowthTrendRows,
      startStr,
      endStr,
    );

    const response = {
      kpis,
      counts,
      statusDistribution,
      prevCounts,
      prevKpis,
      filters: {
        mappings: mappingOptions,
        mappingsDisplayMap: mappingDisplayMap,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        mappings: normalizedMappings,
        team_ids: teamIds,
      },
      rangeDays,
      lastUpdatedAt: spendUpdatedAt && (!lastUpdatedAgg?._max?.updatedAt || spendUpdatedAt > lastUpdatedAgg._max.updatedAt) ? spendUpdatedAt : lastUpdatedAgg?._max?.updatedAt || null,
      teamSpendCoverage,
      products,
      deliveryStatuses,
      volumeGrowthTrend,
    };

    this.logger.log(`CACHE SET ${cacheKey}`);
    await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  /** Store POS components belong to their real shop, independently of the
   * owner of the ad that produced the visit. No row or cost is split by a ratio.
   */
  async getStoreOverview(params: SalesOverviewParams, requestingUser?: { role?: string }) {
    params = { ...params, teamIds: this.normalizeTeamIds(params.teamIds) };
    const tenantId = this.teamContext.getTenantId();
    const requestKey = `sales-store-overview:${tenantId}:${this.analyticsCache.hashObject({
      ...params,
      sourceRevision: 'EXACT_SHOP_POS_COMPONENTS_V1',
      mappings: [...(params.mappings || [])].map(value => this.normalize(value)).sort(),
    })}`;
    const response = await this.analyticsRequestCoordinator.run(tenantId, requestKey, () => this.calculateStoreOverview(params));
    return this.attachDeliveredUnits(response, params, requestingUser, 'store', tenantId);
  }

  private async calculateStoreOverview(params: SalesOverviewParams) {
    const { startDate, endDate, mappings = [], excludeCancel = true, excludeRestocking = true, excludeAbandoned = true, excludeRts = true, excludeRepurchase = true, includeTax12 = false, includeTax1 = false } = params;

    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;
    if (!dayjs(startStr, 'YYYY-MM-DD', true).isValid() || !dayjs(endStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid date format. Expected YYYY-MM-DD');
    }
    if (endStr < startStr) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }
    const rangeDays = this.diffDays(startStr, endStr) + 1;
    const prevEndStr = this.shiftDate(startStr, -1);
    const prevStartStr = this.shiftDate(startStr, -rangeDays);
    const startDate_dt = new Date(`${startStr}T00:00:00.000Z`);
    const endDate_dt = new Date(`${endStr}T00:00:00.000Z`);
    const prevStartDate_dt = new Date(`${prevStartStr}T00:00:00.000Z`);

    const UNATTRIBUTED = UNATTRIBUTED_STORE_KEY;
    const selectedStoreIds = mappings.map((m) => this.normalize(m)).filter((v) => v.length > 0);
    const tenantId = this.teamContext.getTenantId();

    const teamIds = params.teamIds || [];
    const teamWhere = await this.analyticsTeamWhere(this.prisma, tenantId, teamIds);
    const activeStoreWhere = { tenantId, status: 'ACTIVE' as const, OR: [{ enabled: true }, { enabled: null }] };
    // Keep all tenant shops as negative ownership witnesses even in one team.
    const scopeStores = await this.prisma.posStore.findMany({ where: activeStoreWhere, select: { id: true, shopId: true, name: true, teamId: true } });
    const scopeKey = (stores: typeof scopeStores) => stores.map(store => `${store.id}:${store.shopId}:${store.name}:${store.teamId ?? ''}`).sort();
    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      responseShapeVersion: 3,
      emptySelection: params.emptySelection === true,
      sourceRevision: 'EXACT_SHOP_POS_COMPONENTS_V1',
      teamIds,
      activeStores: scopeKey(scopeStores),
      calculationVersion: SALES_CALCULATION_VERSION,
      start: startStr,
      end: endStr,
      stores: [...selectedStoreIds].sort(),
      excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase,
      includeTax12, includeTax1,
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales-stores:${this.analyticsCache.hashObject(cacheKeyPayload)}`;
    const cached = await this.analyticsCache.get<any>(cacheKey);
    if (cached) return cached;

    const metricFields = [
      'spend', 'codPos', 'purchasesPos', 'processedPurchasesPos', 'repurchaseCount', 'repurchaseProcessedPurchasesPos',
      'leads', 'deliveredCodPos', 'shippedCodPos', 'waitingPickupCodPos', 'rtsCodPos', 'canceledCodPos',
      'restockingCodPos', 'currentAbandonedCodPos', 'deliveredCount', 'shippedCount', 'waitingPickupCount',
      'rtsCount', 'canceledCount', 'restockingCount', 'currentAbandonedCount', 'repurchaseDeliveredCount',
      'repurchaseShippedCount', 'repurchaseWaitingPickupCount', 'repurchaseRtsCount', 'repurchaseCanceledCount',
      'repurchaseRestockingCount', 'repurchaseCurrentAbandonedCount', 'repurchaseConfirmedCount',
      'repurchaseUnconfirmedCount', 'confirmedCount', 'unconfirmedCount', 'printedCount', 'deletedCount',
      'repurchasePrintedCount', 'repurchaseDeletedCount', 'confirmedCodPos', 'unconfirmedCodPos',
      'repurchaseCodPos', 'repurchaseDeliveredCodPos', 'repurchaseShippedCodPos', 'repurchaseWaitingPickupCodPos',
      'repurchaseRtsCodPos', 'repurchaseCanceledCodPos', 'repurchaseRestockingCodPos',
      'repurchaseCurrentAbandonedCodPos', 'repurchaseConfirmedCodPos', 'repurchaseUnconfirmedCodPos',
      'cogsPos', 'cogsCanceledPos', 'cogsRestockingPos', 'cogsRtsPos', 'cogsDeliveredPos', 'repurchaseCogsPos',
      'repurchaseCogsCanceledPos', 'repurchaseCogsRestockingPos', 'repurchaseCogsRtsPos', 'repurchaseCogsDeliveredPos',
      'codFeePos', 'codFeeDeliveredPos', 'sfPos', 'ffPos', 'ifPos', 'sfSdrPos', 'ffSdrPos', 'ifSdrPos',
      'repurchaseCodFeePos', 'repurchaseCodFeeDeliveredPos', 'repurchaseSfPos', 'repurchaseFfPos', 'repurchaseIfPos',
      'repurchaseSfSdrPos', 'repurchaseFfSdrPos', 'repurchaseIfSdrPos',
    ] as const;

    const allSelected = params.emptySelection !== true && selectedStoreIds.length === 0;
    const isSelected = (key: string) => params.emptySelection !== true && (allSelected || selectedStoreIds.includes(key));
    const add = (target: Record<string, number>, source: Record<string, any>) => {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number') target[key] = (target[key] || 0) + value;
      }
    };
    const empty = () => Object.fromEntries(metricFields.map(key => [key, 0])) as Record<string, number>;

    // All source identities and all pages share one read-only snapshot. The
    // projection deliberately excludes snapshots, names and customer details.
    const snapshot = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const [rows, tenantStores] = await Promise.all([
        tx.reconcileMarketing.findMany({
          where: { tenantId, date: { gte: prevStartDate_dt, lte: endDate_dt } },
          select: Object.fromEntries([
            'teamId', 'adId', 'adName', 'mapping', 'shops', 'date', 'updatedAt', ...metricFields,
          ].map(key => [key, true])) as any,
        }) as Promise<Array<Record<string, any>>>,
        tx.posStore.findMany({
          where: activeStoreWhere,
          select: { id: true, shopId: true, name: true, teamId: true },
        }),
      ]);
      await this.analyticsTeamWhere(tx, tenantId, teamIds);
      // Team membership belongs to each historical RM/order record. A later
      // store reassignment must not erase earlier team-owned activity.
      const index = await loadSalesStoreAttribution(tx, tenantId, rows as any, tenantStores);
      const { storeByShopId } = index;
      const dayBuckets = new Map<string, { date: string; store: string; sums: ReturnType<typeof createEmptyPosAggregateBucket> & Record<string, any> }>();
      let cursor: string | undefined;
      let ambiguousOrderCount = 0;
      let zeroCogsOrderCount = 0;
      let orderCount = 0;
      let sourceUpdatedAt: Date | null = null;
      const shopIds = [...new Set(tenantStores.map(store => store.shopId))];
      while (shopIds.length) {
        const orders = await tx.posOrder.findMany({
          where: { tenantId, ...teamWhere, shopId: { in: shopIds }, dateLocal: { gte: prevStartStr, lte: endStr }, ...(cursor ? { id: { gt: cursor } } : {}) },
          select: { id: true, shopId: true, posOrderId: true, dateLocal: true, status: true, isVoid: true,
            cod: true, cogs: true, isRepurchase: true, isAbandoned: true, wasAbandonedCart: true, tracking: true, updatedAt: true },
          orderBy: { id: 'asc' }, take: 2000,
        });
        for (const order of orders) {
          const store = storeByShopId.get(order.shopId) ?? UNATTRIBUTED;
          const key = `${order.dateLocal}|${order.shopId}`;
          let day = dayBuckets.get(key);
          if (!day) {
            day = { date: order.dateLocal, store, sums: createEmptyPosAggregateBucket() };
            dayBuckets.set(key, day);
          }
          accumulatePosOrder(day.sums, order, false);
          orderCount++;
          if (store === UNATTRIBUTED) ambiguousOrderCount++;
          if (!order.isVoid && order.status !== 7 && this.toNumber(order.cogs) === 0) zeroCogsOrderCount++;
          if (order.dateLocal >= startStr && isSelected(store) && order.updatedAt && (!sourceUpdatedAt || order.updatedAt > sourceUpdatedAt)) sourceUpdatedAt = order.updatedAt;
          // These direct-source projections retain their existing status and
          // denominator policies; the tracking-based count remains separate.
          if (!order.isVoid && (!excludeRepurchase || !order.isRepurchase)) {
            if ((PROCESSED_SALES_STATUSES as readonly number[]).includes(order.status!)) day.sums.processedSales = (day.sums.processedSales || 0) + this.toNumber(order.cod);
            if (order.status !== 7) day.sums.cancellationTotal = (day.sums.cancellationTotal || 0) + 1;
            if (order.status === 6) day.sums.canceledOrders = (day.sums.canceledOrders || 0) + 1;
            if (order.status === 4) day.sums.undeliveredOrders = (day.sums.undeliveredOrders || 0) + 1;
            if (order.status === 5) day.sums.returnedOrders = (day.sums.returnedOrders || 0) + 1;
          }
        }
        if (orders.length < 2000) break;
        cursor = orders[orders.length - 1].id;
      }
      return { rows, tenantStores, index, dayBuckets, scopedShopIds: shopIds, ambiguousOrderCount, zeroCogsOrderCount, orderCount, sourceUpdatedAt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 60000 });

    const { rows, tenantStores, index } = snapshot;
    const storeNameById = new Map(tenantStores.map(store => [store.id.toLowerCase(), store.name]));
    const currentAggSums = empty();
    const prevAggSums = empty();
    const sourceCurrent = empty();
    const sourcePrevious = empty();
    const canonicalCurrent = empty();
    const canonicalPrevious = empty();
    const storeBuckets = new Map<string, Record<string, number>>();
    const presentStoreKeys = new Set<string>();
    let lastUpdatedAt = snapshot.sourceUpdatedAt;
    const addComponents = (store: string, current: boolean, components: Record<string, any>) => {
      if (current) presentStoreKeys.add(store);
      if (!isSelected(store)) return;
      add(current ? currentAggSums : prevAggSums, components);
      if (current) {
        if (!storeBuckets.has(store)) storeBuckets.set(store, empty());
        add(storeBuckets.get(store)!, components);
      }
    };
    const money = (value: number) => new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    for (const day of snapshot.dayBuckets.values()) {
      const fees = calculatePosFees(day.sums);
      const components = { ...day.sums, orders: undefined,
        sfPos: fees.sf, ffPos: fees.ff, ifPos: fees.inf,
        sfSdrPos: fees.sfSdr, ffSdrPos: fees.ffSdr, ifSdrPos: fees.infSdr,
        repurchaseSfPos: fees.repurchaseSf, repurchaseFfPos: fees.repurchaseFf, repurchaseIfPos: fees.repurchaseIf,
        repurchaseSfSdrPos: fees.repurchaseSfSdr, repurchaseFfSdrPos: fees.repurchaseFfSdr, repurchaseIfSdrPos: fees.repurchaseIfSdr,
        codFeePos: money(fees.codFee), codFeeDeliveredPos: money(fees.codFeeDelivered),
        repurchaseCodFeePos: money(fees.repurchaseCodFee), repurchaseCodFeeDeliveredPos: money(fees.repurchaseCodFeeDelivered),
      };
      const current = day.date >= startStr;
      add(current ? sourceCurrent : sourcePrevious, components);
      addComponents(day.store, current, components);
    }
    let unattributedAdRows = 0;
    let unattributedAdSpend = 0;
    let previousUnattributedAdRows = 0;
    let previousUnattributedAdSpend = 0;
    const adTeamAllocation = partitionTeamAdSpend(rows as any, tenantStores, index, teamIds, startDate_dt);
    for (const { row, storeId: store, included } of adTeamAllocation.rows) {
      const current = row.date >= startDate_dt;
      // Persisted POS components are comparison evidence only. They must never
      // be added to the direct POS components a second time.
      const comparison = current ? canonicalCurrent : canonicalPrevious;
      if (!teamIds.length || (row.teamId && teamIds.includes(row.teamId))) {
        for (const field of metricFields) if (field !== 'spend' && field !== 'leads') comparison[field] += this.toNumber((row as any)[field]);
      }
      if (!included) continue;
      if (current && store === UNATTRIBUTED && (this.toNumber(row.spend) || this.toNumber(row.leads))) {
        unattributedAdRows++;
        unattributedAdSpend += this.toNumber(row.spend);
      } else if (!current && store === UNATTRIBUTED && (this.toNumber(row.spend) || this.toNumber(row.leads))) {
        previousUnattributedAdRows++;
        previousUnattributedAdSpend += this.toNumber(row.spend);
      }
      if (this.toNumber(row.spend) || this.toNumber(row.leads)) addComponents(store, current, { spend: this.toNumber(row.spend), leads: this.toNumber(row.leads) });
      if (current && isSelected(store) && row.updatedAt instanceof Date && (!lastUpdatedAt || row.updatedAt > lastUpdatedAt)) lastUpdatedAt = row.updatedAt;
    }
    const differences = (source: Record<string, number>, canonical: Record<string, number>) =>
      Object.fromEntries(metricFields.filter(field => field !== 'spend' && field !== 'leads')
        .map(field => [field, money(canonical[field] - source[field])]).filter(([, value]) => value !== 0));
    const currentDifferences = differences(sourceCurrent, canonicalCurrent);
    const previousDifferences = differences(sourcePrevious, canonicalPrevious);
    const coverage = {
      basis: 'SAVED_ERP_POS_ORDER_COMPONENTS', adOwnership: 'EXPLICIT_LINK_THEN_UNAMBIGUOUS_HINTS',
      feeBasis: 'EXISTING_RATES_PER_SHOP_DAY', comparisonScope: teamIds.length ? 'SELECTED_TEAM_RECORDS_CURRENT_AND_PREVIOUS' : 'ACTIVE_TENANT_SHOPS_CURRENT_AND_PREVIOUS',
      teamIds,
      ambiguousShopCount: snapshot.scopedShopIds.filter(shop => !index.storeByShopId.get(shop)).length,
      ambiguousOrderCount: snapshot.ambiguousOrderCount, examinedOrderCount: snapshot.orderCount,
      zeroCogsOrderCount: snapshot.zeroCogsOrderCount,
      unattributedAdRows, unattributedAdSpend: money(unattributedAdSpend),
      previousUnattributedAdRows, previousUnattributedAdSpend: money(previousUnattributedAdSpend),
      unknownSelectedStoreCount: selectedStoreIds.filter(key => key !== UNATTRIBUTED && !index.validStoreIds.has(key)).length,
      // Signed canonical minus direct-source residuals expose rounding and
      // reconciliation lag; none are allocated to a guessed store.
      canonicalMinusSource: { current: currentDifferences, previous: previousDifferences },
      hasCanonicalDifferences: Object.keys(currentDifferences).length > 0 || Object.keys(previousDifferences).length > 0,
    };

    const rtsForecastPct = 20;
    const processedSalesAgg = { _sum: { cod: currentAggSums.processedSales } };
    const prevProcessedSalesAgg = { _sum: { cod: prevAggSums.processedSales } };
    const totalOrdersCount = currentAggSums.cancellationTotal || 0;
    const cancelledOrdersCount = currentAggSums.canceledOrders || 0;
    const prevTotalOrdersCount = prevAggSums.cancellationTotal || 0;
    const prevCancelledOrdersCount = prevAggSums.canceledOrders || 0;
    const undeliveredOrdersCount = currentAggSums.undeliveredOrders || 0;
    const returnedOrdersCount = currentAggSums.returnedOrders || 0;
    const prevUndeliveredOrdersCount = prevAggSums.undeliveredOrders || 0;
    const prevReturnedOrdersCount = prevAggSums.returnedOrders || 0;
    const agg = { _sum: currentAggSums };
    const prevAgg = { _sum: prevAggSums };
    const kpiOpts = { excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase, includeTax12, includeTax1, rtsForecastPct };

    const kpis = {
      ...this.computeKpis(agg, { ...kpiOpts, processedSalesValue: this.toNumber(processedSalesAgg?._sum?.cod) }),
      cancellation_rate_pct: totalOrdersCount > 0 ? (cancelledOrdersCount / totalOrdersCount) * 100 : 0,
    };
    const prevKpis = {
      ...this.computeKpis(prevAgg, { ...kpiOpts, processedSalesValue: this.toNumber(prevProcessedSalesAgg?._sum?.cod) }),
      cancellation_rate_pct: prevTotalOrdersCount > 0 ? (prevCancelledOrdersCount / prevTotalOrdersCount) * 100 : 0,
    };
    const toggleOpts = { excludeCancel, excludeRestocking, excludeAbandoned, excludeRts, excludeRepurchase };
    const counts = this.computeCounts(agg, toggleOpts, { undelivered: undeliveredOrdersCount, returned: returnedOrdersCount });
    const prevCounts = this.computeCounts(prevAgg, toggleOpts, { undelivered: prevUndeliveredOrdersCount, returned: prevReturnedOrdersCount });
    const statusDistribution = this.computeStatusDistribution(agg, excludeRepurchase);

    const storeName = (key: string) =>
      key === UNATTRIBUTED ? 'Unattributed' : storeNameById.get(key) ?? 'Unknown store';

    const products = [...storeBuckets.entries()]
      .map(([storeKey, sums]) => {
        const name = storeName(storeKey);
        const computed = this.computeProductRow({ _sum: sums, mapping: name }, { ...kpiOpts });
        return { ...computed, mapping: name, store_id: storeKey === UNATTRIBUTED ? null : storeKey };
      })
      .sort((a, b) => {
        if (a.store_id === null) return 1;
        if (b.store_id === null) return -1;
        return (b.revenue ?? 0) - (a.revenue ?? 0);
      });

    const deliveryStatuses = [...storeBuckets.entries()].map(([storeKey, sums]) =>
      this.computeDeliveryRow(sums, storeName(storeKey), excludeRepurchase));

    // Filter options mirror the product overview's mappings contract so the
    // web picker works unchanged: values are store ids, labels are store names.
    const optionKeys = [...presentStoreKeys];
    optionKeys.sort((a, b) => storeName(a).localeCompare(storeName(b)));
    const mappingsDisplayMap: Record<string, string> = {};
    for (const key of optionKeys) mappingsDisplayMap[key] = storeName(key);

    const response = {
      kpis,
      counts,
      statusDistribution,
      prevCounts,
      prevKpis,
      filters: { mappings: optionKeys, mappingsDisplayMap },
      selected: { start_date: startStr, end_date: endStr, mappings: selectedStoreIds, team_ids: teamIds },
      rangeDays,
      lastUpdatedAt,
      products,
      deliveryStatuses,
      volumeGrowthTrend: [],
      coverage,
      teamSpendCoverage: adTeamAllocation.coverage,
    };
    if (JSON.stringify(scopeKey(scopeStores)) === JSON.stringify(scopeKey(tenantStores))) await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  async reconcileRange(startDate?: string, endDate?: string) {
    if (!startDate || !endDate) {
      throw new BadRequestException('start_date and end_date are required');
    }

    const tenantId = this.teamContext.getTenantId();
    const since = dayjs(startDate).format('YYYY-MM-DD');
    const until = dayjs(endDate).format('YYYY-MM-DD');

    if (
      !dayjs(since, 'YYYY-MM-DD', true).isValid() ||
      !dayjs(until, 'YYYY-MM-DD', true).isValid()
    ) {
      throw new BadRequestException('Invalid date range');
    }

    const dates: string[] = [];
    let current = dayjs(since);
    const end = dayjs(until);
    if (current.isAfter(end)) {
      current = end;
    }

    while (current.isBefore(end) || current.isSame(end, 'day')) {
      dates.push(current.format('YYYY-MM-DD'));
      current = current.add(1, 'day');
    }

    const errors: Array<{ date: string; source: string; error: string }> = [];
    for (const date of dates) {
      const dayStart = new Date(`${date}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      try {
        await this.prisma.reconcileSales.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        });
        await this.prisma.reconcileSalesAttribution.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        });
        await this.prisma.reconcileMarketing.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        });
      } catch (err: any) {
        errors.push({
          date,
          source: 'reconcile_reset',
          error: err?.message || 'Failed to reset reconcile rows',
        });
        continue;
      }

      try {
        await this.reconcileMarketingService.reconcileDay(tenantId, date);
      } catch (err: any) {
        errors.push({
          date,
          source: 'reconcile_marketing',
          error: err?.message || 'Reconcile marketing failed',
        });
      }

      try {
        await this.reconcileSalesService.aggregateDay(tenantId, date);
      } catch (err: any) {
        errors.push({
          date,
          source: 'reconcile_sales',
          error: err?.message || 'Reconcile sales failed',
        });
      }

      try {
        await this.reconcileSalesAttributionService.aggregateDay(tenantId, date);
      } catch (err: any) {
        errors.push({
          date,
          source: 'reconcile_sales_attribution',
          error: err?.message || 'Reconcile sales attribution failed',
        });
      }
    }

    await this.analyticsCache.bumpVersion(tenantId);

    return {
      processedDays: dates.length,
      startDate: since,
      endDate: until,
      errors,
    };
  }
}
