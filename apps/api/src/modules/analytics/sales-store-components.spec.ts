import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { SalesAnalyticsService } from './sales-analytics.service';
import { AnalyticsRequestCoordinatorService } from './analytics-request-coordinator.service';

const tenantId = 'tenant-a';
const current = '2026-10-10';
const previous = '2026-10-09';
const teamA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const teamB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stores = [
  { id: 'store-a', shopId: 'shop-a', name: 'A', tenantId, status: 'ACTIVE', enabled: true },
  { id: 'store-b', shopId: 'shop-b', name: 'B', tenantId, status: 'ACTIVE', enabled: null },
  { id: 'inactive', shopId: 'shop-old', name: 'Old', tenantId, status: 'INACTIVE', enabled: true },
  { id: 'disabled', shopId: 'shop-disabled', name: 'Disabled', tenantId, status: 'ACTIVE', enabled: false },
  { id: 'foreign', shopId: 'shop-other', name: 'Foreign', tenantId: 'tenant-b', status: 'ACTIVE', enabled: true },
];

function matches(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((condition: any) => matches(row, condition));
    if (key === 'AND') return value.every((condition: any) => matches(row, condition));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value && !value.in.includes(row[key])) return false;
      if ('gt' in value && !(row[key] > value.gt)) return false;
      if ('gte' in value && !(row[key] >= value.gte)) return false;
      if ('lte' in value && !(row[key] <= value.lte)) return false;
      if ('not' in value && (row[key] === null || row[key] === value.not)) return false;
      if ('equals' in value && String(row[key]).toLowerCase() !== value.equals.toLowerCase()) return false;
      return true;
    }
    return row[key] === value;
  });
}

function fixture(options: { orders?: any[]; rows?: any[]; links?: any[]; extraStores?: any[]; coordinator?: AnalyticsRequestCoordinatorService } = {}) {
  const order = (id: string, shopId: string, status: number, cod: number, cogs: number, extra: any = {}) => ({
    id, posOrderId: id, tenantId, shopId, dateLocal: current, status, cod, cogs,
    isVoid: false, isRepurchase: false, isAbandoned: false, wasAbandonedCart: false,
    tracking: 'tracking-present', updatedAt: new Date('2026-10-11T01:00:00Z'), ...extra,
  });
  const orders = options.orders || [
    order('01', 'shop-a', 3, 1000, 100), order('02', 'shop-b', 3, 2000, 900),
    order('03', 'shop-a', 3, 300, 60, { isRepurchase: true }),
    order('04', 'shop-a', 6, 100, 20), order('05', 'shop-b', 11, 400, 80),
    order('06', 'shop-b', 4, 500, 70), order('07', 'shop-a', 0, 200, 30, { isAbandoned: true }),
    order('08', 'shop-a', 3, 90000, 80000, { isVoid: true }),
    order('09', 'shop-a', 7, 90000, 80000),
    order('10', 'shop-a', 3, 90000, 80000, { tenantId: 'tenant-b' }),
    order('11', 'shop-old', 3, 90000, 80000), order('12', 'shop-disabled', 3, 90000, 80000),
    order('13', 'shop-other', 3, 90000, 80000),
    order('14', 'shop-a', 3, 800, 80, { dateLocal: previous }),
    order('15', 'shop-b', 5, 400, 40, { dateLocal: previous }),
  ];
  const rows: any[] = options.rows || [
    { tenantId, date: new Date(current), adId: 'shared-ad', adName: '', mapping: 'one-label', shops: ['shop-b', 'shop-a'],
      spend: 150, leads: 30, codPos: 4500, cogsPos: 1260, updatedAt: new Date('2026-10-10T12:00:00Z') },
    { tenantId, date: new Date(previous), adId: 'shared-ad', adName: '', mapping: 'one-label', shops: ['shop-a', 'shop-b'], spend: 50, leads: 10 },
  ];
  const links = options.links || [{ adId: 'shared-ad', creative: { tenantId, storeConfig: { tenantId, storeId: 'store-a' } } }];
  const allStores: any[] = [...stores.map(store => ({ ...store })), ...(options.extraStores || [])];
  const allTeams = [{ id: teamA, tenantId, status: 'ACTIVE' }, { id: teamB, tenantId, status: 'ACTIVE' }];
  const queries: any[] = [];
  const sums = (values: any[], fields: any) => Object.fromEntries(Object.keys(fields).map(field => [field,
    values.reduce((sum, row) => sum + Number(row[field] || 0), 0)]));
  const prisma: any = {
    team: { findMany: jest.fn(async ({ where }: any) => allTeams.filter(row => matches(row, where))) },
    posStore: { findMany: jest.fn(async ({ where }: any) => allStores.filter(row => matches(row, where))) },
    posProduct: { findMany: async () => [] },
    creativeMetaAdLink: { findMany: async () => links }, creative: { findMany: async () => [] },
    creativeStoreConfig: { findMany: async () => [] },
    posOrder: {
      aggregate: async ({ where }: any) => ({ _sum: { cod: orders.filter(row => matches(row, where)).reduce((sum, row) => sum + Number(row.cod), 0) } }),
      count: async ({ where }: any) => orders.filter(row => matches(row, where)).length,
      findMany: jest.fn(async (args: any) => {
      queries.push(args);
      return orders.filter(row => matches(row, args.where)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, args.take);
    }) },
    reconcileSales: Object.fromEntries(['aggregate', 'findMany', 'count', 'groupBy'].map(method => [method,
      () => { throw new Error(`Lossy campaign read forbidden: ${method}`); }])),
    reconcileMarketing: {
      findMany: jest.fn(async ({ where, distinct }: any) => {
        const values = rows.filter(row => matches(row, where));
        return distinct ? [...new Set(values.map(row => row.mapping))].map(mapping => ({ mapping })) : values;
      }),
      count: async ({ where }: any) => rows.filter(row => matches(row, where)).length,
      aggregate: jest.fn(async ({ where, _sum, _max }: any) => _max ? { _max: { updatedAt: null } }
        : { _sum: sums(rows.filter(row => matches(row, where)), _sum) }),
      groupBy: jest.fn(async ({ where, _sum }: any) => {
        const values = rows.filter(row => matches(row, where));
        return [...new Set(values.map(row => row.mapping))].map(mapping => ({ mapping,
          _sum: sums(values.filter(row => row.mapping === mapping), _sum) }));
      }),
    },
    $queryRaw: async () => [], $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (operation: any, settings: any) => {
      expect(settings.isolationLevel).toBe('RepeatableRead');
      return operation(prisma);
    }),
  };
  const entries = new Map<string, any>();
  const payloads: any[] = [];
  const requestKeys: string[] = [];
  const legacyKeys = new Set<string>();
  const hash = (payload: any) => createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const cache = {
    getVersion: async () => 1,
    hashObject: (payload: any) => {
      payloads.push(payload);
      if (payload.responseShapeVersion === 9 || payload.responseShapeVersion === 3) {
        const { sourceRevision: _source, readConsistency: _consistency, activeStores: _stores, ...old } = payload;
        old.responseShapeVersion = payload.responseShapeVersion === 9 ? 8 : 2;
        const namespace = payload.responseShapeVersion === 9 ? 'sales' : 'sales-stores';
        const key = `analytics:${tenantId}:1:${namespace}:${hash(old)}`;
        legacyKeys.add(key);
        entries.set(key, { kpis: { cogs: 999999 } });
      }
      return hash(payload);
    },
    get: async (key: string) => { requestKeys.push(key); return entries.get(key); },
    set: async (key: string, value: any) => { entries.set(key, value); },
  };
  const service = new SalesAnalyticsService(prisma, { getTenantId: () => tenantId,
    buildTenantWhereClause: (where: any) => ({ ...where, tenantId }) } as any, cache as any,
  (options.coordinator || { run: async (_tenant: string, _key: string, operation: any) => operation() }) as any, {} as any, {} as any, {} as any);
  return { service, prisma, queries, entries, payloads, requestKeys, legacyKeys, allStores, allTeams, orders, rows };
}

const params = { startDate: current, endDate: current };

describe('Exact Store POS components with independent ad ownership', () => {
  it('keeps asymmetric actual-shop revenue/COGS while one explicitly owned ad receives all its spend once', async () => {
    const f = fixture();
    const response = await f.service.getStoreOverview(params);
    const a = response.products.find(row => row.store_id === 'store-a')!;
    const b = response.products.find(row => row.store_id === 'store-b')!;
    expect([a.revenue, a.cogs_raw, a.cogs, a.ad_spend]).toEqual([1000, 150, 100, 150]);
    expect([b.revenue, b.cogs_raw, b.cogs, b.ad_spend]).toEqual([2000, 1050, 900, 0]);
    expect(response.kpis.revenue).toBe(3000);
    expect(response.kpis.cogs).toBe(1200); // raw non-repeat; lifecycle components stay explicit
    expect(response.kpis.cogs_canceled).toBe(20);
    expect(response.kpis.cogs_restocking).toBe(80);
    expect(response.prevKpis.revenue).toBe(800);
    expect(response.prevKpis.cogs).toBe(120);
    expect(response.coverage.basis).toBe('SAVED_ERP_POS_ORDER_COMPONENTS');
    expect(response.coverage.hasCanonicalDifferences).toBe(true);
    expect(response.coverage.canonicalMinusSource.current.cogsPos).toBeUndefined();
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const query = f.queries[0];
    expect(query.where).toMatchObject({ tenantId, shopId: { in: ['shop-a', 'shop-b'] }, dateLocal: { gte: previous, lte: current } });
    expect(query.select).not.toHaveProperty('orderSnapshot');
    expect(query.select).not.toHaveProperty('customer');
    expect(query.take).toBe(2000);
    expect(response.lastUpdatedAt).toEqual(new Date('2026-10-11T01:00:00Z'));
  });

  it.each([true, false])('selects a real shop consistently across periods and repurchase=%s', async excludeRepurchase => {
    const f = fixture();
    const response = await f.service.getStoreOverview({ ...params, mappings: ['store-a'], excludeRepurchase });
    expect(response.products.map(row => row.store_id)).toEqual(['store-a']);
    expect(response.kpis.revenue).toBe(excludeRepurchase ? 1000 : 1300);
    expect(response.kpis.cogs).toBe(excludeRepurchase ? 150 : 210);
    expect(response.prevKpis.revenue).toBe(800);
    expect(response.kpis.processed).toBe(excludeRepurchase ? 1000 : 1300);
    expect(response.kpis.cancellation_rate_pct).toBeCloseTo(excludeRepurchase ? 100 / 3 : 25, 8);
  });

  it.each([true, false])('retains canceled/restocking/RTS/abandoned semantics when exclusion=%s', async exclude => {
    const f = fixture();
    const response = await f.service.getStoreOverview({ ...params, excludeCancel: exclude, excludeRestocking: exclude,
      excludeAbandoned: exclude, excludeRts: exclude, excludeRepurchase: false });
    expect(response.kpis.revenue).toBe(exclude ? 3300 : 4500);
    const sourceCogs = response.products.reduce((sum, row) => sum + row.cogs, 0);
    expect(sourceCogs).toBe(exclude ? 1060 : 1260);
    expect(response.counts.delivered).toBe(3);
    expect(response.counts.undelivered).toBe(1);
  });

  it('keeps duplicate active shop ownership once in Unattributed instead of silently choosing either store', async () => {
    const f = fixture({ extraStores: [{ ...stores[0], id: 'duplicate-store', name: 'Duplicate' }] });
    const response = await f.service.getStoreOverview(params);
    const unknown = response.products.find(row => row.store_id === null)!;
    expect(unknown.cogs_raw).toBe(150);
    expect(unknown.revenue).toBe(1000);
    expect(response.kpis.cogs).toBe(1200);
    expect(response.coverage.ambiguousShopCount).toBe(1);
    expect(response.coverage.ambiguousOrderCount).toBe(7); // includes explicit excluded tombstones as evidence
    expect(response.products.find(row => row.store_id === 'store-a')!.cogs_raw).toBe(0);
  });

  it('does not infer a spend split from two shops, and is invariant to their ordering', async () => {
    const left = fixture({ links: [] });
    const right = fixture({ links: [] });
    right.rows.forEach(row => row.shops.reverse());
    const [a, b] = await Promise.all([left.service.getStoreOverview(params), right.service.getStoreOverview(params)]);
    expect(a.products).toEqual(b.products);
    expect(a.products.find(row => row.store_id === null)!.ad_spend).toBe(150);
    expect(a.coverage.unattributedAdSpend).toBe(150);
    expect(a.products.filter(row => row.store_id !== null).reduce((sum, row) => sum + row.cogs_raw, 0)).toBe(1200);
    expect(a.coverage.previousUnattributedAdSpend).toBe(50);
  });

  it('refuses an explicit link whose creative belongs to another tenant', async () => {
    const f = fixture({ links: [{ adId: 'shared-ad', creative: { tenantId: 'other-tenant',
      storeConfig: { tenantId, storeId: 'store-a' } } }] });
    const response = await f.service.getStoreOverview(params);
    expect(response.coverage.unattributedAdSpend).toBe(150);
    expect(response.products.find(row => row.store_id === 'store-a')!.ad_spend).toBe(0);
  });

  it('exposes signed fee residuals without assigning rounding cents or stale stored COGS to a shop', async () => {
    const base = { tenantId, shopId: 'shop-a', dateLocal: current, status: 3, isVoid: false,
      isRepurchase: false, isAbandoned: false, wasAbandonedCart: false, tracking: null, cogs: 0 };
    const f = fixture({ orders: [
      { ...base, id: '01', posOrderId: '01', cod: 0.25 },
      { ...base, id: '02', posOrderId: '02', cod: 0.25 },
    ], rows: [{ tenantId, date: new Date(current), adId: 'shared-ad', shops: ['shop-a'], spend: 0,
      codFeePos: 0.02, codFeeDeliveredPos: 0.02, cogsPos: 999 }] });
    const response = await f.service.getStoreOverview(params);
    expect(response.kpis.cod_fee).toBe(0.01);
    expect(response.kpis.cogs).toBe(0);
    expect(response.coverage.canonicalMinusSource.current.codFeePos).toBe(0.01);
    expect(response.coverage.canonicalMinusSource.current.cogsPos).toBe(999);
  });

  it('pages only scalar fields and preserves totals through the cursor boundary', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ id: String(i).padStart(5, '0'), posOrderId: String(i),
      tenantId, shopId: 'shop-a', dateLocal: current, status: 3, cod: 10, cogs: 2, isVoid: false, isRepurchase: false }));
    const f = fixture({ orders: rows, rows: [] });
    const response = await f.service.getStoreOverview(params);
    expect(response.kpis.revenue).toBe(20010);
    expect(response.kpis.cogs).toBe(4002);
    expect(f.queries).toHaveLength(2);
    expect(f.queries[1].where.id).toEqual({ gt: '01999' });
  });

  it('versions the input basis and avoids cached former-active store population', async () => {
    const f = fixture();
    const first = await f.service.getStoreOverview(params);
    expect(await f.service.getStoreOverview(params)).toBe(first);
    expect(f.payloads.find(payload => payload.responseShapeVersion === 3)).toMatchObject({ sourceRevision: 'EXACT_SHOP_POS_COMPONENTS_V1' });
    expect(f.requestKeys.every(key => !f.legacyKeys.has(key))).toBe(true);
    f.allStores.find(store => store.id === 'store-b')!.enabled = false;
    const revised = await f.service.getStoreOverview(params);
    expect(revised.products.some(row => row.store_id === 'store-b')).toBe(false);
    expect(f.requestKeys[0]).not.toBe(f.requestKeys[f.requestKeys.length - 1]);
  });

  it('uses the recorded order/ad team after a store moves, and includes unassigned records only in All', async () => {
    const base = { tenantId, shopId: 'shop-a', dateLocal: current, status: 3, isVoid: false, isRepurchase: false,
      isAbandoned: false, wasAbandonedCart: false, updatedAt: new Date('2026-10-11T01:00:00Z') };
    const f = fixture({ orders: [
      { ...base, id: '01', posOrderId: '01', teamId: teamA, cod: 1000, cogs: 100 },
      { ...base, id: '02', posOrderId: '02', teamId: teamB, cod: 700, cogs: 70 },
      { ...base, id: '03', posOrderId: '03', teamId: null, cod: 300, cogs: 30 },
    ], rows: [{ tenantId, teamId: teamA, date: new Date(current), adId: 'shared-ad', mapping: 'old-team-ad',
      shops: ['shop-a'], spend: 50, purchasesPos: 1, codPos: 1000, cogsPos: 100, deliveredCount: 1,
      deliveredCodPos: 1000, cogsDeliveredPos: 100 }] });
    f.allStores.find(store => store.id === 'store-a')!.teamId = teamB;
    const a = await f.service.getStoreOverview({ ...params, teamIds: [teamA] });
    expect(a.products.find(row => row.store_id === 'store-a')).toMatchObject({ revenue: 1000, cogs: 100, ad_spend: 50 });
    expect(a.kpis.revenue).toBe(1000);
    expect(f.queries[0].where.teamId).toEqual({ in: [teamA] });
    expect(a.coverage.comparisonScope).toBe('SELECTED_TEAM_RECORDS_CURRENT_AND_PREVIOUS');
    const b = await f.service.getStoreOverview({ ...params, teamIds: [teamB] });
    expect(b.kpis.revenue).toBe(700);
    expect(b.kpis.ad_spend).toBe(0);
    expect((await f.service.getStoreOverview(params)).kpis.revenue).toBe(2000);
    const product = await f.service.getOverview({ ...params, teamIds: [teamA] });
    expect(product.kpis.revenue).toBe(1000);
    expect(product.kpis.processed).toBe(1000);
    expect(product.products[0].mapping).toBe('old-team-ad');
  });

  it('keeps a conflicting other-team shop as a negative ownership witness', async () => {
    const f = fixture({ extraStores: [{ ...stores[0], id: 'duplicate-store', teamId: teamB }] });
    f.orders.forEach(order => { order.teamId = teamA; });
    f.rows.forEach(row => { row.teamId = teamA; });
    const response = await f.service.getStoreOverview({ ...params, teamIds: [teamA] });
    expect(response.coverage.ambiguousShopCount).toBe(1);
    expect(response.products.find(row => row.store_id === null)!.revenue).toBe(1000);
    expect(response.products.find(row => row.store_id === 'store-a')!.revenue).toBe(0);
  });

  it.each(['getOverview', 'getStoreOverview'])('%s validates active tenant teams even if a previously valid scope is cached', async method => {
    const f = fixture();
    await (f.service as any)[method]({ ...params, teamIds: [teamA] });
    f.allTeams[0].status = 'INACTIVE';
    await expect((f.service as any)[method]({ ...params, teamIds: [teamA] })).rejects.toThrow('Selected teams must be active teams in this tenant.');
    await expect((f.service as any)[method]({ ...params, teamIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'] })).rejects.toThrow('Selected teams must be active teams in this tenant.');
    await expect((f.service as any)[method]({ ...params, teamIds: ['not-a-uuid'] })).rejects.toThrow('Select valid tenant teams.');
  });

  it('coalesces identical Store requests and bounds different selections through the existing tenant coordinator', async () => {
    const coordinator = new AnalyticsRequestCoordinatorService();
    (coordinator as any).maxConcurrentPerTenant = 1;
    const f = fixture({ coordinator });
    const original = f.prisma.$transaction;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const firstEntered = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0, active = 0, maxActive = 0;
    f.prisma.$transaction = async (...args: any[]) => {
      calls++; active++; maxActive = Math.max(maxActive, active);
      try { entered(); await blocked; return await original(...args); }
      finally { active--; }
    };
    const first = f.service.getStoreOverview({ ...params, mappings: ['STORE-A'] });
    const same = f.service.getStoreOverview({ ...params, mappings: ['store-a'] });
    const distinct = f.service.getStoreOverview({ ...params, mappings: ['store-b'] });
    await firstEntered;
    try { expect(calls).toBe(1); } finally { release(); }
    const [a, duplicate, b] = await Promise.all([first, same, distinct]);
    expect(a).toBe(duplicate);
    expect(a.products.map(row => row.store_id)).toEqual(['store-a']);
    expect(b.products.map(row => row.store_id)).toEqual(['store-b']);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });
});

describe('Product mapping reporting reads per-ad evidence, not lossy campaign rows', () => {
  const ad = (date: string, mapping: string, cod: number, cost: number, spend: number) => ({ tenantId,
    date: new Date(date), campaignId: 'one-campaign', adId: `${date}-${mapping}`, mapping,
    codPos: cod, cogsPos: cost, deliveredCodPos: cod, cogsDeliveredPos: cost,
    purchasesPos: 1, deliveredCount: 1, spend, leads: 10, shops: ['shop-a'] });
  const rows = [ad(current, 'mapping-a', 1000, 100, 50), ad(current, 'mapping-b', 2000, 900, 150),
    ad(previous, 'mapping-a', 800, 80, 40), ad(previous, 'mapping-b', 500, 250, 25),
    { ...ad(current, 'mapping-a', 90000, 80000, 9000), tenantId: 'other-tenant' },
    ad('2026-10-08', 'mapping-a', 22222, 1111, 1000), ad('2026-10-11', 'mapping-b', 33333, 2222, 1000)];

  it('keeps two mappings in one campaign distinct and conserves current/previous additive totals', async () => {
    const f = fixture({ rows });
    const response = await f.service.getOverview(params);
    expect(response.products.map(row => [row.mapping, row.revenue, row.cogs_raw, row.ad_spend])).toEqual([
      ['mapping-a', 1000, 100, 50], ['mapping-b', 2000, 900, 150],
    ]);
    expect([response.kpis.revenue, response.kpis.cogs, response.kpis.ad_spend]).toEqual([3000, 1000, 200]);
    expect([response.prevKpis.revenue, response.prevKpis.cogs, response.prevKpis.ad_spend]).toEqual([1300, 330, 65]);
    expect(response.products.reduce((sum, row) => sum + row.revenue, 0)).toBe(response.kpis.revenue);
    expect(response.products.reduce((sum, row) => sum + row.net_margin, 0)).toBe(response.kpis.net_margin);
    expect(f.payloads.some(payload => payload.responseShapeVersion === 9 && payload.sourceRevision === 'PER_AD_MAPPING_V1')).toBe(true);
  });

  it('applies the selected mapping to both periods and cannot reuse the former campaign cache', async () => {
    const f = fixture({ rows });
    const selected = { ...params, mappings: ['mapping-b'] };
    const response = await f.service.getOverview(selected);
    expect(response.products.map(row => row.mapping)).toEqual(['mapping-b']);
    expect([response.kpis.revenue, response.kpis.cogs, response.prevKpis.revenue, response.prevKpis.cogs]).toEqual([2000, 900, 500, 250]);
    expect(f.payloads[0].sourceRevision).toBe('PER_AD_MAPPING_V1');
    expect(f.requestKeys.every(key => !f.legacyKeys.has(key))).toBe(true);
    expect(await f.service.getOverview(selected)).toBe(response);
  });

  it('uses one read-only snapshot for marketing groups, direct POS projections and raw movement SQL despite an intervening commit', async () => {
    const sourceOrders = [
      { id: '01', posOrderId: '01', tenantId, shopId: 'shop-a', dateLocal: current, mapping: 'mapping-a', status: 3, cod: 1000, cogs: 100, isVoid: false, isRepurchase: false },
      { id: '02', posOrderId: '02', tenantId, shopId: 'shop-b', dateLocal: current, mapping: 'mapping-b', status: 3, cod: 2000, cogs: 900, isVoid: false, isRepurchase: false },
      { id: '03', posOrderId: '03', tenantId, shopId: 'shop-a', dateLocal: previous, mapping: 'mapping-a', status: 3, cod: 800, cogs: 80, isVoid: false, isRepurchase: false },
    ];
    const live = fixture({ rows: structuredClone(rows), orders: sourceOrders });
    let changed = false, readOnly = false;
    const trace: string[] = [];
    live.prisma.$transaction = async (operation: any, settings: any) => {
      expect(settings).toMatchObject({ isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 60000 });
      const frozen = fixture({ rows: structuredClone(live.rows), orders: structuredClone(live.orders) });
      const tx = frozen.prisma;
      tx.$executeRaw = async (sql: TemplateStringsArray) => {
        expect(sql.join('')).toBe('SET TRANSACTION READ ONLY');
        trace.push('READ_ONLY'); readOnly = true; return 0;
      };
      for (const model of ['posStore', 'posProduct', 'posOrder', 'reconcileMarketing']) {
        for (const [name, operation] of Object.entries(tx[model]) as Array<[string, any]>) {
          tx[model][name] = (...args: any[]) => {
            expect(readOnly).toBe(true); trace.push(`${model}.${name}`);
            const pending = operation(...args);
            if (model === 'reconcileMarketing' && name === 'aggregate' && !changed) {
              // Model an independently committed ingestion/reconcile between
              // the KPI query and subsequent group/direct-order queries.
              changed = true; live.rows[0].cogsPos = 777;
              live.orders[0].cod = 9000; trace.push('OTHER_TRANSACTION_COMMITTED');
            }
            return pending;
          };
        }
      }
      tx.$queryRaw = async () => {
        expect(readOnly).toBe(true); trace.push('movementSQL');
        return [{ date: current, shipped: 1, delivered: 0, rts: 0 }];
      };
      return operation(tx);
    };
    // Any direct read outside the transaction is a regression, even if its
    // result would happen to match this fixture on one particular schedule.
    for (const model of ['posStore', 'posProduct', 'posOrder', 'reconcileMarketing']) {
      for (const name of Object.keys(live.prisma[model])) live.prisma[model][name] = () => { throw new Error(`OUTSIDE_SNAPSHOT:${model}.${name}`); };
    }
    live.prisma.$queryRaw = () => { throw new Error('OUTSIDE_SNAPSHOT:movementSQL'); };
    const result = await live.service.getOverview(params);
    expect(changed).toBe(true);
    expect(trace[0]).toBe('READ_ONLY');
    expect(trace.indexOf('OTHER_TRANSACTION_COMMITTED')).toBeLessThan(trace.indexOf('posOrder.aggregate'));
    expect(trace).toContain('movementSQL');
    expect(result.kpis.cogs).toBe(1000);
    expect(result.products.map(row => row.cogs_raw)).toEqual([100, 900]);
    expect(result.kpis.processed).toBe(3000);
    expect(result.prevKpis.processed).toBe(800);
    expect(result.volumeGrowthTrend[0].shipped).toBe(1);
  });
});
