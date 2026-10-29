import { PosOrderSyncRecoveryService, PosOrderRecoveryError, recoveryRetryDelay, validateRecoveryOrder } from './pos-order-sync-recovery.service';

const raw = {
  id: 7164, shop_id: 1021338367, status: 5, total_quantity: 3,
  inserted_at: '2026-10-11T14:13:19.000000', updated_at: '2026-10-22T06:57:03.850999',
  items: [{ product_id: 'product-a', variation_id: 'variant-a', quantity: 3 }],
};
const clone = <T>(value: T): T => structuredClone(value);
function harness() {
  const row: any = {
    id: 'recovery-1', tenantId: 'tenant-1', storeId: null, shopId: '1021338367', posOrderId: '7164',
    failedLogId: 'failed-1', failedReceivedAt: new Date('2026-10-22'), state: 'QUEUED',
    attemptCount: 0, nextAttemptAt: new Date(0), queueJobId: 'job-1', queuedAt: new Date(0),
    leaseToken: null, leaseUntil: null, updatedAt: new Date(0), createdAt: new Date(0),
  };
  function matches(where: any) {
    return Object.entries(where).every(([key, value]: [string, any]) => {
      const isDate = value && typeof value.getTime === 'function';
      if (value && typeof value === 'object' && !isDate) {
        if (value.in) return value.in.includes(row[key]);
        if (value.lte) return row[key] <= value.lte;
        if (value.lt) return row[key] < value.lt;
        if (value.gt) return row[key] > value.gt;
      }
      return isDate ? +row[key] === +value : row[key] === value;
    });
  }
  const delegate = {
    findUnique: jest.fn(async () => clone(row)),
    findFirst: jest.fn(async ({ where }) => matches(where) ? clone(row) : null),
    findMany: jest.fn(async ({ where }) => matches(where) ? [clone(row)] : []),
    updateMany: jest.fn(async ({ where, data }) => {
      if (!matches(where)) return { count: 0 };
      for (const [key, value] of Object.entries(data) as any) {
        row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
      }
      row.updatedAt = new Date();
      return { count: 1 };
    }),
  };
  const prisma: any = {
    posOrderSyncRecovery: delegate,
    $queryRaw: jest.fn(async () => []), $executeRaw: jest.fn(async () => 1),
    tenant: { findUnique: jest.fn(async () => ({ status: 'ACTIVE', settings: { pancakePosWebhook: { enabled: true, relayEnabled: true } } })) },
    posStore: { findMany: jest.fn(async () => [{ id: 'store-1', integration: { status: 'ACTIVE' } }]) },
    pancakeWebhookLog: {
      findUnique: jest.fn(async () => ({ queueJobId: 'original-job' })),
      create: jest.fn(async () => ({ id: 'attempt-log' })), update: jest.fn(async () => ({})),
    },
    pancakeWebhookLogOrder: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const integration: any = {
    resolvePancakeRecoveryApiKey: jest.fn(async () => 'private-test-key'),
    reconcileRecoveredPancakeOrder: jest.fn(async () => ({ queued: 1, skipped: 0 })),
    receivePancakeOrderWebhook: jest.fn(),
  };
  const orders: any = { upsertPosOrdersWithOutcomes: jest.fn(async () => ({
    upserted: 1, outcomes: [{ shopId: row.shopId, orderId: row.posOrderId, status: 5, upsertStatus: 'UPSERTED' }],
  })) };
  const ownership: any = { resolveOrderRoutes: jest.fn(async () => ({
    issues: [], routes: [{ tenantId: row.tenantId, shopId: row.shopId,
      store: { id: 'store-1', tenantId: row.tenantId, shopId: row.shopId, status: 'ACTIVE', enabled: true,
        integrationId: 'integration-1', apiKey: 'private-test-key', teamId: null } }],
  })) };
  const webhookQueue: any = { getJob: jest.fn(async () => null) };
  const jobs = new Map<string, any>();
  const queue: any = {
    getJob: jest.fn(async (id: string) => jobs.get(id)),
    add: jest.fn(async (_name: string, data: any, options: any) => {
      const job = { data, id: options.jobId, getState: async () => 'waiting' };
      jobs.set(job.id, job); return job;
    }),
  };
  const service = new PosOrderSyncRecoveryService(prisma, integration, orders, ownership, webhookQueue, queue);
  const fetchOrder = jest.spyOn(service, 'fetchOrder').mockImplementation(async () => clone(raw));
  return { row, prisma, delegate, integration, orders, ownership, webhookQueue, queue, jobs, service, fetchOrder };
}

describe('canonical POS recovery validation', () => {
  it('keeps the full provider timestamp and checks exact scope/items/quantity', () => {
    expect(validateRecoveryOrder(raw, { shopId: '1021338367', posOrderId: '7164' })).toBe('2026-10-22T06:57:03.850999000Z');
    for (const modified of [
      { ...raw, id: 7165 }, { ...raw, shop_id: 1 }, { ...raw, updated_at: 'bad' },
      { ...raw, items: undefined }, { ...raw, items: [] }, { ...raw, total_quantity: 4 },
      { ...raw, items: [{ quantity: 3 }] }, { ...raw, status: null },
    ]) expect(() => validateRecoveryOrder(modified, { shopId: '1021338367', posOrderId: '7164' })).toThrow(PosOrderRecoveryError);
  });
  it('backs off with bounded jitter and keeps retrying at 30 minutes', () => {
    expect(recoveryRetryDelay(1, () => 0)).toBe(60_000);
    expect(recoveryRetryDelay(2, () => 0.5)).toBe(132_000);
    expect(recoveryRetryDelay(40, () => 0.9)).toBe(1_800_000);
  });
});

describe('durable POS recovery outbox', () => {
  it('reserves one dispatch under concurrent scheduler ticks', async () => {
    const f = harness(); f.row.state = 'PENDING'; f.row.queueJobId = null;
    await Promise.all([f.service.reserveDue(), f.service.reserveDue()]);
    const queueId = f.row.queueJobId;
    expect(f.row.state).toBe('QUEUED'); expect(queueId).toBeTruthy();
    await f.service.reserveDue(); expect(f.row.queueJobId).toBe(queueId);
  });
  it('reuses its durable job ID after Redis accepted but acknowledgement was lost', async () => {
    const f = harness();
    f.queue.add.mockImplementationOnce(async (_name, data, opts) => {
      f.jobs.set(opts.jobId, { data, getState: async () => 'waiting' });
      throw new Error('lost acknowledgement');
    });
    await f.service.dispatchOutbox(); await f.service.dispatchOutbox();
    expect(f.queue.add).toHaveBeenCalledTimes(1);
    expect(f.queue.add.mock.calls[0][1]).toEqual({ recoveryId: f.row.id });
    expect(f.row.state).toBe('QUEUED'); expect(f.row.queueJobId).toBe('job-1');
  });
  it('reclaims a crashed worker and fences its old queue ID', async () => {
    const f = harness(); f.row.state = 'RUNNING'; f.row.leaseToken = 'old-token'; f.row.leaseUntil = new Date(0);
    await f.service.recoverExpiredLeases(); await f.service.reserveDue();
    expect(f.row.state).toBe('QUEUED'); expect(f.row.queueJobId).not.toBe('job-1');
    expect(await f.service.process(f.row.id, 'job-1')).toEqual({ state: 'SKIPPED' });
    expect(f.fetchOrder).not.toHaveBeenCalled();
  });
  it('releases terminal queue transport failure without losing the durable retry', async () => {
    const f = harness(); f.jobs.set('job-1', { getState: async () => 'failed' });
    await f.service.dispatchOutbox();
    expect(f.row.state).toBe('PENDING'); expect(f.row.lastErrorCode).toBe('QUEUE_JOB_ENDED_BEFORE_CLAIM');
  });
  it('consumes historical receipts, supports pruned jobs, and includes incomplete-version callbacks', async () => {
    const f = harness();
    f.prisma.$queryRaw.mockResolvedValue([{ tenantId: f.row.tenantId, shopId: f.row.shopId, posOrderId: f.row.posOrderId,
      failedLogId: f.row.failedLogId, failedReceivedAt: f.row.failedReceivedAt, queueJobId: null }]);
    await f.service.discoverFailures();
    const query = f.prisma.$queryRaw.mock.calls[0][0].strings.join('');
    expect(query).toContain('NOT EXISTS'); expect(query).toContain('SOURCE_VERSION_REQUIRED');
    expect(query).toContain('INVALID_SOURCE_VERSION'); expect(query).toContain('LIMIT');
    expect(query).toContain('OUTBOUND_PROJECTION_FAILED'); expect(query).toContain("AT TIME ZONE 'UTC'");
    for (const reason of ['AMBIGUOUS_HISTORICAL_OWNER', 'ROUTING_STORE_NOT_FOUND', 'ACTIVE_OWNER_DISABLED', 'DESTINATION_TENANT_NOT_FOUND']) {
      expect(query).toContain(reason);
    }
    const insert = f.prisma.$executeRaw.mock.calls[0][0].strings.join('');
    expect(insert).toContain('ON CONFLICT'); expect(insert).toContain('EXCLUDED."failedReceivedAt"');
    expect(f.webhookQueue.getJob).not.toHaveBeenCalled();
  });
});

describe('POS recovery worker', () => {
  it('honors the emergency disable flag before claiming or fetching', async () => {
    const previous = process.env.POS_ORDER_RECOVERY_ENABLED;
    process.env.POS_ORDER_RECOVERY_ENABLED = 'false';
    try {
      const f = harness();
      expect(await f.service.process(f.row.id, 'job-1')).toEqual({ state: 'SKIPPED', code: 'RECOVERY_DISABLED' });
      expect(f.row.state).toBe('QUEUED'); expect(f.fetchOrder).not.toHaveBeenCalled();
      expect(f.delegate.updateMany).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.POS_ORDER_RECOVERY_ENABLED;
      else process.env.POS_ORDER_RECOVERY_ENABLED = previous;
    }
  });
  it('claims only once, uses canonical source, strict projection, and a new audit without relay', async () => {
    const f = harness();
    await Promise.all([f.service.process(f.row.id, 'job-1'), f.service.process(f.row.id, 'job-1')]);
    expect(f.fetchOrder).toHaveBeenCalledTimes(1); expect(f.orders.upsertPosOrdersWithOutcomes).toHaveBeenCalledTimes(1);
    expect(f.orders.upsertPosOrdersWithOutcomes.mock.calls[0][4]).toEqual({ requireProjectionSuccess: true });
    expect(f.integration.receivePancakeOrderWebhook).not.toHaveBeenCalled();
    expect(f.prisma.pancakeWebhookLog.create.mock.calls[0][0].data.source).toBe('PANCAKE_POS_RECOVERY');
    expect(f.prisma.pancakeWebhookLog.update.mock.calls.every(([input]) => input.where.id === 'attempt-log')).toBe(true);
    expect(f.row.state).toBe('SUCCEEDED'); expect(f.row.attemptCount).toBe(1);
  });
  it('refetches canonical source on every transient attempt, including post-upsert projection failure', async () => {
    const f = harness();
    f.orders.upsertPosOrdersWithOutcomes.mockRejectedValueOnce(new Error('projection failed customer-data-must-not-leak'));
    expect(await f.service.process(f.row.id, 'job-1')).toEqual({ state: 'PENDING', code: 'RECOVERY_PROCESS_FAILED' });
    expect(f.integration.reconcileRecoveredPancakeOrder).not.toHaveBeenCalled();
    f.row.nextAttemptAt = new Date(0); await f.service.reserveDue();
    await f.service.process(f.row.id, f.row.queueJobId);
    expect(f.fetchOrder).toHaveBeenCalledTimes(2); expect(f.row.state).toBe('SUCCEEDED');
    expect(JSON.stringify(f.prisma.pancakeWebhookLog.update.mock.calls)).not.toContain('customer-data-must-not-leak');
  });
  it('leaves auth failures visible and schedules an hourly recheck', async () => {
    const f = harness(); f.fetchOrder.mockRejectedValue(new PosOrderRecoveryError('SOURCE_HTTP_401', true));
    const started = Date.now(); await f.service.process(f.row.id, 'job-1');
    expect(f.row.state).toBe('BLOCKED'); expect(+f.row.nextAttemptAt).toBeGreaterThanOrEqual(started + 3_600_000);
    expect(f.orders.upsertPosOrdersWithOutcomes).not.toHaveBeenCalled();
  });
  it('does not compete with an original webhook still processing', async () => {
    const f = harness(); f.webhookQueue.getJob.mockResolvedValue({ getState: async () => 'delayed' });
    await f.service.process(f.row.id, 'job-1');
    expect(f.row.lastErrorCode).toBe('ORIGINAL_INGEST_PENDING'); expect(f.fetchOrder).not.toHaveBeenCalled();
  });
  it('closes intentionally excluded orders instead of rechecking them forever', async () => {
    const f = harness();
    f.orders.upsertPosOrdersWithOutcomes.mockResolvedValue({ upserted: 0,
      outcomes: [{ upsertStatus: 'SKIPPED', reason: 'SOURCE_EXCLUDED_SHOPEE' }] });
    await f.service.process(f.row.id, 'job-1');
    expect(f.row.state).toBe('SUCCEEDED'); expect(f.row.lastErrorCode).toBe('BUSINESS_RULE_EXCLUDED');
    expect(f.integration.reconcileRecoveredPancakeOrder).not.toHaveBeenCalled();
  });
  it('does not acknowledge a later failure which arrived during processing', async () => {
    const f = harness();
    f.orders.upsertPosOrdersWithOutcomes.mockImplementationOnce(async () => {
      f.row.failedLogId = 'new-failed-receipt';
      return { upserted: 1, outcomes: [{ upsertStatus: 'UPSERTED' }] };
    });
    await f.service.process(f.row.id, 'job-1');
    expect(f.row.state).toBe('PENDING'); expect(f.row.failedLogId).toBe('new-failed-receipt');
    expect(f.row.leaseToken).toBeNull();
  });
  it('blocks an ownership change before applying the fetched snapshot', async () => {
    const f = harness(); const original = await f.ownership.resolveOrderRoutes();
    f.ownership.resolveOrderRoutes.mockResolvedValueOnce(original).mockResolvedValueOnce({ issues: [], routes: [] });
    await f.service.process(f.row.id, 'job-1');
    expect(f.row.lastErrorCode).toBe('OWNERSHIP_CHANGED'); expect(f.orders.upsertPosOrdersWithOutcomes).not.toHaveBeenCalled();
  });
  it('follows a legitimate centralized webhook route while retaining request identity', async () => {
    const f = harness();
    const routed = await f.ownership.resolveOrderRoutes();
    routed.routes[0].tenantId = 'destination-tenant';
    routed.routes[0].store.tenantId = 'destination-tenant';
    f.ownership.resolveOrderRoutes.mockResolvedValue(routed);
    await f.service.process(f.row.id, 'job-1');
    expect(f.row.state).toBe('SUCCEEDED'); expect(f.row.tenantId).toBe('tenant-1');
    expect(f.integration.resolvePancakeRecoveryApiKey.mock.calls[0][0]).toBe('destination-tenant');
    expect(f.orders.upsertPosOrdersWithOutcomes.mock.calls[0][0]).toBe('destination-tenant');
    expect(f.integration.reconcileRecoveredPancakeOrder.mock.calls[0][0]).toBe('destination-tenant');
    expect(f.prisma.pancakeWebhookLog.create.mock.calls[0][0].data.requestTenantId).toBe('tenant-1');
    expect(f.prisma.pancakeWebhookLog.update).toHaveBeenCalledWith({ where: { id: 'attempt-log' }, data: { tenantId: 'destination-tenant' } });
  });
});

describe('canonical provider fetch', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  it('uses GET with redirect rejection and returns only canonical data', async () => {
    const f = harness(); f.fetchOrder.mockRestore();
    const fetchMock = jest.fn(async (_url: any, _options: any) => new Response(JSON.stringify({ success: true, data: raw }), { status: 200 }));
    global.fetch = fetchMock as any;
    expect(await f.service.fetchOrder(f.row, 'secret')).toEqual(raw);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([[401, true], [404, true], [429, false], [503, false]])('classifies HTTP%s without retaining body', async (status, blocked) => {
    const f = harness(); f.fetchOrder.mockRestore();
    global.fetch = jest.fn(async () => new Response('sensitive upstream body', { status: Number(status) })) as any;
    await expect(f.service.fetchOrder(f.row, 'secret')).rejects.toMatchObject({ code: `SOURCE_HTTP_${status}`, blocked });
  });
  it('aborts a hanging provider request at the bounded timeout', async () => {
    jest.useFakeTimers();
    try {
      const f = harness(); f.fetchOrder.mockRestore();
      global.fetch = jest.fn(async (_url: any, opts: any) => new Promise<Response>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('URL-with-secret')));
      })) as any;
      const pending = expect(f.service.fetchOrder(f.row, 'secret')).rejects.toMatchObject({ code: 'SOURCE_REQUEST_FAILED', blocked: false });
      await jest.advanceTimersByTimeAsync(25_000);
      await pending;
    } finally { jest.useRealTimers(); }
  });
});
import { afterEach, describe, expect, it, jest } from '@jest/globals';
