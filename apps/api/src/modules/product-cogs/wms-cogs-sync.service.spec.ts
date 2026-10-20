import { ConflictException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { WmsCogsSyncService, WMS_ERP_COGS_POLICY, assertWmsManagedCogsEditable } from './wms-cogs-sync.service';

const T = '00000000-0000-4000-8000-000000000001', P = '00000000-0000-4000-8000-000000000002', W = '00000000-0000-4000-8000-000000000003';
const S = '00000000-0000-4000-8000-000000000004';
const date = (d: string) => new Date(d + 'T00:00:00Z');
const money = (v: string) => new Prisma.Decimal(v);
const settings = { wmsToErpCogs: { enabled: true, source: 'INHOUSE_UNIT_COST', policy: WMS_ERP_COGS_POLICY, policyVersion: 1 } };
function fixture(wms: string | null = '30.25', erp: string | null = '10.00', enabled = true) {
  const events: string[] = [];
  let profile: any = { id: W, tenantId: T, storeId: S, posProductId: P, productId: 'PARENT', variationId: 'VARIANT', inhouseUnitCost: wms === null ? null : money(wms), status: 'READY', updatedAt: date('2026-10-19') };
  let histories: any[] = erp === null ? [] : [{ id: 'HISTORY', tenantId: T, storeId: S, productId: P, teamId: null, cogs: money(erp), startDate: null, endDate: null, createdAt: date('2026-08-01'), updatedAt: date('2026-08-01') }];
  const product = { id: P, name: 'Fixture', storeId: S, productId: 'PARENT', variationId: 'VARIANT', tenantId: T, customId: null, teamId: null };
  const audits: any[] = [];
  const tx: any = {
    tenant: { findUnique: jest.fn(async () => ({ settings: enabled ? settings : {} })) },
    $executeRawUnsafe: jest.fn(async () => { events.push('cogs-table'); return 0; }),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM tenants')) { events.push('tenant'); return [{ settings: enabled ? settings : {}, status: 'ACTIVE' }]; }
      if (sql.includes('businessDate')) return [{ businessDate: '2026-10-20' }];
      if (sql.includes('FOR UPDATE OF p')) { events.push('parents'); return [product]; }
      if (sql.includes('FROM wms_product_profiles')) { events.push('profiles'); return [{ ...profile }]; }
      throw new Error('Unexpected SQL');
    }),
    posProductCogs: {
      findMany: jest.fn(async () => histories.map(h => ({ ...h }))),
      create: jest.fn(async ({ data }: any) => { events.push('erp-write'); const row = { id: 'TODAY', ...data, createdAt: date('2026-10-20'), updatedAt: date('2026-10-20') }; histories.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => { events.push('erp-write'); const h = histories.find(h => h.id === where.id); Object.assign(h, data); return { ...h }; }),
      updateMany: jest.fn(async ({ where, data }: any) => { const h = histories.find(h => h.id === where.id); if (!h) return { count: 0 }; Object.assign(h, data); return { count: 1 }; }),
    },
    wmsProductProfile: {
      findMany: jest.fn(async () => [profile]),
      update: jest.fn(async ({ data }: any) => { events.push('wms-write'); profile = { ...profile, ...data, updatedAt: date('2026-10-20') }; return profile; }),
    },
    auditLog: {
      findUnique: jest.fn(async ({ where }: any) => audits.find(a => a.id === where.id) ?? null),
      create: jest.fn(async ({ data }: any) => { events.push('audit'); audits.push(data); return data; }),
    },
  };
  const publisher: any = { enqueue: jest.fn(async () => { events.push('queue'); }) };
  const prisma: any = { $transaction: jest.fn(async (fn: any) => {
    const saved = { profile, histories: histories.map(h => ({ ...h })), audits: [...audits] };
    try { return await fn(tx); } catch (e) { profile = saved.profile; histories = saved.histories; audits.splice(0, audits.length, ...saved.audits); throw e; }
  }) };
  const service = new WmsCogsSyncService(prisma, publisher);
  const meta = { source: 'WMS_PROFILE_EDIT' as const, sourceRef: W, actorId: null };
  async function sync() { const p = await service.prepare(tx, T, [W]); return service.syncAfter(tx, p, meta); }
  return { service, tx, prisma, publisher, events, audits, product, sync, meta, profile: () => profile, histories: () => histories };
}

describe('tenant-scoped WMS to ERP current COGS connection', () => {
  it('defaults off without profile/product/history writes or jobs', async () => {
    const f = fixture('30.25', '10.00', false), r = await f.sync(); expect(r.enabled).toBe(false); expect(f.events).toEqual(['cogs-table', 'tenant']); expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });
  it('locks COGS then sorted parents then profiles before source/history decisions', async () => {
    const f = fixture(); await f.sync(); expect(f.events.slice(0, 4)).toEqual(['cogs-table', 'tenant', 'parents', 'profiles']);
    expect(f.tx.$queryRawUnsafe.mock.calls[1][0]).toContain('ORDER BY p.id FOR UPDATE'); expect(f.events.indexOf('audit')).toBeLessThan(f.events.indexOf('queue'));
  });
  it('positive WMS replaces existing ERP today while preserving its undated and past history', async () => {
    const f = fixture(); const r = await f.sync(); expect(r.outcomes[0].status).toBe('SYNCED_FROM_WMS'); expect(f.histories()).toHaveLength(2);
    expect(f.histories()[0].cogs.toString()).toBe('10'); expect(f.histories()[1].cogs.toString()).toBe('30.25'); expect(f.histories()[1].startDate).toEqual(date('2026-10-20'));
    expect(f.publisher.enqueue).toHaveBeenCalledWith({ tenantId: T, storeId: S, changes: [{ productId: P, fromDate: '2026-10-20', toDate: null }] });
    expect(f.audits[0].changes.historicalRatesInferred).toBe(false);
  });
  it.each([null, '0.00'])('missing WMS %s fills from unique current ERP, leaving ERP history unchanged', async value => {
    const f = fixture(value, '359.00'), r = await f.sync(); expect(r.outcomes[0].status).toBe('FILLED_WMS_FROM_ERP'); expect(f.profile().inhouseUnitCost.toString()).toBe('359'); expect(f.histories()).toHaveLength(1); expect(f.publisher.enqueue).not.toHaveBeenCalled();
    expect(f.tx.wmsProductProfile.update.mock.calls[0][0].where.updatedAt).toEqual(date('2026-10-19'));
  });
  it('never replaces a positive WMS cost from ERP or supplier, and same costs are a job/history no-op', async () => {
    const f = fixture('22.00', '22.00'); f.profile().supplierUnitCost = money('999.00'); const r = await f.sync(); expect(r.outcomes[0].status).toBe('ALREADY_EQUAL'); expect(f.tx.posProductCogs.create).not.toHaveBeenCalled(); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled(); expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });
  it('both missing is an explicit audited exception without a guessed cost', async () => {
    const f = fixture(null, null), r = await f.sync(); expect(r.outcomes[0].reason).toBe('BOTH_WMS_AND_CURRENT_ERP_COST_MISSING'); expect(f.audits[0].action).toBe('WMS_ERP_COGS_SYNC_SKIPPED'); expect(f.histories()).toEqual([]); expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });
  it.each(['-1.00', '10000000000.00'])('invalid or ERP overflow WMS %s cannot use ERP fallback', async value => {
    const f = fixture(value, '12.00'), r = await f.sync(); expect(r.outcomes[0].reason).toBe('WMS_INHOUSE_COST_NOT_REPRESENTABLE_IN_ERP'); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled(); expect(f.tx.posProductCogs.create).not.toHaveBeenCalled();
  });
  it('rejects a changed mapping even if the parent or alias has a cost', async () => {
    const f = fixture(); const p = await f.service.prepare(f.tx, T, [W]); f.profile().variationId = 'OTHER'; const r = await f.service.syncAfter(f.tx, p, f.meta); expect(r.outcomes[0].reason).toBe('EXACT_MODERN_PRODUCT_IDENTITY_REQUIRED'); expect(f.publisher.enqueue).not.toHaveBeenCalled();
  });
  it('ambiguous, wrong-scope or future ERP history is review-only even for fallback', async () => {
    for (const mutate of [(f: any) => f.histories().push({ ...f.histories()[0], id: 'SECOND' }), (f: any) => { f.histories()[0].tenantId = 'OTHER'; }, (f: any) => { f.histories()[0].startDate = date('2026-11-01'); }]) {
      const f = fixture(null, '12.00'); mutate(f); const r = await f.sync(); expect(r.outcomes[0].reason).toBe('ERP_HISTORY_REQUIRES_REVIEW'); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled();
    }
  });
  it('queue failure rolls back the same transaction and does not leave a decision audit', async () => {
    const f = fixture(); f.publisher.enqueue.mockRejectedValue(new Error('Queue unavailable')); await expect(f.service.alignExistingProfiles({ tenantId: T, profileIds: [W], sourceRef: 'RUN', actorId: null, runId: T })).rejects.toThrow('Queue unavailable'); expect(f.histories()).toHaveLength(1); expect(f.audits).toHaveLength(0);
  });
  it('bulk same-run retry reuses its exact decision under locks without duplicate writes/jobs', async () => {
    const f = fixture(), input = { tenantId: T, profileIds: [W], runId: T, sourceRef: 'RUN', actorId: null }; const first = await f.service.alignExistingProfiles(input), again = await f.service.alignExistingProfiles(input);
    expect(again.perProduct[0].auditLogId).toBe(first.perProduct[0].auditLogId); expect(again.perProduct[0].replayed).toBe(true); expect(f.audits).toHaveLength(1); expect(f.publisher.enqueue).toHaveBeenCalledTimes(1);
  });
  it('same run/profile cannot replay a decision from a different reviewed source', async () => {
    const f = fixture(), input = { tenantId: T, profileIds: [W], runId: T, sourceRef: 'FIRST_PREVIEW', actorId: null };
    await f.service.alignExistingProfiles(input); await expect(f.service.alignExistingProfiles({ ...input, sourceRef: 'DIFFERENT_PREVIEW' })).rejects.toThrow('identity conflicts'); expect(f.publisher.enqueue).toHaveBeenCalledTimes(1);
  });
  it('bulk missing-cost decisions are durably idempotent and an invalid run has no decision writes', async () => {
    const f = fixture(null, null), input = { tenantId: T, profileIds: [W], runId: T, sourceRef: 'PREVIEW', actorId: null };
    await f.service.alignExistingProfiles(input); const r = await f.service.alignExistingProfiles(input); expect(r.outcomes[0].status).toBe('SKIPPED'); expect(r.outcomes[0].replayed).toBe(true); expect(f.audits).toHaveLength(1);
    await expect(f.service.alignExistingProfiles({ ...input, runId: '' })).rejects.toThrow('run identity'); expect(f.audits).toHaveLength(1);
  });
  it('source edits reject invalid locked identity before the caller can mutate WMS', async () => {
    const f = fixture(); f.profile().variationId = 'CONFLICT'; const p = await f.service.prepare(f.tx, T, [W]); expect(() => f.service.assertSourceProfiles(p)).toThrow('exact tenant'); expect(f.tx.wmsProductProfile.update).not.toHaveBeenCalled();
  });
  it('a prepared context cannot cross transactions and bulk limits are explicit', async () => {
    const f = fixture(), p = await f.service.prepare(f.tx, T, [W]); await expect(f.service.syncAfter({} as any, p, f.meta)).rejects.toThrow(ConflictException); await expect(f.service.prepare(f.tx, T, Array.from({ length: 5001 }, (_, i) => String(i)))).rejects.toThrow('5000');
    await expect(f.service.alignExistingProfiles({ tenantId: T, profileIds: Array.from({ length: 101 }, (_, i) => String(i)), runId: T, sourceRef: 'P', actorId: null })).rejects.toThrow('100');
  });
  it('allows a valid source request over 100 profiles while locking its whole parent set once', async () => {
    const f = fixture(), profiles = Array.from({ length: 101 }, (_, i) => ({ ...f.profile(), id: `PROFILE-${i}`, posProductId: `PRODUCT-${i}` }));
    const products = profiles.map(p => ({ ...f.product, id: p.posProductId }));
    const original = f.tx.$queryRawUnsafe.getMockImplementation();
    f.tx.$queryRawUnsafe.mockImplementation(async (sql: string, ...args: any[]) => sql.includes('FOR UPDATE OF p') ? products : sql.includes('FROM wms_product_profiles') ? profiles : original(sql, ...args));
    const p = await f.service.prepare(f.tx, T, profiles.map(p => p.id)); expect(() => f.service.assertSourceProfiles(p)).not.toThrow();
    expect(f.tx.$queryRawUnsafe.mock.calls.filter((c: any[]) => c[0].includes('FOR UPDATE OF p'))).toHaveLength(1); expect(f.tx.$queryRawUnsafe.mock.calls.find((c: any[]) => c[0].includes('FOR UPDATE OF p'))[1]).toHaveLength(101);
  });
  it('manual ERP writes are rejected only for verified positive WMS authority', async () => {
    const linked: any = { id: W, tenantId: T, storeId: S, status: 'READY', productId: 'PARENT', variationId: 'VARIANT', inhouseUnitCost: money('20.00'), posProduct: { storeId: S, productId: 'PARENT', variationId: 'VARIANT' } };
    const tx: any = { tenant: { findUnique: jest.fn(async () => ({ settings })) }, wmsProductProfile: { findUnique: jest.fn(async () => linked) } };
    await expect(assertWmsManagedCogsEditable(tx, P, { id: S, tenantId: T })).rejects.toThrow('managed by WMS');
    linked.inhouseUnitCost = null; await expect(assertWmsManagedCogsEditable(tx, P, { id: S, tenantId: T })).resolves.toBeUndefined();
    linked.inhouseUnitCost = money('0'); await expect(assertWmsManagedCogsEditable(tx, P, { id: S, tenantId: T })).resolves.toBeUndefined();
    tx.wmsProductProfile.findUnique.mockResolvedValue(null); await expect(assertWmsManagedCogsEditable(tx, P, { id: S, tenantId: T })).resolves.toBeUndefined();
  });
  it('ERP fallback after a historical edit uses current applicable cost, never the edited past amount', async () => {
    const f = fixture('0', '359.00'); f.histories().push({ ...f.histories()[0], id: 'PAST', cogs: money('7.00'), startDate: date('2026-01-01'), endDate: date('2026-01-31') });
    await f.service.syncAfterErpWrites(f.tx, { id: S, tenantId: T }, [P], null); expect(f.profile().inhouseUnitCost.toString()).toBe('359'); expect(f.histories()).toHaveLength(2);
  });
});
