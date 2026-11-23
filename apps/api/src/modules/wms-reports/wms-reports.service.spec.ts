import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import {
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
} from '@prisma/client';
import { WmsReportsService } from './wms-reports.service';
import { WmsDailyInventoryEmailService } from './wms-daily-inventory-email.service';

describe('WmsReportsService & WmsDailyInventoryEmailService', () => {
  const originalFetch = global.fetch;
  const originalResend = process.env.RESEND_API_KEY;
  const originalWarehouseRecipients = process.env.WMS_WAREHOUSE_DAILY_INVENTORY_RECIPIENTS;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalResend === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalResend;
    }
    if (originalWarehouseRecipients === undefined) {
      delete process.env.WMS_WAREHOUSE_DAILY_INVENTORY_RECIPIENTS;
    } else {
      process.env.WMS_WAREHOUSE_DAILY_INVENTORY_RECIPIENTS = originalWarehouseRecipients;
    }
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const createFixture = (options?: {
    isGlobalUser?: boolean;
    clsTenantId?: string;
  }) => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const tenant2Id = '44444444-4444-4444-8444-444444444444';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const store2Id = '55555555-5555-4555-8555-555555555555';
    const posProductId = '33333333-3333-4333-8333-333333333333';
    const posProduct2Id = '66666666-6666-4666-8666-666666666666';

    let savedSettings: Record<string, unknown> = {};
    let savedWarehouseSetting: Record<string, unknown> | null = null;

    const prisma = {
      tenant: {
        findMany: jest.fn(async () => [
          {
            id: tenantId,
            name: 'Next Big Move',
            slug: 'next-big-move',
            billingEmail: 'client@nextbigmove.test',
            settings: savedSettings,
          },
          {
            id: tenant2Id,
            name: 'FAMCO',
            slug: 'famco',
            billingEmail: 'client@famco.test',
            settings: {},
          },
        ]),
        findUnique: jest.fn(async () => ({
          id: tenantId,
          name: 'Next Big Move',
          billingEmail: 'client@nextbigmove.test',
          settings: savedSettings,
        })),
        update: jest.fn(async ({ data }: { data: { settings: Record<string, unknown> } }) => {
          savedSettings = data.settings;
          return { id: tenantId, settings: savedSettings };
        }),
      },
      user: {
        findMany: jest.fn(async (args?: { where?: { tenantId?: unknown } }) => {
          if (args?.where?.tenantId) {
            return [
              {
                tenantId,
                email: 'admin@nextbigmove.test',
                role: 'ADMIN',
              },
              {
                tenantId: tenant2Id,
                email: 'admin@famco.test',
                role: 'ADMIN',
              },
            ];
          }
          return [
            {
              id: 'user-stessey',
              email: 'stessey.soriano@wetrade.test',
              firstName: 'Stessey Anne',
              lastName: 'Soriano',
              tenantId: null,
            },
          ];
        }),
      },
      wmsSystemSetting: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
          if (where.key !== 'warehouse_daily_inventory_email' || !savedWarehouseSetting) {
            return null;
          }
          return { key: where.key, value: savedWarehouseSetting };
        }),
        upsert: jest.fn(
          async ({ create, update }: { create: { value: Record<string, unknown> }; update: { value: Record<string, unknown> } }) => {
            savedWarehouseSetting = savedWarehouseSetting ? update.value : create.value;
            return { key: 'warehouse_daily_inventory_email', value: savedWarehouseSetting };
          },
        ),
      },
      posStore: {
        findMany: jest.fn(async () => [
          {
            id: storeId,
            tenantId,
            shopId: 'shop-1',
            name: 'Main Store',
            shopName: 'Main Store',
            tenant: { name: 'Next Big Move' },
          },
          {
            id: store2Id,
            tenantId: tenant2Id,
            shopId: 'shop-2',
            name: 'Nourio',
            shopName: 'Nourio',
            tenant: { name: 'FAMCO' },
          },
        ]),
      },
      posProduct: {
        findMany: jest.fn(async () => [
          {
            id: posProductId,
            storeId,
            productId: 'prod-1',
            variationId: 'var-1',
            customId: 'SKU-001',
            name: 'Sample Serum',
            productSnapshot: { display_id: 'SKU-001' },
          },
          {
            id: posProduct2Id,
            storeId: store2Id,
            productId: 'prod-2',
            variationId: 'var-2',
            customId: 'NUR-001',
            name: 'Nourio Gummies',
            productSnapshot: { display_id: 'NUR-001' },
          },
        ]),
      },
      wmsInventoryUnit: {
        groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.currentLocation) {
            return [
              { posProductId, _count: { _all: 12 } },
              { posProductId: posProduct2Id, _count: { _all: 25 } },
            ];
          }
          return [
            { posProductId, status: WmsInventoryUnitStatus.PUTAWAY, _count: { _all: 12 } },
            { posProductId, status: WmsInventoryUnitStatus.RECEIVED, _count: { _all: 3 } },
            { posProductId, status: WmsInventoryUnitStatus.RESERVED, _count: { _all: 2 } },
            { posProductId: posProduct2Id, status: WmsInventoryUnitStatus.PUTAWAY, _count: { _all: 25 } },
          ];
        }),
      },
      wmsInventoryMovement: {
        findMany: jest.fn(async () => [
          {
            id: 'mov-1',
            tenantId,
            movementType: WmsInventoryMovementType.RECEIPT,
            fromStatus: null,
            toStatus: WmsInventoryUnitStatus.RECEIVED,
            referenceCode: 'RCV-001',
            notes: 'Batch receipt',
            createdAt: new Date('2026-11-10T02:00:00.000Z'),
            inventoryUnit: {
              id: 'unit-1',
              code: 'U-001',
              storeId,
              posProductId,
              productId: 'prod-1',
              variationId: 'var-1',
              posProduct: {
                id: posProductId,
                name: 'Sample Serum',
                customId: 'SKU-001',
                productSnapshot: null,
              },
            },
            fromLocation: null,
            toLocation: { code: 'STAGE-1', name: 'Staging 1' },
            actor: { firstName: 'Warehouse', lastName: 'Staff', email: 'staff@wms.test' },
          },
          {
            id: 'mov-2',
            tenantId,
            movementType: WmsInventoryMovementType.PUTAWAY,
            fromStatus: WmsInventoryUnitStatus.RECEIVED,
            toStatus: WmsInventoryUnitStatus.PUTAWAY,
            referenceCode: 'PUT-001',
            notes: 'Putaway to bin',
            createdAt: new Date('2026-11-10T03:00:00.000Z'),
            inventoryUnit: {
              id: 'unit-1',
              code: 'U-001',
              storeId,
              posProductId,
              productId: 'prod-1',
              variationId: 'var-1',
              posProduct: {
                id: posProductId,
                name: 'Sample Serum',
                customId: 'SKU-001',
                productSnapshot: null,
              },
            },
            fromLocation: { code: 'STAGE-1', name: 'Staging 1' },
            toLocation: { code: 'BIN-A1', name: 'Bin A1' },
            actor: { firstName: 'Warehouse', lastName: 'Staff', email: 'staff@wms.test' },
          },
          {
            id: 'mov-3',
            tenantId,
            movementType: WmsInventoryMovementType.DISPATCH,
            fromStatus: WmsInventoryUnitStatus.PACKED,
            toStatus: WmsInventoryUnitStatus.DISPATCHED,
            referenceCode: 'ORD-100',
            notes: 'Shipped',
            createdAt: new Date('2026-11-10T05:00:00.000Z'),
            inventoryUnit: {
              id: 'unit-2',
              code: 'U-002',
              storeId,
              posProductId,
              productId: 'prod-1',
              variationId: 'var-1',
              posProduct: {
                id: posProductId,
                name: 'Sample Serum',
                customId: 'SKU-001',
                productSnapshot: null,
              },
            },
            fromLocation: { code: 'BIN-A1', name: 'Bin A1' },
            toLocation: null,
            actor: { firstName: 'Dispatch', lastName: 'Lead', email: 'dispatch@wms.test' },
          },
          {
            id: 'mov-4',
            tenantId: tenant2Id,
            movementType: WmsInventoryMovementType.MANUAL_RECEIPT,
            fromStatus: null,
            toStatus: WmsInventoryUnitStatus.RECEIVED,
            referenceCode: 'MAN-002',
            notes: 'Manual stock in',
            createdAt: new Date('2026-11-10T06:00:00.000Z'),
            inventoryUnit: {
              id: 'unit-3',
              code: 'U-003',
              storeId: store2Id,
              posProductId: posProduct2Id,
              productId: 'prod-2',
              variationId: 'var-2',
              posProduct: {
                id: posProduct2Id,
                name: 'Nourio Gummies',
                customId: 'NUR-001',
                productSnapshot: null,
              },
            },
            fromLocation: null,
            toLocation: { code: 'STAGE-2', name: 'Staging 2' },
            actor: { firstName: 'Stessey Anne', lastName: 'Soriano', email: 'stessey.soriano@wetrade.test' },
          },
        ]),
      },
    };

    const isGlobalUser = options?.isGlobalUser ?? true;
    const cls = {
      get: jest.fn((key: string) => {
        if (key === 'tenantId') return options?.clsTenantId ?? (isGlobalUser ? tenantId : tenantId);
        if (key === 'userRole') return isGlobalUser ? 'SUPER_ADMIN' : 'ADMIN';
        if (key === 'wmsGlobalAccess') return isGlobalUser;
        return undefined;
      }),
    };

    const reportsService = new WmsReportsService(prisma as never, cls as never);
    const emailService = new WmsDailyInventoryEmailService(prisma as never, reportsService);

    return { tenantId, tenant2Id, storeId, posProductId, prisma, reportsService, emailService };
  };

  it('aggregates daily inventory ins and outs without double-counting putaway as stock-in', async () => {
    const { reportsService } = createFixture();
    const report = await reportsService.getDailyInventoryMovementsReport({
      date: '2026-11-10',
      tenantIds: [],
      storeIds: [],
    });

    expect(report.totals.receivedInQty).toBe(1);
    expect(report.totals.manualInQty).toBe(1);
    expect(report.totals.totalInQty).toBe(2);
    expect(report.totals.putAwayMovedQty).toBe(1);
    expect(report.totals.dispatchedOutQty).toBe(1);
    expect(report.totals.totalOutQty).toBe(1);
    expect(report.totals.netChangeQty).toBe(1);
    expect(report.totals.inBinQty).toBe(37);
    expect(report.totals.awaitingPutAwayQty).toBe(3);
    expect(report.totals.reservedQty).toBe(2);
    expect(report.totals.onHandQty).toBe(42);
    expect(report.recentMovements).toHaveLength(4);
    expect(report.warehouseSubscription?.effectiveRecipients).toEqual([
      'stessey.soriano@wetrade.test',
    ]);
  });

  it('updates daily email subscription and sends daily report email', async () => {
    const { tenantId, reportsService, emailService } = createFixture();

    const updated = await reportsService.updateDailyEmailSubscription({
      tenantId,
      enabled: true,
      recipients: ['ops@nextbigmove.test'],
      sendTimeManila: '19:30',
    });

    expect(updated.subscription.enabled).toBe(true);
    expect(updated.subscription.recipients).toEqual(['ops@nextbigmove.test']);
    expect(updated.subscription.sendTimeManila).toBe('19:30');

    const sent = await emailService.sendNow({
      tenantId,
      date: '2026-11-10',
    });

    expect(sent.recipients).toEqual(['ops@nextbigmove.test']);
    expect(sent.subject).toContain('Next Big Move');
    expect(sent.preview.csvContent).toContain('Sample Serum');
    expect(sent.subscription.lastSentDate).toBe('2026-11-10');
  });

  it('builds and sends one consolidated all-client warehouse email grouped by client to Stessey Anne Soriano', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-10T03:00:00.000Z')); // 11:00 Asia/Manila (before 20:00)

    const { reportsService, emailService } = createFixture();

    const preview = await emailService.previewWarehouseNow({ date: '2026-11-10' });
    expect(preview.clientCount).toBe(2);
    expect(preview.subject).toBe('[Warehouse Daily Inventory Ins & Outs] All Clients — 2026-11-10');
    expect(preview.html).toContain('Summary by Client');
    expect(preview.html).toContain('Detailed Stock Ins &amp; Outs Per Client');
    expect(preview.html).toContain('Next Big Move');
    expect(preview.html).toContain('FAMCO');
    expect(preview.html).toContain('Sample Serum');
    expect(preview.html).toContain('Nourio Gummies');
    expect(preview.html).toContain('RCV-001');
    expect(preview.html).toContain('MAN-002');
    expect(preview.text).toContain('=== FAMCO');
    expect(preview.text).toContain('=== NEXT BIG MOVE');
    expect(preview.csvFilename).toBe('warehouse-inventory-ins-outs-all-clients-2026-11-10.csv');
    expect(preview.subscription.effectiveRecipients).toEqual(['stessey.soriano@wetrade.test']);

    // Manual send before 20:00 Manila should send immediately without marking today's 20:00 cron as done
    const manualSent = await emailService.sendWarehouseNow({ date: '2026-11-10' });
    expect(manualSent.recipients).toEqual(['stessey.soriano@wetrade.test']);
    expect(manualSent.subscription.lastSentDate).toBeNull();

    const updatedSub = await reportsService.updateWarehouseDailyEmailSubscription({
      enabled: true,
      recipients: ['stessey.soriano@wetrade.test', 'ops-lead@wetrade.test'],
      sendTimeManila: '20:00',
    });
    expect(updatedSub.subscription.effectiveRecipients).toEqual([
      'stessey.soriano@wetrade.test',
      'ops-lead@wetrade.test',
    ]);
  });

  it('automatically sends the warehouse consolidated email once per day at 20:00 Asia/Manila', async () => {
    jest.useFakeTimers();
    process.env.RESEND_API_KEY = 're_test_key';
    const fetchMock = jest.fn(async (_input: unknown, _init?: unknown) => ({
      ok: true,
      json: async () => ({ id: 'email_ok' }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const getWarehouseEmailBodies = () =>
      fetchMock.mock.calls
        .map((call) => {
          const init = call[1] as { body?: string } | undefined;
          return init?.body
            ? (JSON.parse(init.body) as { to: string[]; subject: string; html: string })
            : null;
        })
        .filter((item): item is { to: string[]; subject: string; html: string } =>
          Boolean(item && String(item.subject).includes('All Clients')),
        );

    const { reportsService, emailService } = createFixture();
    // Disable per-tenant cron emails in this test so we isolate the single consolidated warehouse email
    await reportsService.updateDailyEmailSubscription({
      tenantId: '11111111-1111-4111-8111-111111111111',
      enabled: false,
    });

    // At 19:55 Asia/Manila (11:55 UTC), cron should NOT send yet
    jest.setSystemTime(new Date('2026-11-10T11:55:00.000Z'));
    await emailService.processScheduledDailyEmails();
    expect(getWarehouseEmailBodies()).toHaveLength(0);

    // At 20:00 Asia/Manila (12:00 UTC), cron sends exactly ONE consolidated email to Stessey
    jest.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
    await emailService.processScheduledDailyEmails();
    const warehouseBodiesAt20 = getWarehouseEmailBodies();
    expect(warehouseBodiesAt20).toHaveLength(1);
    const body = warehouseBodiesAt20[0];
    expect(body.to).toEqual(['stessey.soriano@wetrade.test']);
    expect(body.subject).toBe('[Warehouse Daily Inventory Ins & Outs] All Clients — 2026-11-10');
    expect(body.html).toContain('Next Big Move');
    expect(body.html).toContain('FAMCO');

    // Subsequent 5-minute check at 20:05 Asia/Manila MUST NOT send a duplicate email
    jest.setSystemTime(new Date('2026-11-10T12:05:00.000Z'));
    await emailService.processScheduledDailyEmails();
    expect(getWarehouseEmailBodies()).toHaveLength(1);
  });

  it('forbids tenant-scoped users from viewing or updating warehouse-wide daily email endpoints', async () => {
    const { reportsService, emailService } = createFixture({ isGlobalUser: false });

    await expect(
      reportsService.updateWarehouseDailyEmailSubscription({ enabled: false }),
    ).rejects.toThrow(ForbiddenException);
    await expect(emailService.previewWarehouseNow({ date: '2026-11-10' })).rejects.toThrow(
      ForbiddenException,
    );
    await expect(emailService.sendWarehouseNow({ date: '2026-11-10' })).rejects.toThrow(
      ForbiddenException,
    );

    const tenantReport = await reportsService.getDailyInventoryMovementsReport({
      date: '2026-11-10',
      tenantIds: [],
      storeIds: [],
    });
    expect(tenantReport).not.toHaveProperty('warehouseSubscription');
  });
});
