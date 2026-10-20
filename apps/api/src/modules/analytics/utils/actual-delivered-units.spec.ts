import { describe, expect, it, jest } from '@jest/globals';
import {
  ACTUAL_DELIVERED_UNITS_POLICY, allocateDeliveredUnits, deliveredOrderPage,
  deliveredOrderWhere, enrichActualDeliveredUnits, savedDeliveredQuantity,
} from './actual-delivered-units';
import { UNATTRIBUTED_STORE_KEY } from './store-attribution';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const teamA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const teamB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope = {
  tenantId, start: '2026-10-01', end: '2026-10-19', teamIds: [] as string[],
  excludeRepurchase: true, emptySelection: false, allSelected: true,
};
const stores = [{ id: 'store-a', shopId: 'shop-a' }, { id: 'store-b', shopId: 'shop-b' }];
const order = (id: string, extra: Record<string, any> = {}) => ({
  id, tenantId, shopId: 'shop-a', posOrderId: id, dateLocal: '2026-10-10',
  teamId: teamA, status: 3, isVoid: false, isRepurchase: false,
  snapshotKind: 'array', snapshotQuantities: [2, 3, 1], dataKind: 'array',
  dataQuantities: [1], totalQuantity: 1, cogs: 0, ...extra,
});
const report = (mapping: string | null, orders: ReturnType<typeof order>[], extra: Record<string, any> = {}) => ({
  id: `row-${mapping}`, date: new Date('2026-10-10'), teamId: teamA, mapping,
  matchedOrders: orders.map(o => ({ shopId: o.shopId, posOrderId: o.posOrderId, cod: 99 })),
  ...extra,
});
const base = (rows: any[] = [{ mapping: 'Product A', delivered_count: 1 }]) => ({
  products: rows.map(row => ({ cogs: 123, revenue: 999, ...row })),
  kpis: { cogs: 123, revenue: 999 }, counts: { delivered: rows.reduce((n, row) => n + row.delivered_count, 0) },
  selected: { start_date: scope.start, end_date: scope.end },
});
function allocate(response: any, orders: ReturnType<typeof order>[], reports: any[], options: any = {}) {
  return allocateDeliveredUnits(response, { ...scope, ...options }, 'product', stores, orders, reports, 'snapshot');
}

describe('physical delivered quantity authority', () => {
  it('sums all item quantities including repeated variants and zero-cost lines, not orders or cost-derived totalQuantity', () => {
    expect(savedDeliveredQuantity(order('1'))).toBe(6);
    expect(savedDeliveredQuantity(order('1', { snapshotQuantities: [2, 2, '3'], totalQuantity: 0 }))).toBe(7);
  });
  it.each([null, 'null'])('uses saved itemData only if snapshot items are absent (%s)', snapshotKind => {
    expect(savedDeliveredQuantity(order('1', { snapshotKind, snapshotQuantities: null, dataQuantities: [4, '5'] }))).toBe(9);
  });
  it.each([
    ['array', []], ['object', { quantity: 4 }], ['array', [null]], ['array', [0]],
    ['array', [-1]], ['array', [1.5]], ['array', ['2.0']], ['array', ['NaN']],
    ['array', [{}]], ['array', [Number.MAX_SAFE_INTEGER, 1]],
  ])('does not invent a quantity or fall back from present invalid snapshot %s/%j', (snapshotKind, snapshotQuantities) => {
    expect(savedDeliveredQuantity(order('1', { snapshotKind, snapshotQuantities, dataQuantities: [99] }))).toBeNull();
  });
  it('returns unknown when both sources are missing', () => {
    expect(savedDeliveredQuantity(order('1', { snapshotKind: null, dataKind: null, dataQuantities: null }))).toBeNull();
  });
});

describe('exact report membership and filters', () => {
  it('counts one multi-item delivered order once even with repeated membership in the same bucket', () => {
    const o = order('1', { mapping: 'Wrong legacy mapping' });
    const original = base();
    const result = allocate(original, [o, { ...o }], [report('Product A', [o, o]), report('Product A', [o], { id: 'another-ad' })]);
    expect(result.products[0].actual_delivered_units).toBe(6);
    expect(result.kpis.actual_delivered_units).toBe(6);
    expect(result.actualDeliveredUnitsCoverage.duplicateOrderRows).toBe(1);
    expect(result.actualDeliveredUnitsCoverage.policy).toBe(ACTUAL_DELIVERED_UNITS_POLICY);
    expect(original).not.toHaveProperty('actualDeliveredUnitsCoverage');
    expect(original.kpis).not.toHaveProperty('actual_delivered_units');
    expect(original.products[0]).not.toHaveProperty('actual_delivered_units');
    expect(result.products[0]).toHaveProperty('cogs', original.products[0].cogs);
  });
  it('preserves actual units for a delivered order historically marked abandoned', () => {
    const o = order('1', { wasAbandonedCart: true, isAbandoned: true });
    const result = allocate(base(), [o], [report('Product A', [o])]);
    expect(result.kpis.actual_delivered_units).toBe(6);
  });
  it('applies tenant, order-date, current status, void, active shop, team, and repurchase scope together', () => {
    const valid = order('valid', { dateLocal: scope.start });
    const final = order('final', { dateLocal: scope.end, snapshotQuantities: [4] });
    const excluded = [
      order('foreign', { tenantId: 'other-tenant' }), order('old', { dateLocal: '2026-09-30' }),
      order('future', { dateLocal: '2026-10-20' }), order('void', { isVoid: true }),
      order('rts', { status: 4 }), order('cancel', { status: 6 }), order('deleted', { status: 7 }),
      order('restock', { status: 11 }), order('abandoned', { status: 0 }),
      order('other-team', { teamId: teamB }), order('inactive', { shopId: 'inactive-shop' }),
      order('repurchase', { isRepurchase: true }),
    ];
    const result = allocate(base([{ mapping: 'Product A', delivered_count: 2 }]), [valid, final, ...excluded], [
      report('Product A', [valid], { date: scope.start }), report('Product A', [final], { date: scope.end }),
      report('Product A', excluded),
    ], { teamIds: [teamA] });
    expect(result.kpis.actual_delivered_units).toBe(10);
  });
  it('includes repurchase quantities only when repurchase exclusion is disabled', () => {
    const o = order('repurchase', { isRepurchase: true });
    expect(allocate(base(), [o], [report('Product A', [o])], { excludeRepurchase: false }).kpis.actual_delivered_units).toBe(6);
    expect(allocate(base([{ mapping: 'Product A', delivered_count: 0 }]), [o], [report('Product A', [o])]).kpis.actual_delivered_units).toBe(0);
  });
  it('keeps a conflicting mapping outside the selected product/team as a negative ownership witness', () => {
    const o = order('1');
    const result = allocate(base(), [o], [
      report('Product A', [o]), report('Product B', [o], { teamId: teamB }),
    ], { allSelected: false, teamIds: [teamA] });
    expect(result.products[0].actual_delivered_units).toBeNull();
    expect(result.kpis.actual_delivered_units).toBeNull();
    expect(result.actualDeliveredUnitsCoverage.rows[0].ambiguousMembershipOrders).toBe(1);
  });
  it('never double-counts one order assigned to two selected buckets', () => {
    const o = order('1');
    const result = allocate(base([{ mapping: 'A', delivered_count: 1 }, { mapping: 'B', delivered_count: 1 }]), [o], [report('A', [o]), report('B', [o])]);
    expect(result.products.map(row => row.actual_delivered_units)).toEqual([null, null]);
    expect(result.kpis.actual_delivered_units).toBeNull();
  });
  it('does not use same external order ID from a different shop or date as membership', () => {
    const o = order('1');
    const result = allocate(base(), [o], [report('Product A', [order('1', { shopId: 'shop-b' })]),
      report('Product A', [o], { date: '2026-10-09' })]);
    expect(result.kpis.actual_delivered_units).toBeNull();
    expect(result.actualDeliveredUnitsCoverage.rows[0].reportOrderCountMatches).toBe(false);
  });
  it('reports partial/missing quantity as unknown instead of zero or a partial sum', () => {
    const a = order('1'), b = order('2', { snapshotQuantities: [null] });
    const result = allocate(base([{ mapping: 'A', delivered_count: 2 }]), [a, b], [report('A', [a, b])]);
    expect(result.products[0].actual_delivered_units).toBeNull();
    expect(result.actualDeliveredUnitsCoverage.rows[0].unknownQuantityOrders).toBe(1);
  });
  it('reports missing membership and stale financial order-count coverage as unavailable', () => {
    const o = order('1');
    expect(allocate(base(), [o], []).products[0].actual_delivered_units).toBeNull();
    expect(allocate(base([{ mapping: 'Product A', delivered_count: 2 }]), [o], [report('Product A', [o])]).kpis.actual_delivered_units).toBeNull();
    expect(allocate(base(), [o], [report('Product A', [o], { matchedOrders: [{ posOrderId: '1' }] })]).kpis.actual_delivered_units).toBeNull();
  });
  it('returns actual zero for a valid saved report with no delivered orders', () => {
    const result = allocate(base([{ mapping: 'Product A', delivered_count: 0 }]), [], [report('Product A', [])]);
    expect(result.products[0].actual_delivered_units).toBe(0);
    expect(result.kpis.actual_delivered_units).toBe(0);
  });
  it('does not silently omit unassigned delivered orders from an All Products total', () => {
    const o = order('1'), missing = order('2');
    const result = allocate(base(), [o, missing], [report('Product A', [o])]);
    expect(result.products[0].actual_delivered_units).toBe(6);
    expect(result.kpis.actual_delivered_units).toBeNull();
    expect(allocate(base(), [o, missing], [report('Product A', [o])], { allSelected: false }).kpis.actual_delivered_units).toBe(6);
  });
});

describe('store units use actual shop ownership', () => {
  it('assigns actual quantities to the unique store, independent of campaign/product attribution', () => {
    const a = order('1'), b = order('2', { shopId: 'shop-b', snapshotQuantities: [4] });
    const response = base([{ mapping: 'Store A', store_id: 'store-a', delivered_count: 1 },
      { mapping: 'Store B', store_id: 'store-b', delivered_count: 1 }]);
    const result = allocateDeliveredUnits(response, scope, 'store', stores, [a, b], [], 'snapshot');
    expect(result.products.map(row => row.actual_delivered_units)).toEqual([6, 4]);
    expect(result.kpis.actual_delivered_units).toBe(10);
  });
  it('respects store selection and does not guess a duplicated active shop owner', () => {
    const a = order('1'), b = order('2', { shopId: 'shop-b' });
    const selected = base([{ mapping: 'Store A', store_id: 'store-a', delivered_count: 1 }]);
    expect(allocateDeliveredUnits(selected, { ...scope, allSelected: false }, 'store', stores, [a, b], [], 'now').kpis.actual_delivered_units).toBe(6);
    const ambiguous = base([{ mapping: 'Unattributed', store_id: null, delivered_count: 1 }]);
    const result = allocateDeliveredUnits(ambiguous, scope, 'store', [...stores, { id: 'duplicate-owner', shopId: 'shop-a' }], [a], [], 'now');
    expect(result.products[0].actual_delivered_units).toBeNull();
    expect(result.actualDeliveredUnitsCoverage.rows[0].ambiguousMembershipOrders).toBe(1);
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
    const result = await enrichActualDeliveredUnits(prisma, base(), scope, 'product');
    expect(result.kpis.actual_delivered_units).toBe(6);
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
    const sql = deliveredOrderWhere({ ...scope, teamIds: [teamA] }, ['shop-a'], 'cursor');
    expect(sql.text).toContain('o.status = 3 AND o."isVoid" = false');
    expect(sql.text).toContain('o."isRepurchase" = false');
    expect(sql.text).toContain('o."teamId" IN');
    expect(sql.text).not.toContain('wasAbandonedCart');
    expect(sql.text).not.toContain(tenantId);
    expect(sql.values).toEqual([tenantId, scope.start, scope.end, 'shop-a', teamA, 'cursor']);
    expect(deliveredOrderWhere(scope, []).text).toContain('FALSE');
    expect(deliveredOrderPage(scope, stores.map(s => s.shopId)).text).toContain('ORDER BY o.id LIMIT');
  });
  it.each([
    { orders: '100001', lines: '1' }, { orders: '1', lines: '500001' }, { orders: 'not-a-count', lines: '1' },
  ])('returns unknown without loading order payloads beyond quantity budget %j', async budget => {
    const { db, prisma } = database({ $queryRaw: jest.fn(async () => [budget]) });
    const result = await enrichActualDeliveredUnits(prisma, base(), scope, 'product');
    expect(result.actualDeliveredUnitsCoverage).toMatchObject({ status: 'UNAVAILABLE', reason: 'QUANTITY_QUERY_BUDGET_EXCEEDED' });
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
    const result = await enrichActualDeliveredUnits(prisma, base(), scope, 'product');
    expect(result.actualDeliveredUnitsCoverage.reason).toBe('MEMBERSHIP_QUERY_BUDGET_EXCEEDED');
    expect(db.reconcileMarketing.findMany).not.toHaveBeenCalled();
    prisma.$transaction.mockRejectedValue(new Error('private diagnostic'));
    const failed = await enrichActualDeliveredUnits(prisma, base(), scope, 'product');
    expect(failed.kpis.cogs).toBe(123);
    expect(failed.kpis.actual_delivered_units).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('private diagnostic');
  });
  it('returns valid empty selection without querying saved orders or report memberships', async () => {
    const { prisma } = database();
    const result = await enrichActualDeliveredUnits(prisma, base([]), { ...scope, emptySelection: true }, 'product');
    expect(result.kpis.actual_delivered_units).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
