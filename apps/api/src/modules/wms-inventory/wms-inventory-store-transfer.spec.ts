import { describe, expect, it, jest } from '@jest/globals';
import { WmsInventoryService } from './wms-inventory.service';

describe('WmsInventoryService same-store Change variant suggestions & shared stock pool recommendation', () => {
  const buildService = (priorTransferItems: any[]) => {
    const prisma = {
      posStore: {
        findMany: (jest.fn() as any).mockResolvedValue([
          { id: 'store-tonios', name: 'Tonios', shopName: 'Tonios' },
        ]),
      },
      wmsProductProfile: {
        findMany: (jest.fn() as any).mockResolvedValue([
          {
            id: 'profile-old',
            storeId: 'store-tonios',
            posProductId: 'pos-old',
            productId: 'prod-1',
            variationId: '98946cbb-8106-4554-a5bc-ecb498d738fc',
            stockPoolGroupId: null,
            posProduct: {
              id: 'pos-old',
              productId: 'prod-1',
              variationId: '98946cbb-8106-4554-a5bc-ecb498d738fc',
              customId: null,
              productSnapshot: null,
              name: '1 BOTTLE DEEP CURRENT BODY WASH',
            },
          },
          {
            id: 'profile-new',
            storeId: 'store-tonios',
            posProductId: 'pos-new',
            productId: 'prod-2',
            variationId: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
            stockPoolGroupId: null,
            posProduct: {
              id: 'pos-new',
              productId: 'prod-2',
              variationId: 'ef00523e-17be-49c8-b7b4-fb4058a65647',
              customId: null,
              productSnapshot: null,
              name: "TONIO'S DEEP CURRENT BODY WASH",
            },
          },
        ]),
        findFirst: (jest.fn() as any).mockResolvedValue({
          id: 'profile-old',
          storeId: 'store-tonios',
          productId: 'prod-1',
          variationId: '98946cbb-8106-4554-a5bc-ecb498d738fc',
          stockPoolGroupId: null,
          posProduct: {
            id: 'pos-old',
            productId: 'prod-1',
            variationId: '98946cbb-8106-4554-a5bc-ecb498d738fc',
            customId: null,
            productSnapshot: null,
            name: '1 BOTTLE DEEP CURRENT BODY WASH',
          },
        }),
      },
      wmsProductProfileEquivalence: {
        findFirst: (jest.fn() as any).mockResolvedValue(null),
      },
      wmsInventoryStoreTransferItem: {
        findMany: (jest.fn() as any).mockResolvedValue(priorTransferItems),
      },
    };

    const cls = {
      get: (jest.fn() as any).mockImplementation((key: string) => {
        if (key === 'TENANT_ID') return 'tenant-cristobal';
        return null;
      }),
    };

    const service = new WmsInventoryService(
      prisma as any,
      cls as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(service as any, 'resolveTenantScope').mockResolvedValue({
      activeTenantId: 'tenant-cristobal',
      canAccessAllTenants: false,
    });
    return service;
  };

  it('leaves recommendShareStockPool false on a first-ever transfer with no history', async () => {
    const service = buildService([]);
    const res = await service.getStoreTransferOptions({
      targetStoreId: 'store-tonios',
      sourceProfileId: 'profile-old',
    });

    const target = res.products.find((p) => p.profileId === 'profile-new');
    expect(target?.recommendShareStockPool).toBe(false);
  });

  it('suggests same-store variant and recommends shared stock pool when bidirectional transfer history exists', async () => {
    const service = buildService([
      {
        transferId: 'stx-1',
        fromProductProfileId: 'profile-old',
        toProductProfileId: 'profile-new',
      },
      {
        transferId: 'stx-2',
        fromProductProfileId: 'profile-new',
        toProductProfileId: 'profile-old',
      },
    ]);

    const res = await service.getStoreTransferOptions({
      targetStoreId: 'store-tonios',
      sourceProfileId: 'profile-old',
    });

    expect(res.suggestion).toEqual({
      profileId: 'profile-new',
      label: "TONIO'S DEEP CURRENT BODY WASH",
      reason: 'Previously transferred back and forth',
      confidence: 'high',
    });
    const target = res.products.find((p) => p.profileId === 'profile-new');
    expect(target?.recommendShareStockPool).toBe(true);
    expect(target?.bidirectionalTransferHistory).toBe(true);
  });
});
