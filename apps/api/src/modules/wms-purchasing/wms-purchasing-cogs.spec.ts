import { describe, expect, it, jest } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { Prisma, WmsPurchasingBatchStatus, WmsPurchasingRequestType } from '@prisma/client';
import { WmsPurchasingService } from './wms-purchasing.service';

const tenantId = '00000000-0000-4000-8000-000000000001';
const storeId = '00000000-0000-4000-8000-000000000002';
const batchId = '00000000-0000-4000-8000-000000000003';
const lineId = '00000000-0000-4000-8000-000000000004';
const profileId = '00000000-0000-4000-8000-000000000005';
const actorId = '00000000-0000-4000-8000-000000000006';
const clone = (v: any): any => JSON.parse(JSON.stringify(v));

function harness(options: { staleLine?: boolean; staleBatch?: boolean; lockBusy?: boolean; syncFailure?: boolean; preparationFailure?: boolean; fallback?: boolean;
  invalidProfile?: 'tenant' | 'store' | 'pointer' | 'variant' | 'legacy' | 'changedUnderLock' } = {}) {
  const calls: string[] = [];
  const line: any = { id: lineId, batchId, tenantId, storeId, lineNo: 1, requestedQuantity: 5,
    approvedQuantity: 5, receivedQuantity: 0, productId: 'parent-1', variationId: 'variant-1', partnerUnitCost: '80.00', supplierUnitCost: '20.00',
    resolvedProfileId: profileId, resolvedPosProductId: '00000000-0000-4000-8000-000000000007',
    sourceSnapshot: { originalPartnerUnitCost: 80, originalSupplierUnitCost: 20, originalApprovedQuantity: 5 },
    updatedAt: '2026-10-20T01:00:00.000Z',
    batch: { id: batchId, tenantId, storeId, requestType: WmsPurchasingRequestType.PROCUREMENT, status: WmsPurchasingBatchStatus.PENDING_PAYMENT },
  };
  const batch: any = { id: batchId, tenantId, storeId, requestType: WmsPurchasingRequestType.PROCUREMENT,
    status: WmsPurchasingBatchStatus.UNDER_REVIEW, sourceStatus: 'UNDER_REVIEW', invoiceNumber: null,
    invoiceAmount: null, paymentProofAsset: null, paymentProofAssetId: null, paymentProofImageUrl: null,
    paymentSubmittedAt: null, paymentVerifiedAt: null, readyForReceivingAt: null,
    updatedAt: '2026-10-20T01:00:00.000Z', lines: [clone(line)],
  };
  const initial = { profile: { inhouseUnitCost: 120, supplierUnitCost: 20 }, line: clone(line), batch: clone(batch) };
  let committed = clone(initial), working: any;
  const prepared = Object.freeze({ enabled: true, tenantId });
  let profileReads = 0;
  const profileSource = () => {
    profileReads++;
    const p: any = { id: profileId, tenantId, storeId, posProductId: line.resolvedPosProductId, productId: line.productId, variationId: line.variationId,
      posProduct: { id: line.resolvedPosProductId, storeId, productId: line.productId, variationId: line.variationId, store: { tenantId } } };
    if (options.invalidProfile === 'tenant') p.tenantId = '00000000-0000-4000-8000-000000000009';
    if (options.invalidProfile === 'store') p.storeId = '00000000-0000-4000-8000-000000000009';
    if (options.invalidProfile === 'pointer') { p.posProductId = '00000000-0000-4000-8000-000000000009'; p.posProduct.id = p.posProductId; }
    if (options.invalidProfile === 'variant' || options.invalidProfile === 'changedUnderLock' && profileReads > 1) p.variationId = 'other-variant';
    if (options.invalidProfile === 'legacy') { p.variationId = p.productId; p.posProduct.variationId = p.productId; }
    return [p];
  };
  const tx: any = {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      calls.push(sql.includes('FROM pos_products') ? 'lock-identity-parent' : sql.includes('FROM wms_product_profiles') ? 'lock-identity-profile' : sql.includes('wms_purchasing_batches') ? 'lock-batch' : 'lock-line');
      expect(sql).toContain('NOWAIT');
      if (options.lockBusy) throw Object.assign(new Error('busy'), { code: '55P03' });
      return [{ id: sql.includes('FROM pos_products') ? line.resolvedPosProductId : sql.includes('FROM wms_product_profiles') ? profileId : sql.includes('wms_purchasing_batches') ? batchId : lineId }];
    }),
    wmsPurchasingBatchLine: {
      findUnique: jest.fn(async () => { calls.push('read-fresh-line'); return options.staleLine ? { ...clone(line), partnerUnitCost: '95.00' } : clone(line); }),
      update: jest.fn(async ({ data }: any) => { calls.push('write-line'); Object.assign(working.line, data); return working.line; }),
    },
    wmsPurchasingBatch: {
      findUnique: jest.fn(async (query: any) => {
        calls.push(query.include?.paymentProofAsset ? 'read-fresh-batch' : 'read-updated-batch');
        if (query.include?.paymentProofAsset) return options.staleBatch ? { ...clone(batch), updatedAt: '2026-10-20T01:01:00.000Z' } : clone(batch);
        return { ...clone(batch), ...working.batch, tenant: { id: tenantId }, lines: clone(batch.lines) };
      }),
      update: jest.fn(async ({ data }: any) => { calls.push('write-batch'); Object.assign(working.batch, data); return working.batch; }),
    },
    wmsProductProfile: { findMany: jest.fn(async () => { calls.push('read-profile-identity'); return profileSource(); }), update: jest.fn(async ({ where, data }: any) => {
      calls.push('write-profile'); expect(where.id).toBe(profileId);
      expect(where.tenantId).toBe(tenantId); expect(where.posProductId).toBe(line.resolvedPosProductId);
      Object.assign(working.profile, data); return working.profile;
    }) },
    wmsPurchasingEvent: { create: jest.fn(async ({ data }: any) => { calls.push('write-event'); return { id: 'event', ...data }; }) },
  };
  const sync = {
    prepare: jest.fn(async (client: any, tenant: string, ids: string[]) => {
      expect(client).toBe(tx); expect(tenant).toBe(tenantId); expect(ids.every(id => id === profileId)).toBe(true);
      calls.push('prepare-cost-parents-and-profile');
      if (options.preparationFailure) throw new ConflictException('COGS synchronization batch exceeds 100 profiles');
      return prepared;
    }),
    syncAfter: jest.fn(async (client: any, context: any, metadata: any) => {
      expect(client).toBe(tx); expect(context).toBe(prepared); expect(metadata.actorId).toBe(actorId); calls.push('sync-after-final-profile');
      if (options.syncFailure) throw new Error('queue unavailable');
      if (options.fallback) { expect(working.profile.inhouseUnitCost).toBe(0); working.profile.inhouseUnitCost = 95; }
      return { policy: 'INHOUSE_POSITIVE_ELSE_CURRENT_ERP_V1', enabled: true, outcomes: [] };
    }),
  };
  const prisma: any = {
    wmsPurchasingBatchLine: { findUnique: jest.fn(async () => clone(line)) },
    wmsPurchasingBatch: { findUnique: jest.fn(async () => clone(batch)) },
    $transaction: jest.fn(async (callback: any, opts: any) => {
      expect(opts.isolationLevel).toBe(Prisma.TransactionIsolationLevel.ReadCommitted);
      working = clone(committed);
      try { const result = await callback(tx); committed = working; return result; }
      catch (e) { working = clone(committed); throw e; }
    }),
  };
  const service: any = new WmsPurchasingService(prisma, { get: () => actorId } as never, {} as never, {} as never, {} as never, sync as never);
  service.resolveTenantScope = jest.fn(async () => ({ activeTenantId: tenantId }));
  service.validateResolutionTargets = jest.fn(async () => undefined);
  service.resolvePaymentProofAsset = jest.fn(async () => null);
  service.syncPurchasingNotificationEvent = jest.fn(async () => undefined);
  service.syncProcurementInvoiceForBatchTx = jest.fn(async () => undefined);
  service.emitStockRequestUpdate = jest.fn();
  service.getBatchById = jest.fn(async () => ({ ok: true }));
  return { service, tx, sync, prisma, calls, line, batch, state: () => committed };
}

describe('WMS purchasing profile changes project costs within the same transaction', () => {
  it('locks cost parents before the batch/line and synchronizes only after the explicit partner price reaches the profile', async () => {
    const f = harness();
    await f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 });
    expect(f.state().profile.inhouseUnitCost).toBe(150);
    expect(f.calls.indexOf('prepare-cost-parents-and-profile')).toBeLessThan(f.calls.indexOf('lock-batch'));
    expect(f.calls.indexOf('lock-batch')).toBeLessThan(f.calls.indexOf('lock-line'));
    expect(f.calls.indexOf('read-fresh-line')).toBeLessThan(f.calls.indexOf('write-line'));
    expect(f.calls.indexOf('write-profile')).toBeLessThan(f.calls.indexOf('sync-after-final-profile'));
    expect(f.sync.syncAfter).toHaveBeenCalledWith(f.tx, expect.anything(), { source: 'WMS_PURCHASING_LINE', sourceRef: lineId, actorId });
  });

  it('supplier-only edits preserve a newer WMS inhouse price instead of restoring the stale purchasing partner price', async () => {
    const f = harness();
    await f.service.updateLine(batchId, lineId, { supplierUnitCost: 30 });
    expect(f.state().profile).toEqual({ inhouseUnitCost: 120, supplierUnitCost: 30 });
    expect(f.tx.wmsProductProfile.update).toHaveBeenCalledWith({ where: { id: profileId, tenantId, posProductId: f.line.resolvedPosProductId }, data: { supplierUnitCost: 30 } });
    expect(f.sync.prepare).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled();
  });

  it('passes an explicit zero to the shared fallback decision after the final profile update', async () => {
    const f = harness({ fallback: true });
    await f.service.updateLine(batchId, lineId, { partnerUnitCost: 0 });
    expect(f.tx.wmsProductProfile.update).toHaveBeenCalledWith(expect.objectContaining({ data: { supplierUnitCost: 20, inhouseUnitCost: 0 } }));
    expect(f.state().profile.inhouseUnitCost).toBe(95); expect(f.sync.syncAfter).toHaveBeenCalledTimes(1);
  });

  it('rejects a line changed since the initial permission/validation read before any business mutation', async () => {
    const f = harness({ staleLine: true });
    await expect(f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 })).rejects.toBeInstanceOf(ConflictException);
    expect(f.tx.wmsPurchasingBatchLine.update).not.toHaveBeenCalled(); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled();
    expect(f.sync.syncAfter).not.toHaveBeenCalled(); expect(f.state().profile.inhouseUnitCost).toBe(120);
  });

  it('does not publish a partial purchasing edit if shared cost synchronization or its queue fails', async () => {
    const f = harness({ syncFailure: true });
    await expect(f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 })).rejects.toThrow('queue unavailable');
    expect(f.state().profile.inhouseUnitCost).toBe(120); expect(f.state().line.partnerUnitCost).toBe('80.00');
    expect(f.tx.wmsPurchasingEvent.create).not.toHaveBeenCalled();
  });

  it('NOWAIT source contention stops without writes or synchronization', async () => {
    const f = harness({ lockBusy: true });
    await expect(f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 })).rejects.toThrow('busy');
    expect(f.tx.wmsPurchasingBatchLine.update).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled();
  });

  it('unaccepted commercial revisions retain their existing revision flow and do not project a profile cost', async () => {
    const f = harness(); f.line.batch.status = WmsPurchasingBatchStatus.UNDER_REVIEW;
    await f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 });
    expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled(); expect(f.sync.prepare).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled();
    expect(f.state().batch.status).toBe(WmsPurchasingBatchStatus.REVISION);
  });

  it('accepts ordered batch prices, preserving the final price per profile and synchronizing once after every profile write', async () => {
    const f = harness();
    f.batch.lines.push({ ...clone(f.batch.lines[0]), id: '00000000-0000-4000-8000-000000000008', lineNo: 2, partnerUnitCost: '90.00', sourceSnapshot: { originalPartnerUnitCost: 90, originalSupplierUnitCost: 20, originalApprovedQuantity: 5 } });
    await f.service.updateStatus(batchId, { status: WmsPurchasingBatchStatus.PENDING_PAYMENT });
    expect(f.state().profile.inhouseUnitCost).toBe(90); expect(f.tx.wmsProductProfile.update).toHaveBeenCalledTimes(1);
    expect(f.sync.prepare).toHaveBeenCalledTimes(1); expect(f.sync.syncAfter).toHaveBeenCalledTimes(1);
    expect(f.calls.indexOf('prepare-cost-parents-and-profile')).toBeLessThan(f.calls.indexOf('write-batch'));
    expect(f.calls.indexOf('read-fresh-batch')).toBeLessThan(f.calls.indexOf('write-batch'));
    expect(f.calls.indexOf('write-profile')).toBeLessThan(f.calls.indexOf('sync-after-final-profile'));
    expect(f.calls.indexOf('lock-identity-parent')).toBeLessThan(f.calls.indexOf('lock-identity-profile'));
    expect(f.sync.syncAfter).toHaveBeenCalledWith(f.tx, expect.anything(), { source: 'WMS_PROCUREMENT_ACCEPTED', sourceRef: batchId, actorId });
  });

  it('a stale accepted-batch snapshot or rejected preparation cannot write batch/profile/event changes', async () => {
    for (const options of [{ staleBatch: true }, { preparationFailure: true }]) {
      const f = harness(options);
      await expect(f.service.updateStatus(batchId, { status: WmsPurchasingBatchStatus.PENDING_PAYMENT })).rejects.toBeInstanceOf(ConflictException);
      expect(f.tx.wmsPurchasingBatch.update).not.toHaveBeenCalled(); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled();
      expect(f.tx.wmsPurchasingEvent.create).not.toHaveBeenCalled(); expect(f.sync.syncAfter).not.toHaveBeenCalled();
    }
  });

  it.each(['tenant', 'store', 'pointer', 'variant', 'legacy', 'changedUnderLock'] as const)(
    'rejects %s profile resolution before accepted-batch or line business mutations', async invalidProfile => {
      for (const mode of ['batch', 'line'] as const) {
        const f = harness({ invalidProfile });
        const action = mode === 'batch'
          ? f.service.updateStatus(batchId, { status: WmsPurchasingBatchStatus.PENDING_PAYMENT })
          : f.service.updateLine(batchId, lineId, { partnerUnitCost: 150 });
        await expect(action).rejects.toBeInstanceOf(ConflictException);
        expect(f.tx.wmsPurchasingBatch.update).not.toHaveBeenCalled(); expect(f.tx.wmsPurchasingBatchLine.update).not.toHaveBeenCalled();
        expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled(); expect(f.tx.wmsPurchasingEvent.create).not.toHaveBeenCalled();
        expect(f.sync.syncAfter).not.toHaveBeenCalled(); expect(f.state().profile.inhouseUnitCost).toBe(120);
        if (invalidProfile === 'tenant' || invalidProfile === 'store' || invalidProfile === 'pointer') expect(f.calls).not.toContain('lock-identity-parent');
      }
    },
  );
});
