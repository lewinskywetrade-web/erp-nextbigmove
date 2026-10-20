import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { calculateSavedErpCogs, COGS_REFRESH_ORDER_LOCK_SQL, COGS_REFRESH_ORDERS_SQL,
  COGS_REFRESH_PARENT_LOCK_SQL, ProductCogsRecalculationService, resolveSavedCogsProduct } from './product-cogs-recalculation.service';

const tenantId = '10000000-0000-0000-0000-000000000001';
const storeId = '20000000-0000-0000-0000-000000000001';
const productA = { id: '30000000-0000-0000-0000-000000000001', productId: 'parent', variationId: 'variant-a', customId: 'SKU-A' };
const productB = { ...productA, id: '30000000-0000-0000-0000-000000000002', variationId: 'variant-b', customId: 'SKU-B' };
const itemA = { product_id: 'parent', variation_id: 'variant-a', quantity: 2 };
const scope = { tenantId, storeId, changes: [{ productId: productA.id, fromDate: '2026-10-19', toDate: null }] };
const order = (overrides: any = {}) => ({ id: '40000000-0000-0000-0000-000000000001', tenantId, shopId: 'shop-1',
  dateLocal: '2026-10-19', totalQuantity: 2, status: 3, isVoid: false, cogs: '0.00', updatedAt: new Date('2026-10-19T01:00:00Z'),
  snapshotItemsPresent: true, snapshotItems: [itemA], dataItems: null, ...overrides });
const cost = (overrides: any = {}) => ({ id: 'cost-1', productId: productA.id, tenantId, storeId,
  cogs: new Decimal('10.00'), startDate: null, endDate: null, ...overrides });
beforeEach(() => { jest.useFakeTimers().setSystemTime(new Date('2026-10-19T18:00:00Z')); });
afterEach(() => { jest.useRealTimers(); });

describe('strict saved-order ERP catalog calculation', () => {
  it('resolves one exact variant and rejects conflicting parents or display codes', () => {
    expect(resolveSavedCogsProduct(itemA, [productA, productB])).toBe(productA);
    expect(resolveSavedCogsProduct({ ...itemA, product_id: 'wrong-parent' }, [productA])).toBeNull();
    expect(resolveSavedCogsProduct({ ...itemA, product_display_id: 'SKU-B' }, [productA, productB])).toBeNull();
    expect(resolveSavedCogsProduct({ product_id: 'parent' }, [productA, productB])).toBeNull();
    expect(resolveSavedCogsProduct({ ...itemA, variation_id: 'unknown' }, [productA])).toBeNull();
    expect(resolveSavedCogsProduct({ ...itemA, variationId: 'variant-b' }, [productA, productB])).toBeNull();
    expect(resolveSavedCogsProduct({ ...itemA, productId: 'different-parent' }, [productA])).toBeNull();
  });

  it('accepts exact variants with unknown provider barcode aliases but rejects every recognized conflicting alias', () => {
    expect(resolveSavedCogsProduct({ ...itemA, product_display_id: 'provider-code',
      variation_info: { barcode: 'unregistered-barcode' } }, [productA, productB])).toBe(productA);
    expect(resolveSavedCogsProduct({ ...itemA, product_display_id: 'SKU-A',
      variation_info: { barcode: 'SKU-B' } }, [productA, productB])).toBeNull();
    expect(resolveSavedCogsProduct({ ...itemA, product_display_id: 'provider-code' },
      [productA, { ...productB, customId: 'provider-code' }])).toBeNull();
    expect(resolveSavedCogsProduct({ product_display_id: 'provider-code' }, [productA, productB])).toBeNull();
  });

  it('can replay a complete itemData snapshot only through a unique variant display code', () => {
    const saved = order({ snapshotItemsPresent: false, snapshotItems: null, dataItems: [{ productId: 'parent', productDisplayId: 'SKU-A', quantity: '2' }] });
    expect(calculateSavedErpCogs(saved, [productA, productB], [cost()], scope)!.amount.toFixed(2)).toBe('20.00');
    expect(calculateSavedErpCogs(saved, [productA, { ...productB, customId: 'SKU-A' }], [cost()], scope)).toBeNull();
  });

  it('prefers a valid dated ERP cost over the undated default', () => {
    const history = [cost({ cogs: new Decimal(5) }), cost({ startDate: new Date('2026-10-19'), cogs: new Decimal('10.25') })];
    const calculated = calculateSavedErpCogs(order(), [productA], history, scope)!;
    expect(calculated.amount.toFixed(2)).toBe('20.50');
    expect(calculated.productIds).toEqual([productA.id]);
  });

  it('uses the zero rate on its effective date rather than falling back to the paid default', () => {
    const histories = [cost({ cogs: new Decimal(10) }), cost({ startDate: new Date('2026-10-19'), cogs: new Decimal(0) })];
    expect(calculateSavedErpCogs(order({ dateLocal: '2026-10-18' }), [productA], histories, scope)!.amount.toFixed(2)).toBe('20.00');
    expect(calculateSavedErpCogs(order(), [productA], histories, scope)!.amount.toFixed(2)).toBe('0.00');
    expect(calculateSavedErpCogs(order(), [productA], [], scope)).toBeNull();
  });

  it('includes a verified zero-cost line in the full order quantity and sum', () => {
    const saved = order({ totalQuantity: 3, snapshotItems: [itemA, { ...itemA, variation_id: 'variant-b', quantity: 1 }] });
    const histories = [cost({ cogs: new Decimal(0) }), cost({ productId: productB.id, cogs: new Decimal('12.34') })];
    expect(calculateSavedErpCogs(saved, [productA, productB], histories, scope)!.amount.toFixed(2)).toBe('12.34');
  });

  it('does not use future/expired costs or note_product text to fill a catalog gap', () => {
    const saved = order({ snapshotItems: [{ ...itemA, note_product: 'SKU-A-999' }] });
    expect(calculateSavedErpCogs(saved, [productA], [cost({ startDate: new Date('2026-10-20') }),
      cost({ endDate: new Date('2026-10-18') })], scope)).toBeNull();
    expect(calculateSavedErpCogs(saved, [productA], [], scope)).toBeNull();
  });

  it.each([
    ['partial quantity', order({ totalQuantity: 3 }), [cost()]],
    ['explicit empty snapshot', order({ snapshotItems: [], dataItems: [itemA] }), [cost()]],
    ['void', order({ isVoid: true }), [cost()]],
    ['deleted but not void', order({ status: 7 }), [cost()]],
    ['fractional quantity', order({ snapshotItems: [{ ...itemA, quantity: 1.5 }] }), [cost()]],
    ['zero quantity', order({ totalQuantity: 0, snapshotItems: [{ ...itemA, quantity: 0 }] }), [cost()]],
    ['wrong tenant cost', order(), [cost({ tenantId: 'another-tenant' })]],
    ['wrong store cost', order(), [cost({ storeId: 'another-store' })]],
    ['negative cost', order(), [cost({ cogs: new Decimal(-1) })]],
    ['overlapping dated costs', order(), [cost({ startDate: new Date('2026-10-01') }), cost({ startDate: new Date('2026-10-19') })]],
    ['duplicate applicable defaults', order(), [cost(), cost({ id: 'second' })]],
    ['invalid range', order(), [cost({ startDate: new Date('2026-10-19'), endDate: new Date('2026-10-18') })]],
  ])('preserves existing order cost when %s is unresolved', (_reason, saved, history) => {
    expect(calculateSavedErpCogs(saved as any, [productA], history as any, scope)).toBeNull();
  });

  it.each([null, {}, 'invalid', 42, false])('does not replace present invalid snapshot items %p with valid legacy items', snapshotItems => {
    expect(calculateSavedErpCogs(order({ snapshotItems, dataItems: [itemA] }), [productA], [cost()], scope)).toBeNull();
  });

  it('requires known snapshot presence before considering legacy itemData', () => {
    expect(calculateSavedErpCogs(order({ snapshotItemsPresent: undefined, snapshotItems: null, dataItems: [itemA] }),
      [productA], [cost()], scope)).toBeNull();
  });

  it('requires costs for every order line and never applies a partial sum', () => {
    const saved = order({ totalQuantity: 3, snapshotItems: [itemA, { ...itemA, variation_id: 'variant-b', quantity: 1 }] });
    expect(calculateSavedErpCogs(saved, [productA, productB], [cost()], scope)).toBeNull();
    expect(calculateSavedErpCogs(saved, [productA, productB], [cost({ cogs: new Decimal('0.10') }),
      cost({ productId: productB.id, cogs: new Decimal('0.20') })], scope)!.amount.toFixed(2)).toBe('0.40');
  });
});

function harness(orders = [order()]) {
  const events: string[] = [];
  const hooks = { casConflict: false, changedSnapshot: false, changedStatus: false, changedSnapshotPresence: false,
    duplicateStore: false, duplicateDisplay: false };
  const writes: any[] = [];
  let history = [cost()];
  const tx = {
    $executeRawUnsafe: jest.fn(async (sql: string) => { if (sql.startsWith('LOCK TABLE')) events.push('catalog-table-lock'); return 0; }),
    posStore: { findMany: jest.fn(async () => [{ id: storeId }]) },
    posProduct: { findMany: jest.fn(async () => [productA, { ...productB, ...(hooks.duplicateDisplay ? { customId: 'SKU-A' } : {}) }]) },
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      if (sql === COGS_REFRESH_PARENT_LOCK_SQL) {
        events.push('parent-lock');
        expect(params[1]).toBe(storeId); expect(params[2]).toBe(tenantId);
        expect(params[0]).toEqual([...params[0]].sort());
        return [productA, productB].filter(product => params[0].includes(product.id));
      }
      expect(sql).toBe(COGS_REFRESH_ORDER_LOCK_SQL);
      expect(params.slice(1)).toEqual([tenantId, 'shop-1']);
      events.push('order-lock');
      const saved = orders.find(row => row.id === params[0]);
      return saved ? [{ ...saved, ...(hooks.changedSnapshot ? { snapshotItems: [{ ...itemA, quantity: 3 }] } : {}),
        ...(hooks.changedStatus ? { status: 7 } : {}),
        ...(hooks.changedSnapshotPresence ? { snapshotItemsPresent: !saved.snapshotItemsPresent } : {}) }] : [];
    }),
    posProductCogs: { findMany: jest.fn(async (_args: any) => { events.push('history-read'); return history; }) },
    posOrder: { updateMany: jest.fn(async (args: any) => { events.push('order-cas'); writes.push(args); return { count: hooks.casConflict ? 0 : 1 }; }) },
  };
  const prisma = {
    posStore: {
      findFirst: jest.fn(async () => ({ id: storeId, shopId: 'shop-1' })),
      findMany: jest.fn(async () => hooks.duplicateStore ? [{ id: storeId }, { id: 'another-store' }] : [{ id: storeId }]),
    },
    posProduct: { findMany: jest.fn(async () => [productA, productB]) },
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      expect(sql).toBe(COGS_REFRESH_ORDERS_SQL);
      expect(params.slice(0, 2)).toEqual([tenantId, 'shop-1']);
      return orders;
    }),
    $transaction: jest.fn(async (callback: (client: any) => Promise<any>, options: any) => {
      expect(options.isolationLevel).toBe('ReadCommitted'); return callback(tx);
    }),
  };
  return { service: new ProductCogsRecalculationService(prisma as never), prisma, tx, events, hooks, writes,
    setHistory: (rows: any[]) => { history = rows; } };
}

describe('bounded durable ERP order recalculation pages', () => {
  it('waits on the publishing transaction parent locks with bounded database timeouts', async () => {
    const { service, tx, events } = harness();
    await service.waitForSourceTransaction(scope);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '5000ms'");
    expect(events).toEqual(['parent-lock']);
  });

  it('writes the complete ERP amount under source locks and an exact order CAS', async () => {
    const { service, tx, events, writes } = harness();
    const result = await service.recalculateBatch({ ...scope, pageSize: 1 });
    expect(result).toMatchObject({ updated: 1, examined: 1, nextCursor: order().id, affectedDates: ['2026-10-19'] });
    expect(events).toEqual(['catalog-table-lock', 'parent-lock', 'history-read', 'order-lock', 'order-cas']);
    expect(writes[0].where).toMatchObject({ id: order().id, tenantId, shopId: 'shop-1', updatedAt: order().updatedAt,
      cogs: new Decimal(0), totalQuantity: 2, dateLocal: '2026-10-19', status: 3, isVoid: false });
    expect(writes[0].data.cogs.toFixed(2)).toBe('20.00');
    expect(Object.keys(writes[0].data)).toEqual(['cogs']);
    expect(tx.posProductCogs.findMany).toHaveBeenCalledWith({ where: { productId: { in: [productA.id] } } });
  });

  it('retains examined dates on already-correct retries without changing order versions', async () => {
    const { service, writes } = harness([order({ cogs: '20.00' })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ unchanged: 1, updated: 0, affectedDates: ['2026-10-19'] });
    expect(writes).toHaveLength(0);
  });

  it('can apply a verified zero rate to an order without treating missing history as zero', async () => {
    const { service, setHistory, writes } = harness([order({ cogs: '20.00' })]);
    setHistory([cost({ cogs: new Decimal(0) })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ updated: 1, skipped: 0, affectedDates: ['2026-10-19'] });
    expect(writes[0].where.cogs.toFixed(2)).toBe('20.00');
    expect(writes[0].data.cogs.toFixed(2)).toBe('0.00');
  });

  it('preserves amounts when any line lacks an applicable ERP cost', async () => {
    const { service, setHistory, writes } = harness(); setHistory([]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ skipped: 1, updated: 0, affectedDates: ['2026-10-19'] });
    expect(writes).toHaveLength(0);
  });

  it('does not advance a page after CAS failure so the durable job can retry every order', async () => {
    const { service, hooks } = harness(); hooks.casConflict = true;
    await expect(service.recalculateBatch({ ...scope, pageSize: 1 })).rejects.toBeInstanceOf(ConflictException);
    hooks.casConflict = false;
    expect(await service.recalculateBatch({ ...scope, pageSize: 1 })).toMatchObject({ updated: 1, nextCursor: order().id });
  });

  it('retries a concurrent item change even when its millisecond timestamp was unchanged', async () => {
    const { service, hooks, writes } = harness(); hooks.changedSnapshot = true;
    await expect(service.recalculateBatch(scope)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('retries a concurrent deleted status before any cost write even with an unchanged timestamp', async () => {
    const { service, hooks, writes } = harness(); hooks.changedStatus = true;
    await expect(service.recalculateBatch(scope)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('retries newly present invalid snapshot items rather than using the prior legacy fallback', async () => {
    const { service, hooks, writes } = harness([order({ snapshotItemsPresent: false, snapshotItems: null, dataItems: [itemA] })]);
    hooks.changedSnapshotPresence = true;
    await expect(service.recalculateBatch(scope)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('excludes deleted and void orders before catalog locks or affected report dates', async () => {
    const { service, events, writes } = harness([order({ status: 7 }), order({ isVoid: true })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ examined: 2, skipped: 2, updated: 0, affectedDates: [] });
    expect(events).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(COGS_REFRESH_ORDERS_SQL).toContain('o."isVoid"=false AND (o.status IS NULL OR o.status<>7)');
  });

  it('preserves a malformed authoritative snapshot before catalog locks instead of writing from legacy data', async () => {
    const { service, events, writes } = harness([order({ snapshotItems: null, dataItems: [itemA] })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ skipped: 1, updated: 0 });
    expect(events).toHaveLength(0);
    expect(writes).toHaveLength(0);
    for (const sql of [COGS_REFRESH_ORDERS_SQL, COGS_REFRESH_ORDER_LOCK_SQL]) {
      expect(sql).toContain('o.status');
      expect(sql).toContain(`coalesce(jsonb_typeof(o."orderSnapshot")='object' AND o."orderSnapshot" ? 'items',false) AS "snapshotItemsPresent"`);
    }
  });

  it('continues to replay legacy items when the snapshot key is absent, including a null order status', async () => {
    const { service, writes } = harness([order({ status: null, snapshotItemsPresent: false, snapshotItems: null, dataItems: [itemA] })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ updated: 1, skipped: 0 });
    expect(writes[0].where.status).toBeNull();
    expect(writes[0].data.cogs.toFixed(2)).toBe('20.00');
  });

  it('retries an unavailable order row instead of advancing past a concurrent deletion', async () => {
    const { service, tx, writes } = harness();
    const original = tx.$queryRawUnsafe.getMockImplementation()!;
    tx.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: any[]) => {
      if (sql === COGS_REFRESH_ORDER_LOCK_SQL) {
        expect(sql).toContain('NOWAIT');
        throw new Error('could not obtain lock on row');
      }
      return original(sql, ...params);
    });
    await expect(service.recalculateBatch({ ...scope, pageSize: 1 })).rejects.toThrow('could not obtain lock on row');
    expect(writes).toHaveLength(0);
  });

  it('rejects a duplicate tenant/shop store instead of choosing another cost catalog', async () => {
    const { service, hooks, writes, prisma } = harness(); hooks.duplicateStore = true;
    await expect(service.recalculateBatch(scope)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled(); expect(writes).toHaveLength(0);
  });

  it('rechecks display-code ambiguity after excluding concurrent catalog insertions', async () => {
    const { service, hooks, writes, tx } = harness([order({ snapshotItemsPresent: false, snapshotItems: null,
      dataItems: [{ productId: 'parent', productDisplayId: 'SKU-A', quantity: 2 }] })]);
    hooks.duplicateDisplay = true;
    expect(await service.recalculateBatch(scope)).toMatchObject({ skipped: 1, updated: 0 });
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('LOCK TABLE pos_stores,pos_products IN SHARE MODE');
    expect(writes).toHaveLength(0);
  });

  it('limits current-baseline replay to its calendar window and exact tenant/shop', async () => {
    const { service, writes, prisma } = harness([order({ dateLocal: '2026-10-18' }), order({ id: 'other-order', tenantId: 'other-tenant' })]);
    expect(await service.recalculateBatch(scope)).toMatchObject({ skipped: 2, updated: 0, affectedDates: [] });
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(3)).toEqual([null, '2026-10-19', '2026-10-20', 200]);
    expect(writes).toHaveLength(0);
  });

  it('replays older months at their dated rates and preserves a missing earlier rate, not the latest value', async () => {
    const rows = ['2026-01-05', '2026-03-05', '2026-09-05', '2026-10-05'].map((dateLocal, index) =>
      order({ id: `40000000-0000-0000-0000-00000000000${index + 1}`, dateLocal,
        snapshotItems: [{ ...itemA, product_display_id: 'unknown-provider-code' }] }));
    const { service, setHistory, writes } = harness(rows);
    setHistory([
      cost({ startDate: new Date('2026-02-01'), endDate: new Date('2026-08-31'), cogs: new Decimal(5) }),
      cost({ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-30'), cogs: new Decimal(0) }),
      cost({ startDate: new Date('2026-10-01'), cogs: new Decimal(12) }),
    ]);
    const result = await service.recalculateBatch({ ...scope,
      changes: [{ productId: productA.id, fromDate: '2026-01-01', toDate: '2026-10-20' }] });
    expect(result).toMatchObject({ examined: 4, updated: 2, unchanged: 1, skipped: 1 });
    expect(writes.map(write => [write.where.dateLocal, write.data.cogs.toFixed(2)]))
      .toEqual([['2026-03-05', '10.00'], ['2026-10-05', '24.00']]);
  });

  it('preserves historical paid rates outside the original edit while filling only earlier zero orders', async () => {
    const rows = [
      order({ dateLocal: '2026-09-05', cogs: '310.00' }),
      order({ id: '40000000-0000-0000-0000-000000000002', dateLocal: '2026-09-06' }),
      order({ id: '40000000-0000-0000-0000-000000000003', dateLocal: '2026-10-19', cogs: '310.00' }),
    ];
    const { service, writes, setHistory } = harness(rows);
    setHistory([cost({ cogs: new Decimal(160) })]);
    expect(await service.recalculateBatch({ ...scope, changes: [
      scope.changes[0], { productId: productA.id, fromDate: '2026-01-01', toDate: '2026-10-20', zeroOnly: true },
    ] })).toMatchObject({ updated: 2, skipped: 1, affectedDates: ['2026-09-05', '2026-09-06', '2026-10-19'] });
    expect(writes.map(write => [write.where.dateLocal, write.where.cogs.toFixed(2), write.data.cogs.toFixed(2)]))
      .toEqual([['2026-09-06', '0.00', '320.00'], ['2026-10-19', '310.00', '320.00']]);
  });

  it('uses dated rates including explicit zero for historical zero-only replay without adopting the newest rate', async () => {
    const rows = ['2026-03-05', '2026-09-05', '2026-10-05'].map((dateLocal, index) =>
      order({ id: `40000000-0000-0000-0000-00000000000${index + 1}`, dateLocal }));
    const { service, writes, setHistory } = harness(rows);
    setHistory([
      cost({ cogs: new Decimal(12) }),
      cost({ startDate: new Date('2026-03-01'), endDate: new Date('2026-03-31'), cogs: new Decimal(5) }),
      cost({ startDate: new Date('2026-09-01'), endDate: new Date('2026-09-30'), cogs: new Decimal(0) }),
    ]);
    expect(await service.recalculateBatch({ ...scope,
      changes: [{ productId: productA.id, fromDate: '2026-01-01', toDate: null, zeroOnly: true }] }))
      .toMatchObject({ updated: 2, unchanged: 1, skipped: 0 });
    expect(writes.map(write => [write.where.dateLocal, write.data.cogs.toFixed(2)]))
      .toEqual([['2026-03-05', '10.00'], ['2026-10-05', '24.00']]);
  });

  it('does not let an unrelated product edit authorize nonzero historical revaluation', async () => {
    const { service, writes } = harness([order({ cogs: '19.00' })]);
    expect(await service.recalculateBatch({ ...scope, changes: [
      { ...scope.changes[0], productId: productB.id },
      { productId: productA.id, fromDate: '2026-01-01', toDate: null, zeroOnly: true },
    ] })).toMatchObject({ updated: 0, skipped: 1 });
    expect(writes).toHaveLength(0);
  });

  it('retains report dates for zero-only page retries even if a now-positive amount no longer matches history', async () => {
    const { service, writes } = harness([order({ cogs: '20.00' })]);
    const replay = { ...scope, changes: [{ ...scope.changes[0], zeroOnly: true }] };
    expect(await service.recalculateBatch(replay)).toMatchObject({ unchanged: 1, affectedDates: ['2026-10-19'] });
    const changedHistory = harness([order({ cogs: '19.00' })]);
    expect(await changedHistory.service.recalculateBatch(replay))
      .toMatchObject({ skipped: 1, updated: 0, affectedDates: ['2026-10-19'] });
    expect(writes).toHaveLength(0);
    expect(changedHistory.writes).toHaveLength(0);
  });

  it('retries a zero-only row whose saved COGS became positive before the row lock, never overwriting it', async () => {
    const { service, tx, writes } = harness();
    const original = tx.$queryRawUnsafe.getMockImplementation()!;
    tx.$queryRawUnsafe.mockImplementation(async (sql: string, ...params: any[]) => {
      if (sql === COGS_REFRESH_ORDER_LOCK_SQL) return [order({ cogs: '19.00' })];
      return original(sql, ...params);
    });
    await expect(service.recalculateBatch({ ...scope, changes: [{ ...scope.changes[0], zeroOnly: true }] }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('clamps legacy unbounded jobs to 2026 and the current Manila date in SQL and before every write', async () => {
    const { service, writes, prisma } = harness([
      order({ dateLocal: '2025-12-31' }),
      order({ id: '40000000-0000-0000-0000-000000000002', dateLocal: '2026-10-21' }),
    ]);
    const result = await service.recalculateBatch({ ...scope,
      changes: [{ productId: productA.id, fromDate: null, toDate: null }] });
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(3)).toEqual([null, '2026-01-01', '2026-10-20', 200]);
    expect(result).toMatchObject({ skipped: 2, updated: 0, affectedDates: [] });
    expect(writes).toHaveLength(0);
  });

  it('does not scan orders or rebuild days for an entirely archived 2025 interval', async () => {
    const { service, writes, prisma } = harness();
    expect(await service.recalculateBatch({ ...scope,
      changes: [{ productId: productA.id, fromDate: '2025-01-01', toDate: '2025-12-31' }] }))
      .toMatchObject({ examined: 0, updated: 0, affectedDates: [], nextCursor: null });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});
