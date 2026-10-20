import { describe, expect, it, jest } from '@jest/globals';
import {
  ACTUAL_COGS_UNITS_POLICY, allocateCogsUnits, cogsOrderPage,
  cogsOrderWhere, enrichActualCogsUnits, savedItemQuantity,
} from './actual-cogs-units';
import { UNATTRIBUTED_STORE_KEY } from './store-attribution';
import { SalesAnalyticsService } from '../sales-analytics.service';
import { accumulatePosOrder, createEmptyPosAggregateBucket } from '../../workflows/utils/pos-reporting-components';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const teamA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const teamB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope = {
  tenantId, start: '2026-10-01', end: '2026-10-19', teamIds: [] as string[],
  excludeRepurchase: true, excludeCancel: true, excludeRestocking: true, excludeAbandoned: true, excludeRts: true, emptySelection: false, allSelected: true,
};
const stores = [{ id: 'store-a', shopId: 'shop-a' }, { id: 'store-b', shopId: 'shop-b' }];
const order = (id: string, extra: Record<string, any> = {}) => ({
  id, tenantId, shopId: 'shop-a', posOrderId: id, dateLocal: '2026-10-10',
  teamId: teamA, status: 3, isVoid: false, isRepurchase: false, isAbandoned: false,
  snapshotKind: 'array', snapshotQuantities: [2, 3, 1], dataKind: 'array',
  dataQuantities: [1], totalQuantity: 1, cogs: 0, ...extra,
});
const report = (mapping: string | null, orders: ReturnType<typeof order>[], extra: Record<string, any> = {}) => ({
  id: `row-${mapping}`, date: new Date('2026-10-10'), teamId: teamA, mapping,
  matchedOrders: orders.map(o => ({ shopId: o.shopId, posOrderId: o.posOrderId, cod: 99 })),
  ...extra,
});
const base = (rows: any[] = [{ mapping: 'Product A', gross_sales: 1 }]) => {
  const products = rows.map(row => ({ cogs: 0, cogs_forecast_basis: 0, rts_count: 0, revenue: 999, ...row }));
  return {
    products, kpis: { cogs: 0, cogs_adjusted: products.reduce((n, row) => n + row.cogs, 0),
      cogs_forecast_basis: products.reduce((n, row) => n + row.cogs_forecast_basis, 0), revenue: 999 },
    counts: { purchases: products.reduce((n, row) => n + row.gross_sales, 0), rts: products.reduce((n, row) => n + row.rts_count, 0) },
    selected: { start_date: scope.start, end_date: scope.end },
  };
};
function allocate(response: any, orders: ReturnType<typeof order>[], reports: any[], options: any = {}) {
  return allocateCogsUnits(response, { ...scope, ...options }, 'product', stores, orders, reports, 'snapshot');
}

describe('physical item quantity authority', () => {
  it('sums all item quantities including repeated variants and zero-cost lines, not orders or cost-derived totalQuantity', () => {
    expect(savedItemQuantity(order('1'))).toBe(6);
    expect(savedItemQuantity(order('1', { snapshotQuantities: [2, 2, '3'], totalQuantity: 0 }))).toBe(7);
  });
  it.each([null, 'null'])('uses saved itemData only if snapshot items are absent (%s)', snapshotKind => {
    expect(savedItemQuantity(order('1', { snapshotKind, snapshotQuantities: null, dataQuantities: [4, '5'] }))).toBe(9);
  });
  it.each([
    ['array', []], ['object', { quantity: 4 }], ['array', [null]], ['array', [0]],
    ['array', [-1]], ['array', [1.5]], ['array', ['2.0']], ['array', ['NaN']],
    ['array', [{}]], ['array', [Number.MAX_SAFE_INTEGER, 1]],
  ])('does not invent a quantity or fall back from present invalid snapshot %s/%j', (snapshotKind, snapshotQuantities) => {
    expect(savedItemQuantity(order('1', { snapshotKind, snapshotQuantities, dataQuantities: [99] }))).toBeNull();
  });
  it('returns unknown when both sources are missing', () => {
    expect(savedItemQuantity(order('1', { snapshotKind: null, dataKind: null, dataQuantities: null }))).toBeNull();
  });
});

describe('exact report membership and filters', () => {
  it('counts one multi-item delivered order once even with repeated membership in the same bucket', () => {
    const o = order('1', { mapping: 'Wrong legacy mapping' });
    const original = base();
    const result = allocate(original, [o, { ...o }], [report('Product A', [o, o]), report('Product A', [o], { id: 'another-ad' })]);
    expect(result.products[0].actual_units).toBe(6);
    expect(result.kpis.actual_units).toBe(6);
    expect(result.actualUnitsCoverage.duplicateOrderRows).toBe(1);
    expect(result.actualUnitsCoverage.policy).toBe(ACTUAL_COGS_UNITS_POLICY);
    expect(original).not.toHaveProperty('actualUnitsCoverage');
    expect(original.kpis).not.toHaveProperty('actual_units');
    expect(original.products[0]).not.toHaveProperty('actual_units');
    expect(result.products[0]).toHaveProperty('cogs', original.products[0].cogs);
  });
  it('preserves actual units for a delivered order historically marked abandoned', () => {
    const o = order('1', { wasAbandonedCart: true, isAbandoned: true });
    const result = allocate(base(), [o], [report('Product A', [o])]);
    expect(result.kpis.actual_units).toBe(6);
  });
  it('applies tenant, order-date, current status, void, active shop, team, and repurchase scope together', () => {
    const valid = order('valid', { dateLocal: scope.start });
    const final = order('final', { dateLocal: scope.end, snapshotQuantities: [4] });
    const excluded = [
      order('foreign', { tenantId: 'other-tenant' }), order('old', { dateLocal: '2026-09-30' }),
      order('future', { dateLocal: '2026-10-20' }), order('void', { isVoid: true }),
      order('rts', { status: 4 }), order('cancel', { status: 6 }), order('deleted', { status: 7 }),
      order('restock', { status: 11 }), order('abandoned', { status: 0, isAbandoned: true }),
      order('other-team', { teamId: teamB }), order('inactive', { shopId: 'inactive-shop' }),
      order('repurchase', { isRepurchase: true }),
    ];
    const result = allocate(base([{ mapping: 'Product A', gross_sales: 2 }]), [valid, final, ...excluded], [
      report('Product A', [valid], { date: scope.start }), report('Product A', [final], { date: scope.end }),
      report('Product A', excluded),
    ], { teamIds: [teamA] });
    expect(result.kpis.actual_units).toBe(10);
  });
  it('includes repurchase quantities only when repurchase exclusion is disabled', () => {
    const o = order('repurchase', { isRepurchase: true });
    expect(allocate(base(), [o], [report('Product A', [o])], { excludeRepurchase: false }).kpis.actual_units).toBe(6);
    expect(allocate(base([{ mapping: 'Product A', gross_sales: 0 }]), [o], [report('Product A', [o])]).kpis.actual_units).toBe(0);
  });
  it('keeps a conflicting mapping outside the selected product/team as a negative ownership witness', () => {
    const o = order('1');
    const result = allocate(base(), [o], [
      report('Product A', [o]), report('Product B', [o], { teamId: teamB }),
    ], { allSelected: false, teamIds: [teamA] });
    expect(result.products[0].actual_units).toBeNull();
    expect(result.kpis.actual_units).toBeNull();
    expect(result.actualUnitsCoverage.rows[0].selected.ambiguousMembershipOrders).toBe(1);
  });
  it('never double-counts one order assigned to two selected buckets', () => {
    const o = order('1');
    const result = allocate(base([{ mapping: 'A', gross_sales: 1 }, { mapping: 'B', gross_sales: 1 }]), [o], [report('A', [o]), report('B', [o])]);
    expect(result.products.map(row => row.actual_units)).toEqual([null, null]);
    expect(result.kpis.actual_units).toBeNull();
  });
  it('does not use same external order ID from a different shop or date as membership', () => {
    const o = order('1');
    const result = allocate(base(), [o], [report('Product A', [order('1', { shopId: 'shop-b' })]),
      report('Product A', [o], { date: '2026-10-09' })]);
    expect(result.kpis.actual_units).toBeNull();
    expect(result.actualUnitsCoverage.rows[0].selected.reportOrderCountMatches).toBe(false);
  });
  it('reports partial/missing quantity as unknown instead of zero or a partial sum', () => {
    const a = order('1'), b = order('2', { snapshotQuantities: [null] });
    const result = allocate(base([{ mapping: 'A', gross_sales: 2 }]), [a, b], [report('A', [a, b])]);
    expect(result.products[0].actual_units).toBeNull();
    expect(result.actualUnitsCoverage.rows[0].selected.unknownQuantityOrders).toBe(1);
  });
  it('reports missing membership and stale financial order-count coverage as unavailable', () => {
    const o = order('1');
    expect(allocate(base(), [o], []).products[0].actual_units).toBeNull();
    expect(allocate(base([{ mapping: 'Product A', gross_sales: 2 }]), [o], [report('Product A', [o])]).kpis.actual_units).toBeNull();
    expect(allocate(base(), [o], [report('Product A', [o], { matchedOrders: [{ posOrderId: '1' }] })]).kpis.actual_units).toBeNull();
  });
  it('returns actual zero for a valid saved report with no delivered orders', () => {
    const result = allocate(base([{ mapping: 'Product A', gross_sales: 0 }]), [], [report('Product A', [])]);
    expect(result.products[0].actual_units).toBe(0);
    expect(result.kpis.actual_units).toBe(0);
  });
  it('does not silently omit unassigned delivered orders from an All Products total', () => {
    const o = order('1'), missing = order('2');
    const result = allocate(base(), [o, missing], [report('Product A', [o])]);
    expect(result.products[0].actual_units).toBe(6);
    expect(result.kpis.actual_units).toBeNull();
    expect(allocate(base(), [o, missing], [report('Product A', [o])], { allSelected: false }).kpis.actual_units).toBe(6);
  });
});

describe('units match the existing financial COGS cohort', () => {
  const calculations = new SalesAnalyticsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any) as any;
  const orders = [0, 1, 2, 3, 4, 5, 6, 9, 11, 12, 13, null].flatMap((status, index) => [
    order(`normal-${index}`, { status, snapshotQuantities: [index + 1, 2], cogs: '1.10', cod: 100 }),
    order(`repurchase-${index}`, { status, isRepurchase: true, snapshotQuantities: [index + 3], cogs: '2.20', cod: 200 }),
  ]).concat([
    order('currently-abandoned', { status: 0, isAbandoned: true, snapshotQuantities: [5], cogs: '3.30', cod: 100 }),
    order('repurchase-currently-abandoned', { status: 0, isAbandoned: true, isRepurchase: true, snapshotQuantities: [7], cogs: '4.40', cod: 100 }),
    order('historically-abandoned-delivered', { status: 3, isAbandoned: true, wasAbandonedCart: true, snapshotQuantities: [9], cogs: '5.50', cod: 100 }),
    order('free-stock', { status: 3, snapshotQuantities: [17], cogs: '0.00', cod: 100 }),
    order('deleted', { status: 7, snapshotQuantities: [1000], cogs: '1000', cod: 100 }),
    order('void', { status: 3, isVoid: true, snapshotQuantities: [1000], cogs: '1000', cod: 100 }),
  ]);
  const combinations = Array.from({ length: 32 }, (_, mask) => ({
    excludeCancel: !!(mask & 1), excludeRestocking: !!(mask & 2), excludeAbandoned: !!(mask & 4),
    excludeRts: !!(mask & 8), excludeRepurchase: !!(mask & 16),
  }));
  it.each(combinations)('matches COGS, order counts and actual/forecast quantities under filters %j', filters => {
    const aggregate = createEmptyPosAggregateBucket();
    orders.forEach(o => accumulatePosOrder(aggregate, o));
    const options = { ...filters, includeTax12: false, includeTax1: false };
    const sum = { mapping: 'Product A', _sum: aggregate };
    const product = calculations.computeProductRow(sum, options);
    const financial = {
      products: [{ ...product, store_id: 'store-a' }],
      kpis: calculations.computeKpis(sum, options),
      counts: calculations.computeCounts(sum, options),
    };
    const expectedBefore = orders.filter(o => !o.isVoid && o.status !== 7
      && !(filters.excludeRepurchase && o.isRepurchase)
      && !(filters.excludeCancel && o.status === 6)
      && !(filters.excludeRestocking && o.status === 11)
      && !(filters.excludeAbandoned && o.status === 0 && o.isAbandoned));
    const expectedSelected = expectedBefore.filter(o => !filters.excludeRts || ![4, 5].includes(o.status!));
    const quantity = (values: typeof orders) => values.reduce((n, o) => n + savedItemQuantity(o)!, 0);
    for (const mode of ['product', 'store'] as const) {
      const result = allocateCogsUnits(financial, { ...scope, ...filters }, mode, stores, orders,
        [report('Product A', orders)], 'now');
      expect(result.kpis.actual_units).toBe(quantity(expectedSelected));
      expect(result.kpis.actual_units_forecast_basis).toBe(quantity(expectedBefore));
      expect(result.products[0].actual_units).toBe(result.kpis.actual_units);
      expect(result.products[0].actual_units_forecast_basis).toBe(result.kpis.actual_units_forecast_basis);
      expect(result.actualUnitsCoverage.status).toBe('COMPLETE');
      expect(result.actualUnitsCoverage.selected.reportCogsMatches).toBe(true);
      expect(result.actualUnitsCoverage.beforeRts.reportCogsMatches).toBe(true);
    }
  });
  it('keeps selected units available when only excluded RTS quantity is missing', () => {
    const delivered = order('known', { cogs: '10.00' });
    const rts = order('unknown-rts', { status: 5, cogs: '5.00', snapshotQuantities: [null] });
    const response = base([{ mapping: 'Product A', gross_sales: 1, rts_count: 1, cogs: 10, cogs_forecast_basis: 15 }]);
    const result = allocate(response, [delivered, rts], [report('Product A', [delivered, rts])]);
    expect(result.kpis.actual_units).toBe(6);
    expect(result.kpis.actual_units_forecast_basis).toBeNull();
    expect(result.actualUnitsCoverage.selected.unknownQuantityOrders).toBe(0);
    expect(result.actualUnitsCoverage.beforeRts.unknownQuantityOrders).toBe(1);
  });
  it('rejects stale COGS even when report order count still matches, without altering the report', () => {
    const o = order('1', { cogs: '9.99' });
    const response = base([{ mapping: 'Product A', gross_sales: 1, cogs: 10, cogs_forecast_basis: 10 }]);
    const result = allocate(response, [o], [report('Product A', [o])]);
    expect(result.kpis.actual_units).toBeNull();
    expect(result.kpis.actual_units_forecast_basis).toBeNull();
    expect(result.actualUnitsCoverage.selected.reportOrderCountMatches).toBe(true);
    expect(result.actualUnitsCoverage.selected.reportCogsMatches).toBe(false);
    expect(result.products[0].cogs).toBe(10);
  });
  it('accepts real zero cost and compares decimal cents without float-sum artifacts', () => {
    const a = order('1', { cogs: '0.10' }), b = order('2', { cogs: '0.20' }), c = order('3', { cogs: '0.00' });
    const response = base([{ mapping: 'Product A', gross_sales: 3, cogs: 0.1 + 0.2, cogs_forecast_basis: 0.1 + 0.2 }]);
    expect(allocate(response, [a, b, c], [report('Product A', [a, b, c])]).kpis.actual_units).toBe(18);
  });
  it('does not certify a total when total COGS disagrees despite each row matching', () => {
    const o = order('1');
    const response = base();
    response.kpis.cogs_adjusted = 99;
    const result = allocate(response, [o], [report('Product A', [o])]);
    expect(result.products[0].actual_units).toBe(6);
    expect(result.kpis.actual_units).toBeNull();
    expect(result.kpis.actual_units_forecast_basis).toBe(6);
  });
});

describe('store units use actual shop ownership', () => {
  it('assigns actual quantities to the unique store, independent of campaign/product attribution', () => {
    const a = order('1'), b = order('2', { shopId: 'shop-b', snapshotQuantities: [4] });
    const response = base([{ mapping: 'Store A', store_id: 'store-a', gross_sales: 1 },
      { mapping: 'Store B', store_id: 'store-b', gross_sales: 1 }]);
    const result = allocateCogsUnits(response, scope, 'store', stores, [a, b], [], 'snapshot');
    expect(result.products.map(row => row.actual_units)).toEqual([6, 4]);
    expect(result.kpis.actual_units).toBe(10);
  });
  it('respects store selection and does not guess a duplicated active shop owner', () => {
    const a = order('1'), b = order('2', { shopId: 'shop-b' });
    const selected = base([{ mapping: 'Store A', store_id: 'store-a', gross_sales: 1 }]);
    expect(allocateCogsUnits(selected, { ...scope, allSelected: false }, 'store', stores, [a, b], [], 'now').kpis.actual_units).toBe(6);
    const ambiguous = base([{ mapping: 'Unattributed', store_id: null, gross_sales: 1 }]);
    const result = allocateCogsUnits(ambiguous, scope, 'store', [...stores, { id: 'duplicate-owner', shopId: 'shop-a' }], [a], [], 'now');
    expect(result.products[0].actual_units).toBeNull();
    expect(result.actualUnitsCoverage.rows[0].selected.ambiguousMembershipOrders).toBe(1);
    expect(UNATTRIBUTED_STORE_KEY).toBeTruthy();
  });
});

describe('bounded read-only quantity queries', () => {
  function database(overrides: Record<string, any> = {}) {
    const o = order('1');
    const queries: any[] = [];
    const db: any = {
      $executeRaw: jest.fn(async () => 0),
      posStore: { findMany: jest.fn(async () => stores) },
      reconcileMarketing: { findMany: jest.fn(async () => [report('Product A', [o])]) },
      $queryRaw: jest.fn(async (sql: any) => {
        queries.push(sql);
        if (sql.text.includes('AS orders')) return [{ orders: '1', lines: '4' }];
        if (sql.text.includes('AS members')) return [{ rows: '1', bytes: '100', members: '1' }];
        return [o];
      }), ...overrides,
    };
    const prisma: any = { $transaction: jest.fn(async (operation: any) => operation(db)) };
    return { db, prisma, queries };
  }
  it('reads a repeatable read transaction, active tenant shops, all membership witnesses and bounded projected scalars', async () => {
    const { db, prisma, queries } = database();
    const result = await enrichActualCogsUnits(prisma, base(), scope, 'product');
    expect(result.kpis.actual_units).toBe(6);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 30000,
    });
    expect(db.$executeRaw.mock.calls.map((call: any) => call[0][0])).toEqual([
      'SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '10000ms'",
    ]);
    expect(db.posStore.findMany).toHaveBeenCalledWith({
      where: { tenantId, status: 'ACTIVE', OR: [{ enabled: true }, { enabled: null }] },
      select: { id: true, shopId: true },
    });
    expect(db.reconcileMarketing.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId, date: { gte: new Date('2026-10-01'), lte: new Date('2026-10-19') } }, take: 1000,
    }));
    const page = queries.find(query => query.text.startsWith('SELECT o.id'));
    expect(page.text).toContain("length(item->>'quantity') <= 16");
    expect(page.text).toContain("ELSE 'null'::jsonb");
    expect(page.text).not.toContain('totalQuantity');
    expect(page.text).not.toMatch(/SELECT.*o\."orderSnapshot"[, ]/);
    expect(page.text).toContain('LIMIT');
    expect(page.values).toContain(1000);
  });
  it('uses parameterized fixed scope and excludes void/repurchase without excluding previously abandoned deliveries', () => {
    const sql = cogsOrderWhere({ ...scope, teamIds: [teamA] }, ['shop-a'], 'cursor');
    expect(sql.text).toContain('o.status IS DISTINCT FROM 7 AND o."isVoid" = false');
    expect(sql.text).toContain('o."isRepurchase" = false');
    expect(sql.text).toContain('o.status IS DISTINCT FROM 6');
    expect(sql.text).toContain('o.status IS DISTINCT FROM 11');
    expect(sql.text).toContain('NOT (o.status IS NOT DISTINCT FROM 0 AND o."isAbandoned" = true)');
    expect(sql.text).not.toMatch(/status IN \(4,5\)|status = 3/);
    expect(sql.text).toContain('o."teamId" IN');
    expect(sql.text).not.toContain('wasAbandonedCart');
    expect(sql.text).not.toContain(tenantId);
    expect(sql.values).toEqual([tenantId, scope.start, scope.end, 'shop-a', teamA, 'cursor']);
    expect(cogsOrderWhere(scope, []).text).toContain('FALSE');
    expect(cogsOrderPage(scope, stores.map(s => s.shopId)).text).toContain('ORDER BY o.id LIMIT');
  });
  it.each([
    { orders: '100001', lines: '1' }, { orders: '1', lines: '500001' }, { orders: 'not-a-count', lines: '1' },
  ])('returns unknown without loading order payloads beyond quantity budget %j', async budget => {
    const { db, prisma } = database({ $queryRaw: jest.fn(async () => [budget]) });
    const result = await enrichActualCogsUnits(prisma, base(), scope, 'product');
    expect(result.actualUnitsCoverage).toMatchObject({ status: 'UNAVAILABLE', reason: 'QUANTITY_QUERY_BUDGET_EXCEEDED' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.reconcileMarketing.findMany).not.toHaveBeenCalled();
  });
  it('rejects oversized membership payloads and fails soft on a database read error', async () => {
    const { db, prisma } = database();
    db.$queryRaw.mockImplementation(async (sql: any) => {
      if (sql.text.includes('AS orders')) return [{ orders: '0', lines: '0' }];
      if (sql.text.includes('AS members')) return [{ rows: '1', bytes: '16777217', members: '1' }];
      return [];
    });
    const result = await enrichActualCogsUnits(prisma, base(), scope, 'product');
    expect(result.actualUnitsCoverage.reason).toBe('MEMBERSHIP_QUERY_BUDGET_EXCEEDED');
    expect(db.reconcileMarketing.findMany).not.toHaveBeenCalled();
    prisma.$transaction.mockRejectedValue(new Error('private diagnostic'));
    const failed = await enrichActualCogsUnits(prisma, base(), scope, 'product');
    expect(failed.kpis.cogs).toBe(0);
    expect(failed.kpis.actual_units).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('private diagnostic');
  });
  it('returns valid empty selection without querying saved orders or report memberships', async () => {
    const { prisma } = database();
    const result = await enrichActualCogsUnits(prisma, base([]), { ...scope, emptySelection: true }, 'product');
    expect(result.kpis.actual_units).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
