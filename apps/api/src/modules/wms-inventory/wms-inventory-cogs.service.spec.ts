import { describe, expect, it, jest } from '@jest/globals';
import { Decimal } from '@prisma/client/runtime/library';
import { WmsInventoryCogsService } from './wms-inventory-cogs.service';

describe('WMS actual costs remain separate from ERP reporting COGS', () => {
  it.each(['SERIAL_RESERVED', 'BASKET_DEMAND'])('does not copy %s unit costs into ERP orders', async assignmentMode => {
    const erpOrder = { cogs: new Decimal('200.00') };
    const unit = { id: 'unit-1', unitCost: new Decimal('80.00') };
    const prisma = {
      wmsFulfillmentOrder: { findMany: jest.fn(async () => [{
        id: 'fulfillment-1', assignmentMode, posOrderDbId: 'order-1',
        posOrder: { isVoid: false }, totalQuantity: 1,
        reservations: [{ inventoryUnit: unit }], basketUnits: [{ inventoryUnit: unit }],
      }]) },
      posOrder: { update: jest.fn(async ({ data }: any) => { erpOrder.cogs = data.cogs; }) },
      wmsInventoryUnit: { update: jest.fn() },
      wmsProductProfile: { update: jest.fn() },
    };
    const service = new WmsInventoryCogsService(prisma as never);

    expect(await service.syncPosOrderCogsFromMatchedInventoryUnits({
      tenantId: 'tenant-1', storeId: 'store-1', fulfillmentOrderIds: ['fulfillment-1'],
      posOrderRefs: [{ shopId: 'shop-1', posOrderId: 'order-1' }],
    })).toEqual({ updatedOrders: 0, skippedOrders: 0 });

    expect(prisma.wmsFulfillmentOrder.findMany).not.toHaveBeenCalled();
    expect(prisma.posOrder.update).not.toHaveBeenCalled();
    expect(prisma.wmsInventoryUnit.update).not.toHaveBeenCalled();
    expect(prisma.wmsProductProfile.update).not.toHaveBeenCalled();
    expect(erpOrder.cogs.toFixed(2)).toBe('200.00');
    expect(unit.unitCost.toFixed(2)).toBe('80.00');
  });

  it('keeps the completion/dispatch result contract for an empty scope', async () => {
    const service = new WmsInventoryCogsService({} as never);
    await expect(service.syncPosOrderCogsFromMatchedInventoryUnits({}))
      .resolves.toEqual({ updatedOrders: 0, skippedOrders: 0 });
  });
});
