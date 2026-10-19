import { describe, expect, it } from '@jest/globals';
import { SalesAnalyticsService } from './sales-analytics.service';
import { createHash } from 'node:crypto';

type Order = { status: number; cod: number; cogs: number; repurchase?: boolean; abandoned?: boolean; tracking?: boolean };
type Options = {
  excludeRepurchase: boolean; excludeCancel: boolean; excludeRestocking: boolean;
  excludeAbandoned: boolean; excludeRts: boolean; includeTax12: boolean; includeTax1: boolean;
  rtsForecastPct?: number;
};

const defaults: Options = {
  excludeRepurchase: true, excludeCancel: true, excludeRestocking: true,
  excludeAbandoned: true, excludeRts: true, includeTax12: false, includeTax1: false,
};

// Each lifecycle has both a new-customer and repeat order. This deliberately
// includes repeat cancellations/restocking/RTS, which must not be removed twice.
const orders: Order[] = [
  { status: 3, cod: 1000, cogs: 300, tracking: true },
  { status: 3, cod: 600, cogs: 180, tracking: true, repurchase: true },
  { status: 6, cod: 400, cogs: 120 },
  { status: 6, cod: 200, cogs: 60, repurchase: true },
  { status: 11, cod: 500, cogs: 150 },
  { status: 11, cod: 300, cogs: 90, repurchase: true },
  { status: 4, cod: 700, cogs: 210, tracking: true },
  { status: 5, cod: 350, cogs: 105, tracking: true, repurchase: true },
  { status: 2, cod: 800, cogs: 240, tracking: true },
  { status: 2, cod: 450, cogs: 135, tracking: true, repurchase: true },
  { status: 0, cod: 250, cogs: 75, abandoned: true },
  { status: 0, cod: 125, cogs: 37.5, abandoned: true, repurchase: true },
];

const total = (rows: Order[], field: 'cod' | 'cogs') => rows.reduce((sum, row) => sum + row[field], 0);
const rts = (row: Order) => row.status === 4 || row.status === 5;

// Build the same persisted aggregate contract from independent order fixtures;
// no Prisma, Redis, source cost inference or warehouse service runs in this spec.
function aggregateRows(rows: Order[]) {
  const sums: Record<string, number> = {
    purchasesPos: rows.length, codPos: total(rows, 'cod'), cogsPos: total(rows, 'cogs'),
    processedPurchasesPos: rows.filter(row => row.tracking).length, leads: 100,
  };
  for (const [name, predicate] of [
    ['delivered', (row: Order) => row.status === 3],
    ['shipped', (row: Order) => row.status === 2],
    ['canceled', (row: Order) => row.status === 6],
    ['restocking', (row: Order) => row.status === 11],
    ['rts', rts],
    ['currentAbandoned', (row: Order) => !!row.abandoned],
  ] as const) {
    const matching = rows.filter(predicate);
    sums[`${name}Count`] = matching.length;
    sums[`${name}CodPos`] = total(matching, 'cod');
    sums[`cogs${name[0].toUpperCase()}${name.slice(1)}Pos`] = total(matching, 'cogs');
  }
  const nonCanceled = rows.filter(row => row.status !== 6);
  const shippedDeliveredRts = rows.filter(row => row.status === 2 || row.status === 3 || rts(row));
  for (const [name, rate] of [['sf', 60], ['ff', 25], ['if', 5]] as const) {
    sums[`${name}Pos`] = nonCanceled.length * rate;
    sums[`${name}SdrPos`] = shippedDeliveredRts.length * rate;
  }
  sums.codFeePos = total(rows.filter(row => row.status !== 6 && !rts(row)), 'cod') * 0.0224;
  sums.codFeeDeliveredPos = total(rows.filter(row => row.status === 3), 'cod') * 0.0224;
  return sums;
}

function persistedAggregate(rows: Order[], spend: number, mapping = 'product-a') {
  const sums = aggregateRows(rows);
  for (const [field, value] of Object.entries(aggregateRows(rows.filter(row => row.repurchase)))) {
    const key = field === 'purchasesPos' ? 'repurchaseCount'
      : `repurchase${field[0].toUpperCase()}${field.slice(1)}`;
    sums[key] = value;
  }
  return { mapping, _sum: { ...sums, spend } };
}

function calculator() {
  const service = new SalesAnalyticsService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return service as any;
}

describe('Sales analytics product/KPI reporting basis', () => {
  it('excludes repeat delivered revenue together with its costs, rather than keeping a phantom profit', () => {
    const service = calculator();
    const input = persistedAggregate(orders, 200);
    // New-customer delivered 1000 − COGS300 − SDR fees270 − COD22.40 − ads200.
    expect(service.computeProductRow(input, defaults).net_margin).toBeCloseTo(207.6, 8);
    expect(service.computeKpis(input, defaults).net_margin).toBeCloseTo(207.6, 8);
    // Including repeats: delivered1600 − COGS480 − SDR540 − COD35.84 − ads200.
    expect(service.computeProductRow(input, { ...defaults, excludeRepurchase: false }).net_margin).toBeCloseTo(344.16, 8);
  });

  const flagCases = [true, false].flatMap(excludeRepurchase => [true, false].flatMap(excludeCancel =>
    [true, false].flatMap(excludeRestocking => [true, false].map(excludeRts => ({
      excludeRepurchase, excludeCancel, excludeRestocking, excludeRts,
    })))));

  it.each(flagCases)('keeps additive money and component populations coherent for %j', flags => {
    const service = calculator();
    const options = { ...defaults, ...flags };
    const input = persistedAggregate(orders, 200);
    const product = service.computeProductRow(input, options);
    const kpis = service.computeKpis(input, options);
    const basis = orders.filter(row => !options.excludeRepurchase || !row.repurchase);
    const canceled = basis.filter(row => row.status === 6);
    const restocking = basis.filter(row => row.status === 11);
    const goodsBasis = basis.filter(row => !(options.excludeCancel && row.status === 6)
      && !(options.excludeRestocking && row.status === 11));
    const revenueBasis = goodsBasis.filter(row => !row.abandoned && !(options.excludeRts && rts(row)));

    expect(product.revenue).toBe(total(revenueBasis, 'cod'));
    expect(product.cogs).toBe(total(goodsBasis, 'cogs'));
    expect(product.cogs_raw).toBe(total(basis, 'cogs'));
    expect(product.cogs_canceled).toBe(total(canceled, 'cogs'));
    expect(product.cogs_ec).toBe(total(basis.filter(row => row.status !== 6), 'cogs'));
    expect(product.cogs_restocking).toBe(total(restocking, 'cogs'));
    expect(product.canceled_cod).toBe(total(canceled, 'cod'));
    expect(product.restocking_cod).toBe(total(restocking, 'cod'));
    expect(product.rts_cod).toBe(total(basis.filter(rts), 'cod'));
    expect(product.abandoned_cod).toBe(total(basis.filter(row => row.abandoned), 'cod'));
    expect(kpis.cogs_canceled).toBe(product.cogs_canceled);
    expect(kpis.cogs_restocking).toBe(product.cogs_restocking);
    expect(kpis.cogs - (options.excludeCancel ? kpis.cogs_canceled : 0)
      - (options.excludeRestocking ? kpis.cogs_restocking : 0)).toBe(product.cogs);

    const products = [
      service.computeProductRow(persistedAggregate(orders.filter(row => !row.repurchase), 120, 'new'), options),
      service.computeProductRow(persistedAggregate(orders.filter(row => row.repurchase), 80, 'repeat'), options),
    ];
    for (const key of ['revenue', 'ad_spend', 'contribution_margin', 'net_margin', 'cm_rts_forecast']) {
      expect(products.reduce((sum, row) => sum + row[key], 0)).toBeCloseTo(kpis[key], 8);
      expect(product[key]).toBeCloseTo(kpis[key], 8);
    }
    expect(products.reduce((sum, row) => sum + row.cogs_raw, 0)).toBe(kpis.cogs);

    // A scenario includes RTS value before applying its forecast percentage,
    // but never includes repeat RTS when repeats have been excluded.
    const forecastRevenue = total(goodsBasis.filter(row => !row.abandoned), 'cod');
    const fees = basis.filter(row => row.status !== 6).length * 90;
    const deliveredCodFee = total(basis.filter(row => row.status === 3), 'cod') * 0.0224;
    const expectedForecast = forecastRevenue * 0.8 - 200 - fees - deliveredCodFee
      - total(goodsBasis, 'cogs') + total(basis.filter(rts), 'cogs');
    expect(kpis.cm_rts_forecast).toBeCloseTo(expectedForecast, 8);
  });

  it('does not let the live RTS-exclusion toggle reintroduce repeat RTS into the scenario', () => {
    const service = calculator();
    const input = persistedAggregate(orders, 200);
    // Forecast: 80%×2500 − ads200 − fees450 − deliveredCODfee22.40 − COGS825 + RTS210.
    expect(service.computeKpis(input, defaults).cm_rts_forecast).toBeCloseTo(712.6, 8);
    expect(service.computeProductRow(input, defaults).cm_rts_forecast).toBeCloseTo(712.6, 8);
    expect(service.computeKpis(input, { ...defaults, excludeRts: false }).cm_rts_forecast).toBeCloseTo(712.6, 8);
  });

  it('retains entered ERP costs without inferring a higher cost from the sales amount', () => {
    const service = calculator();
    const input = persistedAggregate([
      { status: 3, cod: 1_200_000, cogs: 45_000, tracking: true },
      { status: 3, cod: 800_000, cogs: 31_000, tracking: true },
    ], 100_000);
    const kpis = service.computeKpis(input, defaults);
    const product = service.computeProductRow(input, defaults);
    expect(kpis.revenue).toBe(2_000_000);
    expect(kpis.cogs).toBe(76_000);
    expect(product.cogs).toBe(76_000);
    expect(product.net_margin).toBeCloseTo(1_779_020, 8);
    expect(product.net_margin).toBe(kpis.net_margin);
  });
});

// Exercise the public response paths, including their Prisma projections and
// cache lookup. Rows that differ only in isVoid make a missing source filter
// change the observed amounts/rates rather than merely fail a shape assertion.
function responseFixture() {
  const tenantId = 'tenant-a';
  const shopId = 'shop-a';
  const storeId = 'store-a';
  const posRows: any[] = [];
  const add = (dateLocal: string, status: number | null, cod: number, extra: Record<string, any> = {}) =>
    posRows.push({ tenantId, shopId, mapping: 'product-a', dateLocal, status, cod, isVoid: false, isRepurchase: false, ...extra });
  for (const status of [1, 2, 3, 9, 12, 13]) add('2026-10-10', status, status * 10);
  for (const [status, cod] of [[6, 60], [4, 40], [5, 50], [11, 110], [0, 5], [null, 5], [7, 70]] as const)
    add('2026-10-10', status, cod);
  for (const status of [1, 2, 3, 9, 12, 13, 6, 4, 5, null]) add('2026-10-10', status, 9000, { isVoid: true });
  add('2026-10-10', 3, 7, { isRepurchase: true });
  add('2026-10-10', 6, 8, { isRepurchase: true });
  add('2026-10-10', 4, 9, { isRepurchase: true });
  for (const status of [1, 3, 6, 5, 7]) add('2026-10-09', status, status * 10);
  for (const status of [3, 6, 4, 5]) add('2026-10-09', status, 9000, { isVoid: true });
  add('2026-10-09', 3, 7, { isRepurchase: true });
  add('2026-10-09', 6, 8, { isRepurchase: true });
  for (const date of ['2026-10-09', '2026-10-10']) for (const status of [3, 6]) {
    add(date, status, 90000, { tenantId: 'other-tenant' });
    add(date, status, 90000, { shopId: 'other-shop' });
  }

  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    if (value && typeof value === 'object') {
      if ('in' in value && !value.in.includes(row[key])) return false;
      if ('not' in value && (row[key] === null || row[key] === value.not)) return false;
      if ('gte' in value && row[key] < value.gte) return false;
      if ('lte' in value && row[key] > value.lte) return false;
      if ('equals' in value && String(row[key]).toLowerCase() !== value.equals.toLowerCase()) return false;
      return true;
    }
    return row[key] === value;
  });
  const projections: Array<{ kind: string; where: any }> = [];
  const sums = persistedAggregate(orders, 200)._sum;
  let aggregateQueries = 0;
  const prisma = {
    posStore: { findMany: async () => [{ id: storeId, shopId, name: 'Fixture Store' }] },
    posProduct: { findMany: async () => [] },
    posOrder: {
      aggregate: async ({ where }: any) => {
        projections.push({ kind: 'sum', where });
        return { _sum: { cod: posRows.filter(row => matches(row, where)).reduce((sum, row) => sum + row.cod, 0) } };
      },
      count: async ({ where }: any) => { projections.push({ kind: 'count', where }); return posRows.filter(row => matches(row, where)).length; },
    },
    reconcileSales: {
      aggregate: async (args: any) => { aggregateQueries++; return args._max ? { _max: { updatedAt: null } } : { _sum: sums }; },
      findMany: async () => [], count: async () => 0,
      groupBy: async () => [{ mapping: 'product-a', _sum: sums }],
    },
    reconcileMarketing: { findMany: async () => {
      aggregateQueries++;
      return ['2026-10-09', '2026-10-10'].map(date => ({ ...sums, adId: 'ad-a', shops: [shopId], date: new Date(`${date}T00:00:00Z`), mapping: 'product-a' }));
    } },
    $queryRaw: async () => [],
  };
  const hash = (value: any) => createHash('md5').update(JSON.stringify(value)).digest('hex').slice(0, 12);
  const entries = new Map<string, any>();
  const legacyKeys = new Set<string>();
  const requestedCacheKeys: string[] = [];
  const cache = {
    getVersion: async () => 3,
    hashObject: (payload: any) => {
      if (payload.responseShapeVersion !== undefined) {
        // Seed the exact old payload hash with a realistic pre-deploy response.
        // Without the calculation revision the new request would return it.
        const { calculationVersion: _revision, ...legacy } = payload;
        const namespace = payload.analyticsScope ? 'sales' : 'sales-stores';
        const key = `analytics:${tenantId}:3:${namespace}:${hash(legacy)}`;
        legacyKeys.add(key);
        entries.set(key, { kpis: { processed: 999999 }, products: [{ net_margin: 999999 }] });
      }
      return hash(payload);
    },
    get: async (key: string) => { requestedCacheKeys.push(key); return entries.get(key) ?? null; },
    set: async (key: string, value: any) => { entries.set(key, value); },
  };
  const service = new SalesAnalyticsService(prisma as any, {
    getTenantId: () => tenantId,
    buildTenantWhereClause: (where: any) => ({ ...where, tenantId }),
  } as any, cache as any, { run: async (_tenant: string, _key: string, operation: () => Promise<any>) => operation() } as any,
  {} as any, {} as any, {} as any);
  return { service, projections, legacyKeys, requestedCacheKeys, aggregateQueries: () => aggregateQueries, storeId };
}

describe('Sales analytics response source scopes and calculation cache revision', () => {
  it.each(['product', 'store'] as const)('excludes void source rows in current/previous %s projections while preserving status and repeat policies', async dimension => {
    for (const excludeRepurchase of [true, false]) {
      const fixture = responseFixture();
      const params = { startDate: '2026-10-10', endDate: '2026-10-10', excludeRepurchase,
        mappings: [dimension === 'store' ? fixture.storeId : 'product-a'] };
      const response = dimension === 'store' ? await fixture.service.getStoreOverview(params) : await fixture.service.getOverview(params);
      expect(response.kpis.processed).toBe(excludeRepurchase ? 400 : 407);
      expect(response.prevKpis.processed).toBe(excludeRepurchase ? 40 : 47);
      expect(response.kpis.cancellation_rate_pct).toBeCloseTo(excludeRepurchase ? 100 / 12 : 200 / 15, 8);
      expect(response.prevKpis.cancellation_rate_pct).toBeCloseTo(excludeRepurchase ? 25 : 100 / 3, 8);
      expect(response.counts.undelivered).toBe(excludeRepurchase ? 1 : 2);
      expect(response.counts.returned).toBe(1);
      expect(response.prevCounts.undelivered).toBe(0);
      expect(response.prevCounts.returned).toBe(1);
      expect(fixture.projections).toHaveLength(10);
      for (const { kind, where } of fixture.projections) {
        expect(where.isVoid).toBe(false);
        expect(where.tenantId).toBe('tenant-a');
        expect(where.shopId).toEqual({ in: ['shop-a'] });
        expect(where.isRepurchase).toBe(excludeRepurchase ? false : undefined);
        if (kind === 'sum') expect(where.status.in).toEqual([1, 2, 3, 9, 12, 13]);
      }
    }
  });

  it.each(['product', 'store'] as const)('bypasses old %s cache responses, computes corrected components, then reuses the revised cache', async dimension => {
    const fixture = responseFixture();
    const params = { startDate: '2026-10-10', endDate: '2026-10-10', mappings: [dimension === 'store' ? fixture.storeId : 'product-a'] };
    const read = () => dimension === 'store' ? fixture.service.getStoreOverview(params) : fixture.service.getOverview(params);
    const response = await read();
    expect(fixture.legacyKeys.size).toBe(1);
    expect(fixture.requestedCacheKeys.every(key => !fixture.legacyKeys.has(key))).toBe(true);
    expect(response.products[0].net_margin).toBeCloseTo(207.6, 8);
    expect(response.products[0].cogs_raw).toBe(1095);
    expect(response.products[0].cogs_canceled).toBe(120);
    expect(response.products[0].abandoned_cod).toBe(250);
    expect(response.products[0].cm_rts_forecast).toBeCloseTo(712.6, 8);
    const queries = fixture.aggregateQueries();
    const projections = fixture.projections.length;
    expect(await read()).toBe(response);
    expect(fixture.aggregateQueries()).toBe(queries);
    expect(fixture.projections).toHaveLength(projections);
  });
});
