import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { OpsDigestGuard } from './ops-digest.guard';
import { OpsDigestService } from './ops-digest.service';

function makeExecutionContext(headers: Record<string, string | undefined>): {
  context: ExecutionContext;
  req: { headers: Record<string, string | undefined>; user?: unknown };
} {
  const req = { headers };
  const context = {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
  return { context, req };
}

describe('OpsDigestGuard', () => {
  const originalEnv = process.env.OPS_DIGEST_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPS_DIGEST_TOKEN;
    } else {
      process.env.OPS_DIGEST_TOKEN = originalEnv;
    }
  });

  it('fails closed with ServiceUnavailableException when OPS_DIGEST_TOKEN is unset or short', () => {
    delete process.env.OPS_DIGEST_TOKEN;
    const guard = new OpsDigestGuard();
    const { context } = makeExecutionContext({ authorization: 'Bearer some-token' });
    expect(() => guard.canActivate(context)).toThrow(ServiceUnavailableException);
  });

  it('rejects missing or invalid tokens and accepts matching Bearer token', () => {
    process.env.OPS_DIGEST_TOKEN = 'ops_digest_secret_token_with_more_than_32_chars_12345';
    const guard = new OpsDigestGuard();

    const missing = makeExecutionContext({});
    expect(() => guard.canActivate(missing.context)).toThrow(UnauthorizedException);

    const wrong = makeExecutionContext({
      authorization: 'Bearer wrong_secret_token_with_more_than_32_chars_12345',
    });
    expect(() => guard.canActivate(wrong.context)).toThrow(UnauthorizedException);

    const valid = makeExecutionContext({
      authorization: 'Bearer ops_digest_secret_token_with_more_than_32_chars_12345',
    });
    expect(guard.canActivate(valid.context)).toBe(true);
    expect(valid.req.user).toEqual({
      id: 'ops-digest-automation',
      role: 'SUPER_ADMIN',
      tenantId: null,
    });
  });
});

describe('OpsDigestService', () => {
  const originalResend = process.env.RESEND_API_KEY;
  const originalRecipient = process.env.OPS_DIGEST_EMAIL_TO;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_123456';
    process.env.OPS_DIGEST_EMAIL_TO = 'lewinskycandido@gmail.com';
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = originalResend;
    process.env.OPS_DIGEST_EMAIL_TO = originalRecipient;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('aggregates WMS + ERP sections and redacts sensitive tokens, emails, and phones', async () => {
    const now = new Date('2026-11-11T02:00:00.000Z');
    const prismaMock: any = {
      tenant: {
        findMany: jest.fn(async () => [
          {
            id: 'tenant-1',
            name: 'Famco Retail',
            slug: 'famco',
            status: 'ACTIVE',
            planType: 'enterprise',
            wmsFulfillmentGoLiveAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      },
      posStore: {
        findMany: jest.fn(async () => [
          {
            id: 'store-1',
            tenantId: 'tenant-1',
            name: 'Famco Main',
            shopId: 'shop-1',
            status: 'ACTIVE',
            enabled: true,
            lastSyncAt: now,
          },
        ]),
      },
      wmsStaffActivity: {
        groupBy: (jest.fn() as any)
          .mockResolvedValueOnce([{ platform: 'STOX', outcome: 'REJECTED', _count: { _all: 2 } }])
          .mockResolvedValueOnce([
            { platform: 'STOX', actionType: 'PICK_SCAN', outcome: 'REJECTED', _count: { _all: 2 } },
          ])
          .mockResolvedValueOnce([
            { actorId: 'user-1', platform: 'STOX', outcome: 'REJECTED', _count: { _all: 2 } },
          ]),
        findMany: jest.fn(async () => [
          {
            tenantId: 'tenant-1',
            storeId: 'store-1',
            platform: 'STOX',
            deviceName: 'Zebra-01',
            actionType: 'PICK_SCAN',
            taskType: 'PICK',
            fromStatus: null,
            toStatus: null,
            outcome: 'REJECTED',
            reasonCode: 'WRONG_VARIATION',
            metadata: {
              reason: 'Contact customer@example.com or 09171234567 with Bearer secret123',
              customerPhone: '09171234567',
              expectedVariationId: 'var-1',
            },
            createdAt: now,
            actor: { firstName: 'Juan', lastName: 'Picker' },
          },
        ]),
      },
      user: {
        findMany: jest.fn(async () => [{ id: 'user-1', firstName: 'Juan', lastName: 'Picker' }]),
      },
      wmsFulfillmentOrder: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
      wmsFulfillmentAmendment: { groupBy: jest.fn(async () => []) },
      wmsFulfillmentAdjustment: { findMany: jest.fn(async () => []) },
      wmsInventoryMovement: { groupBy: jest.fn(async () => []) },
      wmsInventoryStoreTransferItem: { findMany: jest.fn(async () => []) },
      wmsProductProfile: { findMany: jest.fn(async () => []) },
      wmsInventoryUnit: { groupBy: jest.fn(async () => []) },
      wmsInventoryCountSession: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
      wmsReceivingBatch: {
        count: jest.fn(async () => 1),
        findMany: jest.fn(async () => []),
      },
      wmsPurchasingBatch: { groupBy: jest.fn(async () => []) },
      wmsOutboundUnitRecord: { groupBy: jest.fn(async () => []) },
      auditLog: { groupBy: jest.fn(async () => []) },
      analyticsEvent: { groupBy: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []),
      undeliverableAttempt: { groupBy: jest.fn(async () => []) },
      integration: { findMany: jest.fn(async () => []) },
      metaAdAccount: { findMany: jest.fn(async () => []) },
      pancakeWebhookLog: { findMany: jest.fn(async () => []) },
      posOrderSyncRecovery: {
        groupBy: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      workflowExecution: {
        groupBy: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
      creativeAiRun: {
        groupBy: jest.fn(async () => []),
        findMany: jest.fn(async () => []),
      },
    };

    const wmsReportsMock: any = {
      getSubscriptionsForTenants: jest.fn(async () => []),
    };

    const service = new OpsDigestService(prismaMock, wmsReportsMock);
    jest.spyOn(service as any, 'inspectRedisQueues').mockResolvedValue([
      {
        queue: 'pancake-webhook',
        wait: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: 0,
        oldestWaitingAgeSeconds: null,
        recentFailures: [],
      },
    ] as never);

    const digest = await service.getDailyDigest({ windowHours: 24 });

    expect(digest.meta.activeTenantCount).toBe(1);
    expect(digest.wms.staffActivities.issuesAndRejections).toHaveLength(1);
    const issue = digest.wms.staffActivities.issuesAndRejections[0];
    expect(issue.reasonCode).toBe('WRONG_VARIATION');
    expect(issue.sampleHints[0]).toEqual({
      reason: 'Contact [EMAIL] or [PHONE] with Bearer [REDACTED]',
      expectedVariationId: 'var-1',
    });
    expect(issue.sampleHints[0]).not.toHaveProperty('customerPhone');
  });

  it('sends email strictly to configured OPS_DIGEST_EMAIL_TO via Resend', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'email_123' }),
      text: async () => '',
    }));
    global.fetch = fetchMock as any;

    const service = new OpsDigestService({} as any, {} as any);
    const res = await service.sendDailyDigestEmail({
      subject: 'Daily WMS & ERP Ops Digest — 2026-11-11',
      text: 'Plain text summary',
      html: '<p>HTML summary</p>',
    });

    expect(res.delivered).toBe(true);
    expect(res.recipients).toEqual(['lewinskycandido@gmail.com']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody.to).toEqual(['lewinskycandido@gmail.com']);
    expect(parsedBody.subject).toBe('Daily WMS & ERP Ops Digest — 2026-11-11');
  });
});
