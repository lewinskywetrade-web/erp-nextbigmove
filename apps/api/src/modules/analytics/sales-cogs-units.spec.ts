import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { SalesAnalyticsService } from './sales-analytics.service';
import { SalesAnalyticsController } from './sales-analytics.controller';
import { AnalyticsRequestCoordinatorService } from './analytics-request-coordinator.service';
import * as cogsUnits from './utils/actual-cogs-units';

describe('SUPER_ADMIN-only COGS-linked units outside shared report caches', () => {
  afterEach(() => { jest.restoreAllMocks(); });
  const modes = ['getOverview', 'getStoreOverview'] as const;
  function fixture(realCoordinator = false) {
    const original = Object.freeze({
      products: Object.freeze([Object.freeze({ mapping: 'A', gross_sales: 1, cogs: 100 })]),
      kpis: Object.freeze({ cogs: 100 }), counts: Object.freeze({ purchases: 1, rts: 0 }),
      selected: Object.freeze({ start_date: '2026-10-01', end_date: '2026-10-19' }),
    });
    const cache = { hashObject: (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex') };
    const coordinator: any = realCoordinator ? new AnalyticsRequestCoordinatorService()
      : { run: jest.fn(async (_tenant: string, _key: string, work: () => Promise<any>) => work()) };
    const prisma: any = {};
    const service = new SalesAnalyticsService(prisma, { getTenantId: () => 'tenant' } as any, cache as any,
      coordinator as any, {} as any, {} as any, {} as any);
    // Models the single public object returned from both Redis and in-flight cache.
    const product = jest.spyOn(service as any, 'calculateOverview').mockResolvedValue(original);
    const store = jest.spyOn(service as any, 'calculateStoreOverview').mockResolvedValue(original);
    const enrich = jest.spyOn(cogsUnits, 'enrichActualCogsUnits').mockImplementation(async (_db, response) => ({
      ...response, kpis: { ...response.kpis, actual_units: 7, actual_units_forecast_basis: 9 },
      products: response.products.map(row => ({ ...row, actual_units: 7, actual_units_forecast_basis: 9 })),
      actualUnitsCoverage: { policy: cogsUnits.ACTUAL_COGS_UNITS_POLICY, status: 'COMPLETE' },
    } as any));
    return { service, original, enrich, coordinator, product, store };
  }
  it.each(modes)('%s has no field for ordinary roles or an original SUPER_ADMIN viewing a non-super target', async method => {
    const f = fixture();
    for (const user of [undefined, { role: 'USER' }, { role: 'TENANT_ADMIN' },
      { role: 'USER', impersonatedBy: 'super-admin', originalRole: 'SUPER_ADMIN' }] as any[]) {
      expect(await f.service[method]({}, user)).toBe(f.original);
    }
    expect(f.enrich).not.toHaveBeenCalled();
    expect(f.original.kpis).not.toHaveProperty('actual_units');
  });
  it.each(modes)('%s decorates only current SUPER_ADMIN, leaves cached object unchanged and uses a separate bounded operation', async method => {
    const f = fixture();
    const before = await f.service[method]({}, { role: 'USER' });
    const elevated = await f.service[method]({ excludeRepurchase: false, excludeCancel: false,
      excludeRestocking: false, excludeAbandoned: false, excludeRts: false }, { role: 'SUPER_ADMIN' });
    const after = await f.service[method]({}, { role: 'USER' });
    expect(before).toBe(after);
    expect(after).toBe(f.original);
    expect(elevated).not.toBe(f.original);
    expect(elevated.kpis.actual_units).toBe(7);
    expect(after.kpis).not.toHaveProperty('actual_units');
    expect(after.products[0]).not.toHaveProperty('actual_units');
    expect(f.enrich).toHaveBeenCalledWith(expect.anything(), f.original, expect.objectContaining({
      tenantId: 'tenant', start: '2026-10-01', end: '2026-10-19', excludeRepurchase: false,
      excludeCancel: false, excludeRestocking: false, excludeAbandoned: false, excludeRts: false,
    }), method === 'getOverview' ? 'product' : 'store');
    expect(f.coordinator.run.mock.calls.filter((call: any) => call[1].startsWith('sales-actual-cogs-units:'))).toHaveLength(1);
  });
  it.each(modes)('%s keeps concurrent SUPER_ADMIN/USER requests isolated while coalescing the shared base', async method => {
    const f = fixture(true);
    (f.coordinator as any).maxConcurrentPerTenant = 1;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const implementation = f.enrich.getMockImplementation()!;
    f.enrich.mockImplementation(async (...args) => { await wait; return implementation(...args); });
    const admin = f.service[method]({}, { role: 'SUPER_ADMIN' });
    const normal = f.service[method]({}, { role: 'USER' });
    expect(await normal).toBe(f.original);
    expect((method === 'getOverview' ? f.product : f.store)).toHaveBeenCalledTimes(1);
    release();
    expect((await admin).kpis.actual_units).toBe(7);
    const later = await f.service[method]({}, { role: 'USER' });
    expect(later).toBe(f.original);
    expect(later.products[0]).not.toHaveProperty('actual_units');
    expect(f.enrich).toHaveBeenCalledTimes(1);
  });
  it.each(modes)('%s cannot enable protected fields from arbitrary request params', async method => {
    const f = fixture();
    await f.service[method]({ role: 'SUPER_ADMIN', actual_units: true, includeActualUnits: true } as any);
    expect(f.enrich).not.toHaveBeenCalled();
  });
  it.each(modes)('%s controller passes the authenticated current identity, not the query/header role', async method => {
    const call = jest.fn(async () => ({}));
    const controller = new SalesAnalyticsController({ [method]: call } as any);
    const user = { role: 'USER', impersonatedBy: 'super-admin' };
    const args: any[] = new Array(12).fill(undefined);
    args[0] = '2026-10-01'; args[1] = '2026-10-19';
    args.push({ user, query: { role: 'SUPER_ADMIN' }, headers: { role: 'SUPER_ADMIN' } });
    await (controller[method] as any)(...args);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ startDate: args[0], endDate: args[1] }), user);
  });
});
