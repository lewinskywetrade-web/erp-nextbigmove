import { ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import {
  Prisma,
  WmsBasketStatus,
  WmsBasketUnitStatus,
  WmsFulfillmentAssignmentMode,
  WmsFulfillmentChangeState,
  WmsFulfillmentLineStatus,
  WmsFulfillmentOrderStatus,
} from '@prisma/client';
import { WmsMobileService } from './wms-mobile.service';

describe('WmsMobileService packing POS item guard', () => {
  const service = Object.create(WmsMobileService.prototype) as WmsMobileService;
  const resolveItemChange = (order: unknown) => (
    (service as unknown as {
      resolveFulfillmentOrderItemChange: (input: unknown) => { hasChanged: boolean } | null;
    }).resolveFulfillmentOrderItemChange(order)
  );

  const sourceItem = (variationId: string) => ({
    quantity: 1,
    variation_id: variationId,
  });
  const sourceLine = (
    variationId: string,
    sourceQuantityRequired: number,
    quantityRequired: number,
    status: WmsFulfillmentLineStatus,
  ) => ({
    variationId,
    sourceQuantityRequired,
    quantityRequired,
    status,
    lineSnapshot: { sourceVariationId: variationId },
  });

  it('does not mistake an approved substitution for a new POS item change', () => {
    const order = {
      status: WmsFulfillmentOrderStatus.PACKING,
      changeState: WmsFulfillmentChangeState.NONE,
      changeDetectedAt: null,
      changeSummary: null,
      posOrder: {
        orderSnapshot: {
          items: [
            sourceItem('osmanthus'),
            sourceItem('cherry-blossom'),
            sourceItem('gardenia'),
          ],
        },
      },
      lines: [
        sourceLine('osmanthus', 1, 2, WmsFulfillmentLineStatus.PICKED),
        sourceLine('cherry-blossom', 1, 0, WmsFulfillmentLineStatus.CANCELED),
        sourceLine('gardenia', 1, 1, WmsFulfillmentLineStatus.PICKED),
      ],
      fulfillmentAdjustments: [{
        type: 'SUBSTITUTION',
        sourceVariationId: 'cherry-blossom',
        substituteVariationId: 'osmanthus',
        quantity: 1,
      }],
    };

    expect(resolveItemChange(order)).toBeNull();
  });

  it('still detects a genuine difference between POS items and WMS source requirements', () => {
    const order = {
      posOrderId: '4',
      status: WmsFulfillmentOrderStatus.PACKING,
      changeState: WmsFulfillmentChangeState.NONE,
      changeDetectedAt: null,
      changeSummary: null,
      posOrder: {
        orderSnapshot: {
          items: [sourceItem('osmanthus'), sourceItem('gardenia')],
        },
      },
      lines: [
        sourceLine('osmanthus', 1, 1, WmsFulfillmentLineStatus.PICKED),
        sourceLine('cherry-blossom', 1, 1, WmsFulfillmentLineStatus.PICKED),
        sourceLine('gardenia', 1, 1, WmsFulfillmentLineStatus.PICKED),
      ],
    };

    expect(resolveItemChange(order)).toEqual(expect.objectContaining({
      hasChanged: true,
      requiresAction: true,
    }));
  });
});

describe('WmsMobileService demand packing serial reassignment', () => {
  const service = Object.create(WmsMobileService.prototype) as WmsMobileService;
  const asyncMock = <T>(value: T) => (
    jest.fn<(...args: unknown[]) => Promise<T>>().mockResolvedValue(value)
  );
  const params = {
    basketId: 'basket-1',
    basketCode: 'BASKET-001',
    basketUnit: {
      id: 'scanned-unit',
      status: WmsBasketUnitStatus.PICKED,
      fulfillmentOrderId: 'source-order',
      fulfillmentLineId: 'source-line',
      variationId: 'variation-1',
      productId: 'product-1',
    },
    targetOrderId: 'target-order',
    targetOrderCode: '2002',
    unitCode: 'SERIAL-001',
  };

  const callReassignment = (tx: unknown, overrides: Record<string, unknown> = {}) => (
    (service as unknown as {
      reassignDemandPackingUnitIfNeeded: (
        transaction: Prisma.TransactionClient,
        input: typeof params,
      ) => Promise<{ sourceOrderId: string; replacementUnitId: string } | null>;
    }).reassignDemandPackingUnitIfNeeded(tx as Prisma.TransactionClient, {
      ...params,
      ...overrides,
    })
  );

  it('keeps a unit already assigned to the selected order unchanged', async () => {
    const tx = {
      wmsFulfillmentOrder: { findUnique: jest.fn() },
      wmsBasketUnit: { findFirst: jest.fn(), updateMany: jest.fn() },
    };

    await expect(callReassignment(tx, {
      basketUnit: {
        ...params.basketUnit,
        fulfillmentOrderId: params.targetOrderId,
      },
    })).resolves.toBeNull();
    expect(tx.wmsFulfillmentOrder.findUnique).not.toHaveBeenCalled();
    expect(tx.wmsBasketUnit.updateMany).not.toHaveBeenCalled();
  });

  it('atomically exchanges equivalent unpacked serial assignments', async () => {
    const tx = {
      wmsFulfillmentOrder: {
        findUnique: asyncMock({
          posOrderId: '1001',
          status: WmsFulfillmentOrderStatus.PICKED,
          lines: [{ id: 'source-line' }],
        }),
      },
      wmsBasketUnit: {
        findFirst: asyncMock({
          id: 'replacement-unit',
          fulfillmentOrderId: params.targetOrderId,
        }),
        updateMany: asyncMock({ count: 1 }),
      },
    };

    await expect(callReassignment(tx)).resolves.toEqual({
      sourceOrderId: 'source-order',
      replacementUnitId: 'replacement-unit',
    });
    expect(tx.wmsBasketUnit.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'replacement-unit',
        status: WmsBasketUnitStatus.PICKED,
        fulfillmentOrderId: params.targetOrderId,
      },
      data: {
        fulfillmentOrderId: 'source-order',
        fulfillmentLineId: 'source-line',
      },
    });
  });

  it('never moves a serial that is already packed for another order', async () => {
    const tx = {
      wmsFulfillmentOrder: {
        findUnique: asyncMock({
          posOrderId: '1001',
          status: WmsFulfillmentOrderStatus.PACKING,
          lines: [{ id: 'source-line' }],
        }),
      },
      wmsBasketUnit: { findFirst: jest.fn(), updateMany: jest.fn() },
    };

    await expect(callReassignment(tx, {
      basketUnit: {
        ...params.basketUnit,
        status: WmsBasketUnitStatus.PACKED,
      },
    })).rejects.toThrow(new ConflictException('Unit SERIAL-001 is already packed for order 1001'));
    expect(tx.wmsBasketUnit.updateMany).not.toHaveBeenCalled();
  });

  it('fails safely when the selected order has no equivalent serial to exchange', async () => {
    const tx = {
      wmsFulfillmentOrder: {
        findUnique: asyncMock({
          posOrderId: '1001',
          status: WmsFulfillmentOrderStatus.PICKED,
          lines: [{ id: 'source-line' }],
        }),
      },
      wmsBasketUnit: {
        findFirst: asyncMock(null),
        updateMany: jest.fn(),
      },
    };

    await expect(callReassignment(tx)).rejects.toThrow(
      'Unit SERIAL-001 is allocated to order 1001. Scan a matching unpacked serial allocated to order 2002.',
    );
    expect(tx.wmsBasketUnit.updateMany).not.toHaveBeenCalled();
  });
});

describe('WmsMobileService demand packing basket manifest', () => {
  const service = Object.create(WmsMobileService.prototype) as WmsMobileService;

  const buildPlan = (basket: unknown, activeOrderId: string | null = null) => (
    (service as unknown as {
      buildMobileBasketPackPlan: (input: unknown, orderId: string | null) => {
        units: Array<Record<string, unknown>>;
      };
    }).buildMobileBasketPackPlan(basket, activeOrderId)
  );

  it('returns every active basket item with its scannable barcode and assigned order', () => {
    const order = {
      id: 'order-1',
      posOrderId: '44404',
      status: WmsFulfillmentOrderStatus.PACKING,
      assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
      customerName: 'Test Customer',
      posOrder: { tracking: 'WAYBILL-1' },
      lines: [{
        id: 'line-1',
        variationId: 'variation-1',
        productId: 'product-1',
        productName: 'Red Clover Bracelet',
        productDisplayId: 'RCB-1',
        status: WmsFulfillmentLineStatus.PICKED,
        quantityRequired: 2,
      }],
      basketUnits: [{
        id: 'basket-unit-2',
        status: WmsBasketUnitStatus.PACKED,
        fulfillmentLineId: 'line-1',
      }],
    };
    const basket = {
      id: 'basket-1',
      barcode: 'BASKET-001',
      status: WmsBasketStatus.PACKING,
      fulfillmentOrders: [order],
      basketUnits: [
        {
          id: 'basket-unit-1',
          inventoryUnitId: 'inventory-unit-1',
          status: WmsBasketUnitStatus.PICKED,
          fulfillmentOrderId: 'order-1',
          fulfillmentLineId: 'line-1',
          variationId: 'variation-1',
          productId: 'product-1',
          inventoryUnit: {
            code: 'SERIAL-001',
            barcode: 'BARCODE-001',
            posProduct: { name: 'Red Clover Bracelet', customId: 'RCB-1' },
          },
          fulfillmentOrder: { id: 'order-1', posOrderId: '44404' },
        },
        {
          id: 'basket-unit-2',
          inventoryUnitId: 'inventory-unit-2',
          status: WmsBasketUnitStatus.PACKED,
          fulfillmentOrderId: 'order-1',
          fulfillmentLineId: 'line-1',
          variationId: 'variation-1',
          productId: 'product-1',
          inventoryUnit: {
            code: 'SERIAL-002',
            barcode: null,
            posProduct: { name: 'Red Clover Bracelet', customId: 'RCB-1' },
          },
          fulfillmentOrder: { id: 'order-1', posOrderId: '44404' },
        },
      ],
    };

    expect(buildPlan(basket, 'order-1').units).toEqual([
      expect.objectContaining({
        id: 'basket-unit-1',
        code: 'SERIAL-001',
        barcode: 'BARCODE-001',
        scannableCode: 'BARCODE-001',
        status: WmsBasketUnitStatus.PICKED,
        assignedOrder: { id: 'order-1', posOrderId: '44404' },
      }),
      expect.objectContaining({
        id: 'basket-unit-2',
        code: 'SERIAL-002',
        barcode: null,
        scannableCode: 'SERIAL-002',
        status: WmsBasketUnitStatus.PACKED,
        assignedOrder: { id: 'order-1', posOrderId: '44404' },
      }),
    ]);
  });
});

describe('WmsMobileService basket POS-shipped pick order reconciliation', () => {
  it('syncs active pick orders in a basket whose POS status moved to shipped/delivered', async () => {
    const reconcileCanceledPickingOrderRefs = jest.fn<(...args: any[]) => Promise<{ cleanedOrders: number }>>()
      .mockResolvedValue({ cleanedOrders: 0 });
    const reconcilePosShippedPickingOrderRefs = jest.fn<(...args: any[]) => Promise<{ syncedOrders: number }>>()
      .mockResolvedValue({ syncedOrders: 1 });

    const service = Object.assign(Object.create(WmsMobileService.prototype), {
      logger: { warn: jest.fn() },
      wmsFulfillmentSyncService: {
        reconcileCanceledPickingOrderRefs,
        reconcilePosShippedPickingOrderRefs,
      },
    }) as WmsMobileService;

    const count = await (service as unknown as {
      reconcileCanceledBasketOrders: (basket: unknown, actorId: string | null) => Promise<number>;
    }).reconcileCanceledBasketOrders({
      barcode: 'BASKET-009',
      fulfillmentOrders: [
        {
          id: 'order-shipped-in-pos',
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '11155',
          status: WmsFulfillmentOrderStatus.IN_PICKING,
          posOrder: { status: 2, isVoid: false },
        },
        {
          id: 'order-already-packed',
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '11156',
          status: WmsFulfillmentOrderStatus.PACKED,
          posOrder: { status: 2, isVoid: false },
        },
      ],
    }, 'actor-1');

    expect(count).toBe(1);
    expect(reconcileCanceledPickingOrderRefs).not.toHaveBeenCalled();
    expect(reconcilePosShippedPickingOrderRefs).toHaveBeenCalledWith({
      actorId: 'actor-1',
      orders: [{
        tenantId: 'tenant-1',
        storeId: 'store-1',
        shopId: 'shop-1',
        posOrderId: '11155',
      }],
    });
  });

  it('always surfaces a diagnostic issueReason on ISSUE tasks even when DB issueReason is null', () => {
    const service = Object.assign(Object.create(WmsMobileService.prototype), {
      wmsFulfillmentSyncService: {
        resolveEmptyFulfillmentIssueReason: jest
          .fn()
          .mockReturnValue('Order item in Pancake POS is not linked to a catalog variation — link a product variation in POS to pick'),
      },
    }) as WmsMobileService;

    const mappedRevisionIssue = (service as any).mapMobilePickingTask({
      id: 'fo-4292',
      posOrderId: '4292',
      shopId: 'shop-nourio',
      status: WmsFulfillmentOrderStatus.ISSUE,
      assignmentMode: 'BASKET_DEMAND',
      sourceRevision: 2,
      issueReason: null,
      customerName: 'myrna tan rioflorido',
      customerPhone: '09175277746',
      totalQuantity: 5,
      allocatedQuantity: 0,
      pickedQuantity: 0,
      store: {
        id: 'store-nourio',
        tenantId: 'tenant-famco',
        name: 'Nourio',
        shopName: 'Nourio',
        tenant: { name: 'FAMCO' },
      },
      posOrder: {
        status: 1,
        isVoid: false,
        dateLocal: '2026-11-11',
      },
      lines: [
        {
          id: 'line-1',
          variationId: 'var-1',
          productId: 'prod-1',
          productName: 'Nourio Item',
          productDisplayId: 'NR-01',
          status: 'RESTOCKING',
          issueReason: null,
          quantityRequired: 5,
          quantityAllocated: 0,
          quantityPicked: 0,
          reservations: [],
        },
      ],
      basketUnits: [],
      fulfillmentAdjustments: [],
      amendments: [],
    });

    expect(mappedRevisionIssue.issueReason).toContain('Order remained in Issue status after a POS item revision (5 required units)');

    const mappedLineIssue = (service as any).mapMobilePickingTask({
      id: 'fo-line-issue',
      posOrderId: '4293',
      shopId: 'shop-nourio',
      status: WmsFulfillmentOrderStatus.ISSUE,
      assignmentMode: 'BASKET_DEMAND',
      sourceRevision: 1,
      issueReason: null,
      customerName: 'Test Customer',
      customerPhone: '09170000000',
      totalQuantity: 2,
      allocatedQuantity: 0,
      pickedQuantity: 1,
      posOrder: { status: 1, isVoid: false },
      lines: [
        {
          id: 'line-zero-issue',
          variationId: 'var-removed',
          productId: 'prod-removed',
          productName: 'Removed Serum',
          productDisplayId: 'RM-01',
          status: 'ISSUE',
          issueReason: 'Picked units remain on a removed order item — return units to bin to continue.',
          quantityRequired: 0,
          quantityAllocated: 0,
          quantityPicked: 1,
          reservations: [],
        },
      ],
      basketUnits: [],
      fulfillmentAdjustments: [],
      amendments: [],
    });

    expect(mappedLineIssue.issueReason).toBe(
      'Removed Serum: Picked units remain on a removed order item — return units to bin to continue.',
    );
    expect(mappedLineIssue.lines).toHaveLength(1);
    expect(mappedLineIssue.lines[0].status).toBe('ISSUE');
  });
});
