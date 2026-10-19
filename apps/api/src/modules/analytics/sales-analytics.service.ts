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
import { ReconcileSalesService } from '../workflows/services/reconcile-sales.service';
import { ReconcileSalesAttributionService } from '../workflows/services/reconcile-sales-attribution.service';
import { AnalyticsRequestCoordinatorService } from './analytics-request-coordinator.service';
import {
  creativeCodeParts,
  resolveStoreAttribution,
  UNATTRIBUTED_STORE_KEY,
} from './utils/store-attribution';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TIMEZONE = 'Asia/Manila';
const PROCESSED_SALES_STATUSES = [1, 2, 3, 9, 12, 13] as const;
// Separate calculation revisions from data-cache versions and response shapes:
// persisted responses from earlier math must not survive a calculation deploy.
const SALES_CALCULATION_VERSION = 2;

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
        (opts.excludeRestocking ? this.toNumber(sum?._sum?.repurchaseCogsRestockingPos) : 0),
      cogsRaw: repurchaseCogs,
      cogsCanceled: this.toNumber(sum?._sum?.repurchaseCogsCanceledPos),
      cogsRestocking: this.toNumber(sum?._sum?.repurchaseCogsRestockingPos),
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
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsDelivered = this.toNumber(sum?._sum?.cogsDeliveredPos);
    const sf = this.toNumber(sum?._sum?.sfPos);
    const ff = this.toNumber(sum?._sum?.ffPos);
    const inf = this.toNumber(sum?._sum?.ifPos);
    const sfSdr = this.toNumber(sum?._sum?.sfSdrPos);
    const ffSdr = this.toNumber(sum?._sum?.ffSdrPos);
    const ifSdr = this.toNumber(sum?._sum?.ifSdrPos);
    // COGS after optional exclusions (remove excluded portions from the total once)
    const cogsAdjusted =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0)
      - repurchaseAdj.cogsVisible;
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
      + cogsRtsAdj;
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

  private computeStatusDistribution(sum: any): SalesStatusDistribution {
    const withoutRepurchase = (countKey: string, repurchaseCountKey: string) =>
      Math.max(
        0,
        this.toNumber(sum?._sum?.[countKey]) -
          this.toNumber(sum?._sum?.[repurchaseCountKey]),
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
    const cogsRts = this.toNumber(sum?._sum?.cogsRtsPos);
    const cogsAdjusted =
      cogs
      - (opts.excludeCancel ? cogsCanceled : 0)
      - (opts.excludeRestocking ? cogsRestocking : 0)
      - repurchaseAdj.cogsVisible;

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
      + (cogsRts - repurchaseAdj.cogsRts);

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
      cogsAdjusted +
      (cogsRts - repurchaseAdj.cogsRts);

    return {
      mapping: sum.mapping ?? null,
      revenue,
      gross_sales: purchasesAdj,
      cogs: cogsAdjusted,
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

  async getOverview(params: SalesOverviewParams) {
    const tenantId = this.teamContext.getTenantId();
    const requestKey = `sales-overview:${tenantId}:${this.analyticsCache.hashObject({
      ...params,
      mappings: [...(params.mappings || [])].map((value) => this.normalize(value)).sort(),
    })}`;

    return this.analyticsRequestCoordinator.run(
      tenantId,
      requestKey,
      () => this.calculateOverview(params),
    );
  }

  private async calculateOverview(params: SalesOverviewParams) {
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
    const activeStores = await this.prisma.posStore.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [{ enabled: true }, { enabled: null }],
      },
      select: { shopId: true },
    });
    const activeShopIds = Array.from(new Set(activeStores.map((store) => store.shopId)));

    const mappingFilter =
      normalizedMappings.length > 0
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
      date: { gte: startDate_dt, lte: endDate_dt },
    });

    const where = {
      ...baseWhere,
      ...mappingFilter,
    };
    const processedSalesWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const prevProcessedSalesWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const cancellationRateWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });
    const prevCancellationRateWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      shopId: { in: activeShopIds },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
      ...mappingFilter,
    });

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      responseShapeVersion: 7,
      calculationVersion: SALES_CALCULATION_VERSION,
      tenantId,
      analyticsScope: 'tenant',
      activeShopIds: [...activeShopIds].sort(),
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
      activeShopIds.length > 0
        ? Prisma.sql`"shopId" IN (${Prisma.join(activeShopIds)})`
        : Prisma.sql`FALSE`,
    ];
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
      this.prisma.reconcileSales.aggregate({
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
      this.prisma.reconcileSales.aggregate({
        where: {
          ...baseWhere,
          ...mappingFilter,
          date: { gte: prevStartDate_dt, lte: prevEndDate_dt },
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
      this.prisma.posOrder.aggregate({
        where: processedSalesWhere,
        _sum: {
          cod: true,
        },
      }),
      this.prisma.posOrder.aggregate({
        where: prevProcessedSalesWhere,
        _sum: {
          cod: true,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...cancellationRateWhere,
          OR: [{ status: { not: 7 } }, { status: null }],
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 6,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          OR: [{ status: { not: 7 } }, { status: null }],
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 6,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 4,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...cancellationRateWhere,
          status: 5,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 4,
        },
      }),
      this.prisma.posOrder.count({
        where: {
          ...prevCancellationRateWhere,
          status: 5,
        },
      }),
      this.prisma.$queryRaw<Array<{ date: string; shipped: number; delivered: number; rts: number }>>(Prisma.sql`
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
      this.prisma.reconcileSales.findMany({
        where: {
          ...baseWhere,
          mapping: { not: null },
        },
        distinct: ['mapping'],
        select: { mapping: true },
      }),
      this.prisma.reconcileSales.count({
        where: {
          ...baseWhere,
          mapping: null,
        },
      }),
      this.prisma.reconcileSales.groupBy({
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
      this.prisma.reconcileSales.aggregate({
        where,
        _max: { updatedAt: true },
      }),
    ]);

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
    await resolveMappingDisplayNames(this.prisma, mappingDisplayMap);

    if (nullCount > 0) {
      const key = this.normalize('__null__');
      mappingDisplayMap[key] = `Unassigned (${nullCount})`;
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

    const deliveryStatuses: DeliveryStatusRow[] = productGroups.map((g) => ({
      mapping: g.mapping,
      total_orders: this.toNumber(g._sum?.purchasesPos),
      new_orders: this.toNumber(g._sum?.unconfirmedCount),
      restocking: this.toNumber(g._sum?.restockingCount),
      confirmed: this.toNumber(g._sum?.confirmedCount),
      printed: this.toNumber(g._sum?.printedCount),
      waiting_pickup: this.toNumber(g._sum?.waitingPickupCount),
      shipped: this.toNumber(g._sum?.shippedCount),
      delivered: this.toNumber(g._sum?.deliveredCount),
      rts: this.toNumber(g._sum?.rtsCount),
      canceled: this.toNumber(g._sum?.canceledCount),
      deleted: this.toNumber(g._sum?.deletedCount),
    }));

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
    const statusDistribution = this.computeStatusDistribution(agg);
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
      },
      rangeDays,
      lastUpdatedAt: lastUpdatedAgg?._max?.updatedAt || null,
      products,
      deliveryStatuses,
      volumeGrowthTrend,
    };

    this.logger.log(`CACHE SET ${cacheKey}`);
    await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  /**
   * Full overview for the sales page's STORE tab: identical response shape to
   * calculateOverview (kpis, counts, prev-period deltas, breakdown rows,
   * delivery statuses), computed with the same math — only the dimension
   * changes. Sourced from reconcile_marketing, the one reconcile table that
   * still knows which store a row touched; its totals are identical to
   * reconcile_sales, so the two tabs tie out by construction.
   *
   * `mappings` carries selected STORE ids here (with '__unattributed__' as the
   * sentinel bucket). Every row is assigned to EXACTLY ONE store via
   *   shops[0] -> creative link -> mapping-embedded store -> Unattributed
   * so buckets partition the data: nothing is dropped or counted twice.
   */
  async getStoreOverview(params: SalesOverviewParams) {
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

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      responseShapeVersion: 1,
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

    // The exact field set the product overview aggregates — same inputs, same
    // computeKpis/computeCounts/computeProductRow math.
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

    const select: Record<string, boolean> = {
      adId: true,
      adName: true,
      mapping: true,
      shops: true,
      date: true,
      updatedAt: true,
    };
    for (const f of metricFields) select[f] = true;

    // Current + previous period in one fetch; rows are split by date below.
    const [rows, tenantStores] = await Promise.all([
      this.prisma.reconcileMarketing.findMany({
        where: { tenantId, date: { gte: prevStartDate_dt, lte: endDate_dt } },
        select: select as any,
      }) as Promise<Array<Record<string, any>>>,
      this.prisma.posStore.findMany({
        where: { tenantId },
        select: { id: true, shopId: true, name: true },
      }),
    ]);

    const storeByShopId = new Map(tenantStores.map((st) => [st.shopId, st.id.toLowerCase()]));
    const storeNameById = new Map(tenantStores.map((st) => [st.id.toLowerCase(), st.name]));

    const unshoppedRows = rows.filter((r) => !(Array.isArray(r.shops) && r.shops.length > 0));
    const unshoppedAdIds = [...new Set(unshoppedRows.map((r) => r.adId as string).filter(Boolean))];
    const detectedCodes = new Set<string>();
    const detectedPrefixes = new Set<string>();
    for (const row of unshoppedRows) {
      const parts = creativeCodeParts(typeof row.adName === 'string' ? row.adName : null);
      if (!parts) continue;
      detectedCodes.add(parts.code);
      detectedPrefixes.add(parts.prefix);
    }

    // All fallbacks are tenant-scoped and loaded in parallel. Explicit links
    // remain authoritative; exact codes and unique active prefixes cover
    // unlinked static creatives and newly arrived ads with no POS orders yet.
    const [links, tenantProducts, codedCreatives, prefixConfigs] = await Promise.all([
      unshoppedAdIds.length > 0
        ? this.prisma.creativeMetaAdLink.findMany({
            where: { tenantId, adId: { in: unshoppedAdIds } },
            select: { adId: true, creative: { select: { storeConfig: { select: { storeId: true } } } } },
          })
        : Promise.resolve([]),
      this.prisma.posProduct.findMany({
        where: { store: { is: { tenantId } }, mapping: { not: null } },
        select: { storeId: true, mapping: true },
      }),
      detectedCodes.size > 0
        ? this.prisma.creative.findMany({
            where: { tenantId, code: { in: [...detectedCodes] } },
            select: { code: true, storeConfig: { select: { storeId: true } } },
          })
        : Promise.resolve([]),
      detectedPrefixes.size > 0
        ? this.prisma.creativeStoreConfig.findMany({
            where: {
              tenantId,
              active: true,
              storeId: { not: null },
              codePrefix: { in: [...detectedPrefixes] },
            },
            select: { codePrefix: true, storeId: true },
          })
        : Promise.resolve([]),
    ]);

    const storeByAdId = new Map<string, string>();
    for (const link of links) {
      const sid = link.creative?.storeConfig?.storeId;
      if (sid && !storeByAdId.has(link.adId)) storeByAdId.set(link.adId, sid.toLowerCase());
    }

    const storeByCreativeCode = new Map<string, string>();
    for (const creative of codedCreatives) {
      const sid = creative.storeConfig?.storeId;
      if (sid) storeByCreativeCode.set(creative.code.toUpperCase(), sid.toLowerCase());
    }

    const storeByCodePrefix = new Map<string, string>();
    for (const config of prefixConfigs) {
      if (config.storeId) storeByCodePrefix.set(config.codePrefix.toUpperCase(), config.storeId.toLowerCase());
    }

    // Coarse legacy mapping -> store only when the label is unambiguous.
    const storeByLabel = new Map<string, string | null>();
    for (const p of tenantProducts) {
      const label = p.mapping?.trim().toLowerCase();
      if (!label) continue;
      const sid = p.storeId.toLowerCase();
      if (storeByLabel.has(label) && storeByLabel.get(label) !== sid) storeByLabel.set(label, null);
      else storeByLabel.set(label, sid);
    }

    const resolveStore = (row: Record<string, any>): string => resolveStoreAttribution(row, {
      storeByShopId,
      storeByAdId,
      storeByCreativeCode,
      storeByCodePrefix,
      storeByLabel,
    });

    const allSelected = selectedStoreIds.length === 0;
    const isSelected = (storeKey: string) => allSelected || selectedStoreIds.includes(storeKey);

    const newBucket = () => {
      const b: Record<string, number> = {};
      for (const f of metricFields) b[f] = 0;
      return b;
    };
    const addRow = (bucket: Record<string, number>, row: Record<string, any>) => {
      for (const f of metricFields) bucket[f] += Number(row[f] ?? 0) || 0;
    };

    const currentAggSums = newBucket();
    const prevAggSums = newBucket();
    const storeBuckets = new Map<string, Record<string, number>>();
    const presentStoreKeys = new Set<string>();
    let lastUpdatedAt: Date | null = null;

    for (const row of rows) {
      const storeKey = resolveStore(row);
      const isCurrent = row.date >= startDate_dt;
      if (isCurrent) presentStoreKeys.add(storeKey);
      if (!isSelected(storeKey)) continue;
      if (isCurrent) {
        addRow(currentAggSums, row);
        let bucket = storeBuckets.get(storeKey);
        if (!bucket) {
          bucket = newBucket();
          storeBuckets.set(storeKey, bucket);
        }
        addRow(bucket, row);
        if (row.updatedAt instanceof Date && (!lastUpdatedAt || row.updatedAt > lastUpdatedAt)) {
          lastUpdatedAt = row.updatedAt;
        }
      } else {
        addRow(prevAggSums, row);
      }
    }

    // POS-order-backed metrics (processed sales, cancellation, undelivered)
    // scope by the selected stores' shopIds — the store analog of the product
    // overview's activeShopIds scope. Unattributed rows have no POS orders by
    // definition, so this is exact.
    const selectedShopIds = tenantStores
      .filter((st) => allSelected || selectedStoreIds.includes(st.id.toLowerCase()))
      .map((st) => st.shopId);
    const posScope = { shopId: { in: selectedShopIds } };
    const processedSalesWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      ...posScope,
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
    });
    const prevProcessedSalesWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      ...posScope,
      status: { in: [...PROCESSED_SALES_STATUSES] },
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
    });
    const cancellationRateWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: startStr, lte: endStr },
      isVoid: false,
      ...posScope,
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
    });
    const prevCancellationRateWhere = this.teamContext.buildTenantWhereClause({
      dateLocal: { gte: prevStartStr, lte: prevEndStr },
      isVoid: false,
      ...posScope,
      ...(excludeRepurchase ? { isRepurchase: false } : {}),
    });

    const [
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
    ] = await Promise.all([
      this.prisma.posOrder.aggregate({ where: processedSalesWhere, _sum: { cod: true } }),
      this.prisma.posOrder.aggregate({ where: prevProcessedSalesWhere, _sum: { cod: true } }),
      this.prisma.posOrder.count({ where: { ...cancellationRateWhere, OR: [{ status: { not: 7 } }, { status: null }] } }),
      this.prisma.posOrder.count({ where: { ...cancellationRateWhere, status: 6 } }),
      this.prisma.posOrder.count({ where: { ...prevCancellationRateWhere, OR: [{ status: { not: 7 } }, { status: null }] } }),
      this.prisma.posOrder.count({ where: { ...prevCancellationRateWhere, status: 6 } }),
      this.prisma.posOrder.count({ where: { ...cancellationRateWhere, status: 4 } }),
      this.prisma.posOrder.count({ where: { ...cancellationRateWhere, status: 5 } }),
      this.prisma.posOrder.count({ where: { ...prevCancellationRateWhere, status: 4 } }),
      this.prisma.posOrder.count({ where: { ...prevCancellationRateWhere, status: 5 } }),
    ]);

    const rtsForecastPct = 20;
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
    const statusDistribution = this.computeStatusDistribution(agg);

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

    const deliveryStatuses = [...storeBuckets.entries()].map(([storeKey, sums]) => ({
      mapping: storeName(storeKey),
      total_orders: sums.purchasesPos,
      new_orders: sums.unconfirmedCount,
      restocking: sums.restockingCount,
      confirmed: sums.confirmedCount,
      printed: sums.printedCount,
      waiting_pickup: sums.waitingPickupCount,
      shipped: sums.shippedCount,
      delivered: sums.deliveredCount,
      rts: sums.rtsCount,
      canceled: sums.canceledCount,
      deleted: sums.deletedCount,
    }));

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
      selected: { start_date: startStr, end_date: endStr, mappings: selectedStoreIds },
      rangeDays,
      lastUpdatedAt,
      products,
      deliveryStatuses,
      volumeGrowthTrend: [],
    };
    await this.analyticsCache.set(cacheKey, response);
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
