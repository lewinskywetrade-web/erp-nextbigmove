import 'reflect-metadata';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { WmsFulfillmentOrderStatus } from '@prisma/client';
import { IntegrationService } from '../integration.service';
import {
  resolveWmsIssueRecheckIntervalMs,
  WmsIssueOrderReconcilerService,
} from './wms-issue-order-reconciler.service';

describe('WmsIssueOrderReconcilerService & IntegrationService ISSUE hydration', () => {
  const originalProcessRole = process.env.PROCESS_ROLE;
  const originalEnabled = process.env.WMS_ISSUE_ORDER_RECONCILE_ENABLED;

  afterEach(() => {
    process.env.PROCESS_ROLE = originalProcessRole;
    process.env.WMS_ISSUE_ORDER_RECONCILE_ENABLED = originalEnabled;
    jest.restoreAllMocks();
  });

  it('uses tiered recheck intervals so newly created ISSUE orders self-heal within ~1 minute', () => {
    expect(resolveWmsIssueRecheckIntervalMs(10_000)).toBe(50_000);
    expect(resolveWmsIssueRecheckIntervalMs(45 * 60_000)).toBe(5 * 60_000);
    expect(resolveWmsIssueRecheckIntervalMs(8 * 60 * 60_000)).toBe(30 * 60_000);
    expect(resolveWmsIssueRecheckIntervalMs(96 * 60 * 60_000)).toBe(4 * 60 * 60_000);
  });

  it('reconciles due ISSUE orders and skips immediate repeat ticks within cooldown', async () => {
    process.env.PROCESS_ROLE = 'api';
    delete process.env.WMS_ISSUE_ORDER_RECONCILE_ENABLED;

    const now = new Date();
    const prisma = {
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          { id: 'fo-11140', createdAt: new Date(now.getTime() - 2 * 60_000) },
          { id: 'fo-11144', createdAt: new Date(now.getTime() - 60_000) },
        ]),
      },
    };
    const reconcileOpenWmsIssueOrders = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({
        evaluatedCount: 2,
        recoveredCount: 2,
        canceledCount: 0,
        remainingIssueCount: 0,
      });

    const reconciler = new WmsIssueOrderReconcilerService(
      prisma as any,
      { reconcileOpenWmsIssueOrders } as any,
    );

    const first = await reconciler.reconcileDueIssueOrders('cron');
    expect(first).toEqual({
      dueCount: 2,
      recoveredCount: 2,
      canceledCount: 0,
      remainingIssueCount: 0,
    });
    expect(reconcileOpenWmsIssueOrders).toHaveBeenCalledTimes(1);
    expect(reconcileOpenWmsIssueOrders).toHaveBeenCalledWith({
      orderIds: ['fo-11140', 'fo-11144'],
      limit: 2,
    });

    const immediateSecond = await reconciler.reconcileDueIssueOrders('cron');
    expect(immediateSecond.dueCount).toBe(0);
    expect(reconcileOpenWmsIssueOrders).toHaveBeenCalledTimes(1);
  });

  it('hydrates confirmed empty-items webhook payloads from authoritative Pancake single-order API without overwriting newer edits with stale replicas', async () => {
    const prisma = {
      posProduct: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue([
          {
            variationId: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
            productId: 'parent-tonios',
          },
        ]),
      },
    };

    const service = Object.create(IntegrationService.prototype) as any;
    service.prisma = prisma;
    service.logger = { warn: jest.fn(), log: jest.fn() };
    service.lastStoreCatalogAutoSyncAt = new Map();
    service.resolveStoreApiKeyForWebhook = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue('pos-api-key');
    service.syncPancakeProductsByStoreId = jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({ syncedCount: 4 });
    service.fetchSingleOrderFromPancakeDetailed = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async (_shopId: string, orderId: string) => {
        if (orderId === '11140') {
          return {
            status: 'ok',
            data: {
              id: '11140',
              shop_id: '1328305357',
              status: 1,
              updated_at: '2026-11-11T08:50:05.000000Z',
              items: [
                {
                  product_id: 'parent-tonios',
                  variation_id: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
                  quantity: 1,
                },
              ],
            },
          };
        }
        return {
          status: 'ok',
          data: {
            id: '11145',
            shop_id: '1328305357',
            status: 1,
            updated_at: '2026-11-11T08:40:00.000000Z',
            items: [
              {
                product_id: 'parent-tonios',
                variation_id: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
                quantity: 1,
              },
            ],
          },
        };
      });

    const hydrated = await service.hydrateIncompleteWebhookOrdersFromPancake(
      'tenant-tonios',
      { id: 'store-tonios', shopId: '1328305357', apiKey: 'enc' },
      [
        {
          id: '11140',
          shop_id: '1328305357',
          status: 1,
          updated_at: '2026-11-11T08:50:00.000000Z',
          items: [],
        },
        {
          id: '11145',
          shop_id: '1328305357',
          status: 1,
          updated_at: '2026-11-11T08:55:00.000000Z',
          items: [],
        },
      ],
    );

    expect(hydrated[0].items).toHaveLength(1);
    expect(hydrated[0].items[0].variation_id).toBe('ef00523e-17be-49c8-b7b4-fb4058a65647');
    // Stale live replica (08:40 < 08:55) must not overwrite newer explicit empty-items edit
    expect(hydrated[1].items).toEqual([]);
  });

  it('reconcileOpenWmsIssueOrders hydrates live POS orders with allowIncompleteOrderHydration and voids 404 POS orders', async () => {
    const posOrderUpdateMany = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ count: 1 });
    const upsertPosOrdersWithOutcomes = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ upserted: 1, outcomes: [] });
    const syncConfirmedPickingOrders = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ syncedOrders: 2 });

    let findManyCall = 0;
    const prisma = {
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockImplementation(async () => {
          findManyCall += 1;
          if (findManyCall === 1) {
            return [
              {
                id: 'fo-11140',
                tenantId: 'tenant-tonios',
                storeId: 'store-tonios',
                shopId: '1328305357',
                posOrderId: '11140',
                posOrderDbId: 'pos-db-11140',
                totalQuantity: 0,
                issueReason: 'Order has no pickable variation items',
                store: {
                  id: 'store-tonios',
                  tenantId: 'tenant-tonios',
                  teamId: 'team-tonios',
                  shopId: '1328305357',
                  integrationId: 'int-tonios',
                  apiKey: 'enc',
                  status: 'ACTIVE',
                  enabled: true,
                },
                tenant: {
                  id: 'tenant-tonios',
                  wmsFulfillmentGoLiveAt: new Date('2026-11-08T16:00:00.000Z'),
                },
                posOrder: {
                  id: 'pos-db-11140',
                  status: 1,
                  isVoid: false,
                  insertedAt: new Date('2026-11-11T08:48:00.000Z'),
                },
              },
              {
                id: 'fo-404',
                tenantId: 'tenant-tonios',
                storeId: 'store-tonios',
                shopId: '1328305357',
                posOrderId: '11199',
                posOrderDbId: 'pos-db-404',
                totalQuantity: 0,
                issueReason: 'Order has no pickable variation items',
                store: {
                  id: 'store-tonios',
                  tenantId: 'tenant-tonios',
                  teamId: 'team-tonios',
                  shopId: '1328305357',
                  integrationId: 'int-tonios',
                  apiKey: 'enc',
                  status: 'ACTIVE',
                  enabled: true,
                },
                tenant: {
                  id: 'tenant-tonios',
                  wmsFulfillmentGoLiveAt: new Date('2026-11-08T16:00:00.000Z'),
                },
                posOrder: {
                  id: 'pos-db-404',
                  status: 1,
                  isVoid: false,
                  insertedAt: new Date('2026-11-11T08:49:00.000Z'),
                },
              },
            ];
          }
          return [
            { id: 'fo-11140', status: WmsFulfillmentOrderStatus.READY },
            { id: 'fo-404', status: WmsFulfillmentOrderStatus.CANCELED },
          ];
        }),
      },
      posShopOwnership: {
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue({ shopId: '1328305357' }),
      },
      posOrder: {
        updateMany: posOrderUpdateMany,
      },
    };

    const service = Object.create(IntegrationService.prototype) as any;
    service.prisma = prisma;
    service.logger = { warn: jest.fn(), log: jest.fn() };
    service.lastStoreCatalogAutoSyncAt = new Map();
    service.resolveStoreApiKeyForWebhook = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue('pos-api-key');
    service.syncPancakeProductsByStoreId = jest
      .fn<() => Promise<any>>()
      .mockResolvedValue({ syncedCount: 4 });
    service.ensureStoreOrdersHavePositiveCogs = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    service.posShopOwnershipService = {
      resolveOrderRoutes: jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(
        async (tenantId: string, orders: any[]) => ({
          routes: [{ tenantId, store: { id: 'store-tonios' }, orders }],
          issues: [],
        }),
      ),
    };
    service.posOrderService = {
      upsertPosOrdersWithOutcomes,
    };
    service.wmsFulfillmentSyncService = {
      syncConfirmedPickingOrders,
    };
    service.fetchSingleOrderFromPancakeDetailed = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async (_shopId: string, posOrderId: string) => {
        if (posOrderId === '11140') {
          return {
            status: 'ok',
            data: {
              id: '11140',
              shop_id: '1328305357',
              status: 1,
              updated_at: '2026-11-11T08:52:00.000000Z',
              items: [
                {
                  product_id: 'parent-tonios',
                  variation_id: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
                  quantity: 1,
                },
              ],
            },
          };
        }
        return { status: 'not_found' };
      });

    const summary = await service.reconcileOpenWmsIssueOrders({
      tenantId: 'tenant-tonios',
      storeId: 'store-tonios',
    });

    expect(summary).toEqual({
      evaluatedCount: 2,
      recoveredCount: 1,
      canceledCount: 1,
      remainingIssueCount: 0,
    });
    expect(upsertPosOrdersWithOutcomes).toHaveBeenCalledWith(
      'tenant-tonios',
      'store-tonios',
      [
        expect.objectContaining({
          id: '11140',
          status: 1,
        }),
      ],
      'team-tonios',
      { allowIncompleteOrderHydration: true },
    );
    expect(posOrderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'pos-db-404',
        tenantId: 'tenant-tonios',
      },
      data: {
        isVoid: true,
      },
    });
    expect(syncConfirmedPickingOrders).toHaveBeenCalledTimes(1);
  });

  it('periodically syncs active stores that have open Pick Queue orders against live Pancake POS', async () => {
    process.env.PROCESS_ROLE = 'api';
    delete process.env.WMS_ISSUE_ORDER_RECONCILE_ENABLED;

    const findMany = jest
      .fn<(...args: any[]) => Promise<any[]>>()
      .mockImplementation(async (args: any) => {
        if (args?.distinct?.includes('storeId')) {
          return [{ storeId: 'store-tonios', tenantId: 'tenant-tonios' }];
        }
        return [];
      });
    const syncPancakeOrdersByStoreId = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ fetchedCount: 10, upsertedCount: 2, wmsSyncedOrders: 2 });

    const reconciler = new WmsIssueOrderReconcilerService(
      { wmsFulfillmentOrder: { findMany } } as any,
      {
        reconcileOpenWmsIssueOrders: jest.fn(),
        syncPancakeOrdersByStoreId,
      } as any,
    );

    await reconciler.reconcileDueIssueOrders('startup');
    expect(syncPancakeOrdersByStoreId).toHaveBeenCalledTimes(1);
    expect(syncPancakeOrdersByStoreId).toHaveBeenCalledWith(
      'store-tonios',
      'tenant-tonios',
      { days: 3, repairIssueOrders: true },
    );

    // Immediate cron tick within the 2-minute window skips re-syncing the same store
    await reconciler.reconcileDueIssueOrders('cron');
    expect(syncPancakeOrdersByStoreId).toHaveBeenCalledTimes(1);
  });

  it('isolates per-store live fetch errors and recovers unbasketed ISSUE orders with pickable lines even when store.enabled is false', async () => {
    const syncConfirmedPickingOrders = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ syncedOrders: 1 });
    const refreshDemandQueueForScope = jest
      .fn<(...args: any[]) => Promise<void>>()
      .mockResolvedValue(undefined);

    let findManyCall = 0;
    const prisma = {
      wmsFulfillmentOrder: {
        findMany: jest.fn<() => Promise<any[]>>().mockImplementation(async () => {
          findManyCall += 1;
          if (findManyCall === 1) {
            return [
              {
                id: 'fo-store-broken',
                tenantId: 'tenant-a',
                storeId: 'store-broken',
                shopId: 'shop-broken',
                posOrderId: '9001',
                posOrderDbId: 'pos-db-9001',
                totalQuantity: 0,
                issueReason: null,
                store: {
                  id: 'store-broken',
                  tenantId: 'tenant-a',
                  teamId: null,
                  shopId: 'shop-broken',
                  integrationId: 'int-a',
                  apiKey: 'enc-a',
                  status: 'ACTIVE',
                  enabled: true,
                },
                tenant: { id: 'tenant-a', wmsFulfillmentGoLiveAt: null },
                posOrder: {
                  id: 'pos-db-9001',
                  status: 1,
                  isVoid: false,
                  insertedAt: new Date('2026-11-11T05:00:00.000Z'),
                },
              },
              {
                id: 'fo-4292',
                tenantId: 'tenant-famco',
                storeId: 'store-nourio',
                shopId: 'shop-nourio',
                posOrderId: '4292',
                posOrderDbId: 'pos-db-4292',
                totalQuantity: 5,
                issueReason: null,
                store: {
                  id: 'store-nourio',
                  tenantId: 'tenant-famco',
                  teamId: null,
                  shopId: 'shop-nourio',
                  integrationId: 'int-famco',
                  apiKey: null,
                  status: 'ACTIVE',
                  enabled: false,
                },
                tenant: { id: 'tenant-famco', wmsFulfillmentGoLiveAt: null },
                posOrder: {
                  id: 'pos-db-4292',
                  status: 1,
                  isVoid: false,
                  insertedAt: new Date('2026-11-11T06:00:00.000Z'),
                },
              },
            ];
          }
          return [
            { id: 'fo-store-broken', status: WmsFulfillmentOrderStatus.ISSUE },
            { id: 'fo-4292', status: WmsFulfillmentOrderStatus.READY },
          ];
        }),
      },
      posShopOwnership: {
        findUnique: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('DB transient error')),
      },
    };

    const service = Object.create(IntegrationService.prototype) as any;
    service.prisma = prisma;
    service.logger = { warn: jest.fn(), log: jest.fn() };
    service.resolveStoreApiKeyForWebhook = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue('pos-api-key');
    service.wmsFulfillmentSyncService = {
      syncConfirmedPickingOrders,
      refreshDemandQueueForScope,
    };

    const summary = await service.reconcileOpenWmsIssueOrders();
    expect(summary).toEqual({
      evaluatedCount: 2,
      recoveredCount: 1,
      canceledCount: 0,
      remainingIssueCount: 1,
    });
    expect(syncConfirmedPickingOrders).toHaveBeenCalledTimes(2);
    expect(refreshDemandQueueForScope).toHaveBeenCalledWith({
      tenantId: 'tenant-famco',
      storeId: 'store-nourio',
    });
  });
});
