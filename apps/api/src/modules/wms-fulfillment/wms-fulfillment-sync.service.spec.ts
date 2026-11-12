import { describe, expect, it, jest } from '@jest/globals';
import { WmsFulfillmentAssignmentMode, WmsFulfillmentOrderStatus } from '@prisma/client';
import { WMS_DEMAND_QUEUE_REFRESH_JOB } from './wms-fulfillment.constants';
import { WmsFulfillmentSyncService } from './wms-fulfillment-sync.service';

describe('WmsFulfillmentSyncService.reconcileCanceledPickingOrderRefs', () => {
  it('deduplicates canceled order references and reconciles each store scope', async () => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);
    const reconcile = jest
      .spyOn(service as any, 'syncCanceledPickingOrders')
      .mockResolvedValueOnce({ cleanedOrders: 2 })
      .mockResolvedValueOnce({ cleanedOrders: 1 });

    const result = await service.reconcileCanceledPickingOrderRefs({
      actorId: 'user-1',
      orders: [
        {
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '100',
        },
        {
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '100',
        },
        {
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '101',
        },
        {
          tenantId: 'tenant-2',
          storeId: 'store-2',
          shopId: 'shop-2',
          posOrderId: '200',
        },
      ],
    });

    expect(result).toEqual({ cleanedOrders: 3 });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tenantId: 'tenant-1',
        storeId: 'store-1',
        actorId: 'user-1',
        posOrderRefs: [
          { shopId: 'shop-1', posOrderId: '100' },
          { shopId: 'shop-1', posOrderId: '101' },
        ],
      }),
      [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
    );
    expect(reconcile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tenantId: 'tenant-2',
        storeId: 'store-2',
        actorId: 'user-1',
        posOrderRefs: [{ shopId: 'shop-2', posOrderId: '200' }],
      }),
      [{ id: 'store-2', tenantId: 'tenant-2', shopId: 'shop-2' }],
    );
  });

  it('does not query fulfillment state when no valid order references are provided', async () => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);
    const reconcile = jest.spyOn(service as any, 'syncCanceledPickingOrders');

    const result = await service.reconcileCanceledPickingOrderRefs({
      actorId: null,
      orders: [],
    });

    expect(result).toEqual({ cleanedOrders: 0 });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('commits canceled basket cleanup before queueing the store-wide demand refresh', async () => {
    const transactionClient = {
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'fulfillment-1',
            tenantId: 'tenant-1',
            storeId: 'store-1',
            assignmentMode: 'BASKET_DEMAND',
            basketId: null,
            basketUnits: [],
            posOrder: { status: 6, isVoid: false },
          },
        ]),
      },
    };
    const prisma = {
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'pos-order-db-1' }]),
      },
      $transaction: jest.fn(async (callback: any) => callback(transactionClient)),
    };
    const queue = {
      add: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'refresh-job-1' }),
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, queue as any);
    jest.spyOn(service as any, 'buildTenantGoLiveOrderFilters').mockResolvedValue([{}]);
    jest.spyOn(service as any, 'releaseCanceledDemandOrderTx').mockResolvedValue(undefined);
    const refreshInsideTransaction = jest.spyOn(service as any, 'refreshDemandFulfillmentQueueTx');

    const result = await (service as any).syncCanceledPickingOrders({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      stores: [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
      actorId: 'user-1',
      posOrderRefs: [{ shopId: 'shop-1', posOrderId: '100' }],
    }, [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }]);

    expect(result).toEqual({ cleanedOrders: 1 });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { timeout: 90000, maxWait: 10000 },
    );
    expect(refreshInsideTransaction).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      WMS_DEMAND_QUEUE_REFRESH_JOB,
      expect.objectContaining({
        tenantId: 'tenant-1',
        storeId: 'store-1',
      }),
      expect.objectContaining({
        attempts: 4,
        removeOnComplete: true,
      }),
    );
    expect(prisma.$transaction.mock.invocationCallOrder[0])
      .toBeLessThan(queue.add.mock.invocationCallOrder[0]);
  });
});

describe('WmsFulfillmentSyncService targeted source revisions', () => {
  it('allows waiting-for-pickup POS updates only for an existing active WMS order', async () => {
    const prisma = {
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      },
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'syncCanceledPickingOrders').mockResolvedValue({ cleanedOrders: 0 });
    jest.spyOn(service as any, 'buildTenantGoLiveOrderFilters').mockResolvedValue([{}]);

    await service.syncConfirmedPickingOrders({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      actorId: null,
      stores: [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
      posOrderRefs: [{ shopId: 'shop-1', posOrderId: '4' }],
    });

    expect(prisma.posOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ status: 1 }),
              expect.objectContaining({
                status: { in: expect.arrayContaining([8, 9, 12, 13]) },
                wmsFulfillmentOrders: {
                  some: {
                    status: { in: expect.arrayContaining(['PACKING', 'PACKED']) },
                  },
                },
              }),
            ]),
          }),
        ]),
      }),
    }));
  });
});

describe('WmsFulfillmentSyncService transient empty-item cancellation recovery', () => {
  const eligibleOrder = {
    id: 'fulfillment-1',
    tenantId: 'tenant-1',
    storeId: 'store-1',
    warehouseId: null,
    shopId: 'shop-1',
    posOrderId: '161',
    status: WmsFulfillmentOrderStatus.CANCELED,
    completedAt: new Date('2026-09-02T03:55:03.656Z'),
    pickedQuantity: 0,
  };

  const createTransactionClient = (overrides: {
    transientWebhook?: { id: string } | null;
    pickedReservationCount?: number;
    basketUnitCount?: number;
    packingProofCount?: number;
    outboundRecordCount?: number;
    manualVoidCount?: number;
  } = {}) => ({
    pancakeWebhookLogOrder: {
      findFirst: jest.fn<() => Promise<{ id: string } | null>>().mockResolvedValue(
        overrides.transientWebhook === undefined
          ? { id: 'webhook-log-order-1' }
          : overrides.transientWebhook,
      ),
    },
    wmsPickReservation: {
      count: jest.fn<() => Promise<number>>().mockResolvedValue(overrides.pickedReservationCount ?? 0),
    },
    wmsBasketUnit: {
      count: jest.fn<() => Promise<number>>().mockResolvedValue(overrides.basketUnitCount ?? 0),
    },
    wmsPackingProof: {
      count: jest.fn<() => Promise<number>>().mockResolvedValue(overrides.packingProofCount ?? 0),
    },
    wmsOutboundUnitRecord: {
      count: jest.fn<() => Promise<number>>().mockResolvedValue(overrides.outboundRecordCount ?? 0),
    },
    wmsStaffActivity: {
      count: jest.fn<() => Promise<number>>().mockResolvedValue(overrides.manualVoidCount ?? 0),
    },
  });

  it('reopens only a confirmed order canceled by the transient empty-items webhook', async () => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);
    const tx = createTransactionClient();

    const result = await (service as any).canRecoverTransientEmptyItemsCancellationTx(tx, {
      order: eligibleOrder,
      posOrder: { status: 1, isVoid: false },
      nextLines: [{ variationId: 'variation-1', quantityRequired: 1 }],
    });

    expect(result).toBe(true);
    expect(tx.pancakeWebhookLogOrder.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        shopId: 'shop-1',
        orderId: '161',
        reason: 'VOID_NO_PRODUCT_ITEMS',
        log: { tenantId: 'tenant-1' },
      }),
      select: { id: true },
    });
  });

  it.each([
    ['picked reservation history', { pickedReservationCount: 1 }],
    ['basket unit history', { basketUnitCount: 1 }],
    ['packing proof history', { packingProofCount: 1 }],
    ['outbound record history', { outboundRecordCount: 1 }],
    ['manual void activity', { manualVoidCount: 1 }],
    ['missing transient webhook evidence', { transientWebhook: null }],
  ])('does not reopen when %s exists', async (_label, overrides) => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);
    const tx = createTransactionClient(overrides);

    const result = await (service as any).canRecoverTransientEmptyItemsCancellationTx(tx, {
      order: eligibleOrder,
      posOrder: { status: 1, isVoid: false },
      nextLines: [{ variationId: 'variation-1', quantityRequired: 1 }],
    });

    expect(result).toBe(false);
  });

  it('rejects canceled orders when POS is still void or no replacement lines exist', async () => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);
    const tx = createTransactionClient();

    await expect((service as any).canRecoverTransientEmptyItemsCancellationTx(tx, {
      order: eligibleOrder,
      posOrder: { status: 1, isVoid: true },
      nextLines: [{ variationId: 'variation-1', quantityRequired: 1 }],
    })).resolves.toBe(false);
    await expect((service as any).canRecoverTransientEmptyItemsCancellationTx(tx, {
      order: eligibleOrder,
      posOrder: { status: 1, isVoid: false },
      nextLines: [],
    })).resolves.toBe(false);

    expect(tx.pancakeWebhookLogOrder.findFirst).not.toHaveBeenCalled();
  });
});

describe('WmsFulfillmentSyncService.returnAmendmentBasketUnit', () => {
  it('only returns a serialized unit owned by the order being amended', async () => {
    const transactionClient = {
      $queryRaw: jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'basket-1' }]),
      wmsFulfillmentOrder: {
        findFirst: jest.fn<() => Promise<any>>().mockResolvedValue({
          id: 'order-1',
          posOrderId: '45484',
          changeSummary: null,
          amendments: [{
            id: 'amendment-1',
            requiredActions: {
              return: [{ variationId: 'variation-1', quantity: 1 }],
            },
          }],
        }),
      },
      wmsBasketUnit: {
        findFirst: jest.fn<() => Promise<any>>().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: any) => callback(transactionClient)),
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);

    await expect(service.returnAmendmentBasketUnit({
      tenantId: 'tenant-1',
      fulfillmentOrderId: 'order-1',
      basketId: 'basket-1',
      code: 'SERIAL-1',
      actorId: 'user-1',
    })).rejects.toThrow('Scanned unit is not one of the items that must be returned');

    expect(transactionClient.wmsBasketUnit.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        basketId: 'basket-1',
        fulfillmentOrderId: 'order-1',
        variationId: { in: ['variation-1'] },
      }),
      include: { inventoryUnit: true },
    });
  });
});

describe('WmsFulfillmentSyncService line extraction & ISSUE recovery', () => {
  it('extracts numeric Pancake variation/product IDs and falls back to itemData when snapshot items are empty', async () => {
    const prisma = {
      posProduct: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            productId: '5001',
            variationId: '9001',
            customId: 'TONIOS-SKU-1',
            name: 'Tonios Signature Pack',
          },
        ]),
      },
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);

    const numericLines = await (service as any).extractFulfillmentLinesFromOrderSnapshot(
      {
        items: [
          {
            product_id: 5001,
            variation_id: 9001,
            quantity: 2,
          },
        ],
      },
      'store-1',
      null,
    );

    expect(numericLines).toHaveLength(1);
    expect(numericLines[0]).toEqual(expect.objectContaining({
      variationId: '9001',
      productId: '5001',
      productName: 'Tonios Signature Pack',
      productDisplayId: 'TONIOS-SKU-1',
      quantityRequired: 2,
    }));

    const fallbackLines = await (service as any).extractFulfillmentLinesFromOrderSnapshot(
      { items: [{ quantity: 1 }] },
      'store-1',
      [
        {
          productId: 5001,
          variationId: 5001,
          variationName: 'Tonios Signature Pack',
          quantity: 3,
        },
      ],
    );

    expect(fallbackLines).toHaveLength(1);
    expect(fallbackLines[0]).toEqual(expect.objectContaining({
      variationId: '9001',
      productId: '5001',
      quantityRequired: 3,
    }));
  });

  it('recovers an unbasketed BASKET_DEMAND order out of ISSUE into RESTOCKING and triggers demand queue refresh', async () => {
    const orderUpdate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const lineUpsert = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const lineUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });
    const adjustmentUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });
    const amendmentUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });
    const amendmentUpsert = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});

    const tx = {
      $queryRaw: jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'locked' }]),
      wmsFulfillmentOrder: {
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue({
          id: 'fulfillment-issue-1',
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '2',
          status: WmsFulfillmentOrderStatus.ISSUE,
          assignmentMode: 'BASKET_DEMAND',
          basketId: null,
          pickedQuantity: 0,
          lines: [],
          basketPickDemands: [],
          basketUnits: [],
        }),
        findUniqueOrThrow: jest.fn<() => Promise<any>>().mockResolvedValue({
          sourceItemsHash: 'old-empty-hash',
          sourceRevision: 1,
        }),
        update: orderUpdate,
      },
      wmsFulfillmentLine: {
        upsert: lineUpsert,
        updateMany: lineUpdateMany,
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      },
      wmsFulfillmentAdjustment: {
        updateMany: adjustmentUpdateMany,
      },
      wmsFulfillmentAmendment: {
        updateMany: amendmentUpdateMany,
        upsert: amendmentUpsert,
      },
    };

    const prisma = {
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'pos-db-2',
            status: 1,
            isVoid: false,
            tenantId: 'tenant-1',
            shopId: 'shop-1',
            posOrderId: '2',
            insertedAt: new Date('2026-01-30T02:00:00.000Z'),
            customerName: null,
            customerPhone: null,
            orderSnapshot: {
              items: [{ product_id: 5001, variation_id: 9001, quantity: 1 }],
            },
            itemData: [],
          },
        ]),
      },
      posProduct: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            productId: '5001',
            variationId: '9001',
            customId: 'TONIOS-SKU-1',
            name: 'Tonios Signature Pack',
          },
        ]),
      },
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };

    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'syncCanceledPickingOrders').mockResolvedValue({ cleanedOrders: 0 });
    jest.spyOn(service as any, 'buildTenantGoLiveOrderFilters').mockResolvedValue([{}]);
    jest.spyOn(service as any, 'canRecoverTransientEmptyItemsCancellationTx').mockResolvedValue(false);
    jest.spyOn(service as any, 'reconcileLegacyFulfillmentLines').mockResolvedValue(undefined);
    const refreshQueue = jest.spyOn(service as any, 'refreshDemandFulfillmentQueue').mockResolvedValue(undefined);

    const result = await service.syncConfirmedPickingOrders({
      tenantId: 'tenant-1',
      storeId: 'store-1',
      actorId: null,
      stores: [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
      posOrderRefs: [{ shopId: 'shop-1', posOrderId: '2' }],
    });

    expect(result).toEqual({ syncedOrders: 1 });
    expect(orderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'fulfillment-issue-1' },
      data: expect.objectContaining({
        status: WmsFulfillmentOrderStatus.RESTOCKING,
        issueReason: null,
        totalQuantity: 1,
        sourceTotalQuantity: 1,
      }),
    }));
    expect(lineUpsert).toHaveBeenCalledTimes(1);
    expect(refreshQueue).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      storeId: 'store-1',
    });
  });

  it('cancels pre-go-live unbasketed ISSUE fulfillment orders when wmsFulfillmentGoLiveAt is set', async () => {
    const goLiveAt = new Date('2026-11-09T00:00:00+08:00');
    const orderUpdate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const lineUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });
    const demandDeleteMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });

    const tx = {
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'fulfillment-june-1',
            tenantId: 'tenant-1',
            storeId: 'store-1',
            posOrderId: '7438256341302',
            status: WmsFulfillmentOrderStatus.ISSUE,
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            basketId: null,
            basketUnits: [],
            lines: [],
            posOrder: {
              status: 1,
              isVoid: false,
              insertedAt: new Date('2026-06-17T04:15:00.000Z'),
            },
          },
        ]),
        update: orderUpdate,
      },
      wmsFulfillmentLine: {
        updateMany: lineUpdateMany,
      },
      wmsBasketPickDemand: {
        deleteMany: demandDeleteMany,
      },
    };

    const prisma = {
      tenant: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'tenant-1',
            wmsFulfillmentGoLiveAt: goLiveAt,
          },
        ]),
      },
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([{ id: 'pos-order-june-1' }]),
      },
      $transaction: jest.fn(async (callback: any) => callback(tx)),
    };
    const queue = {
      add: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'refresh-job-june' }),
    };

    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, queue as any);

    const result = await (service as any).syncCanceledPickingOrders(
      {
        tenantId: 'tenant-1',
        storeId: 'store-1',
        stores: [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
        actorId: null,
      },
      [{ id: 'store-1', tenantId: 'tenant-1', shopId: 'shop-1' }],
    );

    expect(result).toEqual({ cleanedOrders: 1 });
    expect(orderUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'fulfillment-june-1' },
      data: expect.objectContaining({
        status: WmsFulfillmentOrderStatus.CANCELED,
        issueReason: 'Excluded before client WMS fulfillment go-live.',
      }),
    }));
  });

  it('scopes refreshDemandFulfillmentQueue to orders at or after wmsFulfillmentGoLiveAt', async () => {
    const goLiveAt = new Date('2026-11-09T00:00:00+08:00');
    const findMany = jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
    const prisma = {
      tenant: {
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue({
          wmsFulfillmentGoLiveAt: goLiveAt,
        }),
      },
      wmsFulfillmentOrder: {
        findMany,
      },
    };

    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);
    await (service as any).refreshDemandFulfillmentQueue({
      tenantId: 'tenant-1',
      storeId: 'store-1',
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        posOrder: {
          is: expect.objectContaining({
            status: 1,
            isVoid: false,
            insertedAt: { gte: goLiveAt },
          }),
        },
      }),
    }));
  });

  it('expands refreshDemandFulfillmentQueue across linked shared stock pool stores and variations', async () => {
    const poolGroupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const findMany = jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]);
    const prisma = {
      tenant: {
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue({
          wmsFulfillmentGoLiveAt: null,
        }),
      },
      wmsProductProfile: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'prof-old',
            tenantId: 'tenant-famco',
            storeId: 'store-main',
            posProductId: 'pos-old',
            productId: 'prod-old',
            variationId: 'var-old',
            posWarehouseRef: 'pos-wh-main',
            stockPoolGroupId: poolGroupId,
            posProduct: { name: 'Famco Old', customId: 'FAM-1', productSnapshot: null },
            store: { name: 'Famco Main', shopName: 'Famco Main' },
          },
          {
            id: 'prof-new',
            tenantId: 'tenant-famco',
            storeId: 'store-sister',
            posProductId: 'pos-new',
            productId: 'prod-new',
            variationId: 'var-new',
            posWarehouseRef: 'pos-wh-sister',
            stockPoolGroupId: poolGroupId,
            posProduct: { name: 'Famco Sister', customId: 'FAM-1', productSnapshot: null },
            store: { name: 'Famco Sister', shopName: 'Famco Sister' },
          },
        ]),
      },
      wmsFulfillmentOrder: {
        findMany,
      },
    };

    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);
    await (service as any).refreshDemandFulfillmentQueue({
      tenantId: 'tenant-famco',
      storeId: 'store-main',
      variationIds: ['var-old'],
    });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: 'tenant-famco',
        AND: [
          {
            OR: [
              expect.objectContaining({ storeId: 'store-main' }),
              expect.objectContaining({ storeId: 'store-sister' }),
            ],
          },
        ],
      }),
    }));
  });

  it('resolves unambiguous exact catalog variation name and nested combo components without guessing ambiguous names', async () => {
    const prisma = {
      posProduct: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            productId: 'prod-tonios',
            variationId: 'var-tonios-only',
            customId: 'TONIOS-01',
            name: 'Tonios Classic Bottle',
          },
          {
            productId: 'prod-multi',
            variationId: 'var-multi-a',
            customId: 'MULTI-A',
            name: 'Ambiguous Tee',
          },
          {
            productId: 'prod-multi',
            variationId: 'var-multi-b',
            customId: 'MULTI-B',
            name: 'Ambiguous Tee',
          },
        ]),
      },
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);

    const matchedByName = await service.extractFulfillmentLinesFromOrderSnapshot(
      {
        items: [
          {
            variation_id: null,
            product_id: null,
            variation_info: { name: '  tonios classic bottle ' },
            quantity: 2,
          },
        ],
      },
      'store-tonios',
      null,
    );
    expect(matchedByName).toHaveLength(1);
    expect(matchedByName[0]).toEqual(expect.objectContaining({
      variationId: 'var-tonios-only',
      productId: 'prod-tonios',
      quantityRequired: 2,
    }));

    const ambiguousByName = await service.extractFulfillmentLinesFromOrderSnapshot(
      {
        items: [
          {
            variation_id: null,
            product_id: null,
            variation_info: { name: 'Ambiguous Tee' },
            quantity: 1,
          },
        ],
      },
      'store-tonios',
      null,
    );
    expect(ambiguousByName).toEqual([]);

    const comboExpanded = await service.extractFulfillmentLinesFromOrderSnapshot(
      {
        items: [
          {
            variation_id: null,
            product_id: null,
            quantity: 2,
            combo_items: [
              {
                variation_id: 'var-tonios-only',
                product_id: 'prod-tonios',
                quantity: 3,
              },
            ],
          },
        ],
      },
      'store-tonios',
      null,
    );
    expect(comboExpanded).toHaveLength(1);
    expect(comboExpanded[0]).toEqual(expect.objectContaining({
      variationId: 'var-tonios-only',
      quantityRequired: 6,
    }));
  });

  it('produces actionable empty fulfillment issue reasons based on POS item payload state', () => {
    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);

    expect(service.resolveEmptyFulfillmentIssueReason({}, [])).toBe(
      'Order line items have not arrived from Pancake POS yet — syncing from POS',
    );
    expect(service.resolveEmptyFulfillmentIssueReason({ items: [] }, [])).toBe(
      'Order has no line items in Pancake POS — add a product variation in POS to pick',
    );
    expect(
      service.resolveEmptyFulfillmentIssueReason(
        { items: [{ quantity: 2, returned_count: 2 }] },
        [],
      ),
    ).toBe('All order line items are marked returned in Pancake POS');
    expect(
      service.resolveEmptyFulfillmentIssueReason(
        { items: [{ quantity: 1, variation_id: null, note_product: 'Custom freebie' }] },
        [],
      ),
    ).toBe(
      'Order item in Pancake POS ("Custom freebie") is not linked to a catalog variation — link a product variation in POS to pick',
    );
    expect(
      service.resolveEmptyFulfillmentIssueReason(
        { items: [{ quantity: 1, variation_id: null }] },
        [],
      ),
    ).toBe(
      'Order item in Pancake POS is not linked to a catalog variation — link a product variation in POS to pick',
    );
  });
});

describe('WmsFulfillmentSyncService POS shipped pick-status sync', () => {
  it('transitions open Pick-status orders whose POS status is Shipped/Delivered/RTS (2..5) to PACKED, releases basket demand holds, and queues refresh', async () => {
    const orderUpdate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const lineUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 1 });
    const amendmentUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });
    const staffActivityCreate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const basketPickDemandDeleteMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 1 });
    const basketUpdateMany = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ count: 0 });

    const transactionClient = {
      $queryRaw: jest.fn<(...args: any[]) => Promise<any[]>>().mockResolvedValue([]),
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'fo-shipped-1',
            tenantId: 'tenant-1',
            storeId: 'store-1',
            warehouseId: 'wh-1',
            posOrderDbId: 'pos-db-shipped-1',
            posOrderId: '11200',
            assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
            status: WmsFulfillmentOrderStatus.READY,
            basketId: 'basket-1',
            posOrder: {
              id: 'pos-db-shipped-1',
              status: 2,
              isVoid: false,
              tracking: 'JT999888777',
            },
            lines: [
              {
                id: 'line-1',
                variationId: 'var-1',
                quantityRequired: 2,
                status: 'READY',
                reservations: [],
              },
            ],
            basketUnits: [],
          },
        ]),
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue({
          status: WmsFulfillmentOrderStatus.READY,
          basketId: 'basket-1',
          completedAt: null,
          posOrder: {
            status: 2,
            isVoid: false,
            tracking: 'JT999888777',
          },
        }),
        update: orderUpdate,
      },
      wmsFulfillmentLine: {
        updateMany: lineUpdateMany,
        upsert: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}),
      },
      wmsFulfillmentAmendment: {
        updateMany: amendmentUpdateMany,
      },
      wmsBasketPickDemand: {
        deleteMany: basketPickDemandDeleteMany,
      },
      wmsBasket: {
        updateMany: basketUpdateMany,
      },
      wmsStaffActivity: {
        create: staffActivityCreate,
      },
    };

    const prisma = {
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            id: 'pos-db-shipped-1',
            tenantId: 'tenant-1',
            shopId: 'shop-1',
            posOrderId: '11200',
            status: 2,
            isVoid: false,
            tracking: 'JT999888777',
            orderSnapshot: { items: [] },
            itemData: [],
          },
        ]),
      },
      $transaction: jest.fn(async (callback: any) => callback(transactionClient)),
    };
    const queue = {
      add: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 'refresh-job-shipped' }),
    };

    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, queue as any);
    jest.spyOn(service as any, 'buildTenantGoLiveOrderFilters').mockResolvedValue([{}]);
    jest.spyOn(service as any, 'extractFulfillmentLinesFromOrderSnapshot').mockResolvedValue([]);
    const refreshBasketSpy = jest
      .spyOn(service as any, 'refreshDemandBasketStateTx')
      .mockResolvedValue(undefined);

    const result = await service.reconcilePosShippedPickingOrderRefs({
      actorId: 'user-1',
      orders: [
        {
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '11200',
        },
        {
          tenantId: 'tenant-1',
          storeId: 'store-1',
          shopId: 'shop-1',
          posOrderId: '11200',
        },
      ],
    });

    expect(result).toEqual({ syncedOrders: 1 });
    expect(basketPickDemandDeleteMany).toHaveBeenCalledWith({
      where: { fulfillmentOrderId: 'fo-shipped-1' },
    });
    expect(lineUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ fulfillmentOrderId: 'fo-shipped-1' }),
      data: expect.objectContaining({
        quantityAllocated: 0,
        quantityPicked: 0,
        status: 'PICKED',
        issueReason: null,
      }),
    }));
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'fo-shipped-1' },
      data: expect.objectContaining({
        status: WmsFulfillmentOrderStatus.PACKED,
        issueReason: null,
        allocatedQuantity: 0,
        pickedQuantity: 0,
        basketId: null,
      }),
    });
    expect(staffActivityCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actionType: 'ORDER_DISPATCH_SYNC',
        resourceId: 'fo-shipped-1',
        fromStatus: WmsFulfillmentOrderStatus.READY,
        toStatus: WmsFulfillmentOrderStatus.PACKED,
        reasonCode: 'POS_STATUS_SYNC',
      }),
    });
    expect(refreshBasketSpy).toHaveBeenCalledWith(
      transactionClient,
      'basket-1',
      expect.any(Date),
    );
    expect(queue.add).toHaveBeenCalledWith(
      WMS_DEMAND_QUEUE_REFRESH_JOB,
      expect.objectContaining({
        tenantId: 'tenant-1',
        storeId: 'store-1',
      }),
      expect.any(Object),
    );
  });

  it('auto-cancels orphan zero-required lines and never leaves ISSUE orders with null issueReason', async () => {
    const lineUpdate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const orderUpdate = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({});
    const tx = {
      wmsFulfillmentLine: {
        update: lineUpdate,
      },
      wmsFulfillmentOrder: {
        update: orderUpdate,
      },
      wmsProductProfile: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      },
      wmsInventoryUnit: {
        groupBy: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          { warehouseId: 'wh-1', _count: { _all: 10 } },
        ]),
      },
      wmsBasketPickDemandBin: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      },
    };

    const service = new WmsFulfillmentSyncService({} as any, {} as any, {} as any);

    expect(
      service.resolveOrderIssueReason({
        nextOrderStatus: WmsFulfillmentOrderStatus.READY,
        totalQuantity: 5,
        existingIssueReason: 'stale',
      }),
    ).toBeNull();

    expect(
      service.resolveOrderIssueReason({
        nextOrderStatus: WmsFulfillmentOrderStatus.ISSUE,
        totalQuantity: 5,
        existingIssueReason: null,
        lines: [
          {
            productName: 'Nourio Glow Serum',
            status: 'ISSUE' as any,
            issueReason: 'Picked units remain on a removed order item.',
          },
        ],
      }),
    ).toBe('Nourio Glow Serum: Picked units remain on a removed order item.');

    expect(
      service.resolveOrderIssueReason({
        nextOrderStatus: WmsFulfillmentOrderStatus.ISSUE,
        totalQuantity: 5,
        existingIssueReason: null,
        lines: [],
      }),
    ).toBe('Order has a fulfillment issue — review order line items or resync the pick queue.');

    await (service as any).refreshDemandFulfillmentOrderReadinessTx(
      tx as any,
      'fo-4292',
      new Date(),
      {
        order: {
          id: 'fo-4292',
          tenantId: 'tenant-famco',
          storeId: 'store-nourio',
          warehouseId: null,
          posWarehouseRef: null,
          assignmentMode: WmsFulfillmentAssignmentMode.BASKET_DEMAND,
          status: WmsFulfillmentOrderStatus.ISSUE,
          issueReason: null,
          basketId: null,
          claimedById: null,
          posOrder: {
            status: 1,
            isVoid: false,
            dateLocal: '2026-11-11',
          },
          lines: [
            {
              id: 'line-orphan-zero',
              variationId: 'var-removed',
              productName: 'Removed Item',
              quantityRequired: 0,
              quantityAllocated: 0,
              quantityPicked: 0,
              status: 'ISSUE',
              issueReason: 'Order line has no required quantity.',
            },
            {
              id: 'line-valid-5',
              variationId: 'var-active',
              productName: 'Nourio Active Item',
              quantityRequired: 5,
              quantityAllocated: 0,
              quantityPicked: 0,
              status: 'RESTOCKING',
              issueReason: null,
            },
          ],
        },
      },
    );

    expect(lineUpdate).toHaveBeenCalledWith({
      where: { id: 'line-orphan-zero' },
      data: {
        quantityAllocated: 0,
        quantityPicked: 0,
        status: 'CANCELED',
        issueReason: null,
      },
    });
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'fo-4292' },
      data: expect.objectContaining({
        totalQuantity: 5,
        allocatedQuantity: 5,
        status: WmsFulfillmentOrderStatus.READY,
        issueReason: null,
      }),
    });

    expect(
      service.resolveEmptyFulfillmentIssueReason({
        items: [
          {
            quantity: 2,
            variation_info: { name: 'Nourio Promo Pack' },
          },
        ],
      } as any),
    ).toBe(
      'Order item in Pancake POS ("Nourio Promo Pack") is not linked to a catalog variation — link a product variation in POS to pick',
    );
  });

  it('never puts an actively picked order into ISSUE status when POS changes or removes items, and includes active Pick/Pack orders in broad resyncs', async () => {
    const prisma = {
      posOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      },
    };
    const service = new WmsFulfillmentSyncService(prisma as any, {} as any, {} as any);
    jest.spyOn(service as any, 'syncCanceledPickingOrders').mockResolvedValue({ cleanedOrders: 0 });
    jest.spyOn(service as any, 'syncPosShippedPickingOrders').mockResolvedValue({ syncedOrders: 0 });
    jest.spyOn(service as any, 'buildTenantGoLiveOrderFilters').mockResolvedValue([{}]);

    await service.syncConfirmedPickingOrders({
      tenantId: 'tenant-famco',
      storeId: 'store-nourio',
      actorId: 'user-1',
      stores: [{ id: 'store-nourio', tenantId: 'tenant-famco', shopId: 'shop-nourio' }],
      limit: null,
    });

    expect(prisma.posOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({
            wmsFulfillmentOrders: {
              some: {
                status: {
                  in: [
                    WmsFulfillmentOrderStatus.IN_PICKING,
                    WmsFulfillmentOrderStatus.READY_FOR_PACK,
                    WmsFulfillmentOrderStatus.PICKED,
                    WmsFulfillmentOrderStatus.PACKING,
                  ],
                },
              },
            },
          }),
        ]),
      }),
    }));

    expect(
      (service as any).resolveFulfillmentOrderStatus({
        currentStatus: WmsFulfillmentOrderStatus.IN_PICKING,
        claimedById: 'picker-1',
        basketId: 'basket-nourio',
        totalQuantity: 5,
        allocatedQuantity: 5,
        pickedQuantity: 5,
        hasIssue: true,
      }),
    ).toBe(WmsFulfillmentOrderStatus.IN_PICKING);

    expect(
      (service as any).resolveFulfillmentOrderStatus({
        currentStatus: WmsFulfillmentOrderStatus.IN_PICKING,
        claimedById: null,
        basketId: 'basket-nourio',
        totalQuantity: 0,
        allocatedQuantity: 0,
        pickedQuantity: 0,
        hasIssue: false,
      }),
    ).toBe(WmsFulfillmentOrderStatus.IN_PICKING);

    const plan = (service as any).buildFulfillmentAmendmentPlan(
      {
        status: WmsFulfillmentOrderStatus.IN_PICKING,
        basketId: 'basket-nourio',
        lines: [],
        basketPickDemands: [],
        basketUnits: [],
      },
      {
        hasChanges: true,
        added: [],
        removed: [
          {
            variationId: 'var-oto',
            productId: 'prod-oto',
            productName: 'OTO Nourio - 1 bottle 899',
            productDisplayId: 'OTO-899',
            quantityRequired: 1,
            previousQuantity: 1,
            nextQuantity: 0,
            delta: -1,
          },
        ],
        increased: [],
        decreased: [],
      },
      0,
    );
    expect(plan.changeState).toBe('PICK_REWORK_REQUIRED');
    expect(plan.summary.notificationTitle).toBe('Order changed during picking — all items removed');
  });
});
