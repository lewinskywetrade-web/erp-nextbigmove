import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, WmsFulfillmentOrderStatus, WmsInventoryUnitStatus } from '@prisma/client';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { GetCeoDashboardQueryDto } from '../dto/get-ceo-dashboard-query.dto';
import {
  cancelTone,
  computeBreakevenCpp,
  computeMargin,
  computeSafetyMargin,
  financeTone,
  oneInN,
  repeatTone,
  resolvedRates,
  round,
  runIntegrityChecks,
  safeRatio,
} from '../utils/ceo-economics';

dayjs.extend(utc);
dayjs.extend(timezone);

const MANILA_TZ = 'Asia/Manila';
/** A repeat order must follow a delivered first order by at least this long. */
const REPEAT_GAP_DAYS = 10;
/** Pancake status codes. */
/** POS order statuses. 4 is travelling back, 5 has already arrived. */
const STATUS = { delivered: 3, returning: 4, returned: 5, cancelled: 6, deleted: 7, shipped: 2 } as const;

const toNumber = (value: Prisma.Decimal | number | null | undefined) => Number(value ?? 0);

/**
 * The CEO dashboard: the only screen that answers "is the business making
 * money?". Built as an argument, not a metrics dump — where you stand, the
 * three ways a business fails, what physically moved, what to fix.
 *
 * Every figure counts an order on the day it was PLACED, so a campaign is
 * judged by what it bought. Reports uses the opposite lens (the day things
 * happened); the two answer different questions rather than disagreeing.
 *
 * Economics come from reconciled actuals rather than owner-entered settings,
 * so these numbers can never drift from what Reports shows.
 */
@Injectable()
export class CeoDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(tenantId: string, query: GetCeoDashboardQueryDto) {
    const range = this.resolveDateRange(query.startDate, query.endDate);
    const where: Prisma.ReconcileMarketingWhereInput = {
      tenantId,
      date: { gte: range.start, lte: range.end },
      ...(query.accountId ? { accountId: query.accountId } : {}),
      // `shops` is the set of shops an ad's matched orders landed in. Rows that
      // matched no orders carry an empty array and are excluded by this filter,
      // which is correct: unattributed spend cannot be claimed by a store.
      // array_contains tests one value at a time, so a multi-store selection is
      // a union rather than a single predicate.
      ...(query.shopIds?.length
        ? { OR: query.shopIds.map((shopId) => ({ shops: { array_contains: [shopId] } })) }
        : {}),
    };

    const [totals, trendRows, freshness, accounts, retention, stores] = await Promise.all([
      this.prisma.reconcileMarketing.aggregate({
        where,
        _sum: {
          spend: true, purchasesPos: true, codPos: true,
          deliveredCount: true, canceledCount: true, rtsCount: true, shippedCount: true,
          deliveredCodPos: true, canceledCodPos: true, rtsCodPos: true, shippedCodPos: true,
          unconfirmedCodPos: true, confirmedCodPos: true, waitingPickupCodPos: true, restockingCodPos: true,
          cogsDeliveredPos: true, sfSdrPos: true, ffSdrPos: true, ifSdrPos: true, codFeeDeliveredPos: true,
        },
      }),
      this.loadTrend(where, range),
      this.loadFreshness(tenantId),
      this.prisma.metaAdAccount.findMany({
        where: { tenantId }, select: { accountId: true, name: true }, orderBy: { name: 'asc' },
      }),
      this.loadRetention(tenantId, range),
      this.loadStoreOptions(tenantId, range),
    ]);

    const sums = totals._sum;
    const rawOrders = sums.purchasesPos ?? 0;
    const counts = {
      delivered: sums.deliveredCount ?? 0,
      cancelled: sums.canceledCount ?? 0,
      rts: sums.rtsCount ?? 0,
    };
    const rates = resolvedRates(counts);

    const adSpend = toNumber(sums.spend);
    const orderValue = toNumber(sums.codPos);
    const deliveredValue = toNumber(sums.deliveredCodPos);
    const cancelledValue = toNumber(sums.canceledCodPos);
    const rtsValue = toNumber(sums.rtsCodPos);
    const shippedValue = toNumber(sums.shippedCodPos);
    const deliveredCogs = toNumber(sums.cogsDeliveredPos);
    const fulfillmentCost = toNumber(sums.sfSdrPos) + toNumber(sums.ffSdrPos)
      + toNumber(sums.ifSdrPos) + toNumber(sums.codFeeDeliveredPos);

    const deliveredUnits = await this.loadDeliveredUnits(tenantId, range, query.shopIds);
    const rangeDays = Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000));
    const stock = await this.loadStockAndSupply(
      tenantId,
      deliveredUnits > 0 ? deliveredUnits / rangeDays : null,
      deliveredUnits,
      query.shopIds,
    );
    const margin = computeMargin({
      deliveredValue,
      deliveredOrders: counts.delivered,
      deliveredUnits,
      deliveredCogs,
      fulfillmentCost,
    });
    const rtsCostPerOrder = safeRatio(rtsValue, counts.rts);
    const breakevenCpp = computeBreakevenCpp({
      margin: margin.margin,
      deliveryRate: rates.deliveryRate,
      rtsRate: rates.rtsRate,
      rtsCostPerOrder,
    });
    const safety = computeSafetyMargin(adSpend, rawOrders, breakevenCpp);

    // CAC is per DELIVERED customer: an order that cancels bought nothing.
    const cac = safeRatio(adSpend, counts.delivered);
    const ltv = margin.margin !== null && retention.ordersPerCustomer !== null
      ? margin.margin * retention.ordersPerCustomer
      : null;
    const ltvCac = ltv !== null && cac !== null && cac > 0 ? ltv / cac : null;

    const inFlight = Math.max(0, rawOrders - rates.resolvedBase - (sums.shippedCount ?? 0));
    const explicitInProcessValue =
      toNumber(sums.unconfirmedCodPos) +
      toNumber(sums.confirmedCodPos) +
      toNumber(sums.waitingPickupCodPos) +
      toNumber(sums.restockingCodPos);
    const settledAndShippedValue = deliveredValue + cancelledValue + rtsValue + shippedValue;
    const inProcessValue = Math.max(
      explicitInProcessValue,
      Math.max(0, orderValue - settledAndShippedValue),
    );
    const bucketValueSum = settledAndShippedValue + inProcessValue;

    const integrity = runIntegrityChecks({
      counts, rates, rawOrders, bucketValueSum, totalOrderValue: orderValue,
    });

    return {
      selected: { startDate: range.startKey, endDate: range.endKey, accountId: query.accountId ?? '', shopIds: query.shopIds ?? [] },
      filters: {
        accounts: accounts.map((a) => ({ value: a.accountId, label: a.name })),
        stores: stores.options,
      },
      freshness,
      integrity: {
        checks: integrity,
        passed: integrity.every((check) => check.passed),
      },
      trend: trendRows,
      headline: {
        orderAmount: { value: round(orderValue), count: rawOrders, sparkKey: 'orderValue' },
        inTransitAmount: { value: round(shippedValue), count: sums.shippedCount ?? 0, sparkKey: 'inTransitValue' },
        deliveredAmount: { value: round(deliveredValue), count: counts.delivered, sparkKey: 'deliveredValue' },
        adSpend: {
          value: round(adSpend),
          // Per-day pace over the days actually covered by the range.
          perDay: round(adSpend / Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000))),
          sparkKey: 'spend',
        },
        rtsRate: {
          // Measured on units that SHIPPED (delivered + returned) — cancelled
          // orders never left the warehouse, so they are excluded here. The
          // break-even RTS rate uses the resolved base instead, on purpose.
          value: safeRatio(counts.rts, counts.delivered + counts.rts),
          numerator: counts.rts,
          denominator: counts.delivered + counts.rts,
          sparkKey: 'rtsValue',
        },
      },
      stock,
      health: this.buildHealth(safety, rates),
      safetyMargin: {
        headroom: safety.headroom === null ? null : round(safety.headroom, 2),
        cpp: safety.cpp === null ? null : round(safety.cpp),
        breakevenCpp: breakevenCpp === null ? null : round(breakevenCpp),
        netPerOrder: safety.netPerOrder === null ? null : round(safety.netPerOrder),
        tone: safety.tone,
        /** Bar tops out at 4×: beyond that the exact number changes no decision. */
        markerPosition: safety.headroom === null ? null : round(Math.min(safety.headroom / 4, 1), 4),
        fill: safety.cpp !== null && breakevenCpp !== null && breakevenCpp > 0
          ? round(Math.min(safety.cpp / breakevenCpp, 1), 4)
          : null,
      },
      stories: this.buildStories({ cac, counts, rates, retention, ltv, ltvCac, safety, breakevenCpp }),
      shippedVolume: {
        shippedOrders: counts.delivered + counts.rts + (sums.shippedCount ?? 0),
        shippedValue: round(deliveredValue + rtsValue + shippedValue),
        deliveredOrders: counts.delivered,
        deliveredValue: round(deliveredValue),
        deliveredUnits,
        rtsOrders: counts.rts,
        rtsValue: round(rtsValue),
      },
      lossBar: this.buildLossBar({
        counts, rawOrders, inFlight,
        shippedCount: sums.shippedCount ?? 0,
        deliveredValue, cancelledValue, rtsValue, shippedValue, inProcessValue, orderValue,
      }),
      retention: retention.curve,
      firstMove: this.buildFirstMove({
        counts, rates, deliveredValue, cancelledValue, safety, margin,
      }),
      breakdown: {
        adSpend: round(adSpend),
        orderValue: round(orderValue),
        deliveredValue: round(deliveredValue),
        cancelledValue: round(cancelledValue),
        rtsValue: round(rtsValue),
        deliveredCogs: round(deliveredCogs),
        fulfillmentCost: round(fulfillmentCost),
        deliveredAov: margin.deliveredAov === null ? null : round(margin.deliveredAov),
        cancelledAov: safeRatio(cancelledValue, counts.cancelled) === null
          ? null : round(safeRatio(cancelledValue, counts.cancelled) as number),
        unitsPerOrder: round(margin.unitsPerOrder, 2),
        cogsPerUnit: margin.cogsPerUnit === null ? null : round(margin.cogsPerUnit),
        fulfillmentPerParcel: margin.fulfillmentPerParcel === null ? null : round(margin.fulfillmentPerParcel),
        marginPerDeliveredOrder: margin.margin === null ? null : round(margin.margin),
        rtsCostPerOrder: rtsCostPerOrder === null ? null : round(rtsCostPerOrder),
        rawOrders,
        resolvedBase: rates.resolvedBase,
        inFlight,
        deliveryRate: rates.deliveryRate,
        cancelRate: rates.cancelRate,
        rtsRate: rates.rtsRate,
        contributionAfterAds: margin.margin === null ? null
          : round(margin.margin * counts.delivered - adSpend),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  private buildHealth(safety: ReturnType<typeof computeSafetyMargin>, rates: ReturnType<typeof resolvedRates>) {
    if (safety.headroom === null) {
      return {
        tone: 'unknown' as const,
        message: 'Not enough delivered orders yet to tell whether the model pays for itself.',
      };
    }
    if (safety.headroom < 1) {
      return {
        tone: 'critical' as const,
        message: `Every order is losing money: you are paying ₱${Math.round(safety.cpp as number).toLocaleString('en-PH')} to acquire an order that can only afford ₱${Math.round(safety.breakevenCpp as number).toLocaleString('en-PH')}.`,
      };
    }
    if (safety.headroom <= 2) {
      return {
        tone: 'warning' as const,
        message: `The model pays for itself, but only just — ${safety.headroom.toFixed(2)}× cover over break-even. Trim cost before scaling.`,
      };
    }
    return {
      tone: 'healthy' as const,
      message: `Each order can afford ${safety.headroom.toFixed(2)}× what it costs to acquire${rates.deliveryRate !== null ? `, at a ${(rates.deliveryRate * 100).toFixed(1)}% delivery rate` : ''}. There is room to scale.`,
    };
  }

  /** Hero number + three stats + a sentence that writes its own conclusion. */
  private buildStories(input: {
    cac: number | null;
    counts: { delivered: number; cancelled: number; rts: number };
    rates: ReturnType<typeof resolvedRates>;
    retention: { repeatRate: number | null; ordersPerCustomer: number | null; curve: unknown };
    ltv: number | null;
    ltvCac: number | null;
    safety: ReturnType<typeof computeSafetyMargin>;
    breakevenCpp: number | null;
  }) {
    const { cac, counts, rates, retention, ltv, ltvCac, safety, breakevenCpp } = input;
    const peso = (value: number | null) => value === null ? '—' : `₱${Math.round(value).toLocaleString('en-PH')}`;
    const pct = (value: number | null, digits = 1) => value === null ? '—' : `${(value * 100).toFixed(digits)}%`;

    const cancelsPerN = oneInN(rates.cancelRate);
    const acquisitionTone = cancelTone(rates.cancelRate);
    const retentionTone = repeatTone(retention.repeatRate);
    const finTone = financeTone(safety.netPerOrder, ltvCac);

    return {
      acquisition: {
        tone: acquisitionTone,
        hero: { label: 'Cost per delivered customer (CAC)', value: cac === null ? null : round(cac) },
        stats: [
          { label: 'Cost / order', value: safety.cpp === null ? null : round(safety.cpp), format: 'currency' as const },
          { label: 'New delivered', value: counts.delivered, format: 'count' as const },
          { label: 'Cancel rate', value: rates.cancelRate, format: 'percent' as const },
        ],
        sentence: acquisitionTone === 'healthy' || cancelsPerN === null
          ? `You pay ${peso(cac)} to land a delivered customer. Keep cancels low to hold this down.`
          : `About 1 in ${cancelsPerN} orders cancels before you ship it. Every cancel makes each delivered customer cost more than the ${peso(safety.cpp)} you paid per order.`,
      },
      retention: {
        tone: retentionTone,
        hero: { label: 'Repeat-purchase rate', value: retention.repeatRate },
        stats: [
          { label: 'LTV (contribution)', value: ltv === null ? null : round(ltv), format: 'currency' as const },
          { label: 'Avg orders / customer', value: retention.ordersPerCustomer, format: 'decimal' as const },
          { label: 'Delivered customers', value: counts.delivered, format: 'count' as const },
        ],
        sentence: retentionTone === 'critical'
          ? `Only ${pct(retention.repeatRate)} of customers ever re-order. Growth is running entirely on new ads — a repeat base would compound every peso you spend.`
          : `Returning customers are worth ${peso(ltv)} in lifetime contribution.`,
      },
      finance: {
        tone: finTone,
        hero: { label: 'Profit left per order', value: safety.netPerOrder === null ? null : round(safety.netPerOrder) },
        stats: [
          { label: 'LTV : CAC', value: ltvCac === null ? null : round(ltvCac, 2), format: 'multiple' as const },
          { label: 'Delivery rate', value: rates.deliveryRate, format: 'percent' as const },
          { label: 'Break-even CPP', value: breakevenCpp === null ? null : round(breakevenCpp), format: 'currency' as const },
        ],
        sentence: safety.netPerOrder === null
          ? 'Not enough delivered orders yet to say whether the model pays for itself.'
          : safety.netPerOrder > 0
            ? `You keep ${peso(safety.netPerOrder)} per order after ad cost, at an LTV:CAC of ${ltvCac === null ? '—' : `${ltvCac.toFixed(2)}×`} (${ltvCac !== null && ltvCac >= 3 ? 'healthy' : 'below the 3× mark'}).`
            : `You lose ${peso(Math.abs(safety.netPerOrder))} on every order after ad cost — the model isn't paying for itself yet. Start with the priority below.`,
      },
    };
  }

  /**
   * Cancelled and returned are different losses: a cancel costs the sale but no
   * freight, a return costs freight twice and the goods come back sellable.
   */
  private buildLossBar(input: {
    counts: { delivered: number; cancelled: number; rts: number };
    rawOrders: number; inFlight: number; shippedCount: number;
    deliveredValue: number; cancelledValue: number; rtsValue: number; shippedValue: number; inProcessValue: number; orderValue: number;
  }) {
    const { counts, rawOrders, inFlight, shippedCount, deliveredValue, cancelledValue, rtsValue, shippedValue, inProcessValue, orderValue } = input;
    const share = (count: number) => rawOrders > 0 ? round(count / rawOrders, 4) : null;
    return {
      totalOrders: rawOrders,
      totalValue: round(orderValue),
      inFlightOrders: inFlight + shippedCount,
      segments: [
        { key: 'DELIVERED', label: 'Delivered', count: counts.delivered, share: share(counts.delivered), value: round(deliveredValue), note: 'cash collected' },
        { key: 'CANCELLED', label: 'Cancelled', count: counts.cancelled, share: share(counts.cancelled), value: round(cancelledValue), note: 'lost at confirmation, never shipped' },
        { key: 'RTS', label: 'RTS / Returned', count: counts.rts, share: share(counts.rts), value: round(rtsValue), note: 'shipped then bounced — freight paid twice' },
        { key: 'SHIPPED', label: 'In transit', count: shippedCount, share: share(shippedCount), value: round(shippedValue), note: 'out for delivery' },
        { key: 'IN_PROCESS', label: 'In process', count: inFlight, share: share(inFlight), value: round(inProcessValue), note: 'placed, not yet dispatched' },
      ],
    };
  }

  /**
   * The fallback leak worth porting on its own: when the average cancelled
   * order is larger than the average delivered one, the business is losing its
   * most valuable carts — invisible in any single rate.
   */
  private buildFirstMove(input: {
    counts: { delivered: number; cancelled: number; rts: number };
    rates: ReturnType<typeof resolvedRates>;
    deliveredValue: number; cancelledValue: number;
    safety: ReturnType<typeof computeSafetyMargin>;
    margin: ReturnType<typeof computeMargin>;
  }) {
    const { counts, rates, deliveredValue, cancelledValue, safety } = input;
    const peso = (value: number) => `₱${Math.round(value).toLocaleString('en-PH')}`;
    const cancelledAov = safeRatio(cancelledValue, counts.cancelled);
    const deliveredAov = safeRatio(deliveredValue, counts.delivered);

    if (cancelledAov !== null && deliveredAov !== null && cancelledAov > deliveredAov) {
      return {
        leak: {
          title: 'Your biggest orders are dying before they ship',
          detail: `Cancelled orders average ${peso(cancelledAov)} — bigger than the ${peso(deliveredAov)} that actually get delivered. You are paying to acquire your best carts, then losing them at confirmation.`,
        },
        action: {
          title: 'Fix confirmation on high-value orders first',
          detail: 'Prioritise confirmation calls by cart value. The largest carts are the ones cancelling, so the same call effort recovers more money there than anywhere else.',
        },
      };
    }
    if (rates.cancelRate !== null && rates.cancelRate > 0.2) {
      const perN = oneInN(rates.cancelRate);
      return {
        leak: {
          title: 'Cancellations are the biggest leak',
          detail: `About 1 in ${perN} orders cancels before dispatch — ${peso(cancelledValue)} lost at confirmation this period.`,
        },
        action: {
          title: 'Tighten order confirmation',
          detail: 'Every cancel raises the cost of the customers you do deliver. Confirmation is cheaper to fix than acquisition.',
        },
      };
    }
    if (rates.rtsRate !== null && rates.rtsRate > 0.2) {
      return {
        leak: {
          title: 'Returns are eating the margin',
          detail: `${(rates.rtsRate * 100).toFixed(1)}% of resolved orders shipped and came back — freight paid twice on each.`,
        },
        action: {
          title: 'Screen risky deliveries before dispatch',
          detail: 'An RTS costs freight both ways. Filtering the riskiest addresses before dispatch protects margin without touching ad spend.',
        },
      };
    }
    if (safety.netPerOrder !== null && safety.netPerOrder <= 0) {
      return {
        leak: {
          title: 'Acquisition costs more than an order can afford',
          detail: `You pay ${peso(safety.cpp as number)} per order against a break-even of ${peso(safety.breakevenCpp as number)}.`,
        },
        action: {
          title: 'Cut spend on the ads above break-even',
          detail: 'Use Advertising → Performance to find the ads whose CPP sits above the ceiling, and trim those before scaling anything.',
        },
      };
    }
    return {
      leak: { title: 'No dominant leak in this period', detail: 'Outcomes are within their usual bands. The largest remaining gains are in retention rather than acquisition.' },
      action: { title: 'Build a reason to reorder', detail: 'With acquisition paying for itself, repeat purchase is where each additional peso of spend compounds.' },
    };
  }

  private async loadTrend(where: Prisma.ReconcileMarketingWhereInput, range: { startKey: string; endKey: string }) {
    const rows = await this.prisma.reconcileMarketing.groupBy({
      by: ['date'],
      where,
      _sum: {
        spend: true, codPos: true, deliveredCodPos: true, canceledCodPos: true,
        rtsCodPos: true, shippedCodPos: true, purchasesPos: true, deliveredCount: true,
        rtsCount: true,
      },
      orderBy: { date: 'asc' },
    });
    const byDate = new Map(rows.map((row) => [row.date.toISOString().slice(0, 10), row]));
    const labelFormatter = new Intl.DateTimeFormat('en-PH', { month: 'short', day: 'numeric', timeZone: MANILA_TZ });
    const points: Array<Record<string, string | number>> = [];
    for (let cursor = dayjs(range.startKey); !cursor.isAfter(dayjs(range.endKey), 'day'); cursor = cursor.add(1, 'day')) {
      const key = cursor.format('YYYY-MM-DD');
      const row = byDate.get(key);
      points.push({
        date: key,
        label: labelFormatter.format(new Date(`${key}T12:00:00.000Z`)),
        spend: round(toNumber(row?._sum.spend ?? 0)),
        orderValue: round(toNumber(row?._sum.codPos ?? 0)),
        deliveredValue: round(toNumber(row?._sum.deliveredCodPos ?? 0)),
        lostValue: round(toNumber(row?._sum.canceledCodPos ?? 0) + toNumber(row?._sum.rtsCodPos ?? 0)),
        cancelledValue: round(toNumber(row?._sum.canceledCodPos ?? 0)),
        rtsValue: round(toNumber(row?._sum.rtsCodPos ?? 0)),
        inTransitValue: round(toNumber(row?._sum.shippedCodPos ?? 0)),
        orders: row?._sum.purchasesPos ?? 0,
        deliveredOrders: row?._sum.deliveredCount ?? 0,
        rtsOrders: row?._sum.rtsCount ?? 0,
      });
    }
    return points;
  }

  /** Units inside delivered orders, for the per-unit cost of goods. */
  private async loadDeliveredUnits(
    tenantId: string,
    range: { startKey: string; endKey: string },
    shopIds?: string[],
  ) {
    const result = await this.prisma.posOrder.aggregate({
      where: {
        tenantId,
        ...(shopIds?.length ? { shopId: { in: shopIds } } : {}),
        dateLocal: { gte: range.startKey, lte: range.endKey },
        status: STATUS.delivered,
        isVoid: false,
      },
      _sum: { totalQuantity: true },
    });
    return result._sum.totalQuantity ?? 0;
  }

  /**
   * Repeat purchase requires a DELIVERED first order followed by another at
   * least 10 days later. Without that gate, a replacement for a failed
   * delivery files as loyalty.
   */
  private async loadRetention(tenantId: string, range: { startKey: string; endKey: string }) {
    const rows = await this.prisma.$queryRaw<Array<{ orders_per_customer: number | null; repeat_customers: bigint; delivered_customers: bigint; second: bigint; third_plus: bigint }>>`
      WITH delivered AS (
        SELECT "customerPhone" AS phone, MIN("insertedAt") AS first_delivered, COUNT(*) AS delivered_orders
          FROM "pos_orders"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "status" = ${STATUS.delivered}
           AND "isVoid" = false
           AND "customerPhone" IS NOT NULL
           AND "dateLocal" >= ${range.startKey}
           AND "dateLocal" <= ${range.endKey}
         GROUP BY "customerPhone"
      ),
      repeats AS (
        SELECT d.phone,
               COUNT(o.id) FILTER (
                 WHERE o."insertedAt" >= d.first_delivered + INTERVAL '${Prisma.raw(String(REPEAT_GAP_DAYS))} days'
               ) AS later_orders
          FROM delivered d
          LEFT JOIN "pos_orders" o
            ON o."tenantId" = ${tenantId}::uuid
           AND o."customerPhone" = d.phone
           AND o."isVoid" = false
           AND o."status" <> ${STATUS.deleted}
         GROUP BY d.phone
      )
      SELECT
        AVG(1 + later_orders)::float8 AS orders_per_customer,
        COUNT(*) FILTER (WHERE later_orders > 0) AS repeat_customers,
        COUNT(*) AS delivered_customers,
        COUNT(*) FILTER (WHERE later_orders = 1) AS second,
        COUNT(*) FILTER (WHERE later_orders > 1) AS third_plus
      FROM repeats
    `;
    const row = rows[0];
    const deliveredCustomers = Number(row?.delivered_customers ?? 0);
    const repeatCustomers = Number(row?.repeat_customers ?? 0);
    const second = Number(row?.second ?? 0);
    const thirdPlus = Number(row?.third_plus ?? 0);
    const repeatRate = safeRatio(repeatCustomers, deliveredCustomers);

    return {
      repeatRate,
      ordersPerCustomer: row?.orders_per_customer ?? null,
      curve: {
        deliveredCustomers,
        points: [
          { label: '1st order', share: deliveredCustomers > 0 ? 1 : null, customers: deliveredCustomers },
          { label: '2nd order', share: safeRatio(second + thirdPlus, deliveredCustomers), customers: second + thirdPlus },
          { label: '3rd+ order', share: safeRatio(thirdPlus, deliveredCustomers), customers: thirdPlus },
        ],
        gateDays: REPEAT_GAP_DAYS,
      },
    };
  }

  /**
   * Stock & supply, in units rather than pesos, following one item down the
   * line: on the shelf, promised to someone, riding with a courier, coming
   * back, sold.
   *
   * Deliberately NOT filtered by the selected date range — on-hand stock is a
   * running balance and "riding with a courier" is about now, not a period.
   */
  private async loadStockAndSupply(
    tenantId: string,
    averageUnitsShippedPerDay: number | null,
    deliveredUnits: number,
    shopIds?: string[],
  ) {
    // WMS rows carry a real storeId foreign key, so scoping is exact here —
    // unlike the reconciled money panels, which depend on ad-level attribution.
    const storeScope = shopIds?.length ? { store: { shopId: { in: shopIds } } } : {};
    const [grouped, soldAllTime] = await Promise.all([
      this.prisma.wmsInventoryUnit.groupBy({
        by: ['status'],
        where: { tenantId, ...storeScope },
        _count: { _all: true },
      }),
      // Units dispatched through the WMS. Delivery itself is confirmed in POS,
      // not in WMS (fulfilment orders stop at PACKED), so this counts what the
      // warehouse sent out and never came back.
      this.prisma.wmsInventoryUnit.count({
        where: { tenantId, status: WmsInventoryUnitStatus.DISPATCHED, ...storeScope },
      }),
    ]);
    const countOf = (...statuses: string[]) => grouped
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + row._count._all, 0);

    // Everything physically inside the building. PICKED and PACKED units have
    // been pulled for an order but have not left, so they are still warehouse
    // stock. EXPIRED/DAMAGED/LOST/DEADSTOCK are excluded: present, but not
    // sellable.
    const onHand = countOf('RECEIVED', 'PUTAWAY', 'PICKED', 'PACKED');
    const promised = countOf('RESERVED', 'PICKED', 'PACKED');
    // Units that left the building. A unit stays DISPATCHED in WMS even after
    // its order is delivered or returned — WMS is never told — so the POS order
    // status is what separates "still riding" from "already resolved".
    const inTransit = await this.countUnitsByOrderStatus(tenantId, [STATUS.shipped], shopIds);
    // Split rather than summed: 4 is still travelling back, 5 has arrived. They
    // answer different questions — one is money still at risk, the other is
    // stock to re-shelve — so the tile shows both instead of one blended number.
    const [returning, returned] = await Promise.all([
      this.countUnitsByOrderStatus(tenantId, [STATUS.returning], shopIds),
      this.countUnitsByOrderStatus(tenantId, [STATUS.returned], shopIds),
    ]);
    const unsellable = countOf('EXPIRED', 'DEADSTOCK', 'DAMAGED', 'LOST');

    // The tile that matters: when the shelf empties at the pace you ship.
    const daysOfCover = averageUnitsShippedPerDay !== null && averageUnitsShippedPerDay > 0
      ? round(onHand / averageUnitsShippedPerDay, 1)
      : null;

    // Staged units are in the building but not yet on a shelf, so they are the
    // stock arriving rather than stock you can pick. Purchase batches were the
    // previous source, but they measure supplier intent, not units present.
    const incoming = countOf('STAGED');

    return {
      available: grouped.length > 0,
      onHand,
      incoming,
      promised,
      inTransit,
      returning,
      returned,
      sold: deliveredUnits,
      dispatchedAllTime: soldAllTime,
      unsellable,
      daysOfCover,
      averageUnitsShippedPerDay: averageUnitsShippedPerDay === null ? null : round(averageUnitsShippedPerDay, 1),
    };
  }

  /** How long ago each feed last brought data in — not timestamps, currency. */
  /**
   * Stores this tenant can scope the dashboard to.
   *
   * Only active stores that actually carry reconciled orders are offered: a
   * store with nothing attributed to it would render an all-em-dash dashboard
   * and read as broken rather than empty.
   */
  private async loadStoreOptions(tenantId: string, range: { start: Date; end: Date }) {
    const stores = await this.prisma.posStore.findMany({
      where: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] },
      select: { shopId: true, shopName: true, name: true },
      orderBy: { shopName: 'asc' },
    });
    if (stores.length === 0) return { options: [] };

    // Scoped to the selected range: a store with nothing reconciled in this
    // window has no numbers to show, so offering it would only produce an
    // all-em-dash dashboard.
    const withData = await this.prisma.$queryRaw<Array<{ shop: string }>>`
      SELECT DISTINCT jsonb_array_elements_text(shops) AS shop
      FROM reconcile_marketing
      WHERE "tenantId" = ${tenantId}::uuid
        AND date >= ${range.start}
        AND date <= ${range.end}
    `;
    const attributed = new Set(withData.map((row) => row.shop));
    const usable = stores.filter((store) => attributed.has(store.shopId));

    const options = usable.map((store) => ({
      value: store.shopId,
      label: store.shopName || store.name,
    }));
    // No default is returned: the dashboard opens on every store, including a
    // tenant that only has one. Pinning the single store made its figures look
    // scoped when they were simply the tenant's, and hid the "All stores" reset.
    return { options };
  }

  /**
   * Units on fulfilment orders whose POS order sits in one of these statuses.
   *
   * Counting inventory units by their own status does not work here: a unit is
   * left DISPATCHED forever because WMS fulfilment stops at PACKED and delivery
   * is only ever confirmed in POS. WMS Dispatch resolves this by reading the
   * POS status off the fulfilment order, and this mirrors that exactly so the
   * two screens agree.
   */
  private async countUnitsByOrderStatus(
    tenantId: string,
    statuses: number[],
    shopIds?: string[],
  ): Promise<number> {
    const result = await this.prisma.wmsFulfillmentOrder.aggregate({
      where: {
        tenantId,
        status: WmsFulfillmentOrderStatus.PACKED,
        posOrder: { is: { status: { in: statuses }, isVoid: false } },
        ...(shopIds?.length ? { store: { shopId: { in: shopIds } } } : {}),
      },
      _sum: { totalQuantity: true },
    });
    return result._sum.totalQuantity ?? 0;
  }

  private async loadFreshness(tenantId: string) {
    const [orders, spend] = await Promise.all([
      this.prisma.posOrder.aggregate({ where: { tenantId }, _max: { insertedAt: true } }),
      this.prisma.reconcileMarketing.aggregate({ where: { tenantId }, _max: { date: true } }),
    ]);
    return {
      ordersSyncedAt: orders._max.insertedAt?.toISOString() ?? null,
      adSpendImportedDate: spend._max.date ? spend._max.date.toISOString().slice(0, 10) : null,
    };
  }

  private resolveDateRange(startDate?: string, endDate?: string) {
    const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
    for (const value of [startDate, endDate]) {
      if (value !== undefined && !DAY_KEY.test(value)) {
        throw new BadRequestException('Dates must be plain YYYY-MM-DD values');
      }
    }
    const todayKey = dayjs().tz(MANILA_TZ).format('YYYY-MM-DD');
    const startKey = startDate ?? dayjs(todayKey).startOf('month').format('YYYY-MM-DD');
    const endKey = endDate ?? todayKey;
    const start = new Date(`${startKey}T00:00:00.000Z`);
    const end = new Date(`${endKey}T23:59:59.999Z`);
    if (start > end) throw new BadRequestException('startDate must be on or before endDate');
    if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
      throw new BadRequestException('The CEO dashboard supports a maximum date range of 366 days');
    }
    return { start, end, startKey, endKey };
  }
}
