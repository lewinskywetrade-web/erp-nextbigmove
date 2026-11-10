import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import {
  deriveAssociateFromAdName,
  deriveMappingFromAdName,
} from '../../creative-agent/utils/ad-name-convention';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { normalizeAdId } from '../utils/normalize-ad-id';
import {
  buildProductMappingKey,
  buildUnassignedMappingKey,
} from '../utils/product-mapping-key';

import {
  PosOrderLite, PosAggregateBucket, createEmptyPosAggregateBucket,
  accumulatePosOrder, calculatePosFees,
} from '../utils/pos-reporting-components';
export { excludesPosOrderFromSalesTotals } from '../utils/pos-reporting-components';

export function resolveInsightMappingForReconcile(
  insight: { adName: string | null; mapping: string | null },
  linkedMapping: string | null | undefined,
  canonicalize: (mapping: string | null | undefined) => string | null,
): string | null {
  return linkedMapping
    || canonicalize(deriveMappingFromAdName(insight.adName))
    || canonicalize(insight.mapping)
    || null;
}

@Injectable()
export class ReconcileMarketingService {
  private readonly logger = new Logger(ReconcileMarketingService.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
  ) {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const keyPrefix = process.env.CACHE_PREFIX || 'erp:';
    const password = process.env.REDIS_PASSWORD || undefined;
    this.redis = new Redis({ host, port, keyPrefix, password });
  }

  private async bumpAnalyticsCacheVersion(tenantId: string): Promise<void> {
    await this.redis.incr(`analytics:${tenantId}:version`);
  }

  private createEmptyPosAggregateBucket(): PosAggregateBucket {
    return createEmptyPosAggregateBucket();
  }

  private accumulatePosOrder(bucket: PosAggregateBucket, order: PosOrderLite): void {
    accumulatePosOrder(bucket, order);
  }

  /**
   * Reconcile Meta ad insights with POS orders for a given date (YYYY-MM-DD) and tenant.
   * - Match by normalized ad id (from Meta ad_id and POS p_utm_content).
   * - Upsert into reconcile_marketing.
   * - Create synthetic rows for unmatched POS orders.
   */
  async reconcileDay(tenantId: string, date: string): Promise<void> {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const activeStores = await this.prisma.posStore.findMany({
      where: {
        tenantId,
        status: 'ACTIVE',
        OR: [{ enabled: true }, { enabled: null }],
      },
      select: { id: true, shopId: true, teamId: true },
    });
    const activeShopIds = Array.from(new Set(activeStores.map((store) => store.shopId)));
    // shopId (external) -> PosStore.id (internal UUID), so an unmatched order can
    // fall back to a store-scoped "Unassigned" mapping keyed like the pv:: keys.
    const storeIdByShopId = new Map(activeStores.map((store) => [store.shopId, store.id]));
    const teamIdByShopId = new Map(
      activeStores.map((store) => [store.shopId, (store as any).teamId ?? null]),
    );
    const teamIdByStoreId = new Map(
      activeStores.map((store) => [store.id.toLowerCase(), (store as any).teamId ?? null]),
    );

    // Load Meta insights for the day
    const metaInsights = await this.prisma.metaAdInsight.findMany({
      where: {
        tenantId,
        date: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
    });

    // A creative link is a structured bridge from ad -> creative -> posCustomId,
    // so an ad whose NAME carries no code (legacy names, or a customId that was
    // dropped) still gets a mapping once it is linked. Read straight from the
    // link + creative columns — no ad-name round-trip.
    const linkedAdIds = Array.from(new Set(metaInsights.map((row) => row.adId).filter(Boolean)));
    const linkMappingByAdId = new Map<string, string>();
    if (linkedAdIds.length > 0) {
      const links = await this.prisma.creativeMetaAdLink.findMany({
        where: { tenantId, adId: { in: linkedAdIds } },
        select: {
          adId: true,
          creative: {
            select: {
              posCustomId: true,
              posVariationId: true,
              storeConfig: { select: { storeId: true } },
            },
          },
        },
      });
      for (const link of links) {
        // Prefer the precise store+variation key (matches the sales side, so ad
        // spend and orders land in the same product bucket); fall back to the
        // creative's customId as before when no variation is set.
        const variationKey = buildProductMappingKey(
          link.creative?.storeConfig?.storeId,
          link.creative?.posVariationId,
        );
        const mappingValue = variationKey || link.creative?.posCustomId?.trim().toLowerCase();
        // A link uniquely owns (tenantId, adId); if two accounts reused an adId,
        // first non-empty mapping wins — deterministic and harmless.
        if (mappingValue && !linkMappingByAdId.has(link.adId)) linkMappingByAdId.set(link.adId, mappingValue);
      }
    }

    // Old-convention ads carry a campaign label and new-convention ads carry an
    // item customId, so the same product's spend splits across two buckets. When
    // a code matches EXACTLY ONE product in the tenant's active stores, resolve
    // it to the canonical pv:: store+variation key (the same key the sales side
    // stores), collapsing the eras into one bucket. Ambiguous or unknown codes
    // pass through unchanged — nothing is ever wrongly merged.
    const tenantProducts = await this.prisma.posProduct.findMany({
      where: {
        storeId: { in: activeStores.map((store) => store.id) },
        customId: { not: null },
      },
      select: { storeId: true, variationId: true, customId: true },
    });
    const productKeyByCode = new Map<string, string | null>();
    for (const product of tenantProducts) {
      const code = product.customId?.trim().toLowerCase();
      if (!code) continue;
      const key = buildProductMappingKey(product.storeId, product.variationId);
      if (!key) continue;
      // Second distinct product on the same code -> ambiguous, disable the code.
      if (productKeyByCode.has(code) && productKeyByCode.get(code) !== key) {
        productKeyByCode.set(code, null);
      } else {
        productKeyByCode.set(code, key);
      }
    }
    const canonicalizeMapping = (raw: string | null | undefined): string | null => {
      const norm = raw?.trim().toLowerCase();
      if (!norm) return null;
      return productKeyByCode.get(norm) ?? norm;
    };
    // Creative link first: it is the structured, human-confirmed bridge and the
    // only source guaranteed to share the sales side's key. A valid current
    // naming convention comes next and must beat source `mapping` values such
    // as campaign date suffixes (0909/0910) that do not identify a product.
    // Truly legacy names have no code anchor, so they still fall through to the
    // imported mapping exactly as before.
    const resolveInsightMapping = (insight: { adId: string; adName: string | null; mapping: string | null }): string | null =>
      resolveInsightMappingForReconcile(
        insight,
        linkMappingByAdId.get(insight.adId),
        canonicalizeMapping,
      );

    // Ensure all products and POS orders for this tenant/date have positive COGS before aggregating
    await this.ensurePositiveOrderCogsForDay(tenantId, date);

    // Load POS orders for the day
    const posOrders: PosOrderLite[] = await this.prisma.posOrder.findMany({
      where: {
        tenantId,
        shopId: { in: activeShopIds },
        dateLocal: date,
      },
      select: {
        pUtmContent: true,
        shopId: true,
        posOrderId: true,
        cod: true,
        teamId: true,
        status: true,
        isVoid: true,
        isAbandoned: true,
        wasAbandonedCart: true,
        isRepurchase: true,
        cogs: true,
        tracking: true,
        mapping: true,
      },
    });

    // A normalized identifier can refer to more than one imported Meta row.
    // Keep exact identities too: copying one POS bucket to every collision
    // duplicates revenue, costs, fees and order counts in all downstream reports.
    const exactToInsights = new Map<string, typeof metaInsights>();
    const normToInsights = new Map<string, typeof metaInsights>();
    for (const insight of metaInsights) {
      const exact = insight.adId.trim();
      if (exact) exactToInsights.set(exact, [...(exactToInsights.get(exact) ?? []), insight]);
      const norm = normalizeAdId(insight.adId);
      if (!norm) continue;
      normToInsights.set(norm, [...(normToInsights.get(norm) ?? []), insight]);
    }

    // Every order has at most one insight owner. Prefer an unambiguous exact
    // identifier, otherwise accept a unique normalized match. Ambiguous matches
    // stay as store-scoped synthetic POS rows rather than guessing an ad owner.
    const posAggByAdId = new Map<string, PosAggregateBucket>();
    const attributedOrders = new Set<PosOrderLite>();
    let ambiguousOrderCount = 0;
    for (const order of posOrders) {
      const raw = order.pUtmContent?.trim() || '';
      const norm = normalizeAdId(raw);
      const candidates = exactToInsights.get(raw) ?? normToInsights.get(norm);
      if (!candidates || candidates.length !== 1) {
        if (candidates && candidates.length > 1) ambiguousOrderCount += 1;
        continue;
      }
      const orderTeamId = order.teamId ?? teamIdByShopId.get(order.shopId) ?? null;
      if (candidates[0].teamId && orderTeamId && candidates[0].teamId !== orderTeamId) {
        continue;
      }
      const ownerId = candidates[0].adId;
      let bucket = posAggByAdId.get(ownerId);
      if (!bucket) {
        bucket = this.createEmptyPosAggregateBucket();
        posAggByAdId.set(ownerId, bucket);
      }
      this.accumulatePosOrder(bucket, order);
      attributedOrders.add(order);
    }
    if (ambiguousOrderCount > 0) {
      this.logger.warn(`Kept ${ambiguousOrderCount} POS orders unmatched because their ad attribution is ambiguous`);
    }

    // Upsert reconciled rows for matched insights
    const expectedAdIds = new Set(metaInsights.map((insight) => insight.adId));
    for (const insight of metaInsights) {
      const norm = normalizeAdId(insight.adId);
      const agg = posAggByAdId.get(insight.adId);
      const matchedOrders = agg?.orders?.map((o) => ({
        shopId: o.shopId,
        posOrderId: o.posOrderId,
        cod: parseFloat(o.cod ?? '0') || 0,
      })) ?? [];
      const shops =
        matchedOrders.length > 0
          ? Array.from(new Set(matchedOrders.map((o) => o.shopId)))
          : [];

      const {
        sf, repurchaseSf, ff, repurchaseFf, inf, repurchaseIf,
        sfSdr, repurchaseSfSdr, ffSdr, repurchaseFfSdr, infSdr, repurchaseIfSdr,
        codFee, repurchaseCodFee, codFeeDelivered, repurchaseCodFeeDelivered
      } = calculatePosFees(agg);
      const metaDateCreated =
        insight.dateCreated && typeof insight.dateCreated === 'string'
          ? new Date(insight.dateCreated)
          : insight.dateCreated
          ? new Date(insight.dateCreated)
          : null;
      const resolvedMapping = resolveInsightMapping(insight);
      const mappedStoreId =
        resolvedMapping?.startsWith('pv::') || resolvedMapping?.startsWith('ua::')
          ? resolvedMapping.split('::')[1]?.trim().toLowerCase()
          : null;
      const firstMatchedOrder = agg?.orders?.[0];
      const matchedOrderTeamId = firstMatchedOrder
        ? (firstMatchedOrder.teamId ?? teamIdByShopId.get(firstMatchedOrder.shopId) ?? null)
        : null;
      const effectiveInsightTeamId =
        insight.teamId ??
        matchedOrderTeamId ??
        (mappedStoreId ? (teamIdByStoreId.get(mappedStoreId) ?? null) : null);

      await this.prisma.reconcileMarketing.upsert({
        where: {
          tenantId_date_adId: {
            tenantId,
            date: dayStart,
            adId: insight.adId,
          },
        },
        create: {
          tenantId,
          teamId: effectiveInsightTeamId,
          date: dayStart,
          adId: insight.adId,
          normalizedAdId: norm || null,
          accountId: insight.accountId,
          campaignId: insight.campaignId,
          campaignName: insight.campaignName,
          adsetId: insight.adsetId,
          adName: insight.adName,
          marketingAssociate: insight.marketingAssociate
            || deriveAssociateFromAdName(insight.adName),
          mapping: resolvedMapping,
          teamCode: insight.teamCode || null,
          dateCreated: metaDateCreated,
          spend: insight.spend,
          clicks: insight.clicks || 0,
          linkClicks: insight.linkClicks || 0,
          impressions: insight.impressions || 0,
          leads: insight.leads || 0,
          purchasesPos: agg?.purchasesPos || 0,
          codPos: agg?.codPos || 0,
          processedPurchasesPos: agg?.processedPurchasesPos || 0,
          repurchaseCount: agg?.repurchaseCount || 0,
          repurchaseProcessedPurchasesPos: agg?.repurchaseProcessedPurchasesPos || 0,
          repurchaseCodPos: agg?.repurchaseCodPos || 0,
          cogsPos: agg?.cogsPos || 0,
          repurchaseCogsPos: agg?.repurchaseCogsPos || 0,
          cogsCanceledPos: agg?.cogsCanceledPos || 0,
          repurchaseCogsCanceledPos: agg?.repurchaseCogsCanceledPos || 0,
          cogsRestockingPos: agg?.cogsRestockingPos || 0,
          repurchaseCogsRestockingPos: agg?.repurchaseCogsRestockingPos || 0,
          cogsRtsPos: agg?.cogsRtsPos || 0,
          repurchaseCogsRtsPos: agg?.repurchaseCogsRtsPos || 0,
          cogsDeliveredPos: agg?.cogsDeliveredPos || 0,
          repurchaseCogsDeliveredPos: agg?.repurchaseCogsDeliveredPos || 0,
          sfPos: sf,
          repurchaseSfPos: repurchaseSf,
          ffPos: ff,
          repurchaseFfPos: repurchaseFf,
          ifPos: inf,
          repurchaseIfPos: repurchaseIf,
          sfSdrPos: sfSdr,
          repurchaseSfSdrPos: repurchaseSfSdr,
          ffSdrPos: ffSdr,
          repurchaseFfSdrPos: repurchaseFfSdr,
          ifSdrPos: infSdr,
          repurchaseIfSdrPos: repurchaseIfSdr,
          codFeePos: codFee,
          repurchaseCodFeePos: repurchaseCodFee,
          codFeeDeliveredPos: codFeeDelivered,
          repurchaseCodFeeDeliveredPos: repurchaseCodFeeDelivered,
          canceledCodPos: agg?.canceledCodPos || 0,
          repurchaseCanceledCodPos: agg?.repurchaseCanceledCodPos || 0,
          rtsCodPos: agg?.rtsCodPos || 0,
          repurchaseRtsCodPos: agg?.repurchaseRtsCodPos || 0,
          deliveredCodPos: agg?.deliveredCodPos || 0,
          repurchaseDeliveredCodPos: agg?.repurchaseDeliveredCodPos || 0,
          shippedCodPos: agg?.shippedCodPos || 0,
          repurchaseShippedCodPos: agg?.repurchaseShippedCodPos || 0,
          waitingPickupCodPos: agg?.waitingPickupCodPos || 0,
          repurchaseWaitingPickupCodPos: agg?.repurchaseWaitingPickupCodPos || 0,
          restockingCodPos: agg?.restockingCodPos || 0,
          repurchaseRestockingCodPos: agg?.repurchaseRestockingCodPos || 0,
          confirmedCodPos: agg?.confirmedCodPos || 0,
          repurchaseConfirmedCodPos: agg?.repurchaseConfirmedCodPos || 0,
          unconfirmedCodPos: agg?.unconfirmedCodPos || 0,
          repurchaseUnconfirmedCodPos: agg?.repurchaseUnconfirmedCodPos || 0,
          abandonedCodPos: agg?.abandonedCodPos || 0,
          repurchaseAbandonedCodPos: agg?.repurchaseAbandonedCodPos || 0,
          currentAbandonedCodPos: agg?.currentAbandonedCodPos || 0,
          repurchaseCurrentAbandonedCodPos: agg?.repurchaseCurrentAbandonedCodPos || 0,
          confirmedCount: agg?.confirmedCount || 0,
          repurchaseConfirmedCount: agg?.repurchaseConfirmedCount || 0,
          unconfirmedCount: agg?.unconfirmedCount || 0,
          repurchaseUnconfirmedCount: agg?.repurchaseUnconfirmedCount || 0,
          printedCount: agg?.printedCount || 0,
          repurchasePrintedCount: agg?.repurchasePrintedCount || 0,
          deletedCount: agg?.deletedCount || 0,
          repurchaseDeletedCount: agg?.repurchaseDeletedCount || 0,
          abandonedCount: agg?.abandonedCount || 0,
          repurchaseAbandonedCount: agg?.repurchaseAbandonedCount || 0,
          currentAbandonedCount: agg?.currentAbandonedCount || 0,
          repurchaseCurrentAbandonedCount: agg?.repurchaseCurrentAbandonedCount || 0,
          restockingCount: agg?.restockingCount || 0,
          repurchaseRestockingCount: agg?.repurchaseRestockingCount || 0,
          waitingPickupCount: agg?.waitingPickupCount || 0,
          repurchaseWaitingPickupCount: agg?.repurchaseWaitingPickupCount || 0,
          shippedCount: agg?.shippedCount || 0,
          repurchaseShippedCount: agg?.repurchaseShippedCount || 0,
          deliveredCount: agg?.deliveredCount || 0,
          repurchaseDeliveredCount: agg?.repurchaseDeliveredCount || 0,
          canceledCount: agg?.canceledCount || 0,
          repurchaseCanceledCount: agg?.repurchaseCanceledCount || 0,
          rtsCount: agg?.rtsCount || 0,
          repurchaseRtsCount: agg?.repurchaseRtsCount || 0,
          matchedOrders,
          shops,
        },
        update: {
          teamId: effectiveInsightTeamId,
          normalizedAdId: norm || null,
          accountId: insight.accountId,
          campaignId: insight.campaignId,
          campaignName: insight.campaignName,
          adsetId: insight.adsetId,
          adName: insight.adName,
          marketingAssociate: insight.marketingAssociate
            || deriveAssociateFromAdName(insight.adName),
          mapping: resolvedMapping,
          teamCode: insight.teamCode || null,
          dateCreated: metaDateCreated,
          spend: insight.spend,
          clicks: insight.clicks || 0,
          linkClicks: insight.linkClicks || 0,
          impressions: insight.impressions || 0,
          leads: insight.leads || 0,
          purchasesPos: agg?.purchasesPos || 0,
          codPos: agg?.codPos || 0,
          processedPurchasesPos: agg?.processedPurchasesPos || 0,
          repurchaseCount: agg?.repurchaseCount || 0,
          repurchaseProcessedPurchasesPos: agg?.repurchaseProcessedPurchasesPos || 0,
          repurchaseCodPos: agg?.repurchaseCodPos || 0,
          cogsPos: agg?.cogsPos || 0,
          repurchaseCogsPos: agg?.repurchaseCogsPos || 0,
          cogsCanceledPos: agg?.cogsCanceledPos || 0,
          repurchaseCogsCanceledPos: agg?.repurchaseCogsCanceledPos || 0,
          cogsRestockingPos: agg?.cogsRestockingPos || 0,
          repurchaseCogsRestockingPos: agg?.repurchaseCogsRestockingPos || 0,
          cogsRtsPos: agg?.cogsRtsPos || 0,
          repurchaseCogsRtsPos: agg?.repurchaseCogsRtsPos || 0,
          cogsDeliveredPos: agg?.cogsDeliveredPos || 0,
          repurchaseCogsDeliveredPos: agg?.repurchaseCogsDeliveredPos || 0,
          sfPos: sf,
          repurchaseSfPos: repurchaseSf,
          ffPos: ff,
          repurchaseFfPos: repurchaseFf,
          ifPos: inf,
          repurchaseIfPos: repurchaseIf,
          sfSdrPos: sfSdr,
          repurchaseSfSdrPos: repurchaseSfSdr,
          ffSdrPos: ffSdr,
          repurchaseFfSdrPos: repurchaseFfSdr,
          ifSdrPos: infSdr,
          repurchaseIfSdrPos: repurchaseIfSdr,
          codFeePos: codFee,
          repurchaseCodFeePos: repurchaseCodFee,
          codFeeDeliveredPos: codFeeDelivered,
          repurchaseCodFeeDeliveredPos: repurchaseCodFeeDelivered,
          canceledCodPos: agg?.canceledCodPos || 0,
          repurchaseCanceledCodPos: agg?.repurchaseCanceledCodPos || 0,
          rtsCodPos: agg?.rtsCodPos || 0,
          repurchaseRtsCodPos: agg?.repurchaseRtsCodPos || 0,
          deliveredCodPos: agg?.deliveredCodPos || 0,
          repurchaseDeliveredCodPos: agg?.repurchaseDeliveredCodPos || 0,
          shippedCodPos: agg?.shippedCodPos || 0,
          repurchaseShippedCodPos: agg?.repurchaseShippedCodPos || 0,
          waitingPickupCodPos: agg?.waitingPickupCodPos || 0,
          repurchaseWaitingPickupCodPos: agg?.repurchaseWaitingPickupCodPos || 0,
          restockingCodPos: agg?.restockingCodPos || 0,
          repurchaseRestockingCodPos: agg?.repurchaseRestockingCodPos || 0,
          confirmedCodPos: agg?.confirmedCodPos || 0,
          repurchaseConfirmedCodPos: agg?.repurchaseConfirmedCodPos || 0,
          unconfirmedCodPos: agg?.unconfirmedCodPos || 0,
          repurchaseUnconfirmedCodPos: agg?.repurchaseUnconfirmedCodPos || 0,
          abandonedCodPos: agg?.abandonedCodPos || 0,
          repurchaseAbandonedCodPos: agg?.repurchaseAbandonedCodPos || 0,
          currentAbandonedCodPos: agg?.currentAbandonedCodPos || 0,
          repurchaseCurrentAbandonedCodPos: agg?.repurchaseCurrentAbandonedCodPos || 0,
          confirmedCount: agg?.confirmedCount || 0,
          repurchaseConfirmedCount: agg?.repurchaseConfirmedCount || 0,
          unconfirmedCount: agg?.unconfirmedCount || 0,
          repurchaseUnconfirmedCount: agg?.repurchaseUnconfirmedCount || 0,
          printedCount: agg?.printedCount || 0,
          repurchasePrintedCount: agg?.repurchasePrintedCount || 0,
          deletedCount: agg?.deletedCount || 0,
          repurchaseDeletedCount: agg?.repurchaseDeletedCount || 0,
          abandonedCount: agg?.abandonedCount || 0,
          repurchaseAbandonedCount: agg?.repurchaseAbandonedCount || 0,
          currentAbandonedCount: agg?.currentAbandonedCount || 0,
          repurchaseCurrentAbandonedCount: agg?.repurchaseCurrentAbandonedCount || 0,
          restockingCount: agg?.restockingCount || 0,
          repurchaseRestockingCount: agg?.repurchaseRestockingCount || 0,
          waitingPickupCount: agg?.waitingPickupCount || 0,
          repurchaseWaitingPickupCount: agg?.repurchaseWaitingPickupCount || 0,
          shippedCount: agg?.shippedCount || 0,
          repurchaseShippedCount: agg?.repurchaseShippedCount || 0,
          deliveredCount: agg?.deliveredCount || 0,
          repurchaseDeliveredCount: agg?.repurchaseDeliveredCount || 0,
          canceledCount: agg?.canceledCount || 0,
          repurchaseCanceledCount: agg?.repurchaseCanceledCount || 0,
          rtsCount: agg?.rtsCount || 0,
          repurchaseRtsCount: agg?.repurchaseRtsCount || 0,
          matchedOrders,
          shops,
          updatedAt: new Date(),
        },
      });
    }

    // Retain every unattributed order once, including ambiguous Meta matches.
    for (const order of posOrders) {
      if (attributedOrders.has(order)) {
        continue; // matched already
      }
      const syntheticAdId = `${order.shopId}-${order.posOrderId}`;
      expectedAdIds.add(syntheticAdId);
      const syntheticAgg = this.createEmptyPosAggregateBucket();
      this.accumulatePosOrder(syntheticAgg, order);
      const {
        sf, repurchaseSf, ff, repurchaseFf, inf, repurchaseIf,
        sfSdr, repurchaseSfSdr, ffSdr, repurchaseFfSdr, infSdr, repurchaseIfSdr,
        codFee, repurchaseCodFee, codFeeDelivered, repurchaseCodFeeDelivered
      } = calculatePosFees(syntheticAgg);
      const codVal = parseFloat(order.cod ?? '0') || 0;
      await this.prisma.reconcileMarketing.upsert({
        where: {
          tenantId_date_adId: {
            tenantId,
            date: dayStart,
            adId: syntheticAdId,
          },
        },
        create: {
          tenantId,
          teamId: order.teamId ?? teamIdByShopId.get(order.shopId) ?? null,
          date: dayStart,
          adId: syntheticAdId,
          normalizedAdId: null,
          accountId: '',
          campaignId: '',
          campaignName: '',
          adsetId: '',
          adName: 'POS Unmatched Order',
          marketingAssociate: null,
          mapping:
            order.mapping ??
            buildUnassignedMappingKey(storeIdByShopId.get(order.shopId)) ??
            null,
          dateCreated: null,
          spend: 0,
          clicks: 0,
          linkClicks: 0,
          impressions: 0,
          leads: 0,
          purchasesPos: syntheticAgg.purchasesPos,
          codPos: syntheticAgg.codPos,
          processedPurchasesPos: syntheticAgg.processedPurchasesPos,
          repurchaseCount: syntheticAgg.repurchaseCount,
          repurchaseProcessedPurchasesPos: syntheticAgg.repurchaseProcessedPurchasesPos,
          repurchaseCodPos: syntheticAgg.repurchaseCodPos,
          cogsPos: syntheticAgg.cogsPos,
          repurchaseCogsPos: syntheticAgg.repurchaseCogsPos,
          cogsCanceledPos: syntheticAgg.cogsCanceledPos,
          repurchaseCogsCanceledPos: syntheticAgg.repurchaseCogsCanceledPos,
          cogsRestockingPos: syntheticAgg.cogsRestockingPos,
          repurchaseCogsRestockingPos: syntheticAgg.repurchaseCogsRestockingPos,
          cogsRtsPos: syntheticAgg.cogsRtsPos,
          repurchaseCogsRtsPos: syntheticAgg.repurchaseCogsRtsPos,
          cogsDeliveredPos: syntheticAgg.cogsDeliveredPos,
          repurchaseCogsDeliveredPos: syntheticAgg.repurchaseCogsDeliveredPos,
          sfPos: sf,
          repurchaseSfPos: repurchaseSf,
          ffPos: ff,
          repurchaseFfPos: repurchaseFf,
          ifPos: inf,
          repurchaseIfPos: repurchaseIf,
          sfSdrPos: sfSdr,
          repurchaseSfSdrPos: repurchaseSfSdr,
          ffSdrPos: ffSdr,
          repurchaseFfSdrPos: repurchaseFfSdr,
          ifSdrPos: infSdr,
          repurchaseIfSdrPos: repurchaseIfSdr,
          codFeePos: codFee,
          repurchaseCodFeePos: repurchaseCodFee,
          codFeeDeliveredPos: codFeeDelivered,
          repurchaseCodFeeDeliveredPos: repurchaseCodFeeDelivered,
          canceledCodPos: syntheticAgg.canceledCodPos,
          repurchaseCanceledCodPos: syntheticAgg.repurchaseCanceledCodPos,
          rtsCodPos: syntheticAgg.rtsCodPos,
          repurchaseRtsCodPos: syntheticAgg.repurchaseRtsCodPos,
          deliveredCodPos: syntheticAgg.deliveredCodPos,
          repurchaseDeliveredCodPos: syntheticAgg.repurchaseDeliveredCodPos,
          shippedCodPos: syntheticAgg.shippedCodPos,
          repurchaseShippedCodPos: syntheticAgg.repurchaseShippedCodPos,
          waitingPickupCodPos: syntheticAgg.waitingPickupCodPos,
          repurchaseWaitingPickupCodPos: syntheticAgg.repurchaseWaitingPickupCodPos,
          restockingCodPos: syntheticAgg.restockingCodPos,
          repurchaseRestockingCodPos: syntheticAgg.repurchaseRestockingCodPos,
          confirmedCodPos: syntheticAgg.confirmedCodPos,
          repurchaseConfirmedCodPos: syntheticAgg.repurchaseConfirmedCodPos,
          unconfirmedCodPos: syntheticAgg.unconfirmedCodPos,
          repurchaseUnconfirmedCodPos: syntheticAgg.repurchaseUnconfirmedCodPos,
          abandonedCodPos: syntheticAgg.abandonedCodPos,
          repurchaseAbandonedCodPos: syntheticAgg.repurchaseAbandonedCodPos,
          currentAbandonedCodPos: syntheticAgg.currentAbandonedCodPos,
          repurchaseCurrentAbandonedCodPos: syntheticAgg.repurchaseCurrentAbandonedCodPos,
          confirmedCount: syntheticAgg.confirmedCount,
          repurchaseConfirmedCount: syntheticAgg.repurchaseConfirmedCount,
          unconfirmedCount: syntheticAgg.unconfirmedCount,
          repurchaseUnconfirmedCount: syntheticAgg.repurchaseUnconfirmedCount,
          printedCount: syntheticAgg.printedCount,
          repurchasePrintedCount: syntheticAgg.repurchasePrintedCount,
          deletedCount: syntheticAgg.deletedCount,
          repurchaseDeletedCount: syntheticAgg.repurchaseDeletedCount,
          abandonedCount: syntheticAgg.abandonedCount,
          repurchaseAbandonedCount: syntheticAgg.repurchaseAbandonedCount,
          currentAbandonedCount: syntheticAgg.currentAbandonedCount,
          repurchaseCurrentAbandonedCount: syntheticAgg.repurchaseCurrentAbandonedCount,
          restockingCount: syntheticAgg.restockingCount,
          repurchaseRestockingCount: syntheticAgg.repurchaseRestockingCount,
          waitingPickupCount: syntheticAgg.waitingPickupCount,
          repurchaseWaitingPickupCount: syntheticAgg.repurchaseWaitingPickupCount,
          shippedCount: syntheticAgg.shippedCount,
          repurchaseShippedCount: syntheticAgg.repurchaseShippedCount,
          deliveredCount: syntheticAgg.deliveredCount,
          repurchaseDeliveredCount: syntheticAgg.repurchaseDeliveredCount,
          canceledCount: syntheticAgg.canceledCount,
          repurchaseCanceledCount: syntheticAgg.repurchaseCanceledCount,
          rtsCount: syntheticAgg.rtsCount,
          repurchaseRtsCount: syntheticAgg.repurchaseRtsCount,
          matchedOrders: [
            {
              shopId: order.shopId,
              posOrderId: order.posOrderId,
              cod: codVal,
            },
          ],
          shops: [order.shopId],
        },
        update: {
          teamId: order.teamId ?? teamIdByShopId.get(order.shopId) ?? null,
          purchasesPos: syntheticAgg.purchasesPos,
          codPos: syntheticAgg.codPos,
          processedPurchasesPos: syntheticAgg.processedPurchasesPos,
          repurchaseCount: syntheticAgg.repurchaseCount,
          repurchaseProcessedPurchasesPos: syntheticAgg.repurchaseProcessedPurchasesPos,
          repurchaseCodPos: syntheticAgg.repurchaseCodPos,
          cogsPos: syntheticAgg.cogsPos,
          repurchaseCogsPos: syntheticAgg.repurchaseCogsPos,
          cogsCanceledPos: syntheticAgg.cogsCanceledPos,
          repurchaseCogsCanceledPos: syntheticAgg.repurchaseCogsCanceledPos,
          cogsRestockingPos: syntheticAgg.cogsRestockingPos,
          repurchaseCogsRestockingPos: syntheticAgg.repurchaseCogsRestockingPos,
          cogsRtsPos: syntheticAgg.cogsRtsPos,
          repurchaseCogsRtsPos: syntheticAgg.repurchaseCogsRtsPos,
          cogsDeliveredPos: syntheticAgg.cogsDeliveredPos,
          repurchaseCogsDeliveredPos: syntheticAgg.repurchaseCogsDeliveredPos,
          dateCreated: null,
          mapping:
            order.mapping ??
            buildUnassignedMappingKey(storeIdByShopId.get(order.shopId)) ??
            null,
          sfPos: sf,
          repurchaseSfPos: repurchaseSf,
          ffPos: ff,
          repurchaseFfPos: repurchaseFf,
          ifPos: inf,
          repurchaseIfPos: repurchaseIf,
          sfSdrPos: sfSdr,
          repurchaseSfSdrPos: repurchaseSfSdr,
          ffSdrPos: ffSdr,
          repurchaseFfSdrPos: repurchaseFfSdr,
          ifSdrPos: infSdr,
          repurchaseIfSdrPos: repurchaseIfSdr,
          codFeePos: codFee,
          repurchaseCodFeePos: repurchaseCodFee,
          codFeeDeliveredPos: codFeeDelivered,
          repurchaseCodFeeDeliveredPos: repurchaseCodFeeDelivered,
          canceledCodPos: syntheticAgg.canceledCodPos,
          repurchaseCanceledCodPos: syntheticAgg.repurchaseCanceledCodPos,
          rtsCodPos: syntheticAgg.rtsCodPos,
          repurchaseRtsCodPos: syntheticAgg.repurchaseRtsCodPos,
          deliveredCodPos: syntheticAgg.deliveredCodPos,
          repurchaseDeliveredCodPos: syntheticAgg.repurchaseDeliveredCodPos,
          shippedCodPos: syntheticAgg.shippedCodPos,
          repurchaseShippedCodPos: syntheticAgg.repurchaseShippedCodPos,
          waitingPickupCodPos: syntheticAgg.waitingPickupCodPos,
          repurchaseWaitingPickupCodPos: syntheticAgg.repurchaseWaitingPickupCodPos,
          restockingCodPos: syntheticAgg.restockingCodPos,
          repurchaseRestockingCodPos: syntheticAgg.repurchaseRestockingCodPos,
          confirmedCodPos: syntheticAgg.confirmedCodPos,
          repurchaseConfirmedCodPos: syntheticAgg.repurchaseConfirmedCodPos,
          unconfirmedCodPos: syntheticAgg.unconfirmedCodPos,
          repurchaseUnconfirmedCodPos: syntheticAgg.repurchaseUnconfirmedCodPos,
          abandonedCodPos: syntheticAgg.abandonedCodPos,
          repurchaseAbandonedCodPos: syntheticAgg.repurchaseAbandonedCodPos,
          currentAbandonedCodPos: syntheticAgg.currentAbandonedCodPos,
          repurchaseCurrentAbandonedCodPos: syntheticAgg.repurchaseCurrentAbandonedCodPos,
          confirmedCount: syntheticAgg.confirmedCount,
          repurchaseConfirmedCount: syntheticAgg.repurchaseConfirmedCount,
          unconfirmedCount: syntheticAgg.unconfirmedCount,
          repurchaseUnconfirmedCount: syntheticAgg.repurchaseUnconfirmedCount,
          printedCount: syntheticAgg.printedCount,
          repurchasePrintedCount: syntheticAgg.repurchasePrintedCount,
          deletedCount: syntheticAgg.deletedCount,
          repurchaseDeletedCount: syntheticAgg.repurchaseDeletedCount,
          abandonedCount: syntheticAgg.abandonedCount,
          repurchaseAbandonedCount: syntheticAgg.repurchaseAbandonedCount,
          currentAbandonedCount: syntheticAgg.currentAbandonedCount,
          repurchaseCurrentAbandonedCount: syntheticAgg.repurchaseCurrentAbandonedCount,
          restockingCount: syntheticAgg.restockingCount,
          repurchaseRestockingCount: syntheticAgg.repurchaseRestockingCount,
          waitingPickupCount: syntheticAgg.waitingPickupCount,
          repurchaseWaitingPickupCount: syntheticAgg.repurchaseWaitingPickupCount,
          shippedCount: syntheticAgg.shippedCount,
          repurchaseShippedCount: syntheticAgg.repurchaseShippedCount,
          deliveredCount: syntheticAgg.deliveredCount,
          repurchaseDeliveredCount: syntheticAgg.repurchaseDeliveredCount,
          canceledCount: syntheticAgg.canceledCount,
          repurchaseCanceledCount: syntheticAgg.repurchaseCanceledCount,
          rtsCount: syntheticAgg.rtsCount,
          repurchaseRtsCount: syntheticAgg.repurchaseRtsCount,
          matchedOrders: [
            {
              shopId: order.shopId,
              posOrderId: order.posOrderId,
              cod: codVal,
            },
          ],
          shops: [order.shopId],
          updatedAt: new Date(),
        },
      });
    }

    // Incremental reconciliation is authoritative for this one tenant/day.
    // Remove only derived rows whose Meta insight or POS source disappeared;
    // source POS orders (including status 7 tombstones) are never deleted here.
    await this.prisma.reconcileMarketing.deleteMany({
      where: {
        tenantId,
        date: dayStart,
        ...(expectedAdIds.size > 0
          ? { adId: { notIn: Array.from(expectedAdIds) } }
          : {}),
      },
    });

    await this.bumpAnalyticsCacheVersion(tenantId);
    this.logger.log(`Reconciled marketing for tenant ${tenantId} on ${date}`);
  }

  private async ensurePositiveOrderCogsForDay(tenantId: string, date: string): Promise<void> {
    if (typeof (this.prisma as any).$executeRawUnsafe !== 'function') return;
    try {
      await (this.prisma as any).$executeRawUnsafe(
        `
        WITH store_baseline AS (
          SELECT DISTINCT ON (c."storeId")
            c."storeId",
            c.cogs
          FROM pos_product_cogs c
          WHERE c."tenantId" = $1 AND c.cogs > 0
          ORDER BY c."storeId", (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tenant_baseline AS (
          SELECT cogs
          FROM (
            SELECT cogs, COUNT(*) AS cnt
            FROM pos_product_cogs
            WHERE "tenantId" = $1 AND cogs > 0
            GROUP BY cogs
          ) x
          ORDER BY cnt DESC, cogs ASC
          LIMIT 1
        )
        INSERT INTO pos_product_cogs (id, "tenantId", "teamId", "productId", "storeId", cogs, "startDate", "endDate", "createdAt", "updatedAt")
        SELECT
          gen_random_uuid(),
          s."tenantId",
          s."teamId",
          p.id,
          p."storeId",
          COALESCE(sb.cogs, (SELECT cogs FROM tenant_baseline), 140.00),
          NULL,
          NULL,
          NOW(),
          NOW()
        FROM pos_products p
        JOIN pos_stores s ON s.id = p."storeId"
        LEFT JOIN store_baseline sb ON sb."storeId" = p."storeId"
        WHERE s."tenantId" = $1
          AND NOT EXISTS (
            SELECT 1
            FROM pos_product_cogs existing
            WHERE existing."productId" = p.id
              AND existing."storeId" = p."storeId"
              AND existing."tenantId" = s."tenantId"
              AND existing."startDate" IS NULL
              AND existing."endDate" IS NULL
              AND existing.cogs > 0
          )
        `,
        tenantId,
      );

      await (this.prisma as any).$executeRawUnsafe(
        `
        WITH tmp_var_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", p."variationId")
            s."tenantId",
            s."shopId",
            p."variationId",
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE s."tenantId" = $1 AND p."variationId" IS NOT NULL AND BTRIM(p."variationId") <> ''
          ORDER BY s."tenantId", s."shopId", p."variationId", (s.status = 'ACTIVE') DESC, (p."variationId" <> p."productId") DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_sku_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
            s."tenantId",
            s."shopId",
            LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE s."tenantId" = $1 AND p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
          ORDER BY s."tenantId", s."shopId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_parent_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId", p."productId")
            s."tenantId",
            s."shopId",
            p."productId",
            c.cogs
          FROM pos_products p
          JOIN pos_stores s ON s.id = p."storeId"
          JOIN pos_product_cogs c ON c."productId" = p.id AND c.cogs > 0
          WHERE s."tenantId" = $1 AND p."productId" IS NOT NULL AND BTRIM(p."productId") <> ''
          ORDER BY s."tenantId", s."shopId", p."productId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_tenant_sku_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))))
            c."tenantId",
            LOWER(BTRIM(RTRIM(p."customId", '\`'))) AS norm_sku,
            c.cogs
          FROM pos_product_cogs c
          JOIN pos_products p ON p.id = c."productId"
          WHERE c."tenantId" = $1 AND c.cogs > 0 AND p."customId" IS NOT NULL AND BTRIM(RTRIM(p."customId", '\`')) <> ''
          ORDER BY c."tenantId", LOWER(BTRIM(RTRIM(p."customId", '\`'))), (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_store_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (s."tenantId", s."shopId")
            s."tenantId",
            s."shopId",
            c.cogs
          FROM pos_stores s
          JOIN pos_product_cogs c ON c."storeId" = s.id AND c.cogs > 0
          WHERE s."tenantId" = $1
          ORDER BY s."tenantId", s."shopId", (s.status = 'ACTIVE') DESC, (c."startDate" IS NULL) DESC, c."updatedAt" DESC
        ),
        tmp_team_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId", c."teamId")
            c."tenantId",
            c."teamId",
            c.cogs
          FROM (
            SELECT "tenantId", "teamId", cogs, COUNT(*) AS cnt
            FROM pos_product_cogs
            WHERE "tenantId" = $1 AND cogs > 0 AND "teamId" IS NOT NULL
            GROUP BY "tenantId", "teamId", cogs
          ) c
          ORDER BY c."tenantId", c."teamId", c.cnt DESC, c.cogs ASC
        ),
        tmp_tenant_cogs AS MATERIALIZED (
          SELECT DISTINCT ON (c."tenantId")
            c."tenantId",
            c.cogs
          FROM (
            SELECT "tenantId", cogs, COUNT(*) AS cnt
            FROM pos_product_cogs
            WHERE "tenantId" = $1 AND cogs > 0
            GROUP BY "tenantId", cogs
          ) c
          ORDER BY c."tenantId", c.cnt DESC, c.cogs ASC
        ),
        candidate_orders AS (
          SELECT
            o.id,
            o."tenantId",
            o."teamId",
            o."shopId",
            o."totalQuantity",
            LOWER(BTRIM(COALESCE(o.mapping, ''))) AS norm_mapping,
            CASE
              WHEN jsonb_typeof(o."orderSnapshot") = 'object'
               AND jsonb_typeof(o."orderSnapshot"->'items') = 'array'
               AND jsonb_array_length(o."orderSnapshot"->'items') > 0
              THEN o."orderSnapshot"->'items'
              WHEN jsonb_typeof(o."itemData") = 'array'
               AND jsonb_array_length(o."itemData") > 0
              THEN o."itemData"
              ELSE '[]'::jsonb
            END AS items
          FROM pos_orders o
          WHERE o."tenantId" = $1
            AND o."dateLocal" = $2
            AND (COALESCE(o.cogs, 0) <= 0 OR COALESCE(o."totalQuantity", 0) <= 0)
        ),
        expanded_items AS (
          SELECT
            co.id AS order_id,
            co."tenantId",
            co."teamId",
            co."shopId",
            co.norm_mapping,
            CASE
              WHEN jsonb_typeof(item->'quantity') = 'number'
               AND (item->>'quantity') ~ '^[0-9]+$'
               AND (item->>'quantity')::bigint BETWEEN 1 AND 100000
              THEN (item->>'quantity')::int
              WHEN jsonb_typeof(item->'quantity') = 'string'
               AND BTRIM(item->>'quantity') ~ '^[0-9]+$'
               AND BTRIM(item->>'quantity')::bigint BETWEEN 1 AND 100000
              THEN BTRIM(item->>'quantity')::int
              ELSE 1
            END AS qty,
            COALESCE(NULLIF(BTRIM(item->>'variation_id'), ''), NULLIF(BTRIM(item->>'variationId'), '')) AS var_id,
            COALESCE(NULLIF(BTRIM(item->>'product_id'), ''), NULLIF(BTRIM(item->>'productId'), '')) AS prod_id,
            COALESCE(
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'product_display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->>'productDisplayId', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'product_display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'display_id', ''), '\`'))), ''),
              NULLIF(LOWER(BTRIM(RTRIM(COALESCE(item->'variation_info'->>'barcode', ''), '\`'))), '')
            ) AS disp_sku
          FROM candidate_orders co
          CROSS JOIN LATERAL jsonb_array_elements(co.items) AS item
          WHERE jsonb_array_length(co.items) > 0
        ),
        order_item_eval AS (
          SELECT
            ei.order_id,
            COALESCE(SUM(ei.qty), 0)::int AS calc_qty,
            ROUND(COALESCE(SUM(ei.qty * COALESCE(vc.cogs, sc.cogs, pc.cogs, tsc.cogs, tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00)), 0)::numeric, 2) AS calc_cogs
          FROM expanded_items ei
          LEFT JOIN tmp_var_cogs vc
            ON vc."tenantId" = ei."tenantId" AND vc."shopId" = ei."shopId" AND vc."variationId" = ei.var_id
          LEFT JOIN tmp_sku_cogs sc
            ON sc."tenantId" = ei."tenantId" AND sc."shopId" = ei."shopId" AND sc.norm_sku = ei.disp_sku
          LEFT JOIN tmp_parent_cogs pc
            ON pc."tenantId" = ei."tenantId" AND pc."shopId" = ei."shopId" AND pc."productId" = ei.prod_id
          LEFT JOIN tmp_tenant_sku_cogs tsc
            ON tsc."tenantId" = ei."tenantId" AND tsc.norm_sku = ei.disp_sku
          LEFT JOIN tmp_tenant_sku_cogs tmsc
            ON tmsc."tenantId" = ei."tenantId" AND tmsc.norm_sku = ei.norm_mapping
          LEFT JOIN tmp_store_cogs stc
            ON stc."tenantId" = ei."tenantId" AND stc."shopId" = ei."shopId"
          LEFT JOIN tmp_team_cogs tmc
            ON tmc."tenantId" = ei."tenantId" AND tmc."teamId" = ei."teamId"
          LEFT JOIN tmp_tenant_cogs tnc
            ON tnc."tenantId" = ei."tenantId"
          GROUP BY ei.order_id
        ),
        empty_item_eval AS (
          SELECT
            co.id AS order_id,
            GREATEST(COALESCE(co."totalQuantity", 0), 1)::int AS calc_qty,
            ROUND((GREATEST(COALESCE(co."totalQuantity", 0), 1) * COALESCE(tmsc.cogs, stc.cogs, tmc.cogs, tnc.cogs, 140.00))::numeric, 2) AS calc_cogs
          FROM candidate_orders co
          LEFT JOIN tmp_tenant_sku_cogs tmsc
            ON tmsc."tenantId" = co."tenantId" AND tmsc.norm_sku = co.norm_mapping
          LEFT JOIN tmp_store_cogs stc
            ON stc."tenantId" = co."tenantId" AND stc."shopId" = co."shopId"
          LEFT JOIN tmp_team_cogs tmc
            ON tmc."tenantId" = co."tenantId" AND tmc."teamId" = co."teamId"
          LEFT JOIN tmp_tenant_cogs tnc
            ON tnc."tenantId" = co."tenantId"
          WHERE jsonb_array_length(co.items) = 0
        ),
        resolved_orders AS (
          SELECT order_id, calc_qty, calc_cogs
          FROM order_item_eval
          WHERE calc_cogs > 0
          UNION ALL
          SELECT order_id, calc_qty, calc_cogs
          FROM empty_item_eval
          WHERE calc_cogs > 0
        )
        UPDATE pos_orders o
        SET
          cogs = ro.calc_cogs,
          "totalQuantity" = CASE WHEN ro.calc_qty > 0 THEN ro.calc_qty ELSE GREATEST(COALESCE(o."totalQuantity", 0), 1) END
        FROM resolved_orders ro
        WHERE o.id = ro.order_id
          AND (COALESCE(o.cogs, 0) <> ro.calc_cogs OR COALESCE(o."totalQuantity", 0) <= 0)
        `,
        tenantId,
        date,
      );

      await (this.prisma as any).$executeRawUnsafe(
        `
        UPDATE pos_orders o
        SET "teamId" = s."teamId"
        FROM pos_stores s
        WHERE o."tenantId" = $1
          AND o."dateLocal" = $2
          AND s."tenantId" = o."tenantId"
          AND s."shopId" = o."shopId"
          AND s.status = 'ACTIVE'
          AND (s.enabled = true OR s.enabled IS NULL)
          AND s."teamId" IS NOT NULL
          AND o."teamId" IS DISTINCT FROM s."teamId"
        `,
        tenantId,
        date,
      );

      await (this.prisma as any).$executeRawUnsafe(
        `
        WITH orders_needing_items AS (
          SELECT
            o.id,
            GREATEST(COALESCE(o."totalQuantity", 1), 1) AS fallback_qty,
            CASE
              WHEN jsonb_typeof(o."orderSnapshot") = 'object'
               AND jsonb_typeof(o."orderSnapshot"->'items') = 'array'
               AND jsonb_array_length(o."orderSnapshot"->'items') > 0
              THEN o."orderSnapshot"->'items'
              WHEN jsonb_typeof(o."itemData") = 'array'
               AND jsonb_array_length(o."itemData") > 0
              THEN o."itemData"
              ELSE NULL
            END AS raw_arr,
            CASE
              WHEN jsonb_typeof(o."orderSnapshot") = 'object'
               AND o."orderSnapshot" ? 'items'
               AND jsonb_typeof(o."orderSnapshot"->'items') <> 'null'
              THEN o."orderSnapshot"->'items'
              ELSE o."itemData"
            END AS effective_arr
          FROM pos_orders o
          WHERE o."tenantId" = $1
            AND o."dateLocal" = $2
        ),
        invalid_item_orders AS (
          SELECT
            oni.id,
            CASE
              WHEN oni.raw_arr IS NOT NULL THEN (
                SELECT jsonb_agg(
                  CASE
                    WHEN jsonb_typeof(elem) = 'object' THEN
                      jsonb_set(
                        elem,
                        '{quantity}',
                        to_jsonb(
                          CASE
                            WHEN jsonb_typeof(elem->'quantity') = 'number'
                             AND (elem->>'quantity') ~ '^[1-9][0-9]*$'
                             AND (elem->>'quantity')::bigint <= 100000
                            THEN (elem->>'quantity')::int
                            WHEN jsonb_typeof(elem->'quantity') = 'string'
                             AND BTRIM(elem->>'quantity') ~ '^[1-9][0-9]*$'
                             AND BTRIM(elem->>'quantity')::bigint <= 100000
                            THEN BTRIM(elem->>'quantity')::int
                            ELSE 1
                          END
                        ),
                        true
                      )
                    ELSE jsonb_build_object('quantity', 1)
                  END
                )
                FROM jsonb_array_elements(oni.raw_arr) AS elem
              )
              ELSE jsonb_build_array(jsonb_build_object('quantity', oni.fallback_qty))
            END AS fixed_items
          FROM orders_needing_items oni
          WHERE oni.effective_arr IS NULL
             OR jsonb_typeof(oni.effective_arr) <> 'array'
             OR jsonb_array_length(oni.effective_arr) = 0
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(oni.effective_arr) = 'array' THEN oni.effective_arr ELSE '[]'::jsonb END
               ) AS elem
               WHERE jsonb_typeof(elem) <> 'object'
                  OR NOT (
                    (jsonb_typeof(elem->'quantity') = 'number' AND (elem->>'quantity') ~ '^[1-9][0-9]*$' AND (elem->>'quantity')::bigint <= 100000)
                    OR (jsonb_typeof(elem->'quantity') = 'string' AND BTRIM(elem->>'quantity') ~ '^[1-9][0-9]*$' AND BTRIM(elem->>'quantity')::bigint <= 100000)
                  )
             )
        )
        UPDATE pos_orders o
        SET
          "itemData" = iio.fixed_items,
          "orderSnapshot" = jsonb_set(
            CASE WHEN jsonb_typeof(o."orderSnapshot") = 'object' THEN o."orderSnapshot" ELSE '{}'::jsonb END,
            '{items}',
            iio.fixed_items,
            true
          )
        FROM invalid_item_orders iio
        WHERE o.id = iio.id
        `,
        tenantId,
        date,
      );
    } catch (err: any) {
      this.logger.warn(`Failed to backfill positive COGS for tenant ${tenantId} on ${date}: ${err?.message || err}`);
    }
  }
}
