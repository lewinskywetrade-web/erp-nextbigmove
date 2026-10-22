import { Prisma } from '@prisma/client';
import { UNATTRIBUTED_STORE_KEY } from './store-attribution';

export const ACTUAL_COGS_UNITS_POLICY = 'SUPER_ADMIN_COGS_LINKED_UNITS_V2';
const PAGE_SIZE = 1000;
const MAX_ORDERS = 100000;
const MAX_ITEM_LINES = 500000;
const MAX_REPORT_ROWS = 25000;
const MAX_MEMBERS = 100000;
const MAX_MEMBERSHIP_BYTES = 16777216;

type Mode = 'product' | 'store';
type Scope = {
  tenantId: string;
  start: string;
  end: string;
  teamIds: string[];
  excludeRepurchase: boolean;
  excludeCancel: boolean;
  excludeRestocking: boolean;
  excludeAbandoned: boolean;
  excludeRts: boolean;
  emptySelection: boolean;
  allSelected: boolean;
};
type SavedOrder = {
  id: string;
  tenantId: string;
  shopId: string;
  posOrderId: string;
  dateLocal: string;
  teamId: string | null;
  status: number | null;
  isVoid: boolean;
  isRepurchase: boolean;
  isAbandoned: boolean;
  cogs: unknown;
  snapshotKind: string | null;
  snapshotQuantities: unknown;
  dataKind: string | null;
  dataQuantities: unknown;
};
type ReportRow = { id: string; date: Date | string; teamId: string | null; mapping: string | null; matchedOrders: unknown };
type Store = { id: string; shopId: string };
type Product = { mapping: string | null; store_id?: string | null; gross_sales: number; rts_count: number; cogs: number; cogs_forecast_basis: number; [key: string]: any };
type BaseResponse = { products: Product[]; kpis: Record<string, any>; counts: { purchases: number; rts: number }; [key: string]: any };

const bucketKey = (mapping: unknown) => JSON.stringify(mapping ?? null);
const orderKey = (date: string, shop: string, order: string) => JSON.stringify([date, shop, order]);
const within = (value: unknown, max: number) => typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= BigInt(max);
// Financial response sums are JavaScript numbers; normalize only to the
// database's currency precision before comparing with exact saved COGS.
function currency(value: unknown): Prisma.Decimal | null {
  if ((typeof value !== 'number' || !Number.isFinite(value))
    && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))) return null;
  try {
    const decimal = new Prisma.Decimal(value as string | number);
    return decimal.isFinite() ? decimal.toDecimalPlaces(2) : null;
  } catch { return null; }
}

/** Physical quantity includes zero-cost products. PosOrder.totalQuantity is a
 * COGS-derived field and is deliberately never used for this metric. */
export function savedItemQuantity(order: Pick<SavedOrder, 'snapshotKind' | 'snapshotQuantities' | 'dataKind' | 'dataQuantities'>): number | null {
  const hasSnapshotItems = order.snapshotKind !== null && order.snapshotKind !== 'null';
  const kind = hasSnapshotItems ? order.snapshotKind : order.dataKind;
  const quantities = hasSnapshotItems ? order.snapshotQuantities : order.dataQuantities;
  if (kind !== 'array' || !Array.isArray(quantities) || quantities.length === 0) return null;
  let total = 0;
  for (const raw of quantities) {
    const quantity = typeof raw === 'number' ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    total += quantity;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/** Read the before-RTS cohort once, retaining RTS quantities for Forecast.
 * Actual is the same cohort with RTS removed when the filter excludes it. */
export function cogsOrderWhere(scope: Scope, shopIds: string[], cursor?: string): Prisma.Sql {
  return Prisma.sql`o."tenantId" = ${scope.tenantId}::uuid
    AND o.status IS DISTINCT FROM 7 AND o."isVoid" = false
    AND o."dateLocal" BETWEEN ${scope.start} AND ${scope.end}
    AND ${shopIds.length ? Prisma.sql`o."shopId" IN (${Prisma.join(shopIds)})` : Prisma.sql`FALSE`}
    AND ${scope.teamIds.length ? Prisma.sql`o."teamId" IN (${Prisma.join(scope.teamIds.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.sql`TRUE`}
    AND ${scope.excludeRepurchase ? Prisma.sql`o."isRepurchase" = false` : Prisma.sql`TRUE`}
    AND ${scope.excludeCancel ? Prisma.sql`o.status IS DISTINCT FROM 6` : Prisma.sql`TRUE`}
    AND ${scope.excludeRestocking ? Prisma.sql`o.status IS DISTINCT FROM 11` : Prisma.sql`TRUE`}
    AND ${scope.excludeAbandoned ? Prisma.sql`NOT (o.status IS NOT DISTINCT FROM 0 AND o."isAbandoned" = true)` : Prisma.sql`TRUE`}
    AND ${cursor ? Prisma.sql`o.id > ${cursor}::uuid` : Prisma.sql`TRUE`}`;
}

export function cogsOrderPage(scope: Scope, shopIds: string[], cursor?: string): Prisma.Sql {
  return Prisma.sql`SELECT o.id,o."tenantId",o."shopId",o."posOrderId",o."dateLocal",o."teamId",o.status,o."isVoid",o."isRepurchase",o."isAbandoned",o.cogs::text AS cogs,
    jsonb_typeof(o."orderSnapshot"->'items') AS "snapshotKind",
    CASE WHEN jsonb_typeof(o."orderSnapshot"->'items')='array' THEN
      (SELECT jsonb_agg(CASE WHEN jsonb_typeof(item->'quantity') IN ('number','string')
        AND length(item->>'quantity') <= 16 THEN item->'quantity' ELSE 'null'::jsonb END ORDER BY ordinal)
        FROM jsonb_array_elements(o."orderSnapshot"->'items') WITH ORDINALITY AS entries(item,ordinal))
      ELSE NULL END AS "snapshotQuantities",
    jsonb_typeof(o."itemData") AS "dataKind",
    CASE WHEN jsonb_typeof(o."orderSnapshot"->'items') IS NULL AND jsonb_typeof(o."itemData")='array' THEN
      (SELECT jsonb_agg(CASE WHEN jsonb_typeof(item->'quantity') IN ('number','string')
        AND length(item->>'quantity') <= 16 THEN item->'quantity' ELSE 'null'::jsonb END ORDER BY ordinal)
        FROM jsonb_array_elements(o."itemData") WITH ORDINALITY AS entries(item,ordinal))
      ELSE NULL END AS "dataQuantities"
    FROM pos_orders o WHERE ${cogsOrderWhere(scope, shopIds, cursor)}
    ORDER BY o.id LIMIT ${PAGE_SIZE}`;
}

function unavailable(response: BaseResponse, reason: string) {
  return {
    ...response,
    kpis: { ...response?.kpis, actual_units: null, actual_units_forecast_basis: null },
    products: (Array.isArray(response?.products) ? response.products : []).map(row => ({ ...row, actual_units: null, actual_units_forecast_basis: null })),
    actualUnitsCoverage: {
      policy: ACTUAL_COGS_UNITS_POLICY, status: 'UNAVAILABLE', reason,
      basis: 'SAVED_ITEM_QUANTITIES_VISIBLE_COGS_ORDER_DATE', readOnly: true,
    },
  };
}

/** Pure allocation: duplicates in one bucket count once; conflicting buckets
 * are unavailable instead of assigning the same order to several products. */
export function allocateCogsUnits(response: BaseResponse, scope: Scope, mode: Mode, stores: Store[], orders: SavedOrder[], reportRows: ReportRow[], snapshotAt: string) {
  const products = response.products;
  const keys = products.map(row => mode === 'store' ? row.store_id ?? UNATTRIBUTED_STORE_KEY : bucketKey(row.mapping));
  const selectedKeys = new Set(keys);
  const freshComponent = () => ({ units: 0, orders: 0, unknown: 0, ambiguous: 0, cogs: new Prisma.Decimal(0), invalidCost: false });
  const buckets = new Map(keys.map(key => [key, { selected: freshComponent(), beforeRts: freshComponent(), invalidMembership: false }]));
  const storeOwners = new Map<string, Set<string>>();
  for (const store of stores) {
    const set = storeOwners.get(store.shopId) ?? new Set<string>();
    set.add(store.id.toLowerCase());
    storeOwners.set(store.shopId, set);
  }
  const allOwners = new Map<string, Set<string>>();
  const selectedOwners = new Map<string, Set<string>>();
  let invalidMembershipRows = 0;
  if (mode === 'product') {
    for (const row of reportRows) {
      const mappingKey = bucketKey(row.mapping);
      const included = selectedKeys.has(mappingKey) && (!scope.teamIds.length || scope.teamIds.includes(row.teamId!));
      const date = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
      if (!Array.isArray(row.matchedOrders)) {
        if (included) { buckets.get(mappingKey)!.invalidMembership = true; invalidMembershipRows++; }
        continue;
      }
      for (const raw of row.matchedOrders) {
        const member = raw as any;
        if (!member || typeof member !== 'object' || typeof member.shopId !== 'string'
          || !member.shopId || typeof member.posOrderId !== 'string' || !member.posOrderId) {
          if (included) { buckets.get(mappingKey)!.invalidMembership = true; invalidMembershipRows++; }
          continue;
        }
        const key = orderKey(date, member.shopId, member.posOrderId);
        const owners = allOwners.get(key) ?? new Set<string>();
        owners.add(mappingKey);
        allOwners.set(key, owners);
        if (included) {
          const selected = selectedOwners.get(key) ?? new Set<string>();
          selected.add(mappingKey);
          selectedOwners.set(key, selected);
        }
      }
    }
  }
  const seenOrders = new Set<string>();
  let unassignedSelectedOrders = 0;
  let unassignedBeforeRtsOrders = 0;
  let duplicateOrderRows = 0;
  for (const order of orders) {
    // Defensive scope checks mirror the SQL; no deleted/void/other-period
    // row can enter the metric even if the data adapter returns extra rows.
    if (order.tenantId !== scope.tenantId || order.status === 7 || order.isVoid
      || order.dateLocal < scope.start || order.dateLocal > scope.end
      || !storeOwners.has(order.shopId) || (scope.teamIds.length && !scope.teamIds.includes(order.teamId!))
      || (scope.excludeRepurchase && order.isRepurchase)
      || (scope.excludeCancel && order.status === 6)
      || (scope.excludeRestocking && order.status === 11)
      || (scope.excludeAbandoned && order.status === 0 && order.isAbandoned)) continue;
    const inSelected = !scope.excludeRts || (order.status !== 4 && order.status !== 5);
    const identity = orderKey(order.dateLocal, order.shopId, order.posOrderId);
    if (seenOrders.has(identity)) { duplicateOrderRows++; continue; }
    seenOrders.add(identity);
    let owners: Set<string>;
    let ambiguous = false;
    if (mode === 'store') {
      const candidates = storeOwners.get(order.shopId)!;
      owners = new Set([candidates.size === 1 ? [...candidates][0] : UNATTRIBUTED_STORE_KEY]);
      ambiguous = candidates.size !== 1;
    } else {
      owners = selectedOwners.get(identity) ?? new Set();
      ambiguous = (allOwners.get(identity)?.size ?? 0) > 1;
      if (!(allOwners.get(identity)?.size)) {
        unassignedBeforeRtsOrders++;
        if (inSelected) unassignedSelectedOrders++;
      }
    }
    const quantity = savedItemQuantity(order);
    const cost = currency(order.cogs);
    for (const owner of owners) {
      const bucket = buckets.get(owner);
      if (!bucket) continue;
      for (const component of [bucket.beforeRts, ...(inSelected ? [bucket.selected] : [])]) {
        component.orders++;
        if (cost === null) component.invalidCost = true;
        else component.cogs = component.cogs.plus(cost);
        if (ambiguous) { component.ambiguous++; continue; }
        if (quantity === null || !Number.isSafeInteger(component.units + quantity)) { component.unknown++; continue; }
        component.units += quantity;
      }
    }
  }
  const componentCoverage = (component: ReturnType<typeof freshComponent>, count: number, cost: unknown, invalidMembership: boolean) => {
    const countMatches = Number.isSafeInteger(count) && count >= 0 && count === component.orders;
    const expectedCogs = currency(cost);
    const costMatches = !component.invalidCost && expectedCogs !== null && component.cogs.equals(expectedCogs);
    const complete = !invalidMembership && !component.unknown && !component.ambiguous && countMatches && costMatches;
    return {
      units: complete ? component.units : null,
      eligibleOrders: component.orders, unknownQuantityOrders: component.unknown,
      ambiguousMembershipOrders: component.ambiguous, reportOrderCountMatches: countMatches,
      reportCogsMatches: costMatches, sourceCogs: component.cogs.toFixed(2),
      expectedCogs: expectedCogs?.toFixed(2) ?? null, invalidMembership,
    };
  };
  const rowCoverage = products.map((row, index) => {
    const bucket = buckets.get(keys[index])!;
    const selected = componentCoverage(bucket.selected, row.gross_sales, row.cogs, bucket.invalidMembership);
    const beforeRts = componentCoverage(bucket.beforeRts,
      row.gross_sales + (scope.excludeRts ? row.rts_count : 0), row.cogs_forecast_basis, bucket.invalidMembership);
    return {
      mapping: row.mapping, ...(mode === 'store' ? { store_id: row.store_id ?? null } : {}),
      actual_units: selected.units, actual_units_forecast_basis: beforeRts.units,
      selected, beforeRts,
    };
  });
  const totalComponent = (componentKey: 'selected' | 'beforeRts', count: number, cost: unknown, unassigned: number) => {
    const total = freshComponent();
    for (const bucket of buckets.values()) {
      const component = bucket[componentKey];
      total.units += component.units;
      total.orders += component.orders;
      total.unknown += component.unknown;
      total.ambiguous += component.ambiguous;
      total.invalidCost ||= component.invalidCost;
      total.cogs = total.cogs.plus(component.cogs);
    }
    const value = componentCoverage(total, count, cost, invalidMembershipRows > 0);
    if (!Number.isSafeInteger(total.units) || rowCoverage.some(row => row[componentKey].units === null)
      || (mode === 'product' && scope.allSelected && unassigned > 0)) value.units = null;
    return value;
  };
  const selected = totalComponent('selected', response.counts.purchases, response.kpis.cogs_adjusted, unassignedSelectedOrders);
  const beforeRts = totalComponent('beforeRts',
    response.counts.purchases + (scope.excludeRts ? response.counts.rts : 0),
    response.kpis.cogs_forecast_basis, unassignedBeforeRtsOrders);
  return {
    ...response,
    kpis: { ...response.kpis, actual_units: selected.units, actual_units_forecast_basis: beforeRts.units },
    products: products.map((row, index) => ({ ...row, actual_units: rowCoverage[index].actual_units,
      actual_units_forecast_basis: rowCoverage[index].actual_units_forecast_basis })),
    actualUnitsCoverage: {
      policy: ACTUAL_COGS_UNITS_POLICY,
      basis: 'SAVED_ITEM_QUANTITIES_VISIBLE_COGS_ORDER_DATE',
      status: selected.units !== null && beforeRts.units !== null ? 'COMPLETE' : 'INCOMPLETE',
      snapshotAt, readOnly: true,
      quantitySource: 'ORDER_SNAPSHOT_ITEMS_THEN_ITEM_DATA_IF_ABSENT',
      orderDateBasis: 'PosOrder.dateLocal', selected, beforeRts,
      unassignedSelectedOrders, unassignedBeforeRtsOrders,
      exclusions: { cancel: scope.excludeCancel, restocking: scope.excludeRestocking,
        abandoned: scope.excludeAbandoned, rts: scope.excludeRts, repurchase: scope.excludeRepurchase },
      duplicateOrderRows, invalidMembershipRows, rows: rowCoverage,
    },
  };
}

/** Optional role-only decoration after the shared public response cache. This
 * function never mutates that response and never stores protected quantities. */
export async function enrichActualCogsUnits(prisma: any, response: BaseResponse, scope: Scope, mode: Mode) {
  if (!Array.isArray(response?.products) || !response.kpis) return unavailable(response, 'REPORT_SHAPE_UNAVAILABLE');
  if (scope.emptySelection) return allocateCogsUnits(response, scope, mode, [], [], [], new Date().toISOString());
  try {
    return await prisma.$transaction(async (db: any) => {
      await db.$executeRaw`SET TRANSACTION READ ONLY`;
      await db.$executeRaw`SET LOCAL statement_timeout = '10000ms'`;
      const stores: Store[] = await db.posStore.findMany({
        where: { tenantId: scope.tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] },
        select: { id: true, shopId: true },
      });
      const shopIds = [...new Set(stores.map(store => store.shopId))];
      const [budget] = await db.$queryRaw(Prisma.sql`SELECT count(*)::text AS orders,
        coalesce(sum(CASE WHEN jsonb_typeof(o."orderSnapshot"->'items')='array'
          THEN jsonb_array_length(o."orderSnapshot"->'items') ELSE 0 END
          + CASE WHEN jsonb_typeof(o."itemData")='array' THEN jsonb_array_length(o."itemData") ELSE 0 END),0)::text AS lines
        FROM pos_orders o WHERE ${cogsOrderWhere(scope, shopIds)}`);
      if (!budget || !within(budget.orders, MAX_ORDERS) || !within(budget.lines, MAX_ITEM_LINES)) {
        return unavailable(response, 'QUANTITY_QUERY_BUDGET_EXCEEDED');
      }
      const orders: SavedOrder[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page: SavedOrder[] = await db.$queryRaw(cogsOrderPage(scope, shopIds, cursor));
        if (page.length > PAGE_SIZE || orders.length + page.length > MAX_ORDERS) return unavailable(response, 'ORDER_PAGE_BOUND_EXCEEDED');
        orders.push(...page);
        if (page.length < PAGE_SIZE) break;
        const next = page[page.length - 1].id;
        if (cursor && next <= cursor) return unavailable(response, 'ORDER_CURSOR_DID_NOT_ADVANCE');
        cursor = next;
      }
      const rows: ReportRow[] = [];
      if (mode === 'product') {
        const [membershipBudget] = await db.$queryRaw(Prisma.sql`SELECT count(*)::text AS rows,
          coalesce(sum(pg_column_size("matchedOrders")),0)::text AS bytes,
          coalesce(sum(CASE WHEN jsonb_typeof("matchedOrders")='array' THEN jsonb_array_length("matchedOrders") ELSE 0 END),0)::text AS members
          FROM reconcile_marketing WHERE "tenantId"=${scope.tenantId}::uuid
            AND date BETWEEN ${scope.start}::date AND ${scope.end}::date`);
        if (!membershipBudget || !within(membershipBudget.rows, MAX_REPORT_ROWS)
          || !within(membershipBudget.members, MAX_MEMBERS) || !within(membershipBudget.bytes, MAX_MEMBERSHIP_BYTES)) {
          return unavailable(response, 'MEMBERSHIP_QUERY_BUDGET_EXCEEDED');
        }
        let rowCursor: string | undefined;
        for (;;) {
          const page: ReportRow[] = await db.reconcileMarketing.findMany({
            where: { tenantId: scope.tenantId, date: { gte: new Date(`${scope.start}T00:00:00Z`), lte: new Date(`${scope.end}T00:00:00Z`) },
              ...(rowCursor ? { id: { gt: rowCursor } } : {}) },
            select: { id: true, date: true, teamId: true, mapping: true, matchedOrders: true },
            orderBy: { id: 'asc' }, take: PAGE_SIZE,
          });
          if (page.length > PAGE_SIZE || rows.length + page.length > MAX_REPORT_ROWS) return unavailable(response, 'MEMBERSHIP_PAGE_BOUND_EXCEEDED');
          rows.push(...page);
          if (page.length < PAGE_SIZE) break;
          const next = page[page.length - 1].id;
          if (rowCursor && next <= rowCursor) return unavailable(response, 'MEMBERSHIP_CURSOR_DID_NOT_ADVANCE');
          rowCursor = next;
        }
      }
      return allocateCogsUnits(response, scope, mode, stores, orders, rows, new Date().toISOString());
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 30000 });
  } catch {
    // Keep the existing financial report usable; an unknown quantity is never
    // represented as zero and no database or report repair is attempted.
    return unavailable(response, 'SAVED_QUANTITY_OR_MEMBERSHIP_READ_UNAVAILABLE');
  }
}
