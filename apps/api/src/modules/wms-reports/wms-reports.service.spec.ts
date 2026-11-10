import { describe, expect, it, jest } from '@jest/globals';
import {
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
} from '@prisma/client';
import { WmsReportsService } from './wms-reports.service';
import { WmsDailyInventoryEmailService } from './wms-daily-inventory-email.service';

describe('WmsReportsService & WmsDailyInventoryEmailService', () => {
  const createFixture = () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const posProductId = '33333333-3333-4333-8333-333333333333';

    let savedSettings: Record<string, unknown> = {};

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
        findMany: jest.fn(async () => [
          {
            tenantId,
            email: 'admin@nextbigmove.test',
            role: 'ADMIN',
          },
        ]),
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
        ]),
      },
      wmsInventoryUnit: {
        groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.currentLocation) {
            return [{ posProductId, _count: { _all: 12 } }];
          }
          return [
            { posProductId, status: WmsInventoryUnitStatus.PUTAWAY, _count: { _all: 12 } },
            { posProductId, status: WmsInventoryUnitStatus.RECEIVED, _count: { _all: 3 } },
            { posProductId, status: WmsInventoryUnitStatus.RESERVED, _count: { _all: 2 } },
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
        ]),
      },
    };

    const cls = {
      get: jest.fn((key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'userRole') return 'SUPER_ADMIN';
        if (key === 'wmsGlobalAccess') return true;
        return undefined;
      }),
    };

    const reportsService = new WmsReportsService(prisma as never, cls as never);
    const emailService = new WmsDailyInventoryEmailService(prisma as never, reportsService);

    return { tenantId, storeId, posProductId, reportsService, emailService };
  };

  it('aggregates daily inventory ins and outs without double-counting putaway as stock-in', async () => {
    const { reportsService } = createFixture();
    const report = await reportsService.getDailyInventoryMovementsReport({
      date: '2026-11-10',
      tenantIds: [],
      storeIds: [],
    });

    expect(report.totals.receivedInQty).toBe(1);
    expect(report.totals.totalInQty).toBe(1);
    expect(report.totals.putAwayMovedQty).toBe(1);
    expect(report.totals.dispatchedOutQty).toBe(1);
    expect(report.totals.totalOutQty).toBe(1);
    expect(report.totals.netChangeQty).toBe(0);
    expect(report.totals.inBinQty).toBe(12);
    expect(report.totals.awaitingPutAwayQty).toBe(3);
    expect(report.totals.reservedQty).toBe(2);
    expect(report.totals.onHandQty).toBe(17);
    expect(report.recentMovements).toHaveLength(3);
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
});
