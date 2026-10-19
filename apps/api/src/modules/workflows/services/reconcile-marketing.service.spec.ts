import { describe, expect, it, jest } from '@jest/globals';
import {
  excludesPosOrderFromSalesTotals,
  ReconcileMarketingService,
  resolveInsightMappingForReconcile,
} from './reconcile-marketing.service';

describe('reconcile marketing POS eligibility', () => {
  it('keeps deleted and void order tombstones out of sales totals', () => {
    expect(excludesPosOrderFromSalesTotals({ status: 7, isVoid: true })).toBe(true);
    expect(excludesPosOrderFromSalesTotals({ status: 13, isVoid: true })).toBe(true);
    expect(excludesPosOrderFromSalesTotals({ status: 6, isVoid: true })).toBe(true);
  });

  it('continues counting ordinary order statuses', () => {
    expect(excludesPosOrderFromSalesTotals({ status: 1, isVoid: false })).toBe(false);
    expect(excludesPosOrderFromSalesTotals({ status: 5, isVoid: false })).toBe(false);
    expect(excludesPosOrderFromSalesTotals({ status: null, isVoid: false })).toBe(false);
  });
});

describe('reconcile marketing order attribution conservation', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const day = '2026-10-01';
  const numericAdId = '12345678901234';
  const importedAdId = `ad_id=${numericAdId}`;
  const insight = (adId: string, spend: number) => ({
    adId, spend, tenantId, accountId: 'account', campaignId: adId,
    campaignName: 'Campaign', adsetId: 'adset', adName: 'Legacy',
    mapping: 'product', teamId: null,
  });
  const order = (posOrderId: string, pUtmContent: string, cogs: number) => ({
    shopId: 'shop', posOrderId, pUtmContent, status: 3, isVoid: false,
    cod: cogs * 10, cogs, tracking: posOrderId, mapping: 'pv::store::variant',
    teamId: null, isRepurchase: false,
  });

  function harness(meta: any[], orders: any[]) {
    const rows = new Map<string, any>();
    const prisma = {
      posStore: { findMany: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 'store', shopId: 'shop' }]) },
      metaAdInsight: { findMany: jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async () => meta) },
      creativeMetaAdLink: { findMany: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]) },
      posProduct: { findMany: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]) },
      posOrder: { findMany: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(orders) },
      reconcileMarketing: {
        upsert: jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async ({ where, create, update }) => {
          const id = where.tenantId_date_adId.adId;
          rows.set(id, rows.has(id) ? { ...rows.get(id), ...update } : create);
        }),
        deleteMany: jest.fn<(...args: any[]) => Promise<any>>().mockImplementation(async ({ where }) => {
          for (const id of rows.keys()) {
            if (!where.adId || !where.adId.notIn.includes(id)) rows.delete(id);
          }
        }),
      },
    };
    // Exercise the real reconciliation path without constructing network clients.
    const service: ReconcileMarketingService = Object.create(ReconcileMarketingService.prototype);
    Object.assign(service, { prisma, redis: { incr: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(1) },
      logger: { log: jest.fn(), warn: jest.fn() } });
    const total = (field: string) => [...rows.values()].reduce((sum, row) => sum + (row[field] || 0), 0);
    return { service, rows, total };
  }

  it('counts each POS order once when two Meta identifiers normalize to the same ad', async () => {
    const { service, rows, total } = harness(
      [insight(numericAdId, 100), insight(importedAdId, 200)],
      [order('exact', numericAdId, 100), order('imported', importedAdId, 200),
        order('ambiguous', `utm_source=meta&ad_id=${numericAdId}`, 300)],
    );
    await service.reconcileDay(tenantId, day);
    expect(total('purchasesPos')).toBe(3);
    expect(total('codPos')).toBe(6000);
    expect(total('cogsPos')).toBe(600);
    expect(total('cogsDeliveredPos')).toBe(600);
    expect(total('sfPos')).toBe(180);
    expect(total('spend')).toBe(300);
    expect(rows.get(numericAdId).matchedOrders.map((o: any) => o.posOrderId)).toEqual(['exact']);
    expect(rows.get(importedAdId).matchedOrders.map((o: any) => o.posOrderId)).toEqual(['imported']);
    expect(rows.get('shop-ambiguous').mapping).toBe('pv::store::variant');
  });

  it('keeps normalized-only ambiguous orders unmatched and preserves repurchase/lifecycle amounts', async () => {
    const pending = { ...order('pending', `utm_source=meta&ad_id=${numericAdId}`, 76_000),
      cod: 2_000_000, isRepurchase: true, status: 11 };
    const { service, rows, total } = harness(
      [insight(numericAdId, 10), insight(importedAdId, 20)], [pending],
    );
    await service.reconcileDay(tenantId, day);
    expect(total('codPos')).toBe(2_000_000);
    expect(total('cogsPos')).toBe(76_000);
    expect(total('repurchaseCogsPos')).toBe(76_000);
    expect(total('cogsRestockingPos')).toBe(76_000);
    expect(total('purchasesPos')).toBe(1);
    expect(rows.get('shop-pending').normalizedAdId).toBeNull();
    expect(rows.get(numericAdId).purchasesPos).toBe(0);
    expect(rows.get(importedAdId).purchasesPos).toBe(0);
  });

  it('moves an order between unique normalized attribution and synthetic fallback without stale rows', async () => {
    const meta = [insight(numericAdId, 10)];
    const { service, rows, total } = harness(meta,
      [order('order', `utm_source=meta&ad_id=${numericAdId}`, 100)],
    );
    await service.reconcileDay(tenantId, day);
    expect(rows.get(numericAdId).cogsPos).toBe(100);
    meta.push(insight(importedAdId, 20));
    await service.reconcileDay(tenantId, day);
    expect(rows.get(numericAdId).cogsPos).toBe(0);
    expect(rows.get('shop-order').cogsPos).toBe(100);
    expect(total('cogsPos')).toBe(100);
    meta.pop();
    await service.reconcileDay(tenantId, day);
    expect(rows.has('shop-order')).toBe(false);
    expect(rows.has(importedAdId)).toBe(false);
    expect(rows.get(numericAdId).cogsPos).toBe(100);
    expect(total('purchasesPos')).toBe(1);
  });

  it('handles nonnumeric identifiers safely without confusing object prototype keys with ads', async () => {
    const { service, total } = harness([insight('__proto__', 10)], [order('order', '__proto__', 100)]);
    await service.reconcileDay(tenantId, day);
    expect(total('purchasesPos')).toBe(1);
    expect(total('cogsPos')).toBe(100);
  });
});

describe('reconcile marketing insight mapping precedence', () => {
  const canonicalize = (value: string | null | undefined) => value?.trim().toLowerCase() || null;

  it('uses an explicit creative link before every inferred mapping', () => {
    expect(resolveInsightMappingForReconcile(
      { adName: 'ITEM_Static_SENTRA-I0065_Lyca', mapping: '0910' },
      'pv::store::variation',
      canonicalize,
    )).toBe('pv::store::variation');
  });

  it('uses the current static naming convention before an imported date suffix', () => {
    expect(resolveInsightMappingForReconcile(
      { adName: 'ITEM_Static_SENTRA-I0065_Lyca', mapping: '0910' },
      null,
      canonicalize,
    )).toBe('item');
  });

  it('preserves imported mappings for old naming conventions', () => {
    expect(resolveInsightMappingForReconcile(
      { adName: 'TaiSui_ThisCNY|Broad|BOF_Team2_1177_0124', mapping: 'tai sui' },
      null,
      canonicalize,
    )).toBe('tai sui');
  });
});
