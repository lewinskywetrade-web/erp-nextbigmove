import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { SalesPerformanceService } from './sales-performance.service';

const tenantId = '10000000-0000-4000-8000-000000000001';
const teamId = '20000000-0000-4000-8000-000000000001';
const range = { startDate: '2026-10-10', endDate: '2026-10-10' };

function harness(teamIds: string[] | null = [teamId]) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (query: Prisma.Sql) => { queries.push(query); return []; }),
    posStore: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
  };
  const context = {
    getContext: jest.fn(async () => ({ tenantId })),
    getAnalyticsTeamIds: jest.fn(async () => teamIds),
  };
  const cache = {
    getVersion: jest.fn(async () => 4),
    hashObject: jest.fn((value: unknown) => JSON.stringify(value)),
    // Old cached totals deliberately remain available only under their old key.
    get: jest.fn(async (key: string) => key.includes('non-void-v1') ? null : { staleVoidTotal: 999 }),
    set: jest.fn(async () => undefined),
  };
  return { service: new SalesPerformanceService(prisma as never, context as never, cache as never), prisma, context, cache, queries };
}

function expectEligibleReads(queries: Prisma.Sql[], expected: number) {
  expect(queries).toHaveLength(expected);
  for (const query of queries) {
    expect(query.text).toContain('FROM "pos_orders"');
    expect(query.text).toContain('"status" IS DISTINCT FROM 7');
    // IS DISTINCT FROM retains legacy NULL/false flags while excluding true.
    expect(query.text).toContain('"isVoid" IS DISTINCT FROM true');
    expect(query.values).toEqual(expect.arrayContaining([tenantId, teamId]));
  }
}

describe('SalesPerformanceService direct POS eligibility', () => {
  it('uses nonvoid source rows for store-conversion current/previous totals, last update and shop options', async () => {
    const { service, queries, cache } = harness();
    const result = await service.getStoreConversion({ ...range, shopIds: ['shop-a'] });

    expectEligibleReads(queries, 4);
    expect(queries[0].values).toContain('shop-a');
    expect(queries[1].values).toEqual(expect.arrayContaining(['2026-10-09']));
    expect(queries[3].values).not.toContain('shop-a'); // options intentionally cover the unfiltered shop scope
    expect(queries[0].text).toContain('"status" NOT IN (0, 6, 7, 11)');
    expect(result.summary.abandonedOrders).toBe(0);
    expect(cache.hashObject).toHaveBeenCalledWith(expect.objectContaining({ orderPopulation: 'non-void-v1' }));
    expect(cache.set).toHaveBeenCalled();
  });

  it('uses the same population for assignee totals, previous period, options and unassigned count', async () => {
    const { service, queries, cache } = harness();
    const result = await service.getOverview({ ...range, salesAssignees: ['seller-a'], shopIds: ['shop-a'], includeShopOptions: true });

    expectEligibleReads(queries, 6);
    expect(queries[0].values).toEqual(expect.arrayContaining(['seller-a', 'shop-a']));
    expect(queries[1].values).toContain('2026-10-09');
    expect(queries[0].text).toContain('jsonb_path_exists("statusHistory", \'$[*] ? (@.status == 1)\')');
    expect(queries[3].text).toContain('"salesAssignee" IS NULL');
    expect(result.summary.order_count).toBe(0);
    expect(cache.hashObject).toHaveBeenCalledWith(expect.objectContaining({ orderPopulation: 'non-void-v1' }));
  });

  it('excludes voids from all-time tags, event-date delivery/RTS, risk, repurchase, trends and shop choices', async () => {
    const { service, queries, cache } = harness();
    const result = await service.getProblematicDelivery({ ...range, shopIds: ['shop-a'], salesAssignee: 'seller-a' });

    expectEligibleReads(queries, 14);
    for (const query of queries) expect(query.values).toContain('seller-a');
    const eventDateQueries = queries.filter(query => query.text.includes('"deliveredAt" IS NOT NULL') || query.text.includes('"rtsAt" IS NOT NULL'));
    expect(eventDateQueries.length).toBeGreaterThanOrEqual(5);
    expect(queries[2].text).toContain('"status" = 2');
    expect(queries[10].text).toContain('"isRiskConfirmation"');
    expect(queries[11].text).toContain("LOWER(elem->>'name') = 'repurchase'");
    expect(result.deliveredInRange.count).toBe(0);
    expect(cache.hashObject).toHaveBeenCalledWith(expect.objectContaining({ orderPopulation: 'non-void-v1' }));
  });

  it('keeps denied team scopes empty without querying or reading another cached population', async () => {
    const { service, prisma, cache } = harness([]);
    const results = await Promise.all([
      service.getStoreConversion(range), service.getOverview(range), service.getProblematicDelivery(range),
    ]);
    expect(results).toHaveLength(3);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });
});
