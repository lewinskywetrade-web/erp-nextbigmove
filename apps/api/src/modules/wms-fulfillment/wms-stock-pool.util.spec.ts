import { describe, expect, it, jest } from '@jest/globals';
import {
  WmsBasketStatus,
  WmsFulfillmentOrderStatus,
  WmsInventoryUnitStatus,
} from '@prisma/client';
import {
  TenantStockPoolIndex,
  areProfilesCompatibleForStockPool,
  linkProfilesIntoSharedStockPoolTx,
  loadTenantStockPoolIndex,
  resolveStockPoolProductFamilyKey,
  restoreUnitPrePoolVariantOnPutawayTx,
  syncProfileStockPoolLinksTx,
} from './wms-stock-pool.util';

describe('wms-stock-pool.util', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  describe('TenantStockPoolIndex', () => {
    it('pools cross-store and same-store variations while ignoring singleton groups', () => {
      const index = new TenantStockPoolIndex([
        {
          profileId: 'prof-a',
          tenantId,
          storeId: 'store-a',
          posProductId: 'pos-a',
          productId: 'prod-a',
          variationId: 'var-old',
          posWarehouseRef: 'pos-wh-a',
          stockPoolGroupId: groupId,
          productName: 'Famco Old Variation',
          productCustomId: 'FAM-001',
          variationDisplayId: 'FAM-001-OLD',
          storeName: 'Famco Main',
        },
        {
          profileId: 'prof-b',
          tenantId,
          storeId: 'store-b',
          posProductId: 'pos-b',
          productId: 'prod-b',
          variationId: 'var-sister',
          posWarehouseRef: 'pos-wh-b',
          stockPoolGroupId: groupId,
          productName: 'Famco Sister Variation',
          productCustomId: 'FAM-001',
          variationDisplayId: 'FAM-001-SIS',
          storeName: 'Famco Sister',
        },
        {
          profileId: 'prof-singleton',
          tenantId,
          storeId: 'store-c',
          posProductId: 'pos-c',
          productId: 'prod-c',
          variationId: 'var-solo',
          posWarehouseRef: 'pos-wh-c',
          stockPoolGroupId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          productName: 'Solo Product',
          productCustomId: 'SOLO-1',
          variationDisplayId: 'SOLO-1',
          storeName: 'Store C',
        },
      ]);

      expect(index.hasAnyPools).toBe(true);
      expect(index.areStoreVariationsPooled('store-a', 'var-old', 'store-b', 'var-sister')).toBe(true);
      expect(index.areStoreVariationsPooled('store-a', 'var-old', 'store-c', 'var-solo')).toBe(false);
      expect(index.getGroupId('store-c', 'var-solo')).toBeNull();

      // Shared warehouse allocation key prevents double-allocating shared physical stock
      expect(index.buildWarehouseAllocationKey('wh-1', 'store-a', 'var-old')).toBe(
        `wh-1::pool:${groupId}`,
      );
      expect(index.buildWarehouseAllocationKey('wh-1', 'store-b', 'var-sister')).toBe(
        `wh-1::pool:${groupId}`,
      );
      expect(index.buildWarehouseAllocationKey('wh-1', 'store-c', 'var-solo')).toBe(
        'wh-1::store-c::var-solo',
      );

      // Pooled unit identity filter matches all pool members without restricting to sister store posWarehouseRef
      expect(
        index.buildPooledUnitIdentityFilter({
          storeId: 'store-b',
          variationId: 'var-sister',
          posWarehouseRef: 'pos-wh-b',
        }),
      ).toEqual({
        OR: [
          { storeId: 'store-a', variationId: 'var-old' },
          { storeId: 'store-b', variationId: 'var-sister' },
        ],
      });

      // Unpooled unit identity filter preserves strict store + posWarehouseRef scoping
      expect(
        index.buildPooledUnitIdentityFilter({
          storeId: 'store-c',
          variationId: 'var-solo',
          posWarehouseRef: 'pos-wh-c',
        }),
      ).toEqual({
        storeId: 'store-c',
        variationId: 'var-solo',
        OR: [{ posWarehouseRef: 'pos-wh-c' }, { posWarehouseRef: null }],
      });

      // Demand bin holds span all pooled store+variation pairs
      const holdWhere = index.buildPooledDemandBinHoldWhere({
        tenantId,
        storeId: 'store-b',
        variationId: 'var-sister',
        warehouseId: 'wh-1',
        basketStatuses: [WmsBasketStatus.IN_PICKING],
        orderStatuses: [WmsFulfillmentOrderStatus.IN_PICKING],
      });
      expect(holdWhere.OR).toHaveLength(2);

      // Queue refresh scope expands from Store A putaway to Sister Store B automatically
      const expanded = index.expandQueueRefreshScope({
        storeId: 'store-a',
        variationIds: ['var-old'],
      });
      expect(expanded.storeIds.sort()).toEqual(['store-a', 'store-b']);
      expect(expanded.storeVariationClauses).toEqual([
        { storeId: 'store-a', variationIds: ['var-old'] },
        { storeId: 'store-b', variationIds: ['var-sister'] },
      ]);
    });

    it('returns EMPTY_STOCK_POOL_INDEX safely when partial mocks omit wmsProductProfile', async () => {
      const index = await loadTenantStockPoolIndex({}, tenantId);
      expect(index.hasAnyPools).toBe(false);
    });
  });

  describe('linkProfilesIntoSharedStockPoolTx & syncProfileStockPoolLinksTx', () => {
    it('merges existing pool groups transitively when linking profiles', async () => {
      const updateMany = jest.fn<any>().mockResolvedValue({ count: 3 });
      const findMany = jest
        .fn<any>()
        .mockResolvedValueOnce([
          {
            id: 'prof-1',
            storeId: 'store-1',
            variationId: 'var-1',
            stockPoolGroupId: groupId,
          },
          {
            id: 'prof-3',
            storeId: 'store-3',
            variationId: 'var-3',
            stockPoolGroupId: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'prof-1',
            storeId: 'store-1',
            variationId: 'var-1',
            stockPoolGroupId: groupId,
          },
          {
            id: 'prof-2',
            storeId: 'store-2',
            variationId: 'var-2',
            stockPoolGroupId: groupId,
          },
          {
            id: 'prof-3',
            storeId: 'store-3',
            variationId: 'var-3',
            stockPoolGroupId: null,
          },
        ]);

      const tx = {
        wmsProductProfile: {
          findMany,
          updateMany,
        },
      } as any;

      const result = await linkProfilesIntoSharedStockPoolTx(tx, {
        tenantId,
        profileIds: ['prof-1', 'prof-3'],
      });

      expect(result.stockPoolGroupId).toBe(groupId);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          id: { in: ['prof-1', 'prof-3', 'prof-2'] },
        },
        data: {
          stockPoolGroupId: groupId,
        },
      });
      expect(result.affectedScopes).toHaveLength(3);
    });

    it('clears singleton stockPoolGroupId when unlinking a 2-member pool', async () => {
      const update = jest.fn<any>().mockResolvedValue({});
      const updateMany = jest.fn<any>().mockResolvedValue({ count: 1 });
      const tx = {
        wmsProductProfile: {
          findFirst: jest.fn<any>().mockResolvedValue({
            id: 'prof-1',
            storeId: 'store-1',
            variationId: 'var-1',
            stockPoolGroupId: groupId,
          }),
          findMany: jest.fn<any>().mockResolvedValue([
            {
              id: 'prof-1',
              storeId: 'store-1',
              variationId: 'var-1',
              stockPoolGroupId: groupId,
            },
            {
              id: 'prof-2',
              storeId: 'store-2',
              variationId: 'var-2',
              stockPoolGroupId: groupId,
            },
          ]),
          update,
          updateMany,
        },
      } as any;

      const result = await syncProfileStockPoolLinksTx(tx, {
        tenantId,
        profileId: 'prof-1',
        linkedProfileIds: [],
      });

      expect(result.stockPoolGroupId).toBeNull();
      expect(update).toHaveBeenCalledWith({
        where: { id: 'prof-1' },
        data: { stockPoolGroupId: null },
      });
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          tenantId,
          id: { in: ['prof-2'] },
        },
        data: {
          stockPoolGroupId: null,
        },
      });
      expect(result.affectedScopes).toEqual([
        { storeId: 'store-1', variationId: 'var-1' },
        { storeId: 'store-2', variationId: 'var-2' },
      ]);
    });
  });

  describe('resolveStockPoolProductFamilyKey & areProfilesCompatibleForStockPool', () => {
    it('keeps OTO-NMG, Nourio, and Multivitamins Gummies strictly separate as distinct products', () => {
      const nourioBase = {
        name: 'Nourio - 1 bottle 1490',
        customId: 'NOUR',
        variationDisplayId: 'NOUR',
        storeName: 'Nourio',
      };
      const otoNmg = {
        name: 'OTO Nourio - 1 bottle 899',
        customId: 'OTO-NMG',
        variationDisplayId: 'OTO-NMG',
        storeName: 'Nourio',
      };
      const regularNmg = {
        name: 'Nourio Multivitamins Gummies',
        customId: 'NMG',
        variationDisplayId: 'NMG',
        storeName: 'Nourio',
      };

      expect(areProfilesCompatibleForStockPool(nourioBase, otoNmg)).toBe(false);
      expect(areProfilesCompatibleForStockPool(nourioBase, regularNmg)).toBe(false);
      expect(areProfilesCompatibleForStockPool(otoNmg, regularNmg)).toBe(false);
    });

    it('matches Tonios same-product Body Wash variants while rejecting unrelated products', () => {
      const oldBodyWash = {
        name: '1 BOTTLE DEEP CURRENT BODY WASH',
        customId: null,
        storeName: 'Tonios',
      };
      const newBodyWash = {
        name: "TONIO'S DEEP CURRENT BODY WASH",
        customId: null,
        storeName: 'Tonios',
      };
      const hairPomade = {
        name: "TONIO'S HAIR POMADE",
        customId: null,
        storeName: 'Tonios',
      };

      expect(areProfilesCompatibleForStockPool(oldBodyWash, newBodyWash)).toBe(true);
      expect(areProfilesCompatibleForStockPool(newBodyWash, hairPomade)).toBe(false);
    });
  });

  describe('restoreUnitPrePoolVariantOnPutawayTx', () => {
    it('restores original variant when a pool-reassigned unit is returned to putaway', async () => {
      const unitUpdate = jest.fn(async () => ({ id: 'unit-1' }));
      const movementCreate = jest.fn(async () => ({ id: 'mov-revert' }));

      const result = await restoreUnitPrePoolVariantOnPutawayTx(
        {
          wmsInventoryMovement: {
            findMany: jest.fn(async () => [
              {
                referenceType: 'SHARED_STOCK_POOL',
                notes: 'Auto-assigned from shared stock pool on pick (var-orig -> var-target)',
                createdAt: new Date('2026-11-12T05:00:00Z'),
              },
            ]) as never,
            findFirst: jest.fn(async () => ({
              createdAt: new Date('2026-11-11T01:00:00Z'),
            })) as never,
            create: movementCreate as never,
          },
          wmsInventoryStoreTransferItem: {
            findFirst: jest.fn(async () => null) as never,
          },
          wmsInventoryUnit: {
            findUnique: jest.fn(async () => ({
              id: 'unit-1',
              tenantId,
              warehouseId: 'wh-1',
              currentLocationId: 'bin-1',
              status: WmsInventoryUnitStatus.PUTAWAY,
              storeId: 'store-1',
              variationId: 'var-target',
              barcode: '0100012345',
            })) as never,
            update: unitUpdate as never,
          },
          wmsProductProfile: {
            findMany: jest.fn(async () => [
              {
                id: 'prof-orig',
                storeId: 'store-1',
                posProductId: 'pos-orig',
                productId: 'prod-orig',
                variationId: 'var-orig',
                posWarehouseRef: null,
              },
            ]) as never,
          },
        },
        {
          inventoryUnitId: 'unit-1',
          actorId: 'user-1',
          now: new Date('2026-11-12T06:00:00Z'),
        },
      );

      expect(result).toEqual({ restoredVariationId: 'var-orig' });
      expect(unitUpdate).toHaveBeenCalledWith({
        where: { id: 'unit-1' },
        data: {
          storeId: 'store-1',
          posProductId: 'pos-orig',
          productProfileId: 'prof-orig',
          productId: 'prod-orig',
          variationId: 'var-orig',
          posWarehouseRef: null,
          updatedById: 'user-1',
        },
      });
      expect(movementCreate).toHaveBeenCalledTimes(1);
    });
  });
});
