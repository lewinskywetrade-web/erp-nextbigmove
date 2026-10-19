import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { ReportsService } from './reports.service';

const tenantId = '10000000-0000-4000-8000-000000000001';

describe('ReportsService POS order population', () => {
  it('excludes deleted and explicit void orders from the common source of every count and value bucket', async () => {
    const queries: Prisma.Sql[] = [];
    const prisma = {
      $queryRaw: jest.fn(async (query: Prisma.Sql) => {
        queries.push(query);
        return [{ shopId: 'shop-a', totalOrders: 10, deliveredOrders: 2, cancelledOrders: 1,
          returningOrders: 1, returnedOrders: 1, restockingOrders: 1, inProcessOrders: 4,
          totalRevenue: 1000, deliveredRevenue: 200, cancelledRevenue: 100,
          returningRevenue: 100, returnedRevenue: 100, restockingRevenue: 100, inProcessRevenue: 400 }];
      }),
      posStore: { findMany: jest.fn(async () => [{ shopId: 'shop-a', shopName: 'Shop A', name: 'Fallback' }]) },
    };
    const cls = { get: () => tenantId };
    const service = new ReportsService(prisma as never, cls as never);

    const result = await service.getPosOrdersSummary({ startDate: '2026-10-10', endDate: '2026-10-11' });

    expect(queries).toHaveLength(1);
    // Apply eligibility before grouping, rather than correcting only all_orders
    // while leaving delivered/canceled/printed revenue and denominators stale.
    expect(queries[0].text).toMatch(/WHERE po\."tenantId" = \$\d+::uuid[\s\S]*AND po\."status" IS DISTINCT FROM 7\s+AND po\."isVoid" IS DISTINCT FROM true[\s\S]*GROUP BY po\."shopId"/);
    expect(queries[0].values).toEqual(expect.arrayContaining([tenantId, '2026-10-10', '2026-10-11']));
    expect(queries[0].text).toContain('ps."tenantId" = po."tenantId"');
    expect(queries[0].text).toContain('ps."status" = \'ACTIVE\'');
    expect(queries[0].text).toContain('COALESCE(ps."enabled", true) = true');
    expect(result.items[0].qty).toMatchObject({ all_orders: 10, delivered: 2, cancelled: 1,
      rts_rate: 0.5, pending_rate: 0.5, cancellation_rate: 0.1 });
    expect(result.items[0].revenue).toMatchObject({ all_orders: 1000, delivered: 200, cancelled: 100, restocking: 100 });
    expect(result.items[0].pos_store_name).toBe('Shop A');
  });

  it('requires tenant scope and rejects reversed date ranges before reading order values', async () => {
    const prisma = { $queryRaw: jest.fn() };
    const unscoped = new ReportsService(prisma as never, { get: () => undefined } as never);
    await expect(unscoped.getPosOrdersSummary({})).rejects.toThrow('Tenant context is required');
    const scoped = new ReportsService(prisma as never, { get: () => tenantId } as never);
    await expect(scoped.getPosOrdersSummary({ startDate: '2026-10-11', endDate: '2026-10-10' }))
      .rejects.toThrow('start_date must be before or equal to end_date');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
