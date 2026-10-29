import { describe, expect, it, jest } from '@jest/globals';
import { WmsOutboundRecordsService } from './wms-outbound-records.service';

function harness(unitCount = 3) {
  const initial = {
    status: 4, statusHistory: [{ status: 4, updated_at: '2026-10-22T06:57:03.850998' }],
    deliveredAt: null, rtsAt: null, tracking: 'waybill-1', updatedAt: new Date('2026-10-22T06:57:03.850Z'),
    orderSnapshot: { _pancakeUpdatedAt: '2026-10-22T06:57:03.850998000Z' },
  };
  const order: any = {
    id: 'fulfillment-1', posOrderDbId: '11111111-1111-4111-8111-111111111111', tenantId: 'tenant-1', storeId: 'store-1',
    assignmentMode: 'BASKET_DEMAND', posOrder: initial, reservations: [],
    basketUnits: Array.from({ length: unitCount }, (_, index) => ({ fulfillmentLineId: 'line-1',
      inventoryUnit: { id: `unit-${index}`, warehouseId: 'warehouse-1', productProfileId: 'profile-1' } })),
  };
  let current: any = { id: order.posOrderDbId, ...structuredClone(initial), sourceVersion: initial.orderSnapshot._pancakeUpdatedAt };
  const writes: any[] = [];
  const query = jest.fn(async (_query: any) => current ? [current] : []);
  const upsert = jest.fn(async (args: any) => { writes.push(args); return args.create; });
  const hooks: { beforeTransaction?: (count: number) => void } = {};
  const tx = { $queryRaw: query, wmsOutboundUnitRecord: { upsert } };
  let transactions = 0;
  const prisma = {
    wmsFulfillmentOrder: { findMany: jest.fn(async () => [order]) },
    wmsInventoryMovement: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (callback: (client: any) => Promise<any>, options: any) => {
      expect(options).toMatchObject({ isolationLevel: 'ReadCommitted', maxWait: 10_000, timeout: 20_000 });
      hooks.beforeTransaction?.(++transactions);
      return callback(tx);
    }),
  };
  const service = new WmsOutboundRecordsService(prisma as never, {} as never);
  const sync = () => service.syncForPosOrders({ tenantId: 'tenant-1', storeId: 'store-1', posOrderRefs: [{ shopId: 'shop-1', posOrderId: 'order-1' }] });
  return { service, sync, prisma, query, upsert, writes, hooks, order, setCurrent: (next: any) => { current = next; }, getCurrent: () => current };
}

describe('outbound projection source fencing', () => {
  it('locks the source row before writing a stable projection without inventory mutations', async () => {
    const f = harness();
    expect(await f.sync()).toEqual({ upsertedRecords: 3 });
    const query = f.query.mock.calls[0][0];
    expect(query.strings.join('')).toContain('ORDER BY id FOR SHARE NOWAIT');
    expect(query.values).toEqual([f.order.posOrderDbId]);
    expect(f.writes.map(write => write.update.currentStatus)).toEqual(['RETURNING', 'RETURNING', 'RETURNING']);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.upsert.mock.invocationCallOrder[0]);
  });

  it.each([
    { status: 5 },
    { sourceVersion: '2026-10-22T06:57:03.850999000Z' },
    { tracking: 'new-waybill' },
    { statusHistory: [{ status: 5, updated_at: '2026-10-22T06:57:03.850999' }] },
    { updatedAt: new Date('2026-10-22T06:57:03.851Z') },
  ])('rejects an old projection when its exact source inputs changed: %p', async change => {
    const f = harness();
    f.hooks.beforeTransaction = () => f.setCurrent({ ...f.getCurrent(), ...change });
    await expect(f.sync()).rejects.toMatchObject({ code: 'P2034' });
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('does not resurrect projections after the source order disappears', async () => {
    const f = harness(); f.hooks.beforeTransaction = () => f.setCurrent(null);
    await expect(f.sync()).rejects.toMatchObject({ code: 'P2034' });
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('propagates NOWAIT lock conflicts for automatic recovery', async () => {
    const f = harness();
    const error = { code: 'P2010', meta: { code: '55P03' } };
    f.query.mockRejectedValueOnce(error);
    await expect(f.sync()).rejects.toBe(error);
    expect(f.upsert).not.toHaveBeenCalled();
  });

  it('rechecks source inputs for each bounded chunk', async () => {
    const f = harness(101);
    f.hooks.beforeTransaction = count => { if (count === 2) f.setCurrent({ ...f.getCurrent(), status: 5 }); };
    await expect(f.sync()).rejects.toMatchObject({ code: 'P2034' });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(f.upsert).toHaveBeenCalledTimes(100);
  });
});
