import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { buildProductMappingKey } from '../../workflows/utils/product-mapping-key';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { createHash } from 'crypto';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import { WmsFulfillmentSyncService } from '../../wms-fulfillment/wms-fulfillment-sync.service';
import { WmsInventoryService } from '../../wms-inventory/wms-inventory.service';
import { WmsOutboundRecordsService } from '../../wms-inventory/wms-outbound-records.service';
import { COGS_REFRESH_PARENT_LOCK_SQL } from './product-cogs-recalculation.service';
import { WorkflowExecutionGateway } from '../../workflows/gateways/workflow-execution.gateway';
import {
  ORDERS_STATUS_SUMMARY_UPDATED_EVENT,
  ORDERS_UNDELIVERABLES_UPDATED_EVENT,
} from '../../orders/orders.constants';

dayjs.extend(utc);
dayjs.extend(timezone);

interface PosOrderData {
  shopId: string;
  posOrderId: string;
  insertedAt: Date;
  dateLocal: string;
  deliveredAt?: Date | null;
  rtsAt?: Date | null;
  undeliverableAt?: Date | null;
  status?: number;
  statusName?: string;
  cod?: number;
  salesCod?: number;
  mktgCod?: number;
  isMarketingSource?: boolean;
  forUpsell?: boolean;
  isRiskConfirmation?: boolean;
  isAbandoned?: boolean;
  wasAbandonedCart?: boolean;
  isRepurchase?: boolean;
  isUndeliverable?: boolean;
  isVoid?: boolean;
  pUtmCampaign?: string;
  pUtmContent?: string;
  cogs: number;
  totalQuantity: number;
  tracking?: string;
  mapping?: string;
  itemData: any[];
  tags: { id: string; name: string }[];
  customerCare?: string;
  marketer?: string;
  salesAssignee?: string | null;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  deliveryAttemptFailed?: number;
  statusHistory?: any[] | null;
  trackingUpdates?: Array<Record<string, unknown>>;
  rtsReason?: { l1: string | null; l2: string | null; l3: string | null } | null;
  upsellBreakdown?: any | null;
  orderSnapshot?: {
    customer: Record<string, any> | null;
    shipping_address: Record<string, any> | null;
    note: string | null;
    note_print: string | null;
    items: any[] | null;
    warehouse_id: string | null;
    order_link: string | null;
    conversation_id: string | null;
    assigning_seller: Record<string, any> | null;
    total_discount: unknown | null;
    shipping_fee: unknown | null;
    bank_payments: unknown | null;
    surcharge: unknown | null;
    duplicated_phone: unknown | null;
    duplicated_ip: unknown | null;
    histories: any[] | null;
  } | null;
  assigningCare?: string | null;
}

type PosOrderCurrencyContext = {
  orderCurrency: string | null;
  currencyDivisor: number;
};

type UndeliverableAttemptPayload = {
  sourceEventKey: string;
  attemptNumber: number;
  failedAt: Date;
  partnerStatusOld: string | null;
  returnedReason: any | null;
  subStatus: any | null;
  sourceTags: any | null;
};

export type PosOrderUpsertStatus = 'UPSERTED' | 'SKIPPED' | 'DELETED' | 'FAILED';

export interface PosOrderUpsertOutcome {
  shopId: string | null;
  orderId: string | null;
  status: number | null;
  upsertStatus: PosOrderUpsertStatus;
  reason?: string;
  warning?: string;
}

export function shouldTreatNoProductSnapshotAsVoid(
  isNoProductOrder: boolean,
  status: number | null | undefined,
) {
  if (!isNoProductOrder) {
    return false;
  }

  return status !== 1 && status !== 9 && status !== 12;
}

export function shouldQueueWmsFulfillmentSync(
  status: number | null | undefined,
  isVoid: boolean,
) {
  return !isVoid && (status === 1 || status === 9 || status === 12);
}

@Injectable()
export class PosOrderService {
  private readonly logger = new Logger(PosOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wmsFulfillmentSyncService: WmsFulfillmentSyncService,
    private readonly wmsInventoryService: WmsInventoryService,
    private readonly wmsOutboundRecordsService: WmsOutboundRecordsService,
    @Optional()
    private readonly workflowExecutionGateway?: WorkflowExecutionGateway,
  ) {}

  private emitOrderStatusSummaryUpdate(params: {
    tenantId: string;
    source: 'pos_upsert';
    changedOrderCount: number;
  }) {
    this.workflowExecutionGateway?.emitTenantEvent(
      params.tenantId,
      null,
      ORDERS_STATUS_SUMMARY_UPDATED_EVENT,
      {
        tenantId: params.tenantId,
        source: params.source,
        changedOrderCount: params.changedOrderCount,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  private emitUndeliverablesUpdate(params: {
    tenantId: string;
    source: 'pos_upsert';
    changedOrderCount: number;
  }) {
    this.workflowExecutionGateway?.emitTenantEvent(
      params.tenantId,
      null,
      ORDERS_UNDELIVERABLES_UPDATED_EVENT,
      {
        tenantId: params.tenantId,
        source: params.source,
        changedOrderCount: params.changedOrderCount,
        updatedAt: new Date().toISOString(),
      },
    );
  }

  private extractStatusTimestampFromHistory(
    status: number | null | undefined,
    statusHistory: any[] | null,
    targetStatus: number,
  ): Date | null {
    if (status !== targetStatus || !Array.isArray(statusHistory) || statusHistory.length === 0) {
      return null;
    }

    let latestRaw: string | null = null;
    let latestTs = -Infinity;
    let fallbackRaw: string | null = null;

    statusHistory.forEach((entry: any) => {
      if (!entry || entry.status !== targetStatus) return;
      const updatedRaw = typeof entry.updated_at === 'string' ? entry.updated_at.trim() : '';
      if (!updatedRaw) return;

      fallbackRaw = updatedRaw;
      const ts = Date.parse(updatedRaw);
      if (!Number.isNaN(ts) && ts > latestTs) {
        latestTs = ts;
        latestRaw = updatedRaw;
      }
    });

    const pickedRaw = latestRaw ?? fallbackRaw;
    if (!pickedRaw) return null;

    const parsed = dayjs.utc(pickedRaw);
    if (!parsed.isValid()) return null;

    return parsed.tz('Asia/Manila').toDate();
  }

  private parseOrderHistories(rawOrder: any): any[] | null {
    let histories: any = rawOrder?.histories ?? null;
    if (isString(histories)) {
      try {
        histories = JSON.parse(histories);
      } catch {
        histories = null;
      }
    }

    return Array.isArray(histories) ? histories : null;
  }

  private parseTrackingUpdates(rawOrder: any): Array<Record<string, unknown>> | undefined {
    const partner = isObject(rawOrder?.partner) ? rawOrder.partner : null;
    const candidates: Array<{ owner: Record<string, any> | null; key: string }> = [
      { owner: partner, key: 'extend_update' },
      { owner: partner, key: 'extendUpdate' },
      { owner: isObject(rawOrder) ? rawOrder : null, key: 'extend_update' },
      { owner: isObject(rawOrder) ? rawOrder : null, key: 'extendUpdate' },
    ];
    const source = candidates.find(({ owner, key }) =>
      owner ? Object.prototype.hasOwnProperty.call(owner, key) : false,
    );

    if (!source?.owner) {
      return undefined;
    }

    let updates: unknown = source.owner[source.key];
    if (isString(updates)) {
      try {
        updates = JSON.parse(updates);
      } catch {
        return undefined;
      }
    }

    if (!Array.isArray(updates)) {
      return undefined;
    }

    return updates
      .filter((entry): entry is Record<string, any> => isObject(entry))
      .map((entry) => ({
        key: this.toOptionalString(entry.key),
        note: this.toOptionalString(entry.note) ?? '',
        status: this.toOptionalString(entry.status) ?? '',
        tracking_id: this.toOptionalString(entry.tracking_id ?? entry.trackingId),
        update_at: this.toOptionalString(entry.update_at ?? entry.updateAt),
        webhook_params: entry.webhook_params ?? entry.webhookParams ?? null,
      }));
  }

  private toOptionalString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = value.toString().trim();
    return normalized || null;
  }

  private buildUndeliverableAttemptEventKey(entry: any, index: number) {
    const source = JSON.stringify({
      index,
      updated_at: isString(entry?.updated_at) ? entry.updated_at.trim() : null,
      partner_status: entry?.partner_status ?? null,
      returned_reason: entry?.returned_reason ?? null,
      sub_status: entry?.sub_status ?? null,
      tags: entry?.tags ?? null,
    });

    return createHash('sha256').update(source).digest('hex');
  }

  private extractUndeliverableAttempts(rawOrder: any): UndeliverableAttemptPayload[] {
    const histories = this.parseOrderHistories(rawOrder);
    if (!histories || histories.length === 0) {
      return [];
    }

    return histories
      .map((entry: any, index: number) => ({ entry, index }))
      .filter(({ entry }) => isObject(entry))
      .filter(({ entry }) => {
        const partnerStatus = isObject(entry.partner_status) ? entry.partner_status : null;
        const nextStatus = isString(partnerStatus?.new) ? partnerStatus.new.trim().toLowerCase() : '';
        return nextStatus === 'undeliverable';
      })
      .map(({ entry, index }) => {
        const updatedRaw = isString(entry.updated_at) ? entry.updated_at.trim() : '';
        const parsed = updatedRaw ? dayjs.utc(updatedRaw) : null;
        if (!parsed || !parsed.isValid()) return null;

        const partnerStatus = isObject(entry.partner_status) ? entry.partner_status : null;
        const oldStatus = isString(partnerStatus?.old) ? partnerStatus.old.trim() : null;

        return {
          sourceEventKey: this.buildUndeliverableAttemptEventKey(entry, index),
          attemptNumber: 0,
          failedAt: parsed.toDate(),
          partnerStatusOld: oldStatus,
          returnedReason: entry.returned_reason ?? null,
          subStatus: entry.sub_status ?? null,
          sourceTags: entry.tags ?? null,
        };
      })
      .filter((value): value is UndeliverableAttemptPayload => Boolean(value))
      .sort((left, right) => left.failedAt.getTime() - right.failedAt.getTime())
      .map((attempt, index) => ({
        ...attempt,
        attemptNumber: index + 1,
      }));
  }

  private extractUndeliverableState(rawOrder: any) {
    const attempts = this.extractUndeliverableAttempts(rawOrder);

    const firstUndeliverableAt = attempts[0]?.failedAt ?? null;

    return {
      isUndeliverable: Boolean(firstUndeliverableAt),
      undeliverableAt: firstUndeliverableAt,
    };
  }

  private async syncUndeliverableAttempts(params: {
    tenantId: string;
    storeId: string;
    orderId: string;
    rawOrder: any;
  }) {
    const attempts = this.extractUndeliverableAttempts(params.rawOrder);
    if (attempts.length === 0) {
      return;
    }

    await this.prisma.$transaction(
      attempts.map((attempt) => {
        const data = {
          storeId: params.storeId,
          attemptNumber: attempt.attemptNumber,
          failedAt: attempt.failedAt,
          partnerStatusOld: attempt.partnerStatusOld,
          partnerStatusNew: 'undeliverable',
          returnedReason: this.jsonOrDbNull(attempt.returnedReason),
          subStatus: this.jsonOrDbNull(attempt.subStatus),
          sourceTags: this.jsonOrDbNull(attempt.sourceTags),
        };

        return this.prisma.undeliverableAttempt.upsert({
          where: {
            orderId_sourceEventKey: {
              orderId: params.orderId,
              sourceEventKey: attempt.sourceEventKey,
            },
          },
          create: {
            tenantId: params.tenantId,
            orderId: params.orderId,
            sourceEventKey: attempt.sourceEventKey,
            ...data,
          },
          update: data,
        });
      }),
    );
  }

  /**
   * Extract mapping from note_product field
   * Example: "Agriblast-100" -> "Agriblast"
   */
  private extractMapping(noteProduct?: string): string | undefined {
    if (!noteProduct) return undefined;

    // Remove numeric suffix and trim
    const match = noteProduct.match(/^([A-Za-z\s]+)/);
    return match ? match[1].trim() : undefined;
  }

  private resolveOrderCurrencyContext(rawOrder: any): PosOrderCurrencyContext {
    const rawOrderCurrency = rawOrder?.order_currency ?? rawOrder?.orderCurrency ?? null;
    const orderCurrency = typeof rawOrderCurrency === 'string' || typeof rawOrderCurrency === 'number'
      ? rawOrderCurrency.toString().trim().toUpperCase() || null
      : null;

    if (!orderCurrency) {
      return {
        orderCurrency: null,
        currencyDivisor: 1,
      };
    }

    const multiplierMatch = orderCurrency.match(/^[A-Z]{3}(\d+(?:\.\d+)?)$/);
    if (!multiplierMatch) {
      return {
        orderCurrency,
        currencyDivisor: 1,
      };
    }

    const parsedDivisor = parseFloat(multiplierMatch[1] ?? '1');
    return {
      orderCurrency,
      currencyDivisor: Number.isFinite(parsedDivisor) && parsedDivisor > 0 ? parsedDivisor : 1,
    };
  }

  private scaleCurrencyAmount(value: unknown, currencyDivisor: number): number {
    const parsedValue = parseFloat(value == null ? '0' : String(value));
    if (!Number.isFinite(parsedValue)) {
      return NaN;
    }

    const safeDivisor = Number.isFinite(currencyDivisor) && currencyDivisor > 0 ? currencyDivisor : 1;
    return parsedValue / safeDivisor;
  }

  private parseNoteProductCogs(noteProduct: any, quantity: number): number {
    if (!noteProduct || typeof noteProduct !== 'string') return 0;
    const parts = noteProduct.split('-');
    const numRaw = parts[1] ?? '';
    const num = parseFloat((numRaw || '').toString().replace(/[^0-9.\\-]/g, ''));
    if (isNaN(num)) return 0;
    const qtySafe = Math.max(quantity || 0, 1);
    return num * qtySafe;
  }

  /**
   * Derive mapping from productId values by matching pos_products.productId.
   * If multiple distinct mappings found, join with '-' in stable order.
   */
  private async deriveMappingFromItems(
    storeId: string,
    items: any[],
  ): Promise<string | undefined> {
    const productIds = Array.from(
      new Set(
        items
          .map((item: any) => item?.product_id?.toString?.() || item?.productId?.toString?.())
          .filter((v: string | undefined) => !!v),
      ),
    ) as string[];

    if (productIds.length === 0) return undefined;

    const products = await this.prisma.posProduct.findMany({
      where: {
        storeId,
        productId: { in: productIds },
      },
      select: { mapping: true, variationId: true },
    });

    // Single, uniquely-identifiable product -> store the precise store+variation
    // key so the per-product breakdown can name it. (storeId, variationId) is
    // unique in pos_products, so this can't collide across stores/variations.
    const distinctVariationIds = Array.from(
      new Set(products.map((p) => (p.variationId || '').trim()).filter((v) => v.length > 0)),
    );
    if (distinctVariationIds.length === 1) {
      const key = buildProductMappingKey(storeId, distinctVariationIds[0]);
      if (key) return key;
    }

    // Multi-product or no variationId -> fall back to the coarse mapping label
    // (unchanged behaviour), keeping the ad<->sales join intact.
    const mappings = products
      .map((p) => (p.mapping || '').trim())
      .filter((m) => m.length > 0)
      .map((m) => m.toLowerCase());

    if (mappings.length === 0) return undefined;

    const unique = Array.from(new Set(mappings));
    if (unique.length === 1) return unique[0];

    unique.sort();
    return unique.join('-');
  }

  /** Resolve one catalog identity without guessing between sibling variants. */
  private async resolveCogsProduct(tenantId: string, storeId: string, item: any,
    client: Pick<Prisma.TransactionClient, 'posProduct'> = this.prisma) {
    const identifier = this.readCogsIdentifier;
    const variationId = identifier(item?.variation_id) ?? identifier(item?.variationId);
    const productIds = [identifier(item?.product_id), identifier(item?.productId)]
      .filter((value): value is string => Boolean(value));
    const displayIds = [
      identifier(item?.product_display_id),
      identifier(item?.productDisplayId),
      identifier(item?.variation_info?.product_display_id),
      identifier(item?.variation_info?.display_id),
      identifier(item?.variation_info?.barcode),
    ].filter((value): value is string => Boolean(value));
    const candidateIds = Array.from(new Set([...productIds, ...displayIds]));
    if (!variationId && candidateIds.length === 0) return null;

    const products = await client.posProduct.findMany({
      where: {
        storeId,
        store: { tenantId },
        OR: [
          ...(variationId ? [{ variationId }] : []),
          { productId: { in: candidateIds } },
          { customId: { in: candidateIds } },
        ],
      },
      select: { id: true, productId: true, variationId: true, customId: true },
    });

    // A parent product may have differently priced variants. An explicit
    // variation is authoritative and must never resolve to an arbitrary sibling.
    if (variationId) {
      const exact = products.find((product) => product.variationId === variationId);
      if (exact) return exact;
    }

    // Older catalog rows may have no real variation ID. Preserve their unique
    // product/display lookup, but do not substitute a different modern variant
    // when the source variation is absent from the catalog.
    const eligible = variationId
      ? products.filter((product) => !product.variationId || product.variationId === product.productId)
      : products;
    const displayMatches = eligible.filter((product) =>
      product.customId && displayIds.includes(product.customId));
    if (displayMatches.length > 0) {
      return displayMatches.length === 1 ? displayMatches[0] : null;
    }
    const legacyMatches = eligible.filter((product) =>
      candidateIds.includes(product.productId)
      || Boolean(product.customId && candidateIds.includes(product.customId)));
    return legacyMatches.length === 1 ? legacyMatches[0] : null;
  }

  private readCogsIdentifier(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    return String(value).trim() || null;
  }

  /** Calculate catalog COGS for the order date, with the legacy note fallback. */
  private async calculateCogs(
    tenantId: string,
    storeId: string,
    items: any[],
    dateLocal: string,
    client: Pick<Prisma.TransactionClient, 'posProduct' | 'posProductCogs'> = this.prisma,
  ): Promise<{ cogs: number; totalQuantity: number }> {
    let totalCogs = 0;
    let totalQuantity = 0;

    const orderDate = new Date(dateLocal);

    for (const item of items) {
      const quantity = parseInt(item.quantity || '0', 10);
      const noteCogs = this.parseNoteProductCogs(item?.note_product, quantity);
      if (quantity === 0) {
        if (noteCogs > 0) {
          totalCogs += noteCogs;
        }
        continue;
      }

      const product = await this.resolveCogsProduct(tenantId, storeId, item, client);

      if (!product) {
        if (noteCogs > 0) {
          totalCogs += noteCogs;
        } else {
          this.logger.warn(`COGS unresolved catalog identity ${JSON.stringify({
            storeId,
            productId: this.readCogsIdentifier(item?.product_id) ?? this.readCogsIdentifier(item?.productId),
            variationId: this.readCogsIdentifier(item?.variation_id) ?? this.readCogsIdentifier(item?.variationId),
          })}`);
        }
        continue;
      }

      // Get COGS for the order date
      let cogsEntry = await client.posProductCogs.findFirst({
        where: {
          tenantId,
          productId: product.id,
          storeId,
          AND: [{ startDate: { not: null } }, { startDate: { lte: orderDate } }],
          OR: [{ endDate: { gte: orderDate } }, { endDate: null }],
        },
        orderBy: [{ startDate: 'desc' }, { updatedAt: 'desc' }],
      });

      if (!cogsEntry) {
        // Undated legacy defaults may fill a gap, but a dated cost must never
        // leak outside its effective window when an older order is reingested.
        cogsEntry = await client.posProductCogs.findFirst({
          where: {
            tenantId,
            productId: product.id,
            storeId,
            startDate: null,
            OR: [{ endDate: { gte: orderDate } }, { endDate: null }],
          },
          orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        });
      }

      if (cogsEntry) {
        const itemCogs = parseFloat(cogsEntry.cogs.toString()) * quantity;
        totalCogs += itemCogs;
      } else if (noteCogs > 0) {
        totalCogs += noteCogs;
      }

      totalQuantity += quantity;
    }

    return { cogs: totalCogs, totalQuantity };
  }

  /** Re-read the ERP source and persist under the same source locks. */
  private async withLockedErpCogsSource<T>(tenantId: string, storeId: string, items: any[], order: PosOrderData,
    persist: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5000ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15000ms'");
      await tx.$executeRawUnsafe('LOCK TABLE pos_stores,pos_products IN SHARE MODE');
      const stores = await tx.posStore.findMany({ where: { tenantId, shopId: order.shopId }, select: { id: true } });
      if (stores.length !== 1 || stores[0].id !== storeId) throw new ConflictException('ERP COGS store scope is ambiguous');
      // Catalog identity cannot change under table locks. Resolve before
      // sorting parents, but defer every history read until parents are held.
      const ids = new Set<string>();
      for (const item of items) {
        if (parseInt(item.quantity || '0', 10) === 0) continue;
        const product = await this.resolveCogsProduct(tenantId, storeId, item, tx);
        if (product) ids.add(product.id);
      }
      const sortedIds = [...ids].sort();
      if (sortedIds.length) {
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(COGS_REFRESH_PARENT_LOCK_SQL, sortedIds, storeId, tenantId);
        if (locked.length !== sortedIds.length) throw new ConflictException('ERP COGS catalog scope changed');
      }
      const fresh = await this.calculateCogs(tenantId, storeId, items, order.dateLocal, tx);
      // Per-item fallback runs only when catalog evidence is missing.
      // A verified catalog total of zero is intentional partner-supplied stock.
      order.cogs = fresh.cogs;
      order.totalQuantity = fresh.totalQuantity;
      // Existing deletion/ownership transactions can lock an order before
      // changing stores. Retry rather than wait on them under catalog locks.
      await tx.$queryRawUnsafe(`SELECT id FROM pos_orders
        WHERE "tenantId"=$1::uuid AND "shopId"=$2 AND "posOrderId"=$3 FOR UPDATE NOWAIT`, tenantId, order.shopId, order.posOrderId);
      return persist(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 20000 });
  }

  /**
   * Parse Pancake POS order data into our schema
   */
  private async parsePosOrder(
    tenantId: string,
    storeId: string,
    rawOrder: any,
    initialValueOffer: number | null,
  ): Promise<PosOrderData> {
    const currencyContext = this.resolveOrderCurrencyContext(rawOrder);

    // Skip abandoned Shopify checkouts: status 0 with abandon checkout id
    if (
      (rawOrder?.status === 0 || rawOrder?.status === '0') &&
      rawOrder?.shopify_abandon_checkout_id
    ) {
      throw new Error('skip_abandoned_checkout');
    }

    // Treat inserted_at as UTC and derive Manila-local date
    const insertedAtUtc = dayjs.utc(rawOrder.inserted_at);
    const insertedAt = insertedAtUtc.toDate();
    const dateLocal = insertedAtUtc.tz('Asia/Manila').format('YYYY-MM-DD');

    // Extract item info
    const items = rawOrder.items || [];
    const firstItem = items[0];

    // Calculate COGS from note_product
    let { cogs, totalQuantity } = await this.calculateCogs(
      tenantId,
      storeId,
      items,
      dateLocal,
    );

    // Extract mapping from productId -> pos_products.mapping first
    const noteProduct = firstItem?.note_product;
    let mapping = await this.deriveMappingFromItems(storeId, items);

    // Fallback to note_product parsing if no mapping from products
    if (!mapping) {
      mapping = this.extractMapping(noteProduct);
    }

    // Build item data snapshot
    const itemData = items.map((item: any) => {
      const variation = item.variation_info || {};
      return {
        quantity: item.quantity ?? null,
        productId: item.product_id ?? item.productId ?? null,
        variationId: item.variation_id ?? item.variationId ?? null,
        variationName: variation.name ?? null,
        productDisplayId: variation.product_display_id ?? item.product_display_id ?? item.productDisplayId
          ?? variation.display_id ?? variation.barcode ?? null,
      };
    });

    const customerRaw = rawOrder.customer && typeof rawOrder.customer === 'object' ? rawOrder.customer : null;
    const customerName =
      (customerRaw?.name ?? customerRaw?.full_name ?? customerRaw?.fullName ?? undefined) || undefined;
    const customerAddresses =
      customerRaw?.shop_customer_addresses ?? customerRaw?.shop_customer_address ?? null;
    let addressEntry: any = null;
    if (Array.isArray(customerAddresses)) {
      addressEntry = customerAddresses.find((addr) => addr && (addr.full_address || addr.address)) || customerAddresses[0];
    } else if (customerAddresses && typeof customerAddresses === 'object') {
      addressEntry = customerAddresses;
    }
    const customerPhoneNumbersRaw = customerRaw?.phone_numbers ?? customerRaw?.phoneNumbers ?? null;
    const customerPhoneFromList = Array.isArray(customerPhoneNumbersRaw)
      ? customerPhoneNumbersRaw
          .map((phone: any) =>
            typeof phone === 'string' || typeof phone === 'number' ? phone.toString().trim() : '',
          )
          .find((phone: string) => phone.length > 0)
      : undefined;
    const customerPhone = customerPhoneFromList ?? addressEntry?.phone_number ?? addressEntry?.phone ?? undefined;
    const customerAddress = addressEntry?.full_address ?? addressEntry?.address ?? undefined;
    const rawDeliveryAttemptFailed =
      rawOrder?.partner?.count_of_delivery
      ?? rawOrder?.partner?.countOfDelivery
      ?? rawOrder?.partner_count_of_delivery
      ?? rawOrder?.partnerCountOfDelivery
      ?? 0;
    const parsedDeliveryAttemptFailed = Number(rawDeliveryAttemptFailed);
    const deliveryAttemptFailed = Number.isFinite(parsedDeliveryAttemptFailed)
      ? Math.max(0, Math.trunc(parsedDeliveryAttemptFailed))
      : 0;
    const trackingUpdates = this.parseTrackingUpdates(rawOrder);

    const customerCare =
      rawOrder.assigning_care && typeof rawOrder.assigning_care === 'object'
        ? rawOrder.assigning_care.name || undefined
        : undefined;

    const marketer =
      rawOrder.marketer && typeof rawOrder.marketer === 'object'
        ? rawOrder.marketer.name || undefined
        : undefined;

    // Normalize assigning care (fb id only)
    const assigningCareRaw = rawOrder.assigning_care ?? null;
    let assigningCare: string | null = null;
    if (assigningCareRaw) {
      if (typeof assigningCareRaw === 'object') {
        assigningCare = assigningCareRaw.fb_id?.toString?.() || null;
      } else if (typeof assigningCareRaw === 'string') {
        assigningCare = assigningCareRaw.trim() || null;
      }
    }

    // Tags: allow array or JSON string
    let parsedTags: any = rawOrder.tags ?? null;
    if (typeof parsedTags === 'string') {
      try {
        const decoded = JSON.parse(parsedTags);
        if (Array.isArray(decoded)) parsedTags = decoded;
      } catch {
        // keep as-is
      }
    }
    const tags = Array.isArray(parsedTags)
      ? parsedTags
          .filter((t) => t && (typeof t === 'string' || typeof t === 'object'))
          .map((t: any) =>
            typeof t === 'string'
              ? { id: '', name: t }
              : { id: t.id?.toString?.() || '', name: t.name || '' }
          )
      : [];
    const hasRiskConfirmationTag = this.hasTagNameInList(tags, ['risk confirmation']);
    const isRepurchase = this.hasTagNameInList(tags, ['repurchase']);

    // RTS reason: split returned_reason_name by "/"
    let rtsReason: { l1: string | null; l2: string | null; l3: string | null } | null = null;
    if (typeof rawOrder.returned_reason_name === 'string' && rawOrder.returned_reason_name.trim() !== '') {
      const parts = rawOrder.returned_reason_name.split('/').map((p: string) => p.trim());
      const l1 = parts[0] || null;
      const l2 = parts[1] || null;
      const l3 = parts.length > 2 ? parts.slice(2).join('/') || null : null;
      if (l1 || l2 || l3) {
        rtsReason = { l1, l2, l3 };
      }
    }

    const statusHistory = Array.isArray(rawOrder.status_history) ? rawOrder.status_history : null;
    const hasConfirmedHistory = Array.isArray(statusHistory)
      ? statusHistory.some((entry: any) => entry?.status === 1)
      : false;
    const isRiskConfirmation = hasRiskConfirmationTag && hasConfirmedHistory;
    const numericStatus = Number(rawOrder?.status);
    const normalizedStatus = Number.isFinite(numericStatus) ? numericStatus : null;
    const isWebcakeAbandonedCart =
      rawOrder?.is_webcake_abandoned_cart === true || rawOrder?.isWebcakeAbandonedCart === true;
    const isAbandoned = normalizedStatus === 0 && isWebcakeAbandonedCart;
    const deliveredAt = this.extractStatusTimestampFromHistory(
      normalizedStatus,
      statusHistory,
      3,
    );
    const rtsAt = this.extractStatusTimestampFromHistory(
      normalizedStatus,
      statusHistory,
      5,
    );
    const { isUndeliverable, undeliverableAt } = this.extractUndeliverableState(rawOrder);

    // Sales assignee: prefer assigning_seller.fb_id, fallback to latest status_history with status==1
    let salesAssignee: string | null = null;
    const assigningSellerRaw = rawOrder.assigning_seller ?? null;
    if (assigningSellerRaw && typeof assigningSellerRaw === 'object') {
      const fbId = assigningSellerRaw.fb_id ?? assigningSellerRaw.fbId ?? null;
      if (fbId) {
        salesAssignee = fbId.toString();
      }
    } else if (typeof assigningSellerRaw === 'string') {
      const trimmed = assigningSellerRaw.trim();
      if (trimmed) salesAssignee = trimmed;
    }

    if (!salesAssignee && Array.isArray(statusHistory)) {
      let latestEntry: any = null;
      let latestTs = -Infinity;
      let latestIdx = -1;
      statusHistory.forEach((entry: any, idx: number) => {
        if (!entry || entry.status !== 1) return;
        const updatedRaw = entry.updated_at ?? null;
        const ts = typeof updatedRaw === 'string' ? Date.parse(updatedRaw) : NaN;
        if (!isNaN(ts)) {
          if (ts > latestTs) {
            latestTs = ts;
            latestEntry = entry;
          }
          return;
        }
        if (latestTs === -Infinity && idx > latestIdx) {
          latestIdx = idx;
          latestEntry = entry;
        }
      });

      if (latestEntry) {
        const fbId =
          latestEntry.editor_fb ??
          latestEntry.editor?.fb_id ??
          latestEntry.editor?.fbId ??
          null;
        if (fbId) {
          salesAssignee = fbId.toString();
        }
      }
    }

    const hasUpsellTag = this.hasUpsellTagInList(rawOrder?.tags ?? null);
    // Compute history-based breakdown even without tag (used for forUpsell baseline)
    const historyBreakdown = this.computeUpsellBreakdown(rawOrder, currencyContext.currencyDivisor, false);
    // Only persist upsell breakdown if tagged
    const upsellBreakdown = hasUpsellTag ? historyBreakdown : null;

    const snapshotCustomer =
      rawOrder?.customer && typeof rawOrder.customer === 'object' && !Array.isArray(rawOrder.customer)
        ? rawOrder.customer
        : null;
    const snapshotShippingAddress =
      rawOrder?.shipping_address
      && typeof rawOrder.shipping_address === 'object'
      && !Array.isArray(rawOrder.shipping_address)
        ? rawOrder.shipping_address
        : null;
    const snapshotNote = typeof rawOrder?.note === 'string' ? rawOrder.note : null;
    const snapshotNotePrint = typeof rawOrder?.note_print === 'string' ? rawOrder.note_print : null;
    const snapshotItems = Array.isArray(rawOrder?.items) ? rawOrder.items : null;
    const rawWarehouseId =
      rawOrder?.warehouse_id
      ?? rawOrder?.warehouseId
      ?? rawOrder?.warehouse?.id
      ?? null;
    const snapshotWarehouseId =
      typeof rawWarehouseId === 'string' || typeof rawWarehouseId === 'number'
        ? rawWarehouseId.toString().trim() || null
        : null;
    const rawOrderLink = rawOrder?.order_link ?? rawOrder?.orderLink ?? null;
    const snapshotOrderLink =
      typeof rawOrderLink === 'string' || typeof rawOrderLink === 'number'
        ? rawOrderLink.toString()
        : null;
    const rawConversationId = rawOrder?.conversation_id ?? rawOrder?.conversationId ?? null;
    const snapshotConversationId =
      typeof rawConversationId === 'string' || typeof rawConversationId === 'number'
        ? rawConversationId.toString()
        : null;
    const snapshotAssigningSeller =
      rawOrder?.assigning_seller
      && typeof rawOrder.assigning_seller === 'object'
      && !Array.isArray(rawOrder.assigning_seller)
        ? rawOrder.assigning_seller
        : null;
    const snapshotHistories = this.parseOrderHistories(rawOrder);
    const snapshotTotalDiscount = rawOrder?.total_discount ?? null;
    const snapshotShippingFee = rawOrder?.shipping_fee ?? null;
    const snapshotBankPayments = rawOrder?.bank_payments ?? null;
    const snapshotSurcharge = rawOrder?.surcharge ?? null;
    const snapshotDuplicatedPhone = rawOrder?.duplicated_phone ?? rawOrder?.duplicatedPhone ?? null;
    const snapshotDuplicatedIp = rawOrder?.duplicated_ip ?? rawOrder?.duplicatedIp ?? null;
    const orderSnapshot = {
      customer: snapshotCustomer,
      shipping_address: snapshotShippingAddress,
      note: snapshotNote,
      note_print: snapshotNotePrint,
      items: snapshotItems,
      warehouse_id: snapshotWarehouseId,
      order_link: snapshotOrderLink,
      conversation_id: snapshotConversationId,
      assigning_seller: snapshotAssigningSeller,
      total_discount: snapshotTotalDiscount,
      shipping_fee: snapshotShippingFee,
      bank_payments: snapshotBankPayments,
      surcharge: snapshotSurcharge,
      order_currency: currencyContext.orderCurrency,
      currency_divisor: currencyContext.currencyDivisor,
      duplicated_phone: snapshotDuplicatedPhone,
      duplicated_ip: snapshotDuplicatedIp,
      histories: snapshotHistories,
    };

    const codValue = this.scaleCurrencyAmount(rawOrder.cod, currencyContext.currencyDivisor);
    const hasCod = Number.isFinite(codValue);
    let upsellDelta = 0;
    if (upsellBreakdown && typeof upsellBreakdown === 'object') {
      const newAmount = parseFloat(upsellBreakdown.new_amount ?? '0');
      const originalAmount = parseFloat(upsellBreakdown.original_amount ?? '0');
      if (Number.isFinite(newAmount) && Number.isFinite(originalAmount)) {
        upsellDelta = newAmount - originalAmount;
      }
    }

    const adsSource = rawOrder?.ads_source?.toString?.().trim?.().toLowerCase?.() || '';
    const orderSourceName = rawOrder?.order_sources_name?.toString?.().trim?.().toLowerCase?.() || '';
    const isMarketingSource = adsSource === 'facebook' || orderSourceName === 'webcake';
    const safeCod = hasCod ? codValue : 0;
    const mktgCod = isMarketingSource ? safeCod - upsellDelta : 0;

    let forUpsell = false;
    if (initialValueOffer !== null && initialValueOffer > 0 && hasCod) {
      let baselineAmount = safeCod;
      const originalRaw = historyBreakdown?.original_amount;
      const originalVal = parseFloat(originalRaw ?? '0');
      if (Number.isFinite(originalVal) && originalVal > 0) {
        baselineAmount = originalVal;
      }
      forUpsell = baselineAmount <= initialValueOffer;
    }

    let salesCod = 0;
    if (normalizedStatus === 6) {
      salesCod = 0;
    } else if (hasConfirmedHistory) {
      salesCod = safeCod;
    }

    // Fallback mapping: if still empty, derive from note_product first segment
    if (!mapping && typeof noteProduct === 'string' && noteProduct.trim() !== '') {
      const parts = noteProduct.split('-');
      const first = parts[0]?.trim();
      if (first) {
        mapping = first;
      }
    }

    // Normalize mapping to lowercase for consistent matching
    if (mapping) {
      mapping = mapping.trim().toLowerCase();
    }

    const partnerExtend = (rawOrder.partner && typeof rawOrder.partner === 'object')
      ? rawOrder.partner.extend_code || rawOrder.partner.extendCode || null
      : null;

    return {
      shopId: rawOrder.shop_id?.toString(),
      posOrderId: rawOrder.id?.toString(),
      insertedAt,
      dateLocal,
      deliveredAt,
      rtsAt,
      undeliverableAt,
      status: normalizedStatus ?? undefined,
      statusName: rawOrder.status_name,
      cod: codValue,
      salesCod,
      mktgCod,
      isMarketingSource,
      forUpsell,
      isRiskConfirmation,
      isAbandoned,
      wasAbandonedCart: isWebcakeAbandonedCart,
      isRepurchase,
      isUndeliverable,
      isVoid: normalizedStatus === 7,
      pUtmCampaign: rawOrder.p_utm_campaign,
      pUtmContent: rawOrder.p_utm_content,
      cogs,
      totalQuantity,
      // Use partner extend_code as tracking marker; do not fall back to item tracking
      tracking: partnerExtend,
      mapping,
      itemData,
      tags,
      customerCare,
      marketer,
      salesAssignee,
      customerName,
      customerPhone,
      customerAddress,
      deliveryAttemptFailed,
      statusHistory,
      trackingUpdates,
      rtsReason,
      upsellBreakdown,
      orderSnapshot,
      assigningCare,
    };
  }

  /**
   * Upsert POS orders to database
   * Uses upsert pattern to handle re-running workflows for same dates
   */
  async upsertPosOrders(
    tenantId: string,
    storeId: string,
    rawOrders: any[],
    teamId: string | null,
  ): Promise<number> {
    const result = await this.upsertPosOrdersInternal(tenantId, storeId, rawOrders, teamId, true);
    return result.upserted;
  }

  async upsertPosOrdersWithOutcomes(
    tenantId: string,
    storeId: string,
    rawOrders: any[],
    teamId: string | null,
  ): Promise<{ upserted: number; outcomes: PosOrderUpsertOutcome[] }> {
    return this.upsertPosOrdersInternal(tenantId, storeId, rawOrders, teamId, false);
  }

  private async upsertPosOrdersInternal(
    tenantId: string,
    storeId: string,
    rawOrders: any[],
    teamId: string | null,
    throwOnFailure: boolean,
  ): Promise<{ upserted: number; outcomes: PosOrderUpsertOutcome[] }> {
    let upserted = 0;
    const outcomes: PosOrderUpsertOutcome[] = [];
    const fulfillmentCandidates: Array<{ shopId: string; posOrderId: string }> = [];
    const canceledFulfillmentCandidates: Array<{ shopId: string; posOrderId: string }> = [];
    const dispatchCandidates: Array<{ shopId: string; posOrderId: string }> = [];
    const outboundRecordCandidates: Array<{ shopId: string; posOrderId: string }> = [];

    const store = await this.prisma.posStore.findFirst({
      where: { id: storeId, tenantId },
      select: { initialValueOffer: true, shopId: true, teamId: true },
    });
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { wmsFulfillmentGoLiveAt: true },
    });
    let initialValueOffer: number | null = null;
    if (store?.initialValueOffer !== null && store?.initialValueOffer !== undefined) {
      const value = Number(store.initialValueOffer);
      if (Number.isFinite(value) && value > 0) {
        initialValueOffer = value;
      }
    }

    for (const rawOrder of rawOrders) {
      const statusRaw = Number(rawOrder?.status);
      const status = Number.isFinite(statusRaw) ? statusRaw : null;
      const shopId = rawOrder?.shop_id?.toString?.()?.trim?.() || null;
      const posOrderId = rawOrder?.id?.toString?.()?.trim?.() || null;

      const sourceName = rawOrder?.order_sources_name?.toString?.().trim?.() || '';
      const sourceNameLower = sourceName.toLowerCase();
      if (sourceNameLower === 'tiktok' || sourceNameLower === 'shopee') {
        outcomes.push({
          shopId,
          orderId: posOrderId,
          status,
          upsertStatus: 'SKIPPED',
          reason: `SOURCE_EXCLUDED_${sourceNameLower.toUpperCase()}`,
        });
        continue;
      }

      const hasInvalidTag = this.hasTagNameInList(rawOrder?.tags, ['duplicate order', 'no product']);
      if (status === 6 && hasInvalidTag) {
        if (shopId && posOrderId) {
          await this.prisma.posOrder.deleteMany({
            where: { tenantId, shopId, posOrderId },
          });
        }
        outcomes.push({
          shopId,
          orderId: posOrderId,
          status,
          upsertStatus: 'DELETED',
          reason: 'STATUS_6_INVALID_TAG',
        });
        continue;
      }

      const hasItemsPayload = Array.isArray(rawOrder.items);
      const items = hasItemsPayload ? rawOrder.items : [];
      const hasProduct = items.some((item: any) => [
        item?.product_id, item?.productId, item?.variation_id, item?.variationId,
        item?.product_display_id, item?.productDisplayId, item?.variation_info?.product_display_id,
        item?.variation_info?.display_id, item?.variation_info?.barcode,
      ].some(value => this.readCogsIdentifier(value) !== null));
      const isNoProductOrder = hasItemsPayload && (items.length === 0 || !hasProduct);

      try {
        const order = await this.parsePosOrder(
          tenantId,
          storeId,
          rawOrder,
          initialValueOffer,
        );
        if (!hasItemsPayload || rawOrder.status === undefined || rawOrder.status === null) {
          const previous = await this.prisma.posOrder.findUnique({
            where: {
              tenantId_shopId_posOrderId: {
                tenantId,
                shopId: order.shopId,
                posOrderId: order.posOrderId,
              },
            },
            select: {
              orderSnapshot: true,
              itemData: true,
              totalQuantity: true,
              isVoid: true,
              status: true,
            },
          });
          const previousSnapshot = previous?.orderSnapshot && typeof previous.orderSnapshot === 'object'
            && !Array.isArray(previous.orderSnapshot)
            ? previous.orderSnapshot as Record<string, unknown>
            : null;
          if (!hasItemsPayload && order.orderSnapshot && previousSnapshot && Array.isArray(previousSnapshot.items)) {
            order.orderSnapshot.items = previousSnapshot.items;
            order.itemData = Array.isArray(previous?.itemData)
              ? previous.itemData
              : order.itemData;
            order.totalQuantity = previous?.totalQuantity ?? order.totalQuantity;
            order.isVoid = previous?.isVoid ?? order.isVoid;
          }
          if (rawOrder.status === undefined || rawOrder.status === null) {
            order.status = previous?.status ?? order.status;
          }
        }
        // Pancake emits variation replacements as two separate snapshots: the
        // old item is removed first, then the replacement is added a few
        // seconds later. A confirmed order with an explicitly empty item list
        // is therefore an incomplete fulfillment snapshot, not a POS void.
        // Keep it confirmed so WMS can pause it as ISSUE and converge when the
        // replacement snapshot arrives. Only non-fulfillable statuses may use
        // an empty item list as void evidence.
        const shouldTreatAsVoid = shouldTreatNoProductSnapshotAsVoid(
          isNoProductOrder,
          order.status,
        );
        const isConfirmedNoProductSnapshot = isNoProductOrder && !shouldTreatAsVoid;
        if (shouldTreatAsVoid) {
          order.isVoid = true;
        }

        const persistOrder = async (client: Prisma.TransactionClient) => {
          const persistedOrder = await client.posOrder.upsert({
            where: {
              tenantId_shopId_posOrderId: {
                tenantId,
                shopId: order.shopId,
                posOrderId: order.posOrderId,
              },
            },
            create: {
              tenantId,
              teamId,
              shopId: order.shopId,
              posOrderId: order.posOrderId,
              insertedAt: order.insertedAt,
              dateLocal: order.dateLocal,
              deliveredAt: order.deliveredAt,
              rtsAt: order.rtsAt,
              undeliverableAt: order.undeliverableAt,
              status: order.status,
              statusName: order.statusName,
              cod: order.cod ? new Decimal(order.cod) : null,
              salesCod: new Decimal(order.salesCod || 0),
              mktgCod: new Decimal(order.mktgCod || 0),
              isMarketingSource: !!order.isMarketingSource,
              forUpsell: !!order.forUpsell,
              isRiskConfirmation: !!order.isRiskConfirmation,
              isAbandoned: !!order.isAbandoned,
              wasAbandonedCart: !!order.wasAbandonedCart,
              isRepurchase: !!order.isRepurchase,
              isUndeliverable: !!order.isUndeliverable,
              isVoid: !!order.isVoid,
              confirmationUpdateRequestedAt: null,
              confirmationUpdateTargetStatus: null,
              pUtmCampaign: order.pUtmCampaign,
              pUtmContent: order.pUtmContent,
              cogs: new Decimal(order.cogs),
              totalQuantity: order.totalQuantity,
              tracking: order.tracking,
              mapping: order.mapping,
              itemData: order.itemData,
              tags: this.jsonOrDbNull(order.tags),
              customerCare: order.customerCare,
              marketer: order.marketer,
              salesAssignee: order.salesAssignee,
              customerName: order.customerName,
              customerPhone: order.customerPhone,
              customerAddress: order.customerAddress,
              deliveryAttemptFailed: order.deliveryAttemptFailed ?? 0,
              statusHistory: this.jsonOrDbNull(order.statusHistory),
              trackingUpdates: this.jsonOrDbNull(order.trackingUpdates ?? null),
              rtsReason: this.jsonOrDbNull(order.rtsReason),
              upsellBreakdown: this.jsonOrDbNull(order.upsellBreakdown),
              orderSnapshot: this.jsonOrDbNull(order.orderSnapshot),
              assigningCare: order.assigningCare,
            },
            update: {
              teamId,
              insertedAt: order.insertedAt,
              ...(order.deliveredAt ? { deliveredAt: order.deliveredAt } : {}),
              ...(order.rtsAt ? { rtsAt: order.rtsAt } : {}),
              undeliverableAt: order.undeliverableAt,
              status: order.status,
              statusName: order.statusName,
              cod: order.cod ? new Decimal(order.cod) : null,
              salesCod: new Decimal(order.salesCod || 0),
              mktgCod: new Decimal(order.mktgCod || 0),
              isMarketingSource: !!order.isMarketingSource,
              forUpsell: !!order.forUpsell,
              isRiskConfirmation: !!order.isRiskConfirmation,
              isAbandoned: !!order.isAbandoned,
              ...(order.wasAbandonedCart ? { wasAbandonedCart: true } : {}),
              isRepurchase: !!order.isRepurchase,
              isUndeliverable: !!order.isUndeliverable,
              isVoid: !!order.isVoid,
              confirmationUpdateRequestedAt: null,
              confirmationUpdateTargetStatus: null,
              pUtmCampaign: order.pUtmCampaign,
              pUtmContent: order.pUtmContent,
              // ERP reporting costs are updated separately only for explicit
              // item payloads. WMS actual unit costs are an independent basis.
              totalQuantity: order.totalQuantity,
              tracking: order.tracking,
              mapping: order.mapping,
              itemData: order.itemData,
              tags: this.jsonOrDbNull(order.tags),
              customerCare: order.customerCare,
              marketer: order.marketer,
              salesAssignee: order.salesAssignee,
              customerName: order.customerName,
              customerPhone: order.customerPhone,
              customerAddress: order.customerAddress,
              deliveryAttemptFailed: order.deliveryAttemptFailed ?? 0,
              statusHistory: this.jsonOrDbNull(order.statusHistory),
              ...(order.trackingUpdates !== undefined
                ? { trackingUpdates: this.jsonOrDbNull(order.trackingUpdates) }
                : {}),
              rtsReason: this.jsonOrDbNull(order.rtsReason),
              upsellBreakdown: this.jsonOrDbNull(order.upsellBreakdown),
              orderSnapshot: this.jsonOrDbNull(order.orderSnapshot),
              assigningCare: order.assigningCare,
            },
          });
          if (hasItemsPayload) {
            await client.posOrder.updateMany({
              where: {
                id: persistedOrder.id,
                tenantId,
                shopId: order.shopId,
                posOrderId: order.posOrderId,
                // Preserve a concurrent ERP reporting-cost correction.
                updatedAt: persistedOrder.updatedAt,
              },
              data: { cogs: new Decimal(order.cogs) },
            });
          }
          return persistedOrder;
        };
        const persistedOrder = hasItemsPayload
          ? await this.withLockedErpCogsSource(tenantId, storeId, items, order, persistOrder)
          : await persistOrder(this.prisma);
        await this.syncUndeliverableAttempts({
          tenantId,
          storeId,
          orderId: persistedOrder.id,
          rawOrder,
        });

        upserted++;
        if (
          shouldQueueWmsFulfillmentSync(order.status, !!order.isVoid)
          && order.shopId
          && order.posOrderId
          && (
            !tenant?.wmsFulfillmentGoLiveAt
            || order.insertedAt >= tenant.wmsFulfillmentGoLiveAt
          )
        ) {
          fulfillmentCandidates.push({
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          });
        }
        if (
          (order.status === 6 || order.isVoid)
          && order.shopId
          && order.posOrderId
          && (
            !tenant?.wmsFulfillmentGoLiveAt
            || order.insertedAt >= tenant.wmsFulfillmentGoLiveAt
          )
        ) {
          canceledFulfillmentCandidates.push({
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          });
        }
        if (
          (order.status === 2 || order.status === 3)
          && order.shopId
          && order.posOrderId
        ) {
          dispatchCandidates.push({
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          });
        }
        if (
          [4, 5].includes(order.status ?? -1)
          && order.shopId
          && order.posOrderId
        ) {
          outboundRecordCandidates.push({
            shopId: order.shopId,
            posOrderId: order.posOrderId,
          });
        }
        outcomes.push({
          shopId: order.shopId || shopId,
          orderId: order.posOrderId || posOrderId,
          status: typeof order.status === 'number' ? order.status : status,
          upsertStatus: 'UPSERTED',
          ...(isNoProductOrder
            ? {
                reason: isConfirmedNoProductSnapshot
                  ? 'CONFIRMED_NO_PRODUCT_ITEMS'
                  : 'VOID_NO_PRODUCT_ITEMS',
              }
            : {}),
        });
      } catch (error: any) {
        const message = error?.message || 'Unknown error';
        if (this.isTransientDbError(error)) {
          throw error;
        }
        if (message === 'skip_abandoned_checkout') {
          outcomes.push({
            shopId,
            orderId: posOrderId,
            status,
            upsertStatus: 'SKIPPED',
            reason: 'ABANDONED_CHECKOUT',
          });
          continue;
        }

        outcomes.push({
          shopId,
          orderId: posOrderId,
          status,
          upsertStatus: 'FAILED',
          reason: 'ORDER_UPSERT_FAILED',
          warning: message.toString().slice(0, 300),
        });

        if (throwOnFailure) {
          throw error;
        }
      }
    }

    const fulfillmentSyncCandidates = Array.from(
      new Map(
        [...fulfillmentCandidates, ...canceledFulfillmentCandidates]
          .map((ref) => [`${ref.shopId}::${ref.posOrderId}`, ref] as const),
      ).values(),
    );

    if (store && fulfillmentSyncCandidates.length > 0) {
      await this.wmsFulfillmentSyncService.syncConfirmedPickingOrders({
        tenantId,
        storeId,
        actorId: null,
        stores: [{
          id: storeId,
          tenantId,
          shopId: store.shopId,
        }],
        posOrderRefs: fulfillmentSyncCandidates,
      });
    }

    if (dispatchCandidates.length > 0) {
      await this.wmsInventoryService.syncPackedUnitsToDispatchedForPosOrders({
        tenantId,
        storeId,
        posOrderRefs: dispatchCandidates,
      });
    }

    if (outboundRecordCandidates.length > 0) {
      try {
        await this.wmsOutboundRecordsService.syncForPosOrders({
          tenantId,
          storeId,
          posOrderRefs: outboundRecordCandidates,
        });
      } catch (error) {
        this.logger.warn(
          `Outbound unit projection sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const changedSummaryCount = outcomes.filter((outcome) => (
      outcome.upsertStatus === 'UPSERTED' || outcome.upsertStatus === 'DELETED'
    )).length;

    if (changedSummaryCount > 0) {
      this.emitOrderStatusSummaryUpdate({
        tenantId,
        source: 'pos_upsert',
        changedOrderCount: changedSummaryCount,
      });
      this.emitUndeliverablesUpdate({
        tenantId,
        source: 'pos_upsert',
        changedOrderCount: changedSummaryCount,
      });
    }

    return { upserted, outcomes };
  }

  private isTransientDbError(error: any): boolean {
    const message = (error?.message || '').toString().toLowerCase();
    const code = (error?.code || '').toString().toUpperCase();
    const metaCode = (error?.meta?.code || '').toString().toUpperCase();

    return (
      code === 'P2034' ||
      code === 'P2028' ||
      code === '40001' ||
      code === '40P01' ||
      code === '55P03' ||
      code === '57014' ||
      metaCode === '40P01' ||
      metaCode === '40001' ||
      metaCode === '55P03' ||
      metaCode === '57014' ||
      message.includes('deadlock detected') ||
      message.includes('40p01') ||
      message.includes('could not serialize access due to') ||
      message.includes('40001')
    );
  }

  /**
   * Get orders for a specific date range
   */
  async getOrders(
    tenantId: string,
    shopId?: string,
    dateFrom?: string,
    dateTo?: string,
  ): Promise<any[]> {
    const where: any = { tenantId };

    if (shopId) {
      where.shopId = shopId;
    }

    if (dateFrom || dateTo) {
      where.dateLocal = {};
      if (dateFrom) where.dateLocal.gte = dateFrom;
      if (dateTo) where.dateLocal.lte = dateTo;
    }

    return this.prisma.posOrder.findMany({
      where,
      orderBy: [{ dateLocal: 'desc' }, { insertedAt: 'desc' }],
    });
  }

  private jsonOrDbNull(value: any): typeof Prisma.JsonNull | Prisma.InputJsonValue | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    return value as Prisma.InputJsonValue;
  }

  // -----------------------------
  // Upsell helpers
  // -----------------------------
  private hasUpsellTagInList(tagsRaw: any): boolean {
    if (isString(tagsRaw)) {
      try {
        const decoded = JSON.parse(tagsRaw);
        tagsRaw = decoded;
      } catch {
        // ignore parse error
      }
    }
    if (!Array.isArray(tagsRaw)) return false;
    for (const tag of tagsRaw) {
      let id: any = null;
      let name: any = null;
      if (isObject(tag)) {
        id = tag.id ?? null;
        name = tag.name ?? null;
      } else if (isString(tag)) {
        name = tag;
      }
      if (id !== null && parseInt(id, 10) === 103) return true;
      if (typeof name === 'string' && name.trim().toUpperCase() === 'UPSELL') return true;
    }
    return false;
  }

  private hasTagNameInList(tagsRaw: any, names: string[]): boolean {
    if (isString(tagsRaw)) {
      try {
        const decoded = JSON.parse(tagsRaw);
        tagsRaw = decoded;
      } catch {
        // ignore parse error
      }
    }
    if (!Array.isArray(tagsRaw)) return false;
    const normalizedTargets = new Set(names.map((name) => name.trim().toLowerCase()));
    for (const tag of tagsRaw) {
      let name: any = null;
      if (isObject(tag)) {
        name = tag.name ?? null;
      } else if (isString(tag)) {
        name = tag;
      }
      if (typeof name === 'string' && normalizedTargets.has(name.trim().toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  private computeUpsellItemsTotals(itemsRaw: any, currencyDivisor: number): { old: number; new: number } {
    if (!Array.isArray(itemsRaw)) return { old: 0, new: 0 };
    let oldTotal = 0;
    let newTotal = 0;
    for (const item of itemsRaw) {
      if (!isObject(item)) continue;
      const oldItem = item.old ?? null;
      const newItem = item.new ?? null;
      if (isObject(oldItem)) oldTotal += this.computeUpsellItemAmount(oldItem, currencyDivisor);
      if (isObject(newItem)) newTotal += this.computeUpsellItemAmount(newItem, currencyDivisor);
    }
    return { old: oldTotal, new: newTotal };
  }

  private computeUpsellItemAmount(item: any, currencyDivisor: number): number {
    const qty = parseInt(item.quantity ?? '0', 10);
    const price = item.variation_info?.retail_price ?? item.retail_price ?? 0;
    const q = isNaN(qty) ? 0 : Math.max(qty, 0);
    const scaledPrice = this.scaleCurrencyAmount(price, currencyDivisor);
    const p = Number.isFinite(scaledPrice) ? scaledPrice : 0;
    return q * p;
  }

  private extractHistoryAmount(entry: any, key: string, currencyDivisor: number): { old: number; new: number } {
    let old = 0;
    let newVal = 0;
    if (!isObject(entry) || !entry.hasOwnProperty(key)) return { old, new: newVal };
    const value = entry[key];
    if (isObject(value)) {
      if (isNumeric(value.old)) old = this.scaleCurrencyAmount(value.old, currencyDivisor);
      if (isNumeric(value.new)) newVal = this.scaleCurrencyAmount(value.new, currencyDivisor);
    } else if (isNumeric(value)) {
      newVal = this.scaleCurrencyAmount(value, currencyDivisor);
    }
    return { old, new: newVal };
  }

  private extractHistoryDiscount(entry: any, currencyDivisor: number): { old: number; new: number } {
    for (const key of ['total_discount', 'general_discount', 'discount']) {
      if (!entry || !entry.hasOwnProperty(key)) continue;
      const value = entry[key];
      if (isObject(value)) {
        const old = isNumeric(value.old) ? this.scaleCurrencyAmount(value.old, currencyDivisor) : 0;
        const neu = isNumeric(value.new) ? this.scaleCurrencyAmount(value.new, currencyDivisor) : 0;
        return { old, new: neu };
      }
      if (isNumeric(value)) {
        return { old: 0, new: this.scaleCurrencyAmount(value, currencyDivisor) };
      }
    }
    return { old: 0, new: 0 };
  }

  private computeUpsellBreakdown(order: any, currencyDivisor: number, requireUpsellTag = true): any | null {
    if (requireUpsellTag) {
      const tags = order?.tags ?? null;
      if (!this.hasUpsellTagInList(tags)) {
        return null;
      }
    }

    let histories: any = order?.histories ?? null;
    if (isString(histories)) {
      try {
        const decoded = JSON.parse(histories);
        histories = decoded;
      } catch {
        histories = null;
      }
    }
    if (!Array.isArray(histories) || histories.length === 0) {
      return null;
    }

    const entriesWithItems = histories.filter(
      (entry: any) => isObject(entry) && Array.isArray(entry.items) && entry.items.length > 0,
    );
    if (entriesWithItems.length === 0) {
      return null;
    }

    // Group entries by updated_at for discount pairing
    const byUpdatedAt: Record<string, any[]> = {};
    for (const entry of histories) {
      if (!isObject(entry)) continue;
      const updatedRaw = entry.updated_at ?? null;
      if (isString(updatedRaw) && updatedRaw !== '') {
        byUpdatedAt[updatedRaw] = byUpdatedAt[updatedRaw] || [];
        byUpdatedAt[updatedRaw].push(entry);
      }
    }

    let best: any = null;
    let bestRank: number | null = null;

    entriesWithItems.forEach((entry: any, idx: number) => {
      if (!isObject(entry)) return;

      const itemTotals = this.computeUpsellItemsTotals(entry.items ?? null, currencyDivisor);
      if (itemTotals.new <= 0) return;

      let discount = this.extractHistoryDiscount(entry, currencyDivisor);
      if (discount.old <= 0 && discount.new <= 0) {
        const updatedRaw = entry.updated_at ?? null;
        if (isString(updatedRaw) && byUpdatedAt[updatedRaw]) {
          for (const peer of byUpdatedAt[updatedRaw]) {
            const candidate = this.extractHistoryDiscount(peer, currencyDivisor);
            if (candidate.old > 0 || candidate.new > 0) {
              discount = candidate;
              break;
            }
          }
        }
      }

      const shipping = this.extractHistoryAmount(entry, 'shipping_fee', currencyDivisor);

      const isReplacement = itemTotals.old > 0 && itemTotals.new > 0;
      let itemTotalOld = itemTotals.old;
      let itemTotalNew = itemTotals.new;

      let originalAmount = 0;
      let newAmount = 0;

      if (!isReplacement) {
        const orderCod = this.scaleCurrencyAmount(order?.cod, currencyDivisor);
        const hasShippingField = isObject(entry) && Object.prototype.hasOwnProperty.call(entry, 'shipping_fee');
        const hasDiscountField = isObject(entry) && ['total_discount', 'general_discount', 'discount']
          .some((key) => Object.prototype.hasOwnProperty.call(entry, key));
        const hasDiscountValue = discount.old !== 0 || discount.new !== 0;
        const useAdjustments = hasShippingField || hasDiscountField || hasDiscountValue;

        if (useAdjustments) {
          itemTotalOld = orderCod - itemTotalNew - shipping.new + discount.new;
        } else {
          itemTotalOld = orderCod - itemTotalNew;
        }
        originalAmount = itemTotalOld + shipping.old - discount.old;
        newAmount = itemTotalOld + itemTotalNew + shipping.new - discount.new;
      } else {
        originalAmount = itemTotalOld + shipping.old - discount.old;
        newAmount = itemTotalNew + shipping.new - discount.new;
      }

      const updatedRaw = entry.updated_at ?? null;
      let rank = idx;
      if (isString(updatedRaw)) {
        const ts = Date.parse(updatedRaw);
        if (!isNaN(ts)) rank = ts;
      }

      if (bestRank === null || rank > bestRank) {
        bestRank = rank;
        best = {
          flag: true,
          original_amount: originalAmount,
          new_amount: newAmount,
          item_total_old: itemTotalOld,
          item_total_new: itemTotalNew,
          shipping_old: shipping.old,
          shipping_new: shipping.new,
          discount_old: discount.old,
          discount_new: discount.new,
          updated_at: updatedRaw,
        };
      }
    });

    return best;
  }
}

function isString(val: any): val is string {
  return typeof val === 'string';
}

function isObject(val: any): val is Record<string, any> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function isNumeric(val: any): boolean {
  return val !== null && val !== undefined && !isNaN(Number(val));
}
