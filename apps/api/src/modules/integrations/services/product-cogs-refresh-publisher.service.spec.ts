import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProductCogsRefreshPublisherService } from './product-cogs-refresh-publisher.service';
import { normalizeCogsRefreshJob, PRODUCT_COGS_REFRESH_JOB } from '../product-cogs-refresh.constants';

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  changes: [{ productId: '33333333-3333-4333-8333-333333333333', fromDate: '2026-10-19', toDate: null }],
};

describe('ProductCogsRefreshPublisherService', () => {
  let queue: { add: ReturnType<typeof jest.fn<(...args: any[]) => Promise<any>>> };
  let publisher: ProductCogsRefreshPublisherService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-19T18:00:00Z'));
    queue = { add: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}) };
    publisher = new ProductCogsRefreshPublisherService(queue as any);
  });
  afterEach(() => { jest.useRealTimers(); });

  it('gives newer edits unique durable identities even for the same product and date', async () => {
    await publisher.enqueue(scope);
    await publisher.enqueue(scope);
    const first = queue.add.mock.calls[0];
    const second = queue.add.mock.calls[1];
    expect(first[0]).toBe(PRODUCT_COGS_REFRESH_JOB);
    expect(first[1]).toEqual(expect.objectContaining({ tenantId: scope.tenantId, storeId: scope.storeId,
      changes: [scope.changes[0],
        { productId: scope.changes[0].productId, fromDate: '2026-01-01', toDate: '2026-10-20', zeroOnly: true }],
      policy: 'ERP_COGS_2026_HISTORY_PROPAGATION_V1', affectedDates: [] }));
    expect(first[1].refreshId).not.toBe(second[1].refreshId);
    expect(first[2].jobId).not.toBe(second[2].jobId);
    expect(first[2]).toEqual(expect.objectContaining({ attempts: 8, removeOnFail: false,
      backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: { age: 86_400, count: 10_000 } }));
  });

  it('propagates Redis failure so the enclosing COGS transaction can roll back', async () => {
    queue.add.mockRejectedValue(new Error('Redis unavailable'));
    await expect(publisher.enqueue(scope)).rejects.toThrow('Redis unavailable');
  });

  it('preserves original edit ranges and adds a distinct zero-only historical range', async () => {
    const before = { productId: scope.changes[0].productId, fromDate: null, toDate: '2026-10-18' };
    await publisher.enqueue({ ...scope, changes: [before, scope.changes[0], before] });
    expect(queue.add.mock.calls[0][1].changes).toEqual([
      before, scope.changes[0],
      { productId: scope.changes[0].productId, fromDate: '2026-01-01', toDate: '2026-10-20', zeroOnly: true },
    ]);
  });

  it('keeps distinct original ownership and bounds only the expanded zero-only intervals to 2026', async () => {
    const second = '33333333-3333-4333-8333-333333333334';
    await publisher.enqueue({ ...scope, changes: [
      { productId: scope.changes[0].productId, fromDate: null, toDate: null },
      { productId: second, fromDate: '2025-10-01', toDate: '2025-12-31' },
    ] });
    expect(queue.add.mock.calls[0][1].changes).toEqual([
      { productId: scope.changes[0].productId, fromDate: null, toDate: null },
      { productId: second, fromDate: '2025-10-01', toDate: '2025-12-31' },
      { productId: scope.changes[0].productId, fromDate: '2026-01-01', toDate: '2026-10-20', zeroOnly: true },
      { productId: second, fromDate: '2026-01-01', toDate: '2026-10-20', zeroOnly: true },
    ]);
  });

  it('does not merge a zero-only interval into a matching full edit interval or drop its flag in normalization', async () => {
    const original = { ...scope.changes[0], fromDate: '2026-01-01', toDate: '2026-10-20' };
    await publisher.enqueue({ ...scope, changes: [original] });
    const payload = queue.add.mock.calls[0][1];
    expect(normalizeCogsRefreshJob(payload).changes).toEqual([original, { ...original, zeroOnly: true }]);
  });

  it('never broadens an explicitly zero-only request into a nonzero revaluation interval', async () => {
    await publisher.enqueue({ ...scope, changes: [{ ...scope.changes[0], zeroOnly: true }] });
    expect(queue.add.mock.calls[0][1].changes.every((change: any) => change.zeroOnly === true)).toBe(true);
  });

  it.each([
    { ...scope, tenantId: 'not-a-tenant' },
    { ...scope, changes: [] },
    { ...scope, changes: [{ ...scope.changes[0], fromDate: '2026-02-30' }] },
    { ...scope, changes: [{ ...scope.changes[0], toDate: '2026-10-18' }] },
    { ...scope, changes: [{ ...scope.changes[0], zeroOnly: 'true' }] },
  ])('refuses invalid scope or intervals before publishing', async invalid => {
    await expect(publisher.enqueue(invalid as any)).rejects.toThrow('Invalid product COGS refresh');
    expect(queue.add).not.toHaveBeenCalled();
  });
});
