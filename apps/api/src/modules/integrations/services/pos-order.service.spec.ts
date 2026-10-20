import { describe, expect, it, jest } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';
import {
  PosOrderService,
  shouldQueueWmsFulfillmentSync,
  shouldTreatNoProductSnapshotAsVoid,
} from './pos-order.service';

type CatalogProduct = {
  id: string;
  productId: string;
  variationId: string | null;
  customId: string | null;
};

function createCogsHarness(products: CatalogProduct[], costs: Record<string, string>) {
  const prisma = {
    posProduct: { findMany: jest.fn(async (_args: any) => products) },
    posProductCogs: {
      findFirst: jest.fn(async ({ where }: any) => (
        costs[where.productId] === undefined ? null : { cogs: new Decimal(costs[where.productId]) }
      )),
    },
  };
  const service = new PosOrderService(prisma as never, {} as never, {} as never, {} as never);
  const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  return { prisma, service, warn };
}

const variantA: CatalogProduct = {
  id: 'catalog-a', productId: 'parent', variationId: 'variant-a', customId: 'SKU-A',
};
const variantB: CatalogProduct = {
  id: 'catalog-b', productId: 'parent', variationId: 'variant-b', customId: 'SKU-B',
};

type CostHistoryRow = {
  tenantId: string; storeId: string; productId: string; cogs: Decimal;
  startDate: Date | null; endDate: Date | null; updatedAt: Date; createdAt: Date;
};

function historyRow(cogs: string, startDate: string | null, endDate: string | null = null): CostHistoryRow {
  return {
    tenantId: 'tenant-1', storeId: 'store-1', productId: variantA.id, cogs: new Decimal(cogs),
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    updatedAt: new Date('2026-10-19'), createdAt: new Date('2026-10-19'),
  };
}

// Evaluate the actual Prisma predicate against fixture history. An unrestricted
// latest-row query therefore returns the future/expired row and fails the test.
function queryCostHistory(rows: CostHistoryRow[], { where, orderBy }: any) {
  const matches = (row: CostHistoryRow, predicate: any): boolean => Object.entries(predicate).every(([field, condition]: [string, any]) => {
    if (field === 'AND') return condition.every((clause: any) => matches(row, clause));
    if (field === 'OR') return condition.some((clause: any) => matches(row, clause));
    const value = row[field as keyof CostHistoryRow];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator, bound]) => {
        if (operator === 'not') return value !== bound;
        if (value === null) return false;
        if (operator === 'lte' || operator === 'gte') {
          if (!(value instanceof Date) || !(bound instanceof Date)) throw new Error('Expected fixture date comparison');
          return operator === 'lte' ? value.getTime() <= bound.getTime() : value.getTime() >= bound.getTime();
        }
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return value === condition;
  });
  return rows.filter(row => matches(row, where)).sort((left, right) => {
    for (const ordering of orderBy) {
      const [field, direction] = Object.entries(ordering)[0];
      const a = left[field as 'startDate' | 'updatedAt' | 'createdAt']?.getTime() ?? Infinity;
      const b = right[field as 'startDate' | 'updatedAt' | 'createdAt']?.getTime() ?? Infinity;
      if (a !== b) return (a - b) * (direction === 'desc' ? -1 : 1);
    }
    return 0;
  })[0] ?? null;
}

describe('POS order COGS effective dates', () => {
  const item = { product_id: 'parent', variation_id: 'variant-a', quantity: 2, note_product: 'Product-10' };

  it('keeps an earlier order on its note cost after a future baseline is added', async () => {
    const { service, prisma } = createCogsHarness([variantA], {});
    const rows: CostHistoryRow[] = [];
    prisma.posProductCogs.findFirst.mockImplementation(async query => queryCostHistory(rows, query));
    const calculate = (date: string) => (service as any).calculateCogs('tenant-1', 'store-1', [item], date);
    await expect(calculate('2026-10-01')).resolves.toEqual({ cogs: 20, totalQuantity: 2 });
    rows.push(historyRow('12.34', '2026-10-19'));
    await expect(calculate('2026-10-01')).resolves.toEqual({ cogs: 20, totalQuantity: 2 });
    await expect(calculate('2026-10-19')).resolves.toEqual({ cogs: 24.68, totalQuantity: 2 });
  });

  it.each<[string, CostHistoryRow]>([
    ['an expired dated cost', historyRow('12.34', '2026-09-01', '2026-09-30')],
    ['an expired undated default', historyRow('12.34', null, '2026-09-30')],
  ])('uses the note instead of %s', async (_label, cost) => {
    const { service, prisma } = createCogsHarness([variantA], {});
    prisma.posProductCogs.findFirst.mockImplementation(async query => queryCostHistory([cost], query));
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [item], '2026-10-01'))
      .resolves.toEqual({ cogs: 20, totalQuantity: 2 });
  });

  it.each([null, '2026-10-01'])('retains a valid undated default with endDate=%s', async endDate => {
    const { service, prisma } = createCogsHarness([variantA], {});
    const rows = [historyRow('12.34', '2026-10-19'), historyRow('8.00', null, endDate)];
    prisma.posProductCogs.findFirst.mockImplementation(async query => queryCostHistory(rows, query));
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [item], '2026-10-01'))
      .resolves.toEqual({ cogs: 16, totalQuantity: 2 });
  });

  it('prefers an applicable dated cost to an undated default', async () => {
    const { service, prisma } = createCogsHarness([variantA], {});
    const rows = [historyRow('8.00', null), historyRow('11.00', '2026-09-15', '2026-10-01')];
    prisma.posProductCogs.findFirst.mockImplementation(async query => queryCostHistory(rows, query));
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [item], '2026-10-01'))
      .resolves.toEqual({ cogs: 22, totalQuantity: 2 });
  });
});

describe('POS order catalog COGS identity', () => {
  it.each(['variation_id', 'variationId'])(
    'uses %s ahead of the shared parent and display IDs', async (field) => {
      const { service, prisma } = createCogsHarness([variantA, variantB], {
        'catalog-a': '10.00', 'catalog-b': '25.50',
      });
      const result = await (service as any).calculateCogs('tenant-1', 'store-1', [{
        product_id: 'parent', product_display_id: 'SKU-A', [field]: 'variant-b', quantity: 2,
      }], '2026-10-19');

      expect(result).toEqual({ cogs: 51, totalQuantity: 2 });
      expect(prisma.posProduct.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ storeId: 'store-1', store: { tenantId: 'tenant-1' } }),
      }));
      expect(prisma.posProductCogs.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1', storeId: 'store-1', productId: 'catalog-b',
        }),
      }));
    },
  );

  it('supports a variation-only item without a parent product ID', async () => {
    const { service } = createCogsHarness([variantB], { 'catalog-b': '25.50' });
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [{
      variation_id: 'variant-b', quantity: 2,
    }], '2026-10-19')).resolves.toEqual({ cogs: 51, totalQuantity: 2 });
  });

  it('resolves a unique legacy display ID when the parent has multiple variants', async () => {
    const { service } = createCogsHarness([variantA, variantB], {
      'catalog-a': '10', 'catalog-b': '25.50',
    });
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', variation_info: { product_display_id: 'SKU-B' }, quantity: 2,
    }], '2026-10-19')).resolves.toEqual({ cogs: 51, totalQuantity: 2 });
  });

  it('uses the note fallback rather than guessing an ambiguous parent variant', async () => {
    const { service, prisma, warn } = createCogsHarness([variantA, variantB], {
      'catalog-a': '10', 'catalog-b': '25.50',
    });
    const result = await (service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', quantity: 2, note_product: 'Product-18',
    }], '2026-10-19');
    expect(result.cogs).toBe(36);
    expect(prisma.posProductCogs.findFirst).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not substitute a sibling for an unknown explicit variation', async () => {
    const { service, prisma, warn } = createCogsHarness([variantA], { 'catalog-a': '10' });
    const result = await (service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', variation_id: 'not-in-catalog', quantity: 2,
    }], '2026-10-19');
    expect(result.cogs).toBe(0);
    expect(prisma.posProductCogs.findFirst).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'COGS unresolved catalog identity {"storeId":"store-1","productId":"parent","variationId":"not-in-catalog"}',
    );
  });

  it('warns on an ambiguous identity without logging order notes or customer fields', async () => {
    const { service, warn } = createCogsHarness([variantA, variantB], {});
    await (service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', quantity: 2, note_product: 'private customer note',
      customer: { name: 'Private Person', phone: '09123456789' },
    }], '2026-10-19');
    expect(warn).toHaveBeenCalledWith(
      'COGS unresolved catalog identity {"storeId":"store-1","productId":"parent","variationId":null}',
    );
  });

  it.each([null, 'parent'])('preserves unique legacy product rows with variationId=%s', async (variationId) => {
    const { service } = createCogsHarness([{ ...variantA, variationId }], { 'catalog-a': '10' });
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', variation_id: 'new-provider-id', quantity: 2,
    }], '2026-10-19')).resolves.toEqual({ cogs: 20, totalQuantity: 2 });
  });

  it('retains a unique parent-only lookup for old orders', async () => {
    const { service } = createCogsHarness([variantA], { 'catalog-a': '10' });
    await expect((service as any).calculateCogs('tenant-1', 'store-1', [{
      product_id: 'parent', quantity: 2,
    }], '2026-10-19')).resolves.toEqual({ cogs: 20, totalQuantity: 2 });
  });
});

function createUpsertHarness(previous: any = null) {
  const updatedAt = new Date('2026-10-19T00:00:00.000Z');
  let storedCogs = previous?.cogs ?? new Decimal(0);
  let catalogCost = new Decimal(10);
  const events: string[] = [];
  const hooks: { beforeTransaction?: () => Promise<void> } = {};
  const parentLocks = new Set<string>();
  const prisma = {
    posStore: {
      findFirst: jest.fn(async () => ({ initialValueOffer: null, shopId: 'shop-1', teamId: null })),
    },
    tenant: { findUnique: jest.fn(async () => ({ wmsFulfillmentGoLiveAt: null })) },
    posProduct: { findMany: jest.fn(async () => [variantA]) },
    posProductCogs: { findFirst: jest.fn(async () => { events.push('parse-source-read'); return { cogs: catalogCost }; }) },
    posOrder: {
      findUnique: jest.fn(async (_args: any) => previous),
      upsert: jest.fn(async ({ create, update }: any) => {
        events.push('persist-order');
        const write = previous ? update : create;
        if (write.cogs !== undefined) storedCogs = write.cogs;
        return { id: 'order-1', updatedAt };
      }),
      updateMany: jest.fn(async ({ data }: any) => {
        storedCogs = data.cogs;
        return { count: 1 };
      }),
      update: jest.fn(async (_args: any) => ({})),
    },
    wmsFulfillmentOrder: { findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]) },
    $transaction: jest.fn(async (callback: (client: any) => Promise<any>, options: any) => {
      await hooks.beforeTransaction?.();
      expect(options.isolationLevel).toBe('ReadCommitted');
      events.push('transaction-start');
      try { return await callback(tx); }
      finally { parentLocks.clear(); events.push('transaction-end'); }
    }),
  };
  const tx = {
    posStore: { findMany: jest.fn(async () => [{ id: 'store-1' }]) },
    posProduct: prisma.posProduct,
    posProductCogs: { findFirst: jest.fn(async ({ where }: any) => {
      expect(parentLocks.has(where.productId)).toBe(true);
      events.push('locked-source-read'); return { cogs: catalogCost };
    }) },
    posOrder: prisma.posOrder,
    $executeRawUnsafe: jest.fn(async (sql: string) => { if (sql.startsWith('LOCK TABLE')) events.push('catalog-table-lock'); return 0; }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...params: any[]) => {
      if (sql.includes('FROM pos_products')) {
        expect(sql).toContain('FOR SHARE OF p'); expect(sql).toContain('FOR SHARE OF s');
        expect(params.slice(1)).toEqual(['store-1', 'tenant-1']);
        expect(params[0]).toEqual([...params[0]].sort());
        params[0].forEach((id: string) => parentLocks.add(id)); events.push('source-parent-lock');
        return params[0].map((id: string) => ({ id }));
      }
      expect(sql).toContain('FOR UPDATE NOWAIT');
      expect(params).toEqual(['tenant-1', 'shop-1', 'order-1']);
      events.push('order-lock'); return previous ? [{ id: 'order-1' }] : [];
    }),
  };
  const fulfillment = { syncConfirmedPickingOrders: jest.fn(async () => undefined) };
  const inventory = {
    syncPackedUnitsToDispatchedForPosOrders: jest.fn(async () => undefined),
    syncPosOrderCogsFromMatchedInventoryUnits: jest.fn(async (_params: any): Promise<any> => undefined),
  };
  const outbound = { syncForPosOrders: jest.fn(async () => undefined) };
  const service = new PosOrderService(prisma as never, fulfillment as never, inventory as never, outbound as never);
  return { service, prisma, inventory, outbound, updatedAt, events, hooks, tx,
    readCogs: () => storedCogs, completeSourceEdit: (amount: number) => {
      catalogCost = new Decimal(amount);
      if (previous) storedCogs = new Decimal(amount);
      events.push('source-edit-and-refresh-completed');
    } };
}

const rawOrder = { id: 'order-1', shop_id: 'shop-1', inserted_at: '2026-10-18T02:00:00Z', status: 4 };

describe('POS webhook COGS persistence', () => {
  it.each([false, true])('keeps a verified catalog zero despite an old note price (existing=%s)', async existing => {
    const { service, completeSourceEdit, readCogs, prisma } = createUpsertHarness(
      existing ? { cogs: new Decimal('123.45'), orderSnapshot: null } : null);
    completeSourceEdit(0);
    const result = await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 2, note_product: 'SKU-999' }],
    }], null);
    expect(result.upserted).toBe(1);
    expect(readCogs().toFixed(2)).toBe('0.00');
    if (!existing) expect(prisma.posOrder.upsert.mock.calls[0][0].create.cogs.toFixed(2)).toBe('0.00');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('0.00');
  });

  it.each([
    { productId: 'parent', variationId: 'variant-a' },
    { productId: 'parent' },
    { variation_id: 'variant-a' },
    { variationId: 'variant-a' },
    { product_display_id: 'SKU-A' },
    { productDisplayId: 'SKU-A' },
  ])('keeps a complete supported product identity nonvoid for reporting: %p', async identity => {
    const { service, prisma, readCogs } = createUpsertHarness();
    const result = await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, status: 4, items: [{ ...identity, quantity: 1 }],
    }], null);
    expect(result.upserted).toBe(1);
    expect(prisma.posOrder.upsert.mock.calls[0][0].create.isVoid).toBe(false);
    expect(prisma.posOrder.upsert.mock.calls[0][0].update.isVoid).toBe(false);
    expect(readCogs().toFixed(2)).toBe('10.00');
  });

  it('does not treat names, notes or blank identity aliases as product evidence', async () => {
    const { service, prisma } = createUpsertHarness();
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{ ...rawOrder, items: [{
      name: 'Product name', note_product: 'free text', productId: '   ', variation_id: '', quantity: 1,
    }] }], null);
    expect(prisma.posOrder.upsert.mock.calls[0][0].create.isVoid).toBe(true);
  });

  it.each([{ code: 'P2010', meta: { code: '55P03' } }, { code: 'P2010', meta: { code: '57014' } }, { code: 'P2028' }])(
    'rethrows a source transaction conflict for durable webhook retry: %p', async error => {
      const { service, prisma } = createUpsertHarness();
      prisma.$transaction.mockRejectedValueOnce(error);
      await expect(service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
        ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 1 }],
      }], null)).rejects.toBe(error);
      expect(prisma.posOrder.upsert).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])('re-reads locked ERP costs after an edit/refresh overtakes parsing (existing=%s)', async existing => {
    const { service, prisma, tx, hooks, events, completeSourceEdit, readCogs } = createUpsertHarness(
      existing ? { cogs: new Decimal(10), orderSnapshot: null } : null);
    hooks.beforeTransaction = async () => { completeSourceEdit(20); };
    const result = await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 1 }],
    }], null);
    expect(result.upserted).toBe(1);
    expect(prisma.posProductCogs.findFirst).toHaveBeenCalled();
    expect(tx.posProductCogs.findFirst).toHaveBeenCalled();
    expect(events.indexOf('parse-source-read')).toBeLessThan(events.indexOf('source-edit-and-refresh-completed'));
    expect(events.indexOf('source-edit-and-refresh-completed')).toBeLessThan(events.indexOf('locked-source-read'));
    expect(events.indexOf('source-parent-lock')).toBeLessThan(events.indexOf('locked-source-read'));
    expect(events.indexOf('locked-source-read')).toBeLessThan(events.indexOf('persist-order'));
    expect(events.indexOf('persist-order')).toBeLessThan(events.indexOf('transaction-end'));
    expect(prisma.posOrder.upsert.mock.calls[0][0].create.cogs.toFixed(2)).toBe('20.00');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('20.00');
    expect(readCogs().toFixed(2)).toBe('20.00');
  });

  it.each([null, { items: [{ product_id: 'parent', quantity: 2 }] }])(
    'preserves existing COGS on a partial webhook with prior snapshot %j', async (orderSnapshot) => {
      const { service, prisma } = createUpsertHarness({
        orderSnapshot, itemData: [], totalQuantity: 2, cogs: new Decimal('123.45'), isVoid: false,
      });
      const result = await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [rawOrder], null);
      expect(result.upserted).toBe(1);
      expect(prisma.posOrder.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { tenantId_shopId_posOrderId: { tenantId: 'tenant-1', shopId: 'shop-1', posOrderId: 'order-1' } },
      }));
      expect(prisma.posOrder.findUnique.mock.calls[0][0].select).not.toHaveProperty('cogs');
      expect(prisma.posOrder.upsert.mock.calls[0][0].update).not.toHaveProperty('cogs');
      expect(prisma.posOrder.updateMany).not.toHaveBeenCalled();
    },
  );

  it('preserves a legitimate zero cost on a partial webhook', async () => {
    const { service, prisma } = createUpsertHarness({ cogs: new Decimal(0), orderSnapshot: null });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [rawOrder], null);
    expect(prisma.posOrder.upsert.mock.calls[0][0].update).not.toHaveProperty('cogs');
    expect(prisma.posOrder.updateMany).not.toHaveBeenCalled();
  });

  it('cannot overwrite a concurrent cost correction with the earlier snapshot cost', async () => {
    const { service, prisma } = createUpsertHarness({ cogs: new Decimal('123.45'), orderSnapshot: null });
    let storedCogs = new Decimal('123.45');
    prisma.posOrder.findUnique.mockImplementation(async () => {
      storedCogs = new Decimal('456.78'); // Another transaction corrects COGS before this upsert.
      return { cogs: new Decimal('123.45'), orderSnapshot: null };
    });
    prisma.posOrder.upsert.mockImplementation(async ({ update }: any) => {
      if (update.cogs !== undefined) storedCogs = update.cogs;
      return { id: 'order-1', updatedAt: new Date('2026-10-19T00:00:00.000Z') };
    });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [rawOrder], null);
    expect(storedCogs.toFixed(2)).toBe('456.78');
    expect(prisma.posOrder.updateMany).not.toHaveBeenCalled();
  });

  it('still initializes a newly created order without items at zero COGS', async () => {
    const { service, prisma } = createUpsertHarness();
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [rawOrder], null);
    expect(prisma.posOrder.upsert.mock.calls[0][0].create.cogs.toFixed(2)).toBe('0.00');
    expect(prisma.posOrder.upsert.mock.calls[0][0].update).not.toHaveProperty('cogs');
    expect(prisma.posOrder.updateMany).not.toHaveBeenCalled();
  });

  it('recalculates COGS when a complete replacement item payload is supplied', async () => {
    const { service, prisma, updatedAt, readCogs } = createUpsertHarness({ cogs: new Decimal('123.45'), orderSnapshot: null });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 3 }],
    }], null);
    expect(prisma.posOrder.upsert.mock.calls[0][0].update).not.toHaveProperty('cogs');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('30.00');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'order-1', tenantId: 'tenant-1', shopId: 'shop-1', posOrderId: 'order-1', updatedAt,
    });
    expect(readCogs().toFixed(2)).toBe('30.00');
  });

  it('does not reuse an old cost when an explicitly empty item payload arrives', async () => {
    const { service, prisma } = createUpsertHarness({ cogs: new Decimal('123.45'), orderSnapshot: null });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{ ...rawOrder, items: [] }], null);
    expect(prisma.posOrder.upsert.mock.calls[0][0].update).not.toHaveProperty('cogs');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('0.00');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].where).not.toHaveProperty('wmsFulfillmentOrders');
  });

  it('uses ERP catalog costs even when WMS has different or ambiguous actual costs', async () => {
    const { service, prisma, inventory, readCogs } = createUpsertHarness({ cogs: new Decimal('17'), orderSnapshot: null });
    prisma.wmsFulfillmentOrder.findMany.mockResolvedValue([{
      id: 'fulfillment-1', posOrderDbId: 'order-1', assignmentMode: 'BASKET_DEMAND', totalQuantity: 2,
      posOrder: { isVoid: false },
      reservations: [],
      basketUnits: ['old-unit', 'unit-a', 'unit-b'].map((id) => ({
        inventoryUnit: { id, unitCost: new Decimal('8.50') },
      })),
    }]);
    const result = await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 2 }],
    }], null);

    expect(result.upserted).toBe(1);
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('20.00');
    expect(prisma.posOrder.updateMany.mock.calls[0][0].where).not.toHaveProperty('wmsFulfillmentOrders');
    expect(prisma.wmsFulfillmentOrder.findMany).not.toHaveBeenCalled();
    expect(inventory.syncPosOrderCogsFromMatchedInventoryUnits).not.toHaveBeenCalled();
    expect(prisma.posOrder.update).not.toHaveBeenCalled();
    expect(readCogs().toFixed(2)).toBe('20.00');
  });

  it('guards a full-item catalog update against an intervening ERP cost correction', async () => {
    const { service, prisma, updatedAt } = createUpsertHarness({ cogs: new Decimal('17'), orderSnapshot: null });
    let storedCogs = new Decimal('17');
    const correctedVersion = new Date(updatedAt.getTime() + 1);
    prisma.posOrder.updateMany.mockImplementation(async ({ where, data }: any) => {
      storedCogs = new Decimal('19'); // ERP correction wins before the catalog statement.
      if (!where.updatedAt || where.updatedAt.getTime() === correctedVersion.getTime()) {
        storedCogs = data.cogs;
        return { count: 1 };
      }
      return { count: 0 };
    });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 2 }],
    }], null);
    expect(prisma.posOrder.updateMany.mock.calls[0][0].where.updatedAt).toEqual(updatedAt);
    expect(storedCogs.toFixed(2)).toBe('19.00');
  });

  it.each([4, 5])('keeps ERP reporting costs independent after a status-%s upsert', async (status) => {
    const { service, prisma, inventory, outbound, readCogs } = createUpsertHarness();
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, status, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 3 }],
    }], null);
    expect(prisma.posOrder.upsert).toHaveBeenCalledTimes(1);
    expect(outbound.syncForPosOrders).toHaveBeenCalledTimes(1);
    expect(inventory.syncPosOrderCogsFromMatchedInventoryUnits).not.toHaveBeenCalled();
    expect(readCogs().toFixed(2)).toBe('30.00');
  });

  it.each([2, 3, 4, 5])('keeps explicit void-empty status-%s COGS zero without changing workflows', async (status) => {
    const { service, prisma, inventory, outbound, readCogs } = createUpsertHarness({
      cogs: new Decimal('17'), orderSnapshot: null,
    });
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{
      ...rawOrder, status, items: [],
    }], null);
    expect(prisma.posOrder.updateMany.mock.calls[0][0].data.cogs.toFixed(2)).toBe('0.00');
    expect(readCogs().toFixed(2)).toBe('0.00');
    expect(inventory.syncPosOrderCogsFromMatchedInventoryUnits).not.toHaveBeenCalled();
    if (status === 2 || status === 3) {
      expect(inventory.syncPackedUnitsToDispatchedForPosOrders).toHaveBeenCalledTimes(1);
      expect(outbound.syncForPosOrders).not.toHaveBeenCalled();
    } else {
      expect(outbound.syncForPosOrders).toHaveBeenCalledTimes(1);
      expect(inventory.syncPackedUnitsToDispatchedForPosOrders).not.toHaveBeenCalled();
    }
  });

  it('uses ERP catalog costs when a complete snapshot replaces a void-empty event in the same batch', async () => {
    const { service, inventory, readCogs } = createUpsertHarness();
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [
      { ...rawOrder, items: [] },
      { ...rawOrder, items: [{ product_id: 'parent', variation_id: 'variant-a', quantity: 2 }] },
    ], null);
    expect(inventory.syncPosOrderCogsFromMatchedInventoryUnits).not.toHaveBeenCalled();
    expect(readCogs().toFixed(2)).toBe('20.00');
  });

  it('does not restore packed WMS costs for a canceled order', async () => {
    const { service, inventory } = createUpsertHarness();
    await service.upsertPosOrdersWithOutcomes('tenant-1', 'store-1', [{ ...rawOrder, status: 6, items: [] }], null);
    expect(inventory.syncPosOrderCogsFromMatchedInventoryUnits).not.toHaveBeenCalled();
  });
});

describe('shouldTreatNoProductSnapshotAsVoid', () => {
  it.each([1, 9, 12])(
    'keeps an explicitly empty snapshot fulfillable while POS status is %s',
    (status) => {
      expect(shouldTreatNoProductSnapshotAsVoid(true, status)).toBe(false);
    },
  );

  it('still treats an explicitly empty snapshot as void for a canceled POS order', () => {
    expect(shouldTreatNoProductSnapshotAsVoid(true, 6)).toBe(true);
  });

  it('never changes void state when the snapshot contains a product', () => {
    expect(shouldTreatNoProductSnapshotAsVoid(false, 6)).toBe(false);
  });
});

describe('shouldQueueWmsFulfillmentSync', () => {
  it.each([1, 9, 12])(
    'queues WMS reconciliation for an active order at POS status %s',
    (status) => {
      expect(shouldQueueWmsFulfillmentSync(status, false)).toBe(true);
    },
  );

  it('does not queue canceled or void orders', () => {
    expect(shouldQueueWmsFulfillmentSync(6, false)).toBe(false);
    expect(shouldQueueWmsFulfillmentSync(9, true)).toBe(false);
  });
});
