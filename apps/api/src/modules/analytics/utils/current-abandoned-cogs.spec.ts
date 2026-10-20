import { describe, expect, it, jest } from '@jest/globals';
import { abandonedCostQueries, attachCurrentAbandonedCosts, readCurrentAbandonedCosts } from './current-abandoned-cogs';

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', previousStart: '2026-09-12',
  currentStart: '2026-10-01', end: '2026-10-19', activeShopIds: ['shop'], mappings: ['mapping'], includeNull: false };
const group = { period: 'current' as const, mapping: 'mapping', invalidRows: '0', currentAbandonedCount: '1',
  repurchaseCurrentAbandonedCount: '0', currentAbandonedCodPos: '100.00', repurchaseCurrentAbandonedCodPos: '0',
  cogsCurrentAbandonedPos: '0.00', repurchaseCogsCurrentAbandonedPos: '0.00' };
const budget = { targetRows: '1', witnessRows: '1', members: '1', payloadBytes: '100' };
function database(row = group, limits = budget) {
  const query = jest.fn<any>().mockResolvedValueOnce([limits]).mockResolvedValueOnce([row]);
  return { $queryRaw: query, $executeRaw: jest.fn<any>().mockResolvedValue(0) };
}

describe('Exact current abandoned COGS without a schema or mapping guess', () => {
  it('keeps explicit zero and does not query item snapshots or use order mapping', async () => {
    const db = database();
    const rows = await readCurrentAbandonedCosts(db, scope);
    expect(rows[0].cogsCurrentAbandonedPos).toBe(0);
    const { budget: probe, groups } = abandonedCostQueries(scope);
    expect(probe.values).toContain(scope.tenantId);
    expect(groups.values).toContain('mapping');
    expect(groups.values).toContain('shop');
    expect(groups.sql).toContain('"posOrderId"');
    expect(groups.sql).toContain('"dateLocal"');
    expect(groups.sql).toContain('own.owners IS DISTINCT FROM 1');
    expect(groups.sql).not.toContain('o.mapping');
    expect(groups.sql).not.toContain('snapshot');
  });

  it('needs no positive-bucket expansion for a provably zero excluded bucket', async () => {
    const db = database(group, { targetRows: '0', witnessRows: '0', members: '0', payloadBytes: '0' });
    expect(await readCurrentAbandonedCosts(db, scope)).toEqual([]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const sum: any = { currentAbandonedCount: 0, repurchaseCurrentAbandonedCount: 0 };
    attachCurrentAbandonedCosts(sum, []);
    expect(sum.cogsCurrentAbandonedPos).toBe(0);
  });

  it('refuses stale, duplicate, missing or invalid evidence instead of guessing zero', async () => {
    for (const row of [{ ...group, invalidRows: '1' }, { ...group, cogsCurrentAbandonedPos: null },
      { ...group, cogsCurrentAbandonedPos: '-1.00' }, { ...group, currentAbandonedCount: '1.5' }]) {
      await expect(readCurrentAbandonedCosts(database(row as any), scope)).rejects.toThrow('Reconcile the selected dates');
    }
    expect(() => attachCurrentAbandonedCosts({ currentAbandonedCount: 1 }, [])).toThrow('no missing cost has been treated as zero');
  });

  it('bounds relevant-day ownership witnesses before membership expansion', async () => {
    for (const limits of [{ ...budget, members: '100001' }, { ...budget, witnessRows: '25001' },
      { ...budget, payloadBytes: '16777217' }]) {
      const db = database(group, limits);
      await expect(readCurrentAbandonedCosts(db, scope)).rejects.toThrow('Exclude Abandoned');
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    }
    await expect(readCurrentAbandonedCosts({ $executeRaw: async () => { throw new Error('private DB connection'); } }, scope))
      .rejects.toThrow('Reconcile the selected dates');
  });

  it('attaches summed decimal amounts without binary artifacts or a repurchase double subtraction', () => {
    const row = { period: 'current' as const, mapping: 'a', currentAbandonedCount: 1,
      repurchaseCurrentAbandonedCount: 0, currentAbandonedCodPos: 0.1, repurchaseCurrentAbandonedCodPos: 0,
      cogsCurrentAbandonedPos: 0.1, repurchaseCogsCurrentAbandonedPos: 0 };
    const sum: any = { currentAbandonedCount: 2, currentAbandonedCodPos: 0.3 };
    attachCurrentAbandonedCosts(sum, [row, { ...row, mapping: 'b', currentAbandonedCodPos: 0.2, cogsCurrentAbandonedPos: 0.2 }]);
    expect(sum.cogsCurrentAbandonedPos).toBe(0.3);
    expect(sum.repurchaseCogsCurrentAbandonedPos).toBe(0);
  });
});
