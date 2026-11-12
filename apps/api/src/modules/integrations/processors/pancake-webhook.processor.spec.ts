import { describe, expect, it, jest } from '@jest/globals';
import { IntegrationService } from '../integration.service';
import { PancakeWebhookQueueProcessor } from './pancake-webhook.processor';

describe('Pancake reports_by_phone hydrate retry & failed-queue hygiene', () => {
  const buildHydrateHarness = (fetchResult: { metrics: any; warning?: string }) => {
    const queueAdd = (jest.fn() as any).mockResolvedValue(undefined);
    const prisma = {
      posOrder: {
        findFirst: (jest.fn() as any).mockResolvedValue({
          status: 0,
          customerPhone: '09171234567',
          reportsByPhoneOrderFail: null,
          reportsByPhoneOrderSuccess: null,
        }),
        updateMany: (jest.fn() as any).mockResolvedValue({ count: 1 }),
      },
      posStore: {
        findFirst: (jest.fn() as any).mockResolvedValue({
          id: 'store-1',
          integrationId: 'int-1',
          apiKey: 'secret-key',
        }),
      },
      tenant: {
        findUnique: (jest.fn() as any).mockResolvedValue({ settings: {} }),
      },
    };

    const service = Object.create(IntegrationService.prototype) as IntegrationService;
    Object.assign(service as any, {
      prisma,
      pancakeWebhookQueue: { add: queueAdd },
      logger: { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
    });
    jest
      .spyOn(service as any, 'fetchReportsByPhoneMetricsForOrder')
      .mockResolvedValue(fetchResult);

    return { service, queueAdd };
  };

  it('re-enqueues bounded delayed hydrate job quietly without throwing when reports_by_phone is not indexed yet', async () => {
    const { service, queueAdd } = buildHydrateHarness({ metrics: null });

    const result = await service.processPancakeReportsHydrateJob({
      tenantId: 'tenant-1',
      shopId: '407350568',
      orderId: '43392',
      customerPhone: '09171234567',
      attempt: 1,
    });

    expect(result).toEqual({
      success: false,
      reason: 'REPORTS_NOT_READY_REQUEUED',
      hydrated: false,
    });
    expect(queueAdd).toHaveBeenCalledWith(
      'hydrate-reports-by-phone',
      expect.objectContaining({
        tenantId: 'tenant-1',
        shopId: '407350568',
        orderId: '43392',
        attempt: 2,
      }),
      expect.objectContaining({
        jobId: 'pancake-reports-hydrate:tenant-1:407350568:43392:a2',
      }),
    );
  });

  it('exits cleanly without throwing or re-enqueuing once max attempts are reached', async () => {
    const { service, queueAdd } = buildHydrateHarness({ metrics: null });

    const result = await service.processPancakeReportsHydrateJob({
      tenantId: 'tenant-1',
      shopId: '407350568',
      orderId: '43392',
      customerPhone: '09171234567',
      attempt: 8,
    });

    expect(result).toEqual({
      success: false,
      reason: 'REPORTS_NOT_AVAILABLE',
      hydrated: false,
    });
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('still throws on genuine HTTP/network errors so real failures surface', async () => {
    const { service } = buildHydrateHarness({
      metrics: null,
      warning: 'reports_by_phone lookup failed (502) for shop_id=407350568',
    });

    await expect(
      service.processPancakeReportsHydrateJob({
        tenantId: 'tenant-1',
        shopId: '407350568',
        orderId: '43392',
        customerPhone: '09171234567',
      }),
    ).rejects.toThrow('reports_by_phone lookup failed (502) for shop_id=407350568');
  });

  it('purges only legacy "reports_by_phone not available yet" failed jobs while preserving real errors', async () => {
    const removeNoise = (jest.fn() as any).mockResolvedValue(undefined);
    const removeReal = (jest.fn() as any).mockResolvedValue(undefined);
    const queue = {
      getFailed: (jest.fn() as any).mockResolvedValue([
        {
          id: 'noise-1',
          failedReason: 'reports_by_phone not available yet for shop_id=407350568 order_id=43392',
          remove: removeNoise,
        },
        {
          id: 'real-1',
          failedReason: 'Database deadlock while upserting webhook order',
          remove: removeReal,
        },
      ]),
    };

    const processor = new PancakeWebhookQueueProcessor({} as any, queue as any);
    const purged = await processor.purgeLegacyReportsNotAvailableFailedJobs();

    expect(purged).toBe(1);
    expect(removeNoise).toHaveBeenCalledTimes(1);
    expect(removeReal).not.toHaveBeenCalled();
  });
});
