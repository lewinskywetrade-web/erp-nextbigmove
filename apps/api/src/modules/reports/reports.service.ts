import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../../common/prisma/prisma.service';

dayjs.extend(utc);
dayjs.extend(timezone);

const TIMEZONE = process.env.NEXT_PUBLIC_TIMEZONE || process.env.TIMEZONE || 'Asia/Manila';

type GetPosOrdersReportParams = {
  startDate?: string;
  endDate?: string;
};

type PosOrdersReportRow = {
  shopId: string;
  totalOrders: number;
  newOrders: number;
  confirmedOrders: number;
  waitingPickupOrders: number;
  waitPrintOrders: number;
  printedOrders: number;
  shippedOrders: number;
  deliveredOrders: number;
  cancelledOrders: number;
  returningOrders: number;
  returnedOrders: number;
  restockingOrders: number;
  inProcessOrders: number;
  totalRevenue: number;
  newRevenue: number;
  confirmedRevenue: number;
  waitingPickupRevenue: number;
  waitPrintRevenue: number;
  printedRevenue: number;
  shippedRevenue: number;
  deliveredRevenue: number;
  cancelledRevenue: number;
  returningRevenue: number;
  returnedRevenue: number;
  restockingRevenue: number;
  inProcessRevenue: number;
};

@Injectable()
export class ReportsService {
  private readonly inProcessStatuses = [0, 1, 9, 12, 13];

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  private getTenantId(): string {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  private getTodayDateLocal(): string {
    return dayjs().tz(TIMEZONE).format('YYYY-MM-DD');
  }

  private normalizeDateValue(value: string | undefined, fallback: string): string {
    const candidate = value?.trim() || fallback;
    if (!dayjs(candidate, 'YYYY-MM-DD', true).isValid()) {
      throw new BadRequestException('Date filters must use YYYY-MM-DD format');
    }
    return candidate;
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private toRate(numerator: number, denominator: number): number {
    if (denominator <= 0) return 0;
    return numerator / denominator;
  }

  async getPosOrdersSummary(params: GetPosOrdersReportParams) {
    const tenantId = this.getTenantId();
    const today = this.getTodayDateLocal();
    const startDate = this.normalizeDateValue(params.startDate, today);
    const endDate = this.normalizeDateValue(params.endDate, today);

    if (endDate < startDate) {
      throw new BadRequestException('start_date must be before or equal to end_date');
    }

    const rows = await this.prisma.$queryRaw<PosOrdersReportRow[]>(Prisma.sql`
      SELECT
        "shopId" AS "shopId",
        COUNT(*) FILTER (WHERE "status" IS DISTINCT FROM 7)::int AS "totalOrders",
        COUNT(*) FILTER (WHERE "status" = 0)::int AS "newOrders",
        COUNT(*) FILTER (WHERE "status" = 1)::int AS "confirmedOrders",
        COUNT(*) FILTER (WHERE "status" = 9)::int AS "waitingPickupOrders",
        COUNT(*) FILTER (WHERE "status" = 12)::int AS "waitPrintOrders",
        COUNT(*) FILTER (WHERE "status" = 13)::int AS "printedOrders",
        COUNT(*) FILTER (WHERE "status" = 2)::int AS "shippedOrders",
        COUNT(*) FILTER (WHERE "status" = 3)::int AS "deliveredOrders",
        COUNT(*) FILTER (WHERE "status" = 6)::int AS "cancelledOrders",
        COUNT(*) FILTER (WHERE "status" = 4)::int AS "returningOrders",
        COUNT(*) FILTER (WHERE "status" = 5)::int AS "returnedOrders",
        COUNT(*) FILTER (WHERE "status" = 11)::int AS "restockingOrders",
        COUNT(*) FILTER (WHERE "status" IN (${Prisma.join(this.inProcessStatuses)}))::int AS "inProcessOrders",
        COALESCE(SUM(COALESCE("cod", 0)::double precision) FILTER (WHERE "status" IS DISTINCT FROM 7), 0)::double precision AS "totalRevenue",
        COALESCE(SUM(CASE WHEN "status" = 0 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "newRevenue",
        COALESCE(SUM(CASE WHEN "status" = 1 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "confirmedRevenue",
        COALESCE(SUM(CASE WHEN "status" = 9 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "waitingPickupRevenue",
        COALESCE(SUM(CASE WHEN "status" = 12 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "waitPrintRevenue",
        COALESCE(SUM(CASE WHEN "status" = 13 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "printedRevenue",
        COALESCE(SUM(CASE WHEN "status" = 2 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "shippedRevenue",
        COALESCE(SUM(CASE WHEN "status" = 3 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "deliveredRevenue",
        COALESCE(SUM(CASE WHEN "status" = 6 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "cancelledRevenue",
        COALESCE(SUM(CASE WHEN "status" = 4 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "returningRevenue",
        COALESCE(SUM(CASE WHEN "status" = 5 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "returnedRevenue",
        COALESCE(SUM(CASE WHEN "status" = 11 THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "restockingRevenue",
        COALESCE(SUM(CASE WHEN "status" IN (${Prisma.join(this.inProcessStatuses)}) THEN COALESCE("cod", 0)::double precision ELSE 0 END), 0)::double precision AS "inProcessRevenue"
      FROM "pos_orders" po
      WHERE po."tenantId" = ${tenantId}::uuid
        AND po."dateLocal" >= ${startDate}
        AND po."dateLocal" <= ${endDate}
        AND po."status" IS DISTINCT FROM 7
        AND po."isVoid" IS DISTINCT FROM true
        AND EXISTS (
          SELECT 1
          FROM "pos_stores" ps
          WHERE ps."tenantId" = po."tenantId"
            AND ps."shopId" = po."shopId"
            AND ps."status" = 'ACTIVE'
            AND COALESCE(ps."enabled", true) = true
        )
      GROUP BY po."shopId"
      ORDER BY COUNT(*) DESC, po."shopId" ASC
    `);

    const shopIds = rows.map((row) => row.shopId).filter((row) => row.length > 0);
    const stores = shopIds.length
      ? await this.prisma.posStore.findMany({
          where: {
            tenantId,
            shopId: { in: shopIds },
            status: 'ACTIVE',
            OR: [{ enabled: true }, { enabled: null }],
          },
          select: {
            shopId: true,
            shopName: true,
            name: true,
            updatedAt: true,
          },
          orderBy: [{ shopId: 'asc' }, { updatedAt: 'desc' }],
        })
      : [];

    const storeNameByShopId = new Map<string, string>();
    for (const store of stores) {
      if (storeNameByShopId.has(store.shopId)) continue;
      const displayName = store.shopName?.trim() || store.name?.trim() || store.shopId;
      storeNameByShopId.set(store.shopId, displayName);
    }

    const items = rows.map((row) => {
      const totalOrders = this.toNumber(row.totalOrders);
      const newOrders = this.toNumber(row.newOrders);
      const confirmedOrders = this.toNumber(row.confirmedOrders);
      const waitingPickupOrders = this.toNumber(row.waitingPickupOrders);
      const waitPrintOrders = this.toNumber(row.waitPrintOrders);
      const printedOrders = this.toNumber(row.printedOrders);
      const shippedOrders = this.toNumber(row.shippedOrders);
      const deliveredOrders = this.toNumber(row.deliveredOrders);
      const cancelledOrders = this.toNumber(row.cancelledOrders);
      const returningOrders = this.toNumber(row.returningOrders);
      const returnedOrders = this.toNumber(row.returnedOrders);
      const restockingOrders = this.toNumber(row.restockingOrders);
      const inProcessOrders = this.toNumber(row.inProcessOrders);
      const pendingOrders = restockingOrders + inProcessOrders;
      const rtsOrders = returningOrders + returnedOrders;

      return {
        shop_id: row.shopId,
        pos_store_name: storeNameByShopId.get(row.shopId) || row.shopId,
        qty: {
          all_orders: totalOrders,
          new_orders: newOrders,
          confirmed: confirmedOrders,
          waiting_pickup: waitingPickupOrders,
          wait_print: waitPrintOrders,
          printed: printedOrders,
          shipped: shippedOrders,
          delivered: deliveredOrders,
          cancelled: cancelledOrders,
          returning: returningOrders,
          returned: returnedOrders,
          restocking: restockingOrders,
          in_process: inProcessOrders,
          rts_rate: this.toRate(rtsOrders, deliveredOrders + rtsOrders),
          pending_rate: this.toRate(pendingOrders, totalOrders),
          cancellation_rate: this.toRate(cancelledOrders, totalOrders),
        },
        revenue: {
          all_orders: this.toNumber(row.totalRevenue),
          new_orders: this.toNumber(row.newRevenue),
          confirmed: this.toNumber(row.confirmedRevenue),
          waiting_pickup: this.toNumber(row.waitingPickupRevenue),
          wait_print: this.toNumber(row.waitPrintRevenue),
          printed: this.toNumber(row.printedRevenue),
          shipped: this.toNumber(row.shippedRevenue),
          delivered: this.toNumber(row.deliveredRevenue),
          cancelled: this.toNumber(row.cancelledRevenue),
          returning: this.toNumber(row.returningRevenue),
          returned: this.toNumber(row.returnedRevenue),
          restocking: this.toNumber(row.restockingRevenue),
          in_process: this.toNumber(row.inProcessRevenue),
        },
      };
    });

    return {
      items,
      row_count: items.length,
      selected: {
        start_date: startDate,
        end_date: endDate,
      },
      generated_at: new Date().toISOString(),
    };
  }
}
