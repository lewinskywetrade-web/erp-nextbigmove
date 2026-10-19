import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProductCogsRefreshProcessor } from './product-cogs-refresh.processor';
import { PANCAKE_WEBHOOK_RECONCILE_JOB } from '../../integrations/pancake-webhook.constants';
import { PRODUCT_COGS_REFRESH_JOB, ProductCogsRefreshJobData } from '../../integrations/product-cogs-refresh.constants';

const data: ProductCogsRefreshJobData = {
  refreshId: '55555555-5555-4555-8555-555555555555',
  tenantId: '11111111-1111-4111-8111-111111111111',
  storeId: '22222222-2222-4222-8222-222222222222',
  changes: [{ productId: '33333333-3333-4333-8333-333333333333', fromDate: null, toDate: null }],
  affectedDates: [],
};
const cursor = '44444444-4444-4444-8444-444444444444';
const result = (overrides = {}) => ({ nextCursor: null, affectedDates: [], examined: 1,
  updated: 1, unchanged: 0, skipped: 0, ...overrides });
const job = (payload = data) => ({ data: payload } as any);

describe('ProductCogsRefreshProcessor', () => {
  type AsyncMock = ReturnType<typeof jest.fn<(...args: any[]) => Promise<any>>>;
  let recalculation: { waitForSourceTransaction: AsyncMock; recalculateBatch: AsyncMock };
  let queue: { add: AsyncMock };
  let processor: ProductCogsRefreshProcessor;

  beforeEach(() => {
    recalculation = { waitForSourceTransaction: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined),
      recalculateBatch: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(result()) };
    queue = { add: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({}) };
    processor = new ProductCogsRefreshProcessor(recalculation as any, queue as any);
  });

  it('waits for the source transaction before reading costs in the first bounded page', async () => {
    const phases: string[] = [];
    recalculation.waitForSourceTransaction.mockImplementation(async () => { phases.push('source committed'); });
    recalculation.recalculateBatch.mockImplementation(async () => { phases.push('read'); return result(); });
    await processor.handleRefresh(job());
    expect(phases).toEqual(['source committed', 'read']);
    expect(recalculation.waitForSourceTransaction).toHaveBeenCalledWith({ tenantId: data.tenantId,
      storeId: data.storeId, changes: data.changes });
    expect(recalculation.recalculateBatch).toHaveBeenCalledWith({ tenantId: data.tenantId,
      storeId: data.storeId, changes: data.changes, cursor: undefined, pageSize: 200 });
  });

  it('queues a durable continuation with prior and current dates before any reports rebuild', async () => {
    recalculation.recalculateBatch.mockResolvedValue(result({ nextCursor: cursor,
      affectedDates: ['2026-10-19', '2026-10-18', '2026-10-19'] }));
    await processor.handleRefresh(job({ ...data, affectedDates: ['2026-10-17'] }));
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(PRODUCT_COGS_REFRESH_JOB,
      { ...data, cursor, affectedDates: ['2026-10-17', '2026-10-18', '2026-10-19'] },
      expect.objectContaining({ jobId: `product-cogs-refresh-${data.refreshId}-${cursor}`, attempts: 8, removeOnFail: false }));
  });

  it('rebuilds each affected owner-tenant day once after the last page, without a full reset', async () => {
    recalculation.recalculateBatch.mockResolvedValue(result({ affectedDates: ['2026-10-19', '2026-10-18'] }));
    await processor.handleRefresh(job({ ...data, cursor, affectedDates: ['2026-10-18', '2026-10-17'] }));
    expect(recalculation.waitForSourceTransaction).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(queue.add.mock.calls.map(call => call[1].dateLocal)).toEqual(['2026-10-17', '2026-10-18', '2026-10-19']);
    for (const [name, payload, options] of queue.add.mock.calls) {
      expect(name).toBe(PANCAKE_WEBHOOK_RECONCILE_JOB);
      expect(payload).toEqual(expect.objectContaining({ tenantId: data.tenantId, teamId: null,
        reconcileMode: 'incremental', requestId: data.refreshId }));
      expect(options).toEqual(expect.objectContaining({ attempts: 8, removeOnFail: false }));
    }
  });

  it('retains affected dates on retry after costs changed but continuation enqueue failed', async () => {
    recalculation.recalculateBatch.mockResolvedValueOnce(result({ nextCursor: cursor, affectedDates: ['2026-10-19'] }))
      .mockResolvedValueOnce(result({ nextCursor: cursor, affectedDates: ['2026-10-19'], updated: 0, unchanged: 1 }));
    queue.add.mockRejectedValueOnce(new Error('Redis acknowledgement lost')).mockResolvedValue({});
    await expect(processor.handleRefresh(job())).rejects.toThrow('Redis acknowledgement lost');
    await processor.handleRefresh(job());
    expect(queue.add.mock.calls[1][1].affectedDates).toEqual(['2026-10-19']);
    expect(queue.add.mock.calls[1][2].jobId).toBe(queue.add.mock.calls[0][2].jobId);
  });

  it('retries final-day enqueue failures with the same durable report job identities', async () => {
    const payload = { ...data, cursor, affectedDates: ['2026-10-17', '2026-10-18'] };
    queue.add.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Redis unavailable')).mockResolvedValue({});
    await expect(processor.handleRefresh(job(payload))).rejects.toThrow('Redis unavailable');
    await processor.handleRefresh(job(payload));
    expect(queue.add.mock.calls[2][2].jobId).toBe(queue.add.mock.calls[0][2].jobId);
    expect(queue.add.mock.calls[3][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
  });

  it('does not advance a page when an order CAS conflict requires retry', async () => {
    recalculation.recalculateBatch.mockRejectedValue(new Error('COGS_REFRESH_CONCURRENT_ORDER_CHANGE'));
    await expect(processor.handleRefresh(job())).rejects.toThrow('COGS_REFRESH_CONCURRENT_ORDER_CHANGE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retries a bounded parent-lock failure before starting recalculation', async () => {
    recalculation.waitForSourceTransaction.mockRejectedValue(new Error('lock timeout'));
    await expect(processor.handleRefresh(job())).rejects.toThrow('lock timeout');
    expect(recalculation.recalculateBatch).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a non-advancing continuation instead of looping forever', async () => {
    recalculation.recalculateBatch.mockResolvedValue(result({ nextCursor: cursor }));
    await expect(processor.handleRefresh(job({ ...data, cursor }))).rejects.toThrow('COGS_REFRESH_CURSOR_DID_NOT_ADVANCE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects malformed queued scope without touching data', async () => {
    await expect(processor.handleRefresh(job({ ...data, cursor: 'not-an-order-id' }))).rejects.toThrow('Invalid product COGS refresh job');
    expect(recalculation.waitForSourceTransaction).not.toHaveBeenCalled();
    expect(recalculation.recalculateBatch).not.toHaveBeenCalled();
  });
});
