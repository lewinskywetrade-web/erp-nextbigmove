import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TeamContextService } from '../../common/services/team-context.service';
import { AnalyticsCacheService } from './analytics-cache.service';
import { Prisma } from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = process.env.NEXT_PUBLIC_TIMEZONE || 'Asia/Manila';
const POS_ORDER_POPULATION = 'non-void-v1';
const RISK_CONFIRMATION_GROUPS = [
  'HIGH RTS RATE',
  'ABANDONED',
  'NO CONVERSATION',
  'WITH CONVERSATION',
  'HAS RTS ORDER',
] as const;

type SalesPerformanceRow = {
  salesAssignee: string | null;
  shopId: string;
  orderCount: number;
  totalCod: number;
  salesCod: number;
  mktgCod: number;
  salesCodCount: number;
  mktgCodCount: number;
  upsellDelta: number;
  confirmedCount: number;
  marketingLeadCount: number;
  deliveredCount: number;
  rtsCount: number;
  pendingCount: number;
  cancelledCount: number;
  upsellCount: number;
  forUpsellCount: number;
  upsellTagCount: number;
  statusCounts: Record<string, number>;
  salesVsMktgPct: number;
  confirmationRatePct: number;
  rtsRatePct: number;
  pendingRatePct: number;
  cancellationRatePct: number;
  upsellRatePct: number;
};

@Injectable()
export class SalesPerformanceService {
  private readonly logger = new Logger(SalesPerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamContext: TeamContextService,
    private readonly analyticsCache: AnalyticsCacheService,
  ) {}

  private toNumber(val: any): number {
    const n = typeof val === 'string' ? parseFloat(val) : Number(val);
    return Number.isFinite(n) ? n : 0;
  }

  private toReasonLabel(value: string): string {
    return (value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\b[a-z]/g, (m) => m.toUpperCase());
  }

  private normalizeAssignee(value?: string | null): string {
    return (value || '').trim().toLowerCase();
  }

  private diffDays(startStr: string, endStr: string): number {
    return dayjs(endStr, 'YYYY-MM-DD').diff(dayjs(startStr, 'YYYY-MM-DD'), 'day');
  }

  private shiftDate(dateStr: string, offsetDays: number): string {
    return dayjs(dateStr, 'YYYY-MM-DD').add(offsetDays, 'day').format('YYYY-MM-DD');
  }

  private buildEmptyResponse(startStr: string, endStr: string, rangeDays: number, salesAssignees: string[] = []) {
    const emptySummary = {
      upsell_delta: 0,
      sales_cod: 0,
      sales_cod_count: 0,
      mktg_cod: 0,
      mktg_cod_count: 0,
      sales_vs_mktg_pct: 0,
      confirmed_count: 0,
      marketing_lead_count: 0,
      confirmation_rate_pct: 0,
      delivered_count: 0,
      rts_count: 0,
      rts_rate_pct: 0,
      pending_count: 0,
      cancelled_count: 0,
      pending_rate_pct: 0,
      cancellation_rate_pct: 0,
      upsell_rate_pct: 0,
      total_cod: 0,
      order_count: 0,
      upsell_count: 0,
      for_upsell_count: 0,
      upsell_tag_count: 0,
    };
    return {
      summary: emptySummary,
      prevSummary: emptySummary,
      rows: [],
      filters: { salesAssignees: [], includeUnassigned: false, shops: [] as string[], shopDisplayMap: {} as Record<string, string> },
      selected: { start_date: startStr, end_date: endStr, sales_assignees: salesAssignees, shop_ids: [] as string[] },
      rangeDays,
      lastUpdatedAt: null,
    };
  }

  private buildEmptyProblematicDeliveryResponse(
    startStr: string,
    endStr: string,
    selectedShopIds: string[] = [],
    salesAssignee: string | null = null,
  ) {
    return {
      data: [],
      total: 0,
      trend: [] as Array<{ date: string; delivered_count: number; rts_count: number }>,
      undeliverableAllTime: {
        count: 0,
        totalCod: 0,
      },
      undeliverableTrend: [] as Array<{ date: string; count: number }>,
      onDeliveryAllTime: {
        count: 0,
        totalCod: 0,
      },
      onDeliveryTrend: [] as Array<{ date: string; count: number }>,
      deliveredInRange: {
        count: 0,
        totalCod: 0,
      },
      deliveredInRangeTrend: [] as Array<{ date: string; count: number }>,
      returnedInRange: {
        count: 0,
        totalCod: 0,
      },
      returnedInRangeTrend: [] as Array<{ date: string; count: number }>,
      riskConfirmationRows: RISK_CONFIRMATION_GROUPS.map((riskTag) => ({
        riskTag,
        confirmedCount: 0,
        restockingCount: 0,
        waitingForPickupCount: 0,
        shippedCount: 0,
        deliveredCount: 0,
        rtsCount: 0,
      })),
      repurchaseByShop: [] as Array<{
        shopId: string;
        deliveredOrders: number;
        deliveredAmount: number;
        rtsOrders: number;
        rtsAmount: number;
        shippedOrders: number;
        shippedAmount: number;
        totalOrders: number;
        totalAmount: number;
      }>,
      filters: { shops: [] as string[], shopDisplayMap: {} as Record<string, string> },
      selected: {
        start_date: startStr,
        end_date: endStr,
        shop_ids: selectedShopIds,
        sales_assignee: salesAssignee,
      },
      lastUpdatedAt: null as string | null,
    };
  }

  private buildEmptyStoreConversionResponse(
    startStr: string,
    endStr: string,
    rangeDays: number,
    selectedShopIds: string[] = [],
  ) {
    const emptySummary = {
      abandonedOrders: 0,
      abandonedConvertedOrders: 0,
      abandonedConvertedRevenue: 0,
      abandonedConversionRatePct: 0,
      abandonedDeliveredOrders: 0,
      abandonedRtsOrders: 0,
      abandonedDeliveryRatePct: 0,
      abandonedRtsRatePct: 0,
      repurchaseOrders: 0,
      repurchaseConvertedOrders: 0,
      repurchaseRevenue: 0,
      repurchaseConversionRatePct: 0,
      repurchaseDeliveredOrders: 0,
      repurchaseRtsOrders: 0,
      repurchaseDeliveryRatePct: 0,
      repurchaseRtsRatePct: 0,
    };

    return {
      summary: emptySummary,
      prevSummary: emptySummary,
      rows: [],
      filters: {
        shops: [] as string[],
        shopDisplayMap: {} as Record<string, string>,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        shop_ids: selectedShopIds,
      },
      rangeDays,
      lastUpdatedAt: null as string | null,
    };
  }

  private buildStoreConversionSummary(rows: Array<Record<string, any>>) {
    const summary = rows.reduce(
      (acc, row) => {
        acc.abandonedOrders += this.toNumber(row.abandoned_orders);
        acc.abandonedConvertedOrders += this.toNumber(row.abandoned_converted_orders);
        acc.abandonedConvertedRevenue += this.toNumber(row.abandoned_converted_revenue);
        acc.abandonedDeliveredOrders += this.toNumber(row.abandoned_delivered_orders);
        acc.abandonedRtsOrders += this.toNumber(row.abandoned_rts_orders);
        acc.repurchaseOrders += this.toNumber(row.repurchase_orders);
        acc.repurchaseConvertedOrders += this.toNumber(row.repurchase_converted_orders);
        acc.repurchaseRevenue += this.toNumber(row.repurchase_revenue);
        acc.repurchaseDeliveredOrders += this.toNumber(row.repurchase_delivered_orders);
        acc.repurchaseRtsOrders += this.toNumber(row.repurchase_rts_orders);
        return acc;
      },
      {
        abandonedOrders: 0,
        abandonedConvertedOrders: 0,
        abandonedConvertedRevenue: 0,
        abandonedDeliveredOrders: 0,
        abandonedRtsOrders: 0,
        repurchaseOrders: 0,
        repurchaseConvertedOrders: 0,
        repurchaseRevenue: 0,
        repurchaseDeliveredOrders: 0,
        repurchaseRtsOrders: 0,
      },
    );
    const abandonedOutcomeTotal = summary.abandonedDeliveredOrders + summary.abandonedRtsOrders;
    const repurchaseOutcomeTotal = summary.repurchaseDeliveredOrders + summary.repurchaseRtsOrders;

    return {
      ...summary,
      abandonedConversionRatePct:
        summary.abandonedOrders > 0
          ? (summary.abandonedConvertedOrders / summary.abandonedOrders) * 100
          : 0,
      abandonedDeliveryRatePct:
        abandonedOutcomeTotal > 0
          ? (summary.abandonedDeliveredOrders / abandonedOutcomeTotal) * 100
          : 0,
      abandonedRtsRatePct:
        abandonedOutcomeTotal > 0
          ? (summary.abandonedRtsOrders / abandonedOutcomeTotal) * 100
          : 0,
      repurchaseConversionRatePct:
        summary.repurchaseOrders > 0
          ? (summary.repurchaseConvertedOrders / summary.repurchaseOrders) * 100
          : 0,
      repurchaseDeliveryRatePct:
        repurchaseOutcomeTotal > 0
          ? (summary.repurchaseDeliveredOrders / repurchaseOutcomeTotal) * 100
          : 0,
      repurchaseRtsRatePct:
        repurchaseOutcomeTotal > 0
          ? (summary.repurchaseRtsOrders / repurchaseOutcomeTotal) * 100
          : 0,
    };
  }

  async getStoreConversion(params: {
    startDate?: string;
    endDate?: string;
    shopIds?: string[];
  }) {
    const { startDate, endDate, shopIds = [] } = params;
    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;

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
    const normalizedShopIds = (shopIds || [])
      .map((v) => v?.toString?.().trim?.() || '')
      .filter((v) => v.length > 0);

    const { tenantId } = await this.teamContext.getContext();
    const effectiveTeamIds = await this.teamContext.getAnalyticsTeamIds('sales');

    if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length === 0) {
      return this.buildEmptyStoreConversionResponse(startStr, endStr, rangeDays, normalizedShopIds);
    }

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      tenantId,
      orderPopulation: POS_ORDER_POPULATION,
      teamIds: effectiveTeamIds || [],
      start: startStr,
      end: endStr,
      shopIds: normalizedShopIds.sort(),
      chart: 'store-conversion',
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales-performance:store-conversion:${this.analyticsCache.hashObject(cacheKeyPayload)}`;
    const cached = await this.analyticsCache.get<any>(cacheKey);
    if (cached) return cached;

    const buildBaseWhere = (start: string, end: string, includeShopFilter = true) => {
      const where = [
        Prisma.sql`"tenantId" = ${tenantId}::uuid`,
        Prisma.sql`"dateLocal" >= ${start}`,
        Prisma.sql`"dateLocal" <= ${end}`,
        Prisma.sql`"status" IS DISTINCT FROM 7`,
        Prisma.sql`"isVoid" IS DISTINCT FROM true`,
        Prisma.sql`(COALESCE("wasAbandonedCart", false) = true OR COALESCE("isRepurchase", false) = true)`,
      ];
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        where.push(Prisma.sql`"teamId" IN (${Prisma.join(effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`))})`);
      }
      if (includeShopFilter && normalizedShopIds.length > 0) {
        where.push(Prisma.sql`"shopId" IN (${Prisma.join(normalizedShopIds)})`);
      }
      return where;
    };

    const buildRowsQuery = (whereClause: Prisma.Sql) => Prisma.sql`
      SELECT
        "shopId",
        COUNT(*) FILTER (WHERE COALESCE("wasAbandonedCart", false) = true)::int AS abandoned_orders,
        COUNT(*) FILTER (
          WHERE COALESCE("wasAbandonedCart", false) = true
            AND "status" NOT IN (0, 6, 7, 11)
        )::int AS abandoned_converted_orders,
        COALESCE(SUM(
          CASE
            WHEN COALESCE("wasAbandonedCart", false) = true
              AND "status" NOT IN (0, 6, 7, 11)
              THEN COALESCE("cod", 0)
            ELSE 0
          END
        ), 0)::numeric AS abandoned_converted_revenue,
        COUNT(*) FILTER (
          WHERE COALESCE("wasAbandonedCart", false) = true
            AND "status" = 3
        )::int AS abandoned_delivered_orders,
        COUNT(*) FILTER (
          WHERE COALESCE("wasAbandonedCart", false) = true
            AND "status" IN (4, 5)
        )::int AS abandoned_rts_orders,
        COUNT(*) FILTER (WHERE COALESCE("isRepurchase", false) = true)::int AS repurchase_orders,
        COUNT(*) FILTER (
          WHERE COALESCE("isRepurchase", false) = true
            AND "status" NOT IN (0, 6, 7, 11)
        )::int AS repurchase_converted_orders,
        COALESCE(SUM(
          CASE
            WHEN COALESCE("isRepurchase", false) = true
              AND "status" NOT IN (0, 6, 7, 11)
              THEN COALESCE("cod", 0)
            ELSE 0
          END
        ), 0)::numeric AS repurchase_revenue,
        COUNT(*) FILTER (
          WHERE COALESCE("isRepurchase", false) = true
            AND "status" = 3
        )::int AS repurchase_delivered_orders,
        COUNT(*) FILTER (
          WHERE COALESCE("isRepurchase", false) = true
            AND "status" IN (4, 5)
        )::int AS repurchase_rts_orders
      FROM "pos_orders"
      ${whereClause}
      GROUP BY "shopId"
      ORDER BY "shopId"
    `;

    const whereClause = Prisma.sql`WHERE ${Prisma.join(buildBaseWhere(startStr, endStr), ' AND ')}`;
    const prevWhereClause = Prisma.sql`WHERE ${Prisma.join(buildBaseWhere(prevStartStr, prevEndStr), ' AND ')}`;
    const optionWhereClause = Prisma.sql`WHERE ${Prisma.join(buildBaseWhere(startStr, endStr, false), ' AND ')}`;

    const [rawRows, prevRawRows, lastUpdatedRows, optionRows] = await Promise.all([
      this.prisma.$queryRaw<any[]>(buildRowsQuery(whereClause)),
      this.prisma.$queryRaw<any[]>(buildRowsQuery(prevWhereClause)),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT MAX("updatedAt") AS "last_updated"
        FROM "pos_orders"
        ${whereClause}
      `),
      this.prisma.$queryRaw<Array<{ shopId: string }>>(Prisma.sql`
        SELECT DISTINCT "shopId"
        FROM "pos_orders"
        ${optionWhereClause}
        AND "shopId" IS NOT NULL
        ORDER BY "shopId"
      `),
    ]);

    const rows = rawRows.map((row) => {
      const abandonedOrders = this.toNumber(row.abandoned_orders);
      const abandonedConvertedOrders = this.toNumber(row.abandoned_converted_orders);
      const abandonedConvertedRevenue = this.toNumber(row.abandoned_converted_revenue);
      const abandonedDeliveredOrders = this.toNumber(row.abandoned_delivered_orders);
      const abandonedRtsOrders = this.toNumber(row.abandoned_rts_orders);
      const abandonedOutcomeTotal = abandonedDeliveredOrders + abandonedRtsOrders;
      const repurchaseOrders = this.toNumber(row.repurchase_orders);
      const repurchaseConvertedOrders = this.toNumber(row.repurchase_converted_orders);
      const repurchaseRevenue = this.toNumber(row.repurchase_revenue);
      const repurchaseDeliveredOrders = this.toNumber(row.repurchase_delivered_orders);
      const repurchaseRtsOrders = this.toNumber(row.repurchase_rts_orders);
      const repurchaseOutcomeTotal = repurchaseDeliveredOrders + repurchaseRtsOrders;

      return {
        shopId: (row.shopId || '').toString(),
        abandonedOrders,
        abandonedConvertedOrders,
        abandonedConvertedRevenue,
        abandonedConversionRatePct:
          abandonedOrders > 0 ? (abandonedConvertedOrders / abandonedOrders) * 100 : 0,
        abandonedDeliveredOrders,
        abandonedRtsOrders,
        abandonedDeliveryRatePct:
          abandonedOutcomeTotal > 0 ? (abandonedDeliveredOrders / abandonedOutcomeTotal) * 100 : 0,
        abandonedRtsRatePct:
          abandonedOutcomeTotal > 0 ? (abandonedRtsOrders / abandonedOutcomeTotal) * 100 : 0,
        repurchaseOrders,
        repurchaseConvertedOrders,
        repurchaseRevenue,
        repurchaseConversionRatePct:
          repurchaseOrders > 0 ? (repurchaseConvertedOrders / repurchaseOrders) * 100 : 0,
        repurchaseDeliveredOrders,
        repurchaseRtsOrders,
        repurchaseDeliveryRatePct:
          repurchaseOutcomeTotal > 0 ? (repurchaseDeliveredOrders / repurchaseOutcomeTotal) * 100 : 0,
        repurchaseRtsRatePct:
          repurchaseOutcomeTotal > 0 ? (repurchaseRtsOrders / repurchaseOutcomeTotal) * 100 : 0,
      };
    });

    const summary = this.buildStoreConversionSummary(rawRows);
    const prevSummary = this.buildStoreConversionSummary(prevRawRows);
    const shopIdsList = optionRows.map((row) => row.shopId).filter(Boolean);
    const shopDisplayMap: Record<string, string> = {};

    if (shopIdsList.length > 0) {
      const storeWhere: Prisma.PosStoreWhereInput = {
        tenantId,
        shopId: { in: shopIdsList },
      };
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        storeWhere.teamId = { in: effectiveTeamIds };
      }
      const stores = await this.prisma.posStore.findMany({
        where: storeWhere,
        select: { shopId: true, shopName: true, name: true },
      });
      stores.forEach((store) => {
        const display = store.shopName || store.name || store.shopId;
        if (display) {
          shopDisplayMap[store.shopId] = display;
        }
      });
    }

    const response = {
      summary,
      prevSummary,
      rows,
      filters: {
        shops: shopIdsList,
        shopDisplayMap,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        shop_ids: normalizedShopIds,
      },
      rangeDays,
      lastUpdatedAt: lastUpdatedRows?.[0]?.last_updated ?? null,
    };

    await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  async getOverview(params: {
    startDate?: string;
    endDate?: string;
    salesAssignees?: string[];
    shopIds?: string[];
    includeShopOptions?: boolean;
  }) {
    const { startDate, endDate, salesAssignees = [], shopIds = [], includeShopOptions = false } = params;

    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;

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

    const normalizedAssignees = (salesAssignees || [])
      .map((v) => v?.toString?.().trim?.() || '')
      .filter((v) => v.length > 0);
    const includeNull = normalizedAssignees.includes('__null__');
    const assigneeValues = normalizedAssignees.filter((v) => v !== '__null__');
    const normalizedShopIds = (shopIds || [])
      .map((v) => v?.toString?.().trim?.() || '')
      .filter((v) => v.length > 0);

    const { tenantId } = await this.teamContext.getContext();
    const effectiveTeamIds = await this.teamContext.getAnalyticsTeamIds('sales');

    if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length === 0) {
      return this.buildEmptyResponse(startStr, endStr, rangeDays, normalizedAssignees);
    }

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      tenantId,
      orderPopulation: POS_ORDER_POPULATION,
      teamIds: effectiveTeamIds || [],
      start: startStr,
      end: endStr,
      salesAssignees: normalizedAssignees.sort(),
      shopIds: normalizedShopIds.sort(),
      includeShopOptions,
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales-performance:${this.analyticsCache.hashObject(cacheKeyPayload)}`;
    const cached = await this.analyticsCache.get<any>(cacheKey);
    if (cached) return cached;

    const buildBaseWhere = (start: string, end: string) => {
      const where = [
        Prisma.sql`"tenantId" = ${tenantId}::uuid`,
        Prisma.sql`"dateLocal" >= ${start}`,
        Prisma.sql`"dateLocal" <= ${end}`,
        Prisma.sql`"status" IS DISTINCT FROM 7`,
        Prisma.sql`"isVoid" IS DISTINCT FROM true`,
      ];
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        const teamIdParams = effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`);
        where.push(Prisma.sql`"teamId" IN (${Prisma.join(teamIdParams)})`);
      }
      return where;
    };

    const applyAssigneeFilters = (base: Prisma.Sql[]) => {
      const filtered = [...base];
      if (assigneeValues.length > 0 && includeNull) {
        filtered.push(
          Prisma.sql`("salesAssignee" IN (${Prisma.join(assigneeValues)}) OR "salesAssignee" IS NULL)`,
        );
      } else if (assigneeValues.length > 0) {
        filtered.push(
          Prisma.sql`"salesAssignee" IN (${Prisma.join(assigneeValues)})`,
        );
      } else if (includeNull) {
        filtered.push(Prisma.sql`"salesAssignee" IS NULL`);
      }
      return filtered;
    };

    const applyShopFilters = (base: Prisma.Sql[]) => {
      const filtered = [...base];
      if (normalizedShopIds.length > 0) {
        filtered.push(Prisma.sql`"shopId" IN (${Prisma.join(normalizedShopIds)})`);
      }
      return filtered;
    };

    const baseWhere = buildBaseWhere(startStr, endStr);
    const filteredWhere = applyShopFilters(applyAssigneeFilters(baseWhere));
    const whereClause = Prisma.sql`WHERE ${Prisma.join(filteredWhere, ' AND ')}`;

    const prevBaseWhere = buildBaseWhere(prevStartStr, prevEndStr);
    const prevFilteredWhere = applyShopFilters(applyAssigneeFilters(prevBaseWhere));
    const prevWhereClause = Prisma.sql`WHERE ${Prisma.join(prevFilteredWhere, ' AND ')}`;

    const buildRowsQuery = (clause: Prisma.Sql) => Prisma.sql`
      WITH filtered AS (
        SELECT
          "salesAssignee",
          "shopId",
          "status",
          "cod",
          "salesCod",
          "mktgCod",
          "isMarketingSource",
          "forUpsell",
          "statusHistory",
          "tags",
          "upsellBreakdown"
        FROM "pos_orders"
        ${clause}
      ),
      agg AS (
        SELECT
          "salesAssignee",
          "shopId",
          COUNT(*)::int AS "order_count",
          COALESCE(SUM(COALESCE("cod", 0)), 0)::numeric AS "total_cod",
          COALESCE(SUM(COALESCE("salesCod", 0)), 0)::numeric AS "sales_cod",
          COALESCE(SUM(
            CASE
              WHEN COALESCE(jsonb_path_exists("statusHistory", '$[*] ? (@.status == 1)'), false)
                AND COALESCE("status", 0) <> 6
                THEN 1
              ELSE 0
            END
          ), 0)::int AS "sales_cod_count",
          COALESCE(SUM(
            CASE
              WHEN COALESCE(jsonb_path_exists("statusHistory", '$[*] ? (@.status == 1)'), false)
                THEN 1
              ELSE 0
            END
          ), 0)::int AS "confirmed_count",
          COALESCE(SUM(CASE WHEN "isMarketingSource" THEN 1 ELSE 0 END), 0)::int AS "marketing_lead_count",
          COALESCE(SUM(CASE WHEN "forUpsell" THEN 1 ELSE 0 END), 0)::int AS "for_upsell_count",
          COALESCE(SUM(
            CASE
              WHEN COALESCE(jsonb_path_exists("tags", '$[*] ? (@.name == "UPSELL")'), false)
                THEN 1
              ELSE 0
            END
          ), 0)::int AS "upsell_tag_count",
          COALESCE(SUM(
            CASE
              WHEN "upsellBreakdown" IS NULL THEN 0
              ELSE
                (
                  CASE
                    WHEN ("upsellBreakdown"->>'new_amount') ~ '^-?\\d+(\\.\\d+)?$'
                      THEN ("upsellBreakdown"->>'new_amount')::numeric
                    ELSE 0
                  END
                ) -
                (
                  CASE
                    WHEN ("upsellBreakdown"->>'original_amount') ~ '^-?\\d+(\\.\\d+)?$'
                      THEN ("upsellBreakdown"->>'original_amount')::numeric
                    ELSE 0
                  END
                )
            END
          ), 0)::numeric AS "upsell_delta",
          COALESCE(SUM(
            CASE
              WHEN "mktgCod" IS NOT NULL THEN "mktgCod"
              ELSE COALESCE("cod", 0) - (
                CASE
                  WHEN "upsellBreakdown" IS NULL THEN 0
                  ELSE
                    (
                      CASE
                        WHEN ("upsellBreakdown"->>'new_amount') ~ '^-?\\d+(\\.\\d+)?$'
                          THEN ("upsellBreakdown"->>'new_amount')::numeric
                        ELSE 0
                      END
                    ) -
                    (
                      CASE
                        WHEN ("upsellBreakdown"->>'original_amount') ~ '^-?\\d+(\\.\\d+)?$'
                          THEN ("upsellBreakdown"->>'original_amount')::numeric
                        ELSE 0
                      END
                    )
                END
              )
            END
          ), 0)::numeric AS "mktg_cod",
          COALESCE(SUM(CASE WHEN "isMarketingSource" THEN 1 ELSE 0 END), 0)::int AS "mktg_cod_count",
          COALESCE(SUM(CASE WHEN "upsellBreakdown" IS NULL THEN 0 ELSE 1 END), 0)::int AS "upsell_count"
        FROM filtered
        GROUP BY "salesAssignee", "shopId"
      ),
      status_counts AS (
        SELECT
          "salesAssignee",
          "shopId",
          COALESCE("status"::text, 'null') AS status_key,
          COUNT(*)::int AS status_count
        FROM filtered
        GROUP BY "salesAssignee", "shopId", COALESCE("status"::text, 'null')
      )
      SELECT
        agg."salesAssignee",
        agg."shopId",
        agg."order_count",
        agg."total_cod",
        agg."sales_cod",
        agg."sales_cod_count",
        agg."mktg_cod",
        agg."mktg_cod_count",
        agg."upsell_delta",
        agg."confirmed_count",
        agg."marketing_lead_count",
        agg."for_upsell_count",
        agg."upsell_tag_count",
        agg."upsell_count",
        COALESCE(jsonb_object_agg(sc.status_key, sc.status_count) FILTER (WHERE sc.status_key IS NOT NULL), '{}'::jsonb) AS "status_counts"
      FROM agg
      LEFT JOIN status_counts sc
        ON sc."salesAssignee" IS NOT DISTINCT FROM agg."salesAssignee"
        AND sc."shopId" = agg."shopId"
      GROUP BY
        agg."salesAssignee",
        agg."shopId",
        agg."order_count",
        agg."total_cod",
        agg."sales_cod",
        agg."sales_cod_count",
        agg."mktg_cod",
        agg."mktg_cod_count",
        agg."upsell_delta",
        agg."confirmed_count",
        agg."marketing_lead_count",
        agg."for_upsell_count",
        agg."upsell_tag_count",
        agg."upsell_count"
      ORDER BY agg."salesAssignee" NULLS LAST, agg."shopId"
    `;

    const rowsQuery = buildRowsQuery(whereClause);
    const prevRowsQuery = buildRowsQuery(prevWhereClause);

    const [rawRows, prevRawRows] = await Promise.all([
      this.prisma.$queryRaw<any[]>(rowsQuery),
      this.prisma.$queryRaw<any[]>(prevRowsQuery),
    ]);

    const rows: SalesPerformanceRow[] = rawRows.map((row) => {
      const salesCod = this.toNumber(row.sales_cod);
      const mktgCod = this.toNumber(row.mktg_cod);
      const salesCodCount = this.toNumber(row.sales_cod_count);
      const mktgCodCount = this.toNumber(row.mktg_cod_count);
      const upsellDelta = this.toNumber(row.upsell_delta);
      const confirmedCount = this.toNumber(row.confirmed_count);
      const marketingLeadCount = this.toNumber(row.marketing_lead_count);
      const forUpsellCount = this.toNumber(row.for_upsell_count);
      const upsellTagCount = this.toNumber(row.upsell_tag_count);
      const totalCod = this.toNumber(row.total_cod);
      const statusCounts: Record<string, number> = row.status_counts || {};
      const deliveredCount = this.toNumber(statusCounts['3'] ?? 0);
      const rtsCount =
        this.toNumber(statusCounts['4'] ?? 0) + this.toNumber(statusCounts['5'] ?? 0);
      const pendingCount = this.toNumber(statusCounts['11'] ?? 0);
      const cancelledCount = this.toNumber(statusCounts['6'] ?? 0);
      const orderCount = this.toNumber(row.order_count);
      const rtsDenominator = deliveredCount + rtsCount;
      return {
        salesAssignee: row.salesAssignee ?? null,
        shopId: row.shopId,
        orderCount,
        totalCod,
        salesCod,
        mktgCod,
        salesCodCount,
        mktgCodCount,
        upsellDelta,
        confirmedCount,
        marketingLeadCount,
        upsellCount: this.toNumber(row.upsell_count),
        forUpsellCount,
        upsellTagCount,
        deliveredCount,
        rtsCount,
        pendingCount,
        cancelledCount,
        statusCounts,
        salesVsMktgPct: mktgCod > 0 ? (salesCod / mktgCod) * 100 : 0,
        confirmationRatePct:
          orderCount > 0
            ? (confirmedCount / orderCount) * 100
            : 0,
        rtsRatePct: rtsDenominator > 0 ? (rtsCount / rtsDenominator) * 100 : 0,
        pendingRatePct: orderCount > 0 ? (pendingCount / orderCount) * 100 : 0,
        cancellationRatePct: orderCount > 0 ? (cancelledCount / orderCount) * 100 : 0,
        upsellRatePct: forUpsellCount > 0 ? (upsellTagCount / forUpsellCount) * 100 : 0,
      };
    });

    const summary = rows.reduce(
      (acc, row) => {
        acc.upsell_delta += row.upsellDelta;
        acc.sales_cod += row.salesCod;
        acc.sales_cod_count += row.salesCodCount;
        acc.mktg_cod += row.mktgCod;
        acc.mktg_cod_count += row.mktgCodCount;
        acc.confirmed_count += row.confirmedCount;
        acc.marketing_lead_count += row.marketingLeadCount;
        acc.delivered_count += row.deliveredCount;
        acc.rts_count += row.rtsCount;
        acc.pending_count += row.pendingCount;
        acc.cancelled_count += row.cancelledCount;
        acc.total_cod += row.totalCod;
        acc.order_count += row.orderCount;
        acc.upsell_count += row.upsellCount;
        acc.for_upsell_count += row.forUpsellCount;
        acc.upsell_tag_count += row.upsellTagCount;
        return acc;
      },
      {
        upsell_delta: 0,
        sales_cod: 0,
        sales_cod_count: 0,
        mktg_cod: 0,
        mktg_cod_count: 0,
        confirmed_count: 0,
        marketing_lead_count: 0,
        delivered_count: 0,
        rts_count: 0,
        pending_count: 0,
        cancelled_count: 0,
        total_cod: 0,
        order_count: 0,
        upsell_count: 0,
        for_upsell_count: 0,
        upsell_tag_count: 0,
      },
    );

    const summaryWithPct = {
      ...summary,
      sales_vs_mktg_pct: summary.mktg_cod > 0 ? (summary.sales_cod / summary.mktg_cod) * 100 : 0,
      confirmation_rate_pct:
        summary.order_count > 0
          ? (summary.confirmed_count / summary.order_count) * 100
          : 0,
      rts_rate_pct:
        summary.delivered_count + summary.rts_count > 0
          ? (summary.rts_count / (summary.delivered_count + summary.rts_count)) * 100
          : 0,
      pending_rate_pct:
        summary.order_count > 0
          ? (summary.pending_count / summary.order_count) * 100
          : 0,
      cancellation_rate_pct:
        summary.order_count > 0
          ? (summary.cancelled_count / summary.order_count) * 100
          : 0,
      upsell_rate_pct:
        summary.for_upsell_count > 0
          ? (summary.upsell_tag_count / summary.for_upsell_count) * 100
          : 0,
    };

    const prevSummary = prevRawRows.reduce(
      (acc, row) => {
        acc.upsell_delta += this.toNumber(row.upsell_delta);
        acc.sales_cod += this.toNumber(row.sales_cod);
        acc.sales_cod_count += this.toNumber(row.sales_cod_count);
        acc.mktg_cod += this.toNumber(row.mktg_cod);
        acc.mktg_cod_count += this.toNumber(row.mktg_cod_count);
        acc.confirmed_count += this.toNumber(row.confirmed_count);
        acc.marketing_lead_count += this.toNumber(row.marketing_lead_count);
        acc.delivered_count += this.toNumber(row.status_counts?.['3'] ?? 0);
        acc.rts_count +=
          this.toNumber(row.status_counts?.['4'] ?? 0) +
          this.toNumber(row.status_counts?.['5'] ?? 0);
        acc.pending_count += this.toNumber(row.status_counts?.['11'] ?? 0);
        acc.cancelled_count += this.toNumber(row.status_counts?.['6'] ?? 0);
        acc.total_cod += this.toNumber(row.total_cod);
        acc.order_count += this.toNumber(row.order_count);
        acc.upsell_count += this.toNumber(row.upsell_count);
        acc.for_upsell_count += this.toNumber(row.for_upsell_count);
        acc.upsell_tag_count += this.toNumber(row.upsell_tag_count);
        return acc;
      },
      {
        upsell_delta: 0,
        sales_cod: 0,
        sales_cod_count: 0,
        mktg_cod: 0,
        mktg_cod_count: 0,
        confirmed_count: 0,
        marketing_lead_count: 0,
        delivered_count: 0,
        rts_count: 0,
        pending_count: 0,
        cancelled_count: 0,
        total_cod: 0,
        order_count: 0,
        upsell_count: 0,
        for_upsell_count: 0,
        upsell_tag_count: 0,
      },
    );
    const prevSummaryWithPct = {
      ...prevSummary,
      sales_vs_mktg_pct: prevSummary.mktg_cod > 0 ? (prevSummary.sales_cod / prevSummary.mktg_cod) * 100 : 0,
      confirmation_rate_pct:
        prevSummary.order_count > 0
          ? (prevSummary.confirmed_count / prevSummary.order_count) * 100
          : 0,
      rts_rate_pct:
        prevSummary.delivered_count + prevSummary.rts_count > 0
          ? (prevSummary.rts_count / (prevSummary.delivered_count + prevSummary.rts_count)) * 100
          : 0,
      pending_rate_pct:
        prevSummary.order_count > 0
          ? (prevSummary.pending_count / prevSummary.order_count) * 100
          : 0,
      cancellation_rate_pct:
        prevSummary.order_count > 0
          ? (prevSummary.cancelled_count / prevSummary.order_count) * 100
          : 0,
      upsell_rate_pct:
        prevSummary.for_upsell_count > 0
          ? (prevSummary.upsell_tag_count / prevSummary.for_upsell_count) * 100
          : 0,
    };

    const optionsWhere = Prisma.sql`WHERE ${Prisma.join(baseWhere, ' AND ')}`;
    const shopOptionsWhere = Prisma.sql`WHERE ${Prisma.join(applyAssigneeFilters(baseWhere), ' AND ')}`;
    const assigneeOptionsQuery = Prisma.sql`
      SELECT DISTINCT "salesAssignee"
      FROM "pos_orders"
      ${optionsWhere}
      AND "salesAssignee" IS NOT NULL
      ORDER BY "salesAssignee"
    `;
    const unassignedCountQuery = Prisma.sql`
      SELECT COUNT(*)::int AS "count"
      FROM "pos_orders"
      ${optionsWhere}
      AND "salesAssignee" IS NULL
    `;
    const shopOptionsQuery = includeShopOptions
      ? Prisma.sql`
        SELECT DISTINCT "shopId"
        FROM "pos_orders"
        ${shopOptionsWhere}
        ORDER BY "shopId"
      `
      : null;

    const [assigneeRows, users, unassignedCountRows, shopRows] = await Promise.all([
      this.prisma.$queryRaw<any[]>(assigneeOptionsQuery),
      this.prisma.user.findMany({
        where: { tenantId },
        select: { employeeId: true, firstName: true, lastName: true, email: true },
      }),
      this.prisma.$queryRaw<any[]>(unassignedCountQuery),
      shopOptionsQuery ? this.prisma.$queryRaw<any[]>(shopOptionsQuery) : Promise.resolve([]),
    ]);
    const unassignedCount = this.toNumber(unassignedCountRows?.[0]?.count);
    const includeUnassigned = unassignedCount > 0;

    const userMap: Record<string, string> = {};
    users.forEach((u) => {
      const full = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email || u.employeeId || '';
      if (u.employeeId) {
        userMap[this.normalizeAssignee(u.employeeId)] = full;
      }
      if (full) {
        userMap[this.normalizeAssignee(full)] = full;
      }
    });

    const salesAssigneesDisplayMap: Record<string, string> = {};
    const optionMap: Record<string, string> = {};
    assigneeRows.forEach((r) => {
      const raw = r.salesAssignee ?? '';
      const trimmed = raw.trim();
      if (!trimmed) return;
      const normalized = this.normalizeAssignee(trimmed);
      const display = userMap[normalized] || trimmed;
      optionMap[trimmed] = trimmed;
      if (!salesAssigneesDisplayMap[trimmed]) {
        salesAssigneesDisplayMap[trimmed] = display;
      }
      if (!salesAssigneesDisplayMap[normalized]) {
        salesAssigneesDisplayMap[normalized] = display;
      }
    });
    if (includeUnassigned) {
      salesAssigneesDisplayMap['__null__'] = unassignedCount > 0 ? `Unassigned (${unassignedCount})` : 'Unassigned';
    }

    const assigneeOptions = Object.keys(optionMap).sort((a, b) => {
      const da = salesAssigneesDisplayMap[a] || optionMap[a] || a;
      const db = salesAssigneesDisplayMap[b] || optionMap[b] || b;
      return da.localeCompare(db);
    });

    const lastUpdatedQuery = Prisma.sql`
      SELECT MAX("updatedAt") AS "last_updated"
      FROM "pos_orders"
      ${optionsWhere}
    `;
    const lastUpdatedRows = await this.prisma.$queryRaw<any[]>(lastUpdatedQuery);
    const lastUpdatedAt = lastUpdatedRows?.[0]?.last_updated ?? null;

    const shopIdsList = shopRows.map((r) => r.shopId).filter(Boolean);
    const shopDisplayMap: Record<string, string> = {};
    if (includeShopOptions && shopIdsList.length > 0) {
      const storeWhere: Prisma.PosStoreWhereInput = {
        tenantId,
        shopId: { in: shopIdsList },
      };
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        storeWhere.teamId = { in: effectiveTeamIds };
      }
      const stores = await this.prisma.posStore.findMany({
        where: storeWhere,
        select: { shopId: true, shopName: true, name: true },
      });
      stores.forEach((store) => {
        const display = store.shopName || store.name || store.shopId;
        if (display) {
          shopDisplayMap[store.shopId] = display;
        }
      });
    }

    const response = {
      summary: summaryWithPct,
      prevSummary: prevSummaryWithPct,
      rows,
      filters: {
        salesAssignees: assigneeOptions,
        salesAssigneesDisplayMap,
        includeUnassigned,
        shops: shopIdsList,
        shopDisplayMap,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        sales_assignees: normalizedAssignees,
        shop_ids: normalizedShopIds,
      },
      rangeDays,
      lastUpdatedAt,
    };

    await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  async getMyStats(params: {
    startDate?: string;
    endDate?: string;
    salesAssignee?: string | null;
    shopIds?: string[];
  }) {
    const { startDate, endDate, salesAssignee, shopIds = [] } = params;

    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;
    const rangeDays = this.diffDays(startStr, endStr) + 1;

    if (!dayjs(startStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid start_date format. Expected YYYY-MM-DD');
    }
    if (!dayjs(endStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid end_date format. Expected YYYY-MM-DD');
    }
    if (endStr < startStr) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }

    if (!salesAssignee || !salesAssignee.toString().trim()) {
      return this.buildEmptyResponse(startStr, endStr, rangeDays, []);
    }

    return this.getOverview({
      startDate,
      endDate,
      salesAssignees: [salesAssignee.toString()],
      shopIds,
      includeShopOptions: true,
    });
  }

  async getMyProblematicDelivery(params: {
    startDate?: string;
    endDate?: string;
    salesAssignee?: string | null;
    shopIds?: string[];
  }) {
    const startStr = (params.startDate && params.startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (params.endDate && params.endDate.trim()) || startStr;
    const normalizedShopIds = (params.shopIds || [])
      .map((v) => v?.toString?.().trim?.() || '')
      .filter((v) => v.length > 0);
    const assignee = params.salesAssignee?.toString().trim() || '';

    if (!assignee) {
      return this.buildEmptyProblematicDeliveryResponse(startStr, endStr, normalizedShopIds, null);
    }

    return this.getProblematicDelivery({
      startDate: params.startDate,
      endDate: params.endDate,
      shopIds: params.shopIds,
      salesAssignee: assignee,
    });
  }

  async getProblematicDelivery(params: {
    startDate?: string;
    endDate?: string;
    shopIds?: string[];
    salesAssignee?: string | null;
  }) {
    const { startDate, endDate, shopIds = [], salesAssignee } = params;
    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;

    if (!dayjs(startStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid start_date format. Expected YYYY-MM-DD');
    }
    if (!dayjs(endStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid end_date format. Expected YYYY-MM-DD');
    }
    if (endStr < startStr) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }

    const normalizedShopIds = (shopIds || [])
      .map((v) => v?.toString?.().trim?.() || '')
      .filter((v) => v.length > 0);
    const normalizedSalesAssignee = salesAssignee?.toString().trim() || null;

    const { tenantId } = await this.teamContext.getContext();
    const effectiveTeamIds = await this.teamContext.getAnalyticsTeamIds('sales');

    if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length === 0) {
      return this.buildEmptyProblematicDeliveryResponse(
        startStr,
        endStr,
        normalizedShopIds,
        normalizedSalesAssignee,
      );
    }

    const cacheVersion = await this.analyticsCache.getVersion(tenantId);
    const cacheKeyPayload = {
      tenantId,
      orderPopulation: POS_ORDER_POPULATION,
      teamIds: effectiveTeamIds || [],
      start: startStr,
      end: endStr,
      shopIds: normalizedShopIds.sort(),
      salesAssignee: normalizedSalesAssignee,
      chart: 'problematic-delivery',
    };
    const cacheKey = `analytics:${tenantId}:${cacheVersion}:sales-performance:problematic-delivery:${this.analyticsCache.hashObject(cacheKeyPayload)}`;
    const cached = await this.analyticsCache.get<any>(cacheKey);
    if (cached) return cached;

    const buildBaseWhere = (start: string, end: string) => {
      const where = [
        Prisma.sql`"tenantId" = ${tenantId}::uuid`,
        Prisma.sql`"dateLocal" >= ${start}`,
        Prisma.sql`"dateLocal" <= ${end}`,
        Prisma.sql`"status" IS DISTINCT FROM 7`,
        Prisma.sql`"isVoid" IS DISTINCT FROM true`,
      ];
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        const teamIdParams = effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`);
        where.push(Prisma.sql`"teamId" IN (${Prisma.join(teamIdParams)})`);
      }
      return where;
    };

    const applyShopFilters = (base: Prisma.Sql[]) => {
      const filtered = [...base];
      if (normalizedShopIds.length > 0) {
        filtered.push(Prisma.sql`"shopId" IN (${Prisma.join(normalizedShopIds)})`);
      }
      return filtered;
    };

    const applySalesAssigneeFilters = (base: Prisma.Sql[]) => {
      const filtered = [...base];
      if (normalizedSalesAssignee) {
        filtered.push(
          Prisma.sql`LOWER(BTRIM(COALESCE("salesAssignee", ''))) = LOWER(BTRIM(${normalizedSalesAssignee}))`,
        );
      }
      return filtered;
    };

    const baseWhere = applySalesAssigneeFilters(buildBaseWhere(startStr, endStr));
    const chartWhere = applyShopFilters(baseWhere);
    const whereClause = Prisma.sql`WHERE ${Prisma.join(chartWhere, ' AND ')}`;
    const deliveredRangeStartUtc = dayjs.tz(startStr, TIMEZONE).startOf('day').utc().toDate();
    const deliveredRangeEndUtcExclusive = dayjs
      .tz(endStr, TIMEZONE)
      .add(1, 'day')
      .startOf('day')
      .utc()
      .toDate();
    const deliveredRangeBaseWhere = [
      Prisma.sql`"tenantId" = ${tenantId}::uuid`,
      Prisma.sql`"status" IS DISTINCT FROM 7`,
      Prisma.sql`"isVoid" IS DISTINCT FROM true`,
      ...(Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0
        ? [Prisma.sql`"teamId" IN (${Prisma.join(effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`))})`]
        : []),
    ];
    const deliveredRangeWhere = applyShopFilters(
      applySalesAssigneeFilters(deliveredRangeBaseWhere),
    );
    deliveredRangeWhere.push(Prisma.sql`"deliveredAt" IS NOT NULL`);
    deliveredRangeWhere.push(Prisma.sql`"deliveredAt" >= ${deliveredRangeStartUtc}`);
    deliveredRangeWhere.push(Prisma.sql`"deliveredAt" < ${deliveredRangeEndUtcExclusive}`);
    const deliveredRangeWhereClause = Prisma.sql`WHERE ${Prisma.join(deliveredRangeWhere, ' AND ')}`;
    const returnedRangeWhere = applyShopFilters(
      applySalesAssigneeFilters(deliveredRangeBaseWhere),
    );
    returnedRangeWhere.push(Prisma.sql`"rtsAt" IS NOT NULL`);
    returnedRangeWhere.push(Prisma.sql`"rtsAt" >= ${deliveredRangeStartUtc}`);
    returnedRangeWhere.push(Prisma.sql`"rtsAt" < ${deliveredRangeEndUtcExclusive}`);
    const returnedRangeWhereClause = Prisma.sql`WHERE ${Prisma.join(returnedRangeWhere, ' AND ')}`;
    const allTimeBaseWhere = [
      Prisma.sql`"tenantId" = ${tenantId}::uuid`,
      Prisma.sql`"status" IS DISTINCT FROM 7`,
      Prisma.sql`"isVoid" IS DISTINCT FROM true`,
      ...(Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0
        ? [Prisma.sql`"teamId" IN (${Prisma.join(effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`))})`]
        : []),
    ];
    const allTimeWhere = applyShopFilters(applySalesAssigneeFilters(allTimeBaseWhere));
    const allTimeWhereClause = Prisma.sql`WHERE ${Prisma.join(allTimeWhere, ' AND ')}`;

    const [
      rows,
      trendRows,
      undeliverableSummaryRows,
      undeliverableTrendRows,
      onDeliverySummaryRows,
      onDeliveryTrendRows,
      deliveredInRangeSummaryRows,
      deliveredInRangeTrendRows,
      returnedInRangeSummaryRows,
      returnedInRangeTrendRows,
      riskConfirmationRawRows,
      repurchaseByShopRows,
    ] = await Promise.all([
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH reasons AS (
          SELECT
            LOWER(NULLIF(BTRIM(REGEXP_REPLACE("rtsReason"->>'l1', '\\s+', ' ', 'g')), '')) AS l1,
            LOWER(NULLIF(BTRIM(REGEXP_REPLACE("rtsReason"->>'l2', '\\s+', ' ', 'g')), '')) AS l2,
            LOWER(NULLIF(BTRIM(REGEXP_REPLACE("rtsReason"->>'l3', '\\s+', ' ', 'g')), '')) AS l3
          FROM "pos_orders"
          ${whereClause}
          AND "status" IN (4, 5)
          AND "rtsReason" IS NOT NULL
        )
        SELECT
          l1,
          l2,
          l3,
          COUNT(*)::int AS count
        FROM reasons
        WHERE l1 IS NOT NULL
          AND l2 IS NOT NULL
          AND l3 IS NOT NULL
          AND l1 <> 'unknown'
          AND l2 <> 'unknown'
          AND l3 <> 'unknown'
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH dates AS (
          SELECT generate_series(${startStr}::date, ${endStr}::date, interval '1 day')::date AS d
        ),
        counts AS (
          SELECT
            "dateLocal"::date AS d,
            COALESCE(SUM(CASE WHEN "status" = 3 THEN 1 ELSE 0 END), 0)::int AS delivered_count,
            COALESCE(SUM(CASE WHEN "status" IN (4, 5) THEN 1 ELSE 0 END), 0)::int AS rts_count
          FROM "pos_orders"
          ${whereClause}
          GROUP BY 1
        )
        SELECT
          TO_CHAR(dates.d, 'YYYY-MM-DD') AS date,
          COALESCE(counts.delivered_count, 0)::int AS delivered_count,
          COALESCE(counts.rts_count, 0)::int AS rts_count
        FROM dates
        LEFT JOIN counts ON counts.d = dates.d
        ORDER BY dates.d
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE("cod", 0)), 0)::numeric AS total_cod
        FROM "pos_orders"
        ${allTimeWhereClause}
        AND "status" = 2
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE("tags", '[]'::jsonb)) AS tag(value)
          WHERE LOWER(BTRIM(REGEXP_REPLACE(COALESCE(tag.value->>'name', ''), '\\s+', ' ', 'g'))) = 'undeliverable'
        )
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          TO_CHAR("dateLocal"::date, 'YYYY-MM-DD') AS date,
          COUNT(*)::int AS count
        FROM "pos_orders"
        ${allTimeWhereClause}
        AND "status" = 2
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE("tags", '[]'::jsonb)) AS tag(value)
          WHERE LOWER(BTRIM(REGEXP_REPLACE(COALESCE(tag.value->>'name', ''), '\\s+', ' ', 'g'))) = 'undeliverable'
        )
        GROUP BY 1
        ORDER BY 1
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE("cod", 0)), 0)::numeric AS total_cod
        FROM "pos_orders"
        ${allTimeWhereClause}
        AND "status" = 2
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE("tags", '[]'::jsonb)) AS tag(value)
          WHERE LOWER(BTRIM(REGEXP_REPLACE(COALESCE(tag.value->>'name', ''), '\\s+', ' ', 'g'))) = 'on delivery'
        )
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          TO_CHAR("dateLocal"::date, 'YYYY-MM-DD') AS date,
          COUNT(*)::int AS count
        FROM "pos_orders"
        ${allTimeWhereClause}
        AND "status" = 2
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE("tags", '[]'::jsonb)) AS tag(value)
          WHERE LOWER(BTRIM(REGEXP_REPLACE(COALESCE(tag.value->>'name', ''), '\\s+', ' ', 'g'))) = 'on delivery'
        )
        GROUP BY 1
        ORDER BY 1
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE("cod", 0)), 0)::numeric AS total_cod
        FROM "pos_orders"
        ${deliveredRangeWhereClause}
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH dates AS (
          SELECT generate_series(${startStr}::date, ${endStr}::date, interval '1 day')::date AS d
        ),
        counts AS (
          SELECT
            (("deliveredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE})::date AS d,
            COUNT(*)::int AS count
          FROM "pos_orders"
          ${deliveredRangeWhereClause}
          GROUP BY 1
        )
        SELECT
          TO_CHAR(dates.d, 'YYYY-MM-DD') AS date,
          COALESCE(counts.count, 0)::int AS count
        FROM dates
        LEFT JOIN counts ON counts.d = dates.d
        ORDER BY dates.d
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS count,
          COALESCE(SUM(COALESCE("cod", 0)), 0)::numeric AS total_cod
        FROM "pos_orders"
        ${returnedRangeWhereClause}
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH dates AS (
          SELECT generate_series(${startStr}::date, ${endStr}::date, interval '1 day')::date AS d
        ),
        counts AS (
          SELECT
            (("rtsAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TIMEZONE})::date AS d,
            COUNT(*)::int AS count
          FROM "pos_orders"
          ${returnedRangeWhereClause}
          GROUP BY 1
        )
        SELECT
          TO_CHAR(dates.d, 'YYYY-MM-DD') AS date,
          COALESCE(counts.count, 0)::int AS count
        FROM dates
        LEFT JOIN counts ON counts.d = dates.d
        ORDER BY dates.d
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH scoped_orders AS (
          SELECT
            "id",
            "status",
            "isRiskConfirmation",
            COALESCE("tags", '[]'::jsonb) AS tags
          FROM "pos_orders"
          ${whereClause}
        ),
        tag_rows AS (
          SELECT
            o."id",
            o."status",
            o."isRiskConfirmation",
            LOWER(
              NULLIF(
                BTRIM(
                  REGEXP_REPLACE(
                    COALESCE(
                      CASE
                        WHEN jsonb_typeof(tag.value) = 'object' THEN tag.value->>'name'
                        WHEN jsonb_typeof(tag.value) = 'string' THEN trim(BOTH '"' FROM tag.value::text)
                        ELSE ''
                      END,
                      ''
                    ),
                    '\\s+',
                    ' ',
                    'g'
                  )
                ),
                ''
              )
            ) AS tag_name
          FROM scoped_orders o
          LEFT JOIN LATERAL jsonb_array_elements(o.tags) AS tag(value) ON TRUE
        ),
        per_order AS (
          SELECT
            "id",
            MAX("status")::int AS status,
            MAX("isRiskConfirmation"::int)::int AS is_risk_confirmation,
            MAX(CASE WHEN tag_name = 'risk confirmation' THEN 1 ELSE 0 END)::int AS has_risk_confirmation_tag,
            MAX(CASE WHEN tag_name = 'high rts rate' THEN 1 ELSE 0 END)::int AS has_high_rts_rate,
            MAX(CASE WHEN tag_name = 'abandoned' THEN 1 ELSE 0 END)::int AS has_abandoned,
            MAX(CASE WHEN tag_name = 'no conversation' THEN 1 ELSE 0 END)::int AS has_no_conversation,
            MAX(CASE WHEN tag_name = 'with conversation' THEN 1 ELSE 0 END)::int AS has_with_conversation,
            MAX(CASE WHEN tag_name = 'has rts order' THEN 1 ELSE 0 END)::int AS has_has_rts_order
          FROM tag_rows
          GROUP BY "id"
        ),
        classified AS (
          SELECT
            CASE
              WHEN has_high_rts_rate = 1 THEN 'HIGH RTS RATE'
              WHEN has_abandoned = 1 THEN 'ABANDONED'
              WHEN has_no_conversation = 1 THEN 'NO CONVERSATION'
              WHEN has_with_conversation = 1 THEN 'WITH CONVERSATION'
              WHEN has_has_rts_order = 1 THEN 'HAS RTS ORDER'
              ELSE NULL
            END AS risk_tag,
            status,
            is_risk_confirmation,
            has_risk_confirmation_tag
          FROM per_order
          WHERE is_risk_confirmation = 1
             OR (has_risk_confirmation_tag = 1 AND status = 11)
        )
        SELECT
          risk_tag,
          COALESCE(SUM(CASE WHEN is_risk_confirmation = 1 AND status <> 6 THEN 1 ELSE 0 END), 0)::int AS confirmed_count,
          COALESCE(SUM(CASE WHEN has_risk_confirmation_tag = 1 AND status = 11 THEN 1 ELSE 0 END), 0)::int AS restocking_count,
          COALESCE(SUM(CASE WHEN is_risk_confirmation = 1 AND status = 9 THEN 1 ELSE 0 END), 0)::int AS waiting_for_pickup_count,
          COALESCE(SUM(CASE WHEN is_risk_confirmation = 1 AND status = 2 THEN 1 ELSE 0 END), 0)::int AS shipped_count,
          COALESCE(SUM(CASE WHEN is_risk_confirmation = 1 AND status = 3 THEN 1 ELSE 0 END), 0)::int AS delivered_count,
          COALESCE(SUM(CASE WHEN is_risk_confirmation = 1 AND status IN (4, 5) THEN 1 ELSE 0 END), 0)::int AS rts_count
        FROM classified
        WHERE risk_tag IS NOT NULL
        GROUP BY risk_tag
      `),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT
          "shopId",
          COUNT(*) FILTER (WHERE "status" = 3)::int AS delivered_orders,
          COALESCE(
            SUM(
              CASE
                WHEN "status" = 3 THEN COALESCE("cod", 0)
                ELSE 0
              END
            ),
            0
          )::numeric AS delivered_amount,
          COUNT(*) FILTER (WHERE "status" IN (4, 5))::int AS rts_orders,
          COALESCE(
            SUM(
              CASE
                WHEN "status" IN (4, 5) THEN COALESCE("cod", 0)
                ELSE 0
              END
            ),
            0
          )::numeric AS rts_amount,
          COUNT(*) FILTER (WHERE "status" = 2)::int AS shipped_orders,
          COALESCE(
            SUM(
              CASE
                WHEN "status" = 2 THEN COALESCE("cod", 0)
                ELSE 0
              END
            ),
            0
          )::numeric AS shipped_amount,
          COUNT(*) FILTER (WHERE "status" IN (2, 3, 4, 5))::int AS total_orders,
          COALESCE(
            SUM(
              CASE
                WHEN "status" IN (2, 3, 4, 5) THEN COALESCE("cod", 0)
                ELSE 0
              END
            ),
            0
          )::numeric AS total_amount
        FROM "pos_orders"
        ${whereClause}
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(COALESCE("tags", '[]'::jsonb)) AS elem
          WHERE LOWER(elem->>'name') = 'repurchase'
        )
        GROUP BY "shopId"
        ORDER BY "shopId" ASC
      `),
    ]);

    const l1Map = new Map<string, { name: string; value: number; children: Map<string, { name: string; value: number; children: Map<string, { name: string; value: number }> }> }>();
    let total = 0;

    for (const row of rows) {
      const l1 = (row.l1 as string) || '';
      const l2 = (row.l2 as string) || '';
      const l3 = (row.l3 as string) || '';
      const count = this.toNumber(row.count);
      if (!l1 || !l2 || !l3 || count <= 0) continue;

      total += count;
      if (!l1Map.has(l1)) {
        l1Map.set(l1, { name: this.toReasonLabel(l1), value: 0, children: new Map() });
      }
      const l1Node = l1Map.get(l1)!;
      l1Node.value += count;

      if (!l1Node.children.has(l2)) {
        l1Node.children.set(l2, { name: this.toReasonLabel(l2), value: 0, children: new Map() });
      }
      const l2Node = l1Node.children.get(l2)!;
      l2Node.value += count;

      if (!l2Node.children.has(l3)) {
        l2Node.children.set(l3, { name: this.toReasonLabel(l3), value: 0 });
      }
      const l3Node = l2Node.children.get(l3)!;
      l3Node.value += count;
    }

    const data = Array.from(l1Map.values()).map((l1Node) => ({
      name: l1Node.name,
      value: l1Node.value,
      children: Array.from(l1Node.children.values()).map((l2Node) => ({
        name: l2Node.name,
        value: l2Node.value,
        children: Array.from(l2Node.children.values()).map((l3Node) => ({
          name: l3Node.name,
          value: l3Node.value,
        })),
      })),
    }));

    const shopScopeWhere = applySalesAssigneeFilters([
      Prisma.sql`"tenantId" = ${tenantId}::uuid`,
      Prisma.sql`"status" IS DISTINCT FROM 7`,
      Prisma.sql`"isVoid" IS DISTINCT FROM true`,
      ...(Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0
        ? [Prisma.sql`"teamId" IN (${Prisma.join(effectiveTeamIds.map((id) => Prisma.sql`${id}::uuid`))})`]
        : []),
    ]);
    const shopRows = await this.prisma.$queryRaw<{ shopId: string }[]>(Prisma.sql`
      SELECT DISTINCT "shopId"
      FROM "pos_orders"
      WHERE ${Prisma.join(shopScopeWhere, ' AND ')}
        AND (
          ("dateLocal" >= ${startStr} AND "dateLocal" <= ${endStr})
          OR (
            "deliveredAt" IS NOT NULL
            AND "deliveredAt" >= ${deliveredRangeStartUtc}
            AND "deliveredAt" < ${deliveredRangeEndUtcExclusive}
          )
        )
      ORDER BY "shopId"
    `);
    const shopIdsList = shopRows.map((r) => r.shopId).filter(Boolean);
    const shopDisplayMap: Record<string, string> = {};

    if (shopIdsList.length > 0) {
      const storeWhere: Prisma.PosStoreWhereInput = {
        tenantId,
        shopId: { in: shopIdsList },
      };
      if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
        storeWhere.teamId = { in: effectiveTeamIds };
      }
      const stores = await this.prisma.posStore.findMany({
        where: storeWhere,
        select: { shopId: true, shopName: true, name: true },
      });
      stores.forEach((store) => {
        const display = store.shopName || store.name || store.shopId;
        if (display) {
          shopDisplayMap[store.shopId] = display;
        }
      });
    }

    const lastUpdatedRows = await this.prisma.$queryRaw<{ last_updated: string | null }[]>(Prisma.sql`
      SELECT MAX("updatedAt")::text AS last_updated
      FROM "pos_orders"
      WHERE ${Prisma.join(chartWhere, ' AND ')}
    `);
    const lastUpdatedAt = lastUpdatedRows?.[0]?.last_updated ?? null;
    const undeliverableSummary = undeliverableSummaryRows?.[0] || {};
    const onDeliverySummary = onDeliverySummaryRows?.[0] || {};
    const deliveredInRangeSummary = deliveredInRangeSummaryRows?.[0] || {};
    const returnedInRangeSummary = returnedInRangeSummaryRows?.[0] || {};
    const riskRowsMap = new Map<
      string,
      {
        confirmedCount: number;
        restockingCount: number;
        waitingForPickupCount: number;
        shippedCount: number;
        deliveredCount: number;
        rtsCount: number;
      }
    >();
    (riskConfirmationRawRows || []).forEach((row) => {
      const label = (row?.risk_tag || '').toString().trim();
      if (!label) return;
      riskRowsMap.set(label, {
        confirmedCount: this.toNumber(row?.confirmed_count),
        restockingCount: this.toNumber(row?.restocking_count),
        waitingForPickupCount: this.toNumber(row?.waiting_for_pickup_count),
        shippedCount: this.toNumber(row?.shipped_count),
        deliveredCount: this.toNumber(row?.delivered_count),
        rtsCount: this.toNumber(row?.rts_count),
      });
    });
    const riskConfirmationRows = RISK_CONFIRMATION_GROUPS.map((riskTag) => ({
      riskTag,
      confirmedCount: riskRowsMap.get(riskTag)?.confirmedCount ?? 0,
      restockingCount: riskRowsMap.get(riskTag)?.restockingCount ?? 0,
      waitingForPickupCount: riskRowsMap.get(riskTag)?.waitingForPickupCount ?? 0,
      shippedCount: riskRowsMap.get(riskTag)?.shippedCount ?? 0,
      deliveredCount: riskRowsMap.get(riskTag)?.deliveredCount ?? 0,
      rtsCount: riskRowsMap.get(riskTag)?.rtsCount ?? 0,
    }));

    const response = {
      data,
      total,
      trend: (trendRows || []).map((row) => ({
        date: (row.date || '').toString(),
        delivered_count: this.toNumber(row.delivered_count),
        rts_count: this.toNumber(row.rts_count),
      })),
      undeliverableAllTime: {
        count: this.toNumber(undeliverableSummary.count),
        totalCod: this.toNumber(undeliverableSummary.total_cod),
      },
      undeliverableTrend: (undeliverableTrendRows || []).map((row) => ({
        date: (row.date || '').toString(),
        count: this.toNumber(row.count),
      })),
      onDeliveryAllTime: {
        count: this.toNumber(onDeliverySummary.count),
        totalCod: this.toNumber(onDeliverySummary.total_cod),
      },
      onDeliveryTrend: (onDeliveryTrendRows || []).map((row) => ({
        date: (row.date || '').toString(),
        count: this.toNumber(row.count),
      })),
      deliveredInRange: {
        count: this.toNumber(deliveredInRangeSummary.count),
        totalCod: this.toNumber(deliveredInRangeSummary.total_cod),
      },
      deliveredInRangeTrend: (deliveredInRangeTrendRows || []).map((row) => ({
        date: (row.date || '').toString(),
        count: this.toNumber(row.count),
      })),
      returnedInRange: {
        count: this.toNumber(returnedInRangeSummary.count),
        totalCod: this.toNumber(returnedInRangeSummary.total_cod),
      },
      returnedInRangeTrend: (returnedInRangeTrendRows || []).map((row) => ({
        date: (row.date || '').toString(),
        count: this.toNumber(row.count),
      })),
      riskConfirmationRows,
      repurchaseByShop: (repurchaseByShopRows || []).map((row) => ({
        shopId: (row.shopId || '').toString(),
        deliveredOrders: this.toNumber(row.delivered_orders),
        deliveredAmount: this.toNumber(row.delivered_amount),
        rtsOrders: this.toNumber(row.rts_orders),
        rtsAmount: this.toNumber(row.rts_amount),
        shippedOrders: this.toNumber(row.shipped_orders),
        shippedAmount: this.toNumber(row.shipped_amount),
        totalOrders: this.toNumber(row.total_orders),
        totalAmount: this.toNumber(row.total_amount),
      })),
      filters: {
        shops: shopIdsList,
        shopDisplayMap,
      },
      selected: {
        start_date: startStr,
        end_date: endStr,
        shop_ids: normalizedShopIds,
        sales_assignee: normalizedSalesAssignee,
      },
      lastUpdatedAt,
    };

    await this.analyticsCache.set(cacheKey, response);
    return response;
  }

  async deletePosOrdersInRange(startDate?: string, endDate?: string) {
    const startStr = (startDate && startDate.trim()) || dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
    const endStr = (endDate && endDate.trim()) || startStr;

    if (!dayjs(startStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid start_date format. Expected YYYY-MM-DD');
    }
    if (!dayjs(endStr, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Invalid end_date format. Expected YYYY-MM-DD');
    }
    if (endStr < startStr) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }

    const { tenantId } = await this.teamContext.getContext();
    const effectiveTeamIds = await this.teamContext.getAnalyticsTeamIds('sales');

    if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length === 0) {
      return { deletedCount: 0, start_date: startStr, end_date: endStr };
    }

    const where: Prisma.PosOrderWhereInput = {
      tenantId,
      dateLocal: {
        gte: startStr,
        lte: endStr,
      },
    };

    if (Array.isArray(effectiveTeamIds) && effectiveTeamIds.length > 0) {
      where.teamId = { in: effectiveTeamIds };
    }

    const result = await this.prisma.posOrder.deleteMany({ where });
    await this.analyticsCache.bumpVersion(tenantId);
    this.logger.warn(`Deleted ${result.count} pos_orders for ${tenantId} (${startStr} -> ${endStr})`);

    return { deletedCount: result.count, start_date: startStr, end_date: endStr };
  }
}
