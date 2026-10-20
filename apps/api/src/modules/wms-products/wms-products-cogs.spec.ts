import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { WmsProductsService } from './wms-products.service';

describe('WMS product COGS source edit boundary', () => {
  function fixture() {
    const existing: any = { id: 'PROFILE', tenantId: 'TENANT', storeId: 'STORE', posProductId: 'PRODUCT', productId: 'PARENT', variationId: 'VARIANT',
      updatedAt: new Date('2026-10-19T00:00:00Z'), preferredLocationId: null, pickLocationId: null, posWarehouseRef: null,
      posProduct: { id: 'PRODUCT', productId: 'PARENT', variationId: 'VARIANT' } };
    const events: string[] = [];
    const model: any = { update: jest.fn(async () => { events.push('source-write'); return existing; }), findUniqueOrThrow: jest.fn(async () => existing) };
    const tx: any = { wmsProductProfile: model };
    const prisma: any = { wmsProductProfile: { findFirst: jest.fn(async () => existing) }, $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const sync: any = { prepare: jest.fn(async () => { events.push('prepare'); return { enabled: true }; }), assertSourceProfiles: jest.fn(() => events.push('identity')),
      syncAfter: jest.fn(async () => { events.push('project'); return { policy: 'FIXTURE', enabled: true, outcomes: [] }; }) };
    const service = new WmsProductsService(prisma, { get: () => undefined } as any, {} as any, sync);
    jest.spyOn(service as any, 'resolveTenantScope').mockResolvedValue({ activeTenantId: 'TENANT' });
    jest.spyOn(service as any, 'validateLocationReference').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'mapProfile').mockImplementation(() => ({ id: 'PROFILE' }));
    return { service, prisma, sync, model, existing, events };
  }
  it('prepares and verifies source identity before scoped version-CAS mutation', async () => {
    const f = fixture(); await f.service.updateProfile('PROFILE', { inhouseUnitCost: 359 });
    expect(f.events).toEqual(['prepare', 'identity', 'source-write', 'project']);
    expect(f.model.update.mock.calls[0][0].where).toEqual({ id: 'PROFILE', tenantId: 'TENANT', storeId: 'STORE', posProductId: 'PRODUCT', productId: 'PARENT', variationId: 'VARIANT', updatedAt: f.existing.updatedAt });
    expect(f.model.findUniqueOrThrow.mock.calls[0][0].where).toEqual({ id: 'PROFILE', tenantId: 'TENANT', storeId: 'STORE', posProductId: 'PRODUCT' });
  });
  it('wrong locked identity and stale source versions stop before projection', async () => {
    const f = fixture(); f.sync.assertSourceProfiles.mockImplementation(() => { throw new Error('Wrong identity'); });
    await expect(f.service.updateProfile('PROFILE', { inhouseUnitCost: 1 })).rejects.toThrow('Wrong identity'); expect(f.model.update).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled();
    const g = fixture(); g.model.update.mockRejectedValue(new Error('Version changed')); await expect(g.service.updateProfile('PROFILE', { inhouseUnitCost: 1 })).rejects.toThrow('Version changed'); expect(g.sync.syncAfter).not.toHaveBeenCalled();
  });
  it('supplier-only edits keep all synchronization code out of the flow', async () => {
    const f = fixture(); await f.service.updateProfile('PROFILE', { supplierUnitCost: 99 }); expect(f.sync.prepare).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled(); expect(f.events).toEqual(['source-write']);
  });
});
