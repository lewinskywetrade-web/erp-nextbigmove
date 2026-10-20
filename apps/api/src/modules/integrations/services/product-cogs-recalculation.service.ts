import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PRODUCT_COGS_REFRESH_FROM, isProductCogsRefreshDate, productCogsManilaDate } from '../product-cogs-refresh-policy';

export type ProductCogsRefreshChange = { productId: string; fromDate: string | null; toDate: string | null };
export type ProductCogsRefreshScope = { tenantId: string; storeId: string; changes: ProductCogsRefreshChange[] };
type CatalogProduct = { id: string; productId: string; variationId: string | null; customId: string | null };
type SavedOrder = {
  id: string; tenantId: string; shopId: string; dateLocal: string; totalQuantity: number;
  isVoid: boolean; cogs: string; updatedAt: Date; snapshotItems: unknown; dataItems: unknown;
};
type CostRow = { productId: string; tenantId: string; storeId: string; cogs: Decimal; startDate: Date | null; endDate: Date | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_AMOUNT = new Decimal('9999999999.99');
const identifier = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null;
export function isCogsCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime())
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function validCost(value: Decimal) {
  return value.isFinite() && value.gte(0) && value.lte(MAX_AMOUNT) && value.decimalPlaces() <= 2;
}

/** Strict replay never guesses a sibling or interprets free-text order notes. */
export function resolveSavedCogsProduct(item: any, products: CatalogProduct[]): CatalogProduct | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const variants = [...new Set([identifier(item.variation_id), identifier(item.variationId)].filter((value): value is string => !!value))];
  const parents = [...new Set([identifier(item.product_id), identifier(item.productId)].filter((value): value is string => !!value))];
  if (variants.length > 1 || parents.length > 1) return null;
  const variant = variants[0];
  const displays = [item.product_display_id, item.productDisplayId, item.variation_info?.product_display_id,
    item.variation_info?.display_id, item.variation_info?.barcode].map(identifier).filter((value): value is string => !!value);
  const modern = products.filter(product => product.variationId && product.variationId !== product.productId);
  const matches = variant ? modern.filter(product => product.variationId === variant)
    : modern.filter(product => product.customId && displays.includes(product.customId));
  if (matches.length !== 1) return null;
  const product = matches[0];
  if (parents.length && !parents.some(parent => parent === product.productId || parent === product.customId)) return null;
  // Provider display/barcode aliases often differ from the ERP custom SKU.
  // An unknown auxiliary value cannot veto an exact variant. A recognized
  // alias pointing at another product remains a genuine identity conflict,
  // including when the item also contains this product's own alias.
  if (displays.some(display => products.some(other => other.id !== product.id && other.customId === display))) return null;
  return product;
}

export function calculateSavedErpCogs(
  order: Pick<SavedOrder, 'dateLocal' | 'totalQuantity' | 'isVoid' | 'snapshotItems' | 'dataItems'>,
  products: CatalogProduct[], costs: CostRow[], scope: Pick<ProductCogsRefreshScope, 'tenantId' | 'storeId'>,
): { amount: Decimal; productIds: string[] } | null {
  if (order.isVoid || !isCogsCalendarDate(order.dateLocal) || !Number.isSafeInteger(order.totalQuantity) || order.totalQuantity <= 0) return null;
  const items = Array.isArray(order.snapshotItems) ? order.snapshotItems : order.dataItems;
  if (!Array.isArray(items) || !items.length) return null;
  let totalQuantity = 0;
  let amount = new Decimal(0);
  const productIds = new Set<string>();
  const date = new Date(`${order.dateLocal}T00:00:00Z`).getTime();
  for (const item of items) {
    if (!item || typeof item !== 'object') return null;
    const quantity = typeof item.quantity === 'number' ? item.quantity
      : typeof item.quantity === 'string' && /^\d+$/.test(item.quantity) ? Number(item.quantity) : NaN;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    const product = resolveSavedCogsProduct(item, products);
    if (!product) return null;
    const history = costs.filter(row => row.productId === product.id);
    if (history.some(row => row.tenantId !== scope.tenantId || row.storeId !== scope.storeId || !validCost(row.cogs)
      || (row.startDate && !Number.isFinite(row.startDate.getTime())) || (row.endDate && !Number.isFinite(row.endDate.getTime()))
      || (row.startDate && row.endDate && row.endDate < row.startDate))) return null;
    const dated = history.filter(row => row.startDate && row.startDate.getTime() <= date && (!row.endDate || row.endDate.getTime() >= date));
    const defaults = history.filter(row => row.startDate === null && (!row.endDate || row.endDate.getTime() >= date));
    const applicable = dated.length ? dated : defaults;
    if (applicable.length !== 1) return null;
    amount = amount.plus(applicable[0].cogs.times(quantity));
    totalQuantity += quantity;
    productIds.add(product.id);
  }
  if (totalQuantity !== order.totalQuantity || !validCost(amount)) return null;
  return { amount, productIds: [...productIds] };
}

// Fetch only item identity/quantity metadata, never customer details or notes.
const projectItems = (expression: string) => `CASE WHEN jsonb_typeof(${expression})='array' THEN
  (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'quantity',item->'quantity','product_id',item->'product_id','productId',item->'productId',
    'variation_id',item->'variation_id','variationId',item->'variationId',
    'product_display_id',item->'product_display_id','productDisplayId',item->'productDisplayId',
    'variation_info',jsonb_build_object('product_display_id',item->'variation_info'->'product_display_id',
      'display_id',item->'variation_info'->'display_id','barcode',item->'variation_info'->'barcode')
  ) ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(${expression}) WITH ORDINALITY AS entries(item,ordinal)) ELSE NULL END`;
const ORDER_COLUMNS = `o.id,o."tenantId",o."shopId",o."dateLocal",o."totalQuantity",o."isVoid",o.cogs::text AS cogs,o."updatedAt",
  ${projectItems(`o."orderSnapshot"->'items'`)} AS "snapshotItems",${projectItems('o."itemData"')} AS "dataItems"`;
export const COGS_REFRESH_ORDERS_SQL = `SELECT ${ORDER_COLUMNS} FROM pos_orders o
  WHERE o."tenantId"=$1::uuid AND o."shopId"=$2 AND ($3::uuid IS NULL OR o.id>$3::uuid)
    AND ($4::text IS NULL OR o."dateLocal">=$4) AND ($5::text IS NULL OR o."dateLocal"<=$5)
  ORDER BY o.id LIMIT $6`;
export const COGS_REFRESH_ORDER_LOCK_SQL = `SELECT ${ORDER_COLUMNS} FROM pos_orders o
  WHERE o.id=$1::uuid AND o."tenantId"=$2::uuid AND o."shopId"=$3 FOR UPDATE OF o NOWAIT`;
export const COGS_REFRESH_PARENT_LOCK_SQL = `SELECT p.id,p."productId",p."variationId",p."customId"
  FROM pos_products p JOIN pos_stores s ON s.id=p."storeId"
  WHERE p.id=ANY($1::uuid[]) AND p."storeId"=$2::uuid AND s."tenantId"=$3::uuid
  ORDER BY p.id FOR SHARE OF p FOR SHARE OF s`;

@Injectable()
export class ProductCogsRecalculationService {
  constructor(private readonly prisma: PrismaService) {}

  private validateScope(scope: ProductCogsRefreshScope) {
    if (!UUID.test(scope.tenantId) || !UUID.test(scope.storeId) || !Array.isArray(scope.changes) || !scope.changes.length
      || scope.changes.some(change => !UUID.test(change.productId)
        || (change.fromDate !== null && !isCogsCalendarDate(change.fromDate))
        || (change.toDate !== null && !isCogsCalendarDate(change.toDate))
        || (change.fromDate !== null && change.toDate !== null && change.fromDate > change.toDate))) {
      throw new BadRequestException('Invalid ERP COGS refresh scope');
    }
  }

  private async boundedTransaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5000ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15000ms'");
      return callback(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 20000 });
  }

  async waitForSourceTransaction(scope: ProductCogsRefreshScope): Promise<void> {
    this.validateScope(scope);
    const ids = [...new Set(scope.changes.map(change => change.productId))].sort();
    await this.boundedTransaction(async tx => {
      const rows = await tx.$queryRawUnsafe<CatalogProduct[]>(COGS_REFRESH_PARENT_LOCK_SQL, ids, scope.storeId, scope.tenantId);
      if (rows.length !== ids.length) throw new ConflictException('ERP COGS refresh product scope changed');
    });
  }

  async recalculateBatch(scope: ProductCogsRefreshScope & { cursor?: string; pageSize?: number }) {
    this.validateScope(scope);
    if (scope.cursor && !UUID.test(scope.cursor)) throw new BadRequestException('Invalid ERP COGS refresh cursor');
    const pageSize = scope.pageSize ?? 200;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new BadRequestException('Invalid ERP COGS refresh page size');
    const store = await this.prisma.posStore.findFirst({ where: { id: scope.storeId, tenantId: scope.tenantId }, select: { id: true, shopId: true } });
    if (!store) throw new ConflictException('ERP COGS refresh store scope changed');
    // PosOrder has no storeId: a duplicate tenant/shop cannot be disambiguated safely.
    const stores = await this.prisma.posStore.findMany({ where: { tenantId: scope.tenantId, shopId: store.shopId }, select: { id: true } });
    if (stores.length !== 1 || stores[0].id !== scope.storeId) throw new ConflictException('ERP COGS refresh shop scope is ambiguous');
    const products = await this.prisma.posProduct.findMany({ where: { storeId: scope.storeId, store: { tenantId: scope.tenantId } },
      select: { id: true, productId: true, variationId: true, customId: true } });
    const starts = scope.changes.map(change => change.fromDate);
    const ends = scope.changes.map(change => change.toDate);
    const earliest = starts.includes(null) ? PRODUCT_COGS_REFRESH_FROM : (starts as string[]).sort()[0];
    const from = earliest < PRODUCT_COGS_REFRESH_FROM ? PRODUCT_COGS_REFRESH_FROM : earliest;
    const sortedEnds = (ends.filter((date): date is string => date !== null)).sort();
    const today = productCogsManilaDate();
    const latest = ends.includes(null) ? today : sortedEnds[sortedEnds.length - 1];
    const until = latest > today ? today : latest;
    if (until < from) return { nextCursor: null, affectedDates: [], examined: 0, updated: 0, unchanged: 0, skipped: 0 };
    const orders = await this.prisma.$queryRawUnsafe<SavedOrder[]>(COGS_REFRESH_ORDERS_SQL,
      scope.tenantId, store.shopId, scope.cursor ?? null, from, until, pageSize);
    const dates = new Set<string>();
    const result = { nextCursor: orders.length === pageSize ? orders[orders.length - 1].id : null,
      affectedDates: [] as string[], examined: orders.length, updated: 0, unchanged: 0, skipped: 0 };
    for (const order of orders) {
      // Include examined valid dates even on a retry where an earlier attempt
      // already wrote the amount. Aggregate refresh must not be lost.
      const ranges = scope.changes.filter(change => isCogsCalendarDate(order.dateLocal) && isProductCogsRefreshDate(order.dateLocal, today)
        && (!change.fromDate || order.dateLocal >= change.fromDate) && (!change.toDate || order.dateLocal <= change.toDate));
      if (!ranges.length || order.tenantId !== scope.tenantId || order.shopId !== store.shopId) { result.skipped++; continue; }
      dates.add(order.dateLocal);
      const items = Array.isArray(order.snapshotItems) ? order.snapshotItems : order.dataItems;
      if (!Array.isArray(items) || !items.length || order.isVoid) { result.skipped++; continue; }
      const resolved = items.map(item => resolveSavedCogsProduct(item, products));
      if (resolved.some(product => !product) || !ranges.some(change => resolved.some(product => product!.id === change.productId))) { result.skipped++; continue; }
      const ids = [...new Set(resolved.map(product => product!.id))].sort();
      const status = await this.boundedTransaction(async tx => {
        // Store/shop and display-code identities lack unique constraints.
        // Bound these catalog phantoms before taking parent locks, then check
        // the relevant identities again. Locks last for this one order only.
        await tx.$executeRawUnsafe('LOCK TABLE pos_stores,pos_products IN SHARE MODE');
        const lockedProducts = await tx.$queryRawUnsafe<CatalogProduct[]>(COGS_REFRESH_PARENT_LOCK_SQL, ids, scope.storeId, scope.tenantId);
        if (lockedProducts.length !== ids.length) throw new ConflictException('ERP COGS refresh catalog changed; retry page');
        const currentStores = await tx.posStore.findMany({ where: { tenantId: scope.tenantId, shopId: store.shopId }, select: { id: true } });
        if (currentStores.length !== 1 || currentStores[0].id !== scope.storeId) throw new ConflictException('ERP COGS refresh shop scope changed; retry page');
        const variants = items.flatMap(item => [identifier(item?.variation_id), identifier(item?.variationId)]).filter((value): value is string => !!value);
        const displays = items.flatMap(item => [item?.product_display_id, item?.productDisplayId, item?.variation_info?.product_display_id,
          item?.variation_info?.display_id, item?.variation_info?.barcode]).map(identifier).filter((value): value is string => !!value);
        const currentProducts = await tx.posProduct.findMany({ where: { storeId: scope.storeId, store: { tenantId: scope.tenantId },
          OR: [{ id: { in: ids } }, { variationId: { in: variants } }, { customId: { in: displays } }] },
        select: { id: true, productId: true, variationId: true, customId: true } });
        const currentResolved = items.map(item => resolveSavedCogsProduct(item, currentProducts));
        if (currentResolved.some(product => !product)) return 'skipped';
        const currentIds = [...new Set(currentResolved.map(product => product!.id))].sort();
        if (JSON.stringify(currentIds) !== JSON.stringify(ids)) throw new ConflictException('ERP COGS refresh catalog identity changed; retry page');
        const costs = await tx.posProductCogs.findMany({ where: { productId: { in: ids } } });
        const calculated = calculateSavedErpCogs(order, lockedProducts, costs, scope);
        if (!calculated) return 'skipped';
        // Deletion/ownership flows can hold an order before changing stores.
        // Never wait on their order row while holding catalog SHARE locks.
        const [current] = await tx.$queryRawUnsafe<SavedOrder[]>(COGS_REFRESH_ORDER_LOCK_SQL, order.id, scope.tenantId, store.shopId);
        if (!current || current.updatedAt.getTime() !== order.updatedAt.getTime() || current.cogs !== order.cogs
          || current.dateLocal !== order.dateLocal || current.totalQuantity !== order.totalQuantity || current.isVoid !== order.isVoid
          || JSON.stringify(current.snapshotItems) !== JSON.stringify(order.snapshotItems)
          || JSON.stringify(current.dataItems) !== JSON.stringify(order.dataItems)) {
          throw new ConflictException('ERP order changed during COGS refresh; retry page');
        }
        if (calculated.amount.equals(current.cogs)) return 'unchanged';
        const changed = await tx.posOrder.updateMany({ where: { id: order.id, tenantId: scope.tenantId, shopId: store.shopId,
          updatedAt: order.updatedAt, cogs: new Decimal(order.cogs), dateLocal: order.dateLocal, totalQuantity: order.totalQuantity, isVoid: order.isVoid },
        data: { cogs: calculated.amount } });
        if (changed.count !== 1) throw new ConflictException('ERP order COGS compare-and-set failed; retry page');
        return 'updated';
      });
      result[status]++;
    }
    result.affectedDates = [...dates].sort();
    return result;
  }
}
