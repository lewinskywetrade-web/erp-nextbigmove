import { describe, expect, it, jest } from '@jest/globals';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { TeamGuard } from '../../common/guards/team.guard';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { ReportsController } from './reports.controller';

describe('ReportsController', () => {
  it('enforces JwtAuthGuard, TenantGuard, TeamGuard, and PermissionsGuard at controller level', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ReportsController);
    expect(guards).toEqual([JwtAuthGuard, TenantGuard, TeamGuard, PermissionsGuard]);
  });

  it('grants daily-inventory-movements read permission to daily_inventory, pos_orders, and stock_request readers and forwards client portal scope', async () => {
    const permissions = Reflect.getMetadata(
      PERMISSIONS_KEY,
      ReportsController.prototype.getDailyInventoryMovements,
    );
    expect(permissions).toEqual([
      'reports.daily_inventory.read',
      'reports.pos_orders.read',
      'stock_request.read',
    ]);

    const wmsReportsService = {
      getDailyInventoryMovementsReport: jest.fn(async () => ({ rows: [] })),
      updateDailyEmailSubscription: jest.fn(async () => ({ subscription: {} })),
    };
    const wmsDailyInventoryEmailService = {
      sendNow: jest.fn(async () => ({ status: 'SENT' })),
    };
    const controller = new ReportsController(
      {} as any,
      wmsReportsService as any,
      wmsDailyInventoryEmailService as any,
    );

    const query = { startDate: '2026-11-19', endDate: '2026-11-19', storeIds: ['store-1'] };
    await controller.getDailyInventoryMovements(query as any);
    expect(wmsReportsService.getDailyInventoryMovementsReport).toHaveBeenCalledWith(query, {
      enforceClientPortalScope: true,
    });

    await controller.updateDailyInventorySubscription({ enabled: true } as any);
    expect(wmsReportsService.updateDailyEmailSubscription).toHaveBeenCalledWith(
      { enabled: true },
      { enforceClientPortalScope: true },
    );

    await controller.sendDailyInventoryEmail({ date: '2026-11-19' } as any);
    expect(wmsDailyInventoryEmailService.sendNow).toHaveBeenCalledWith(
      { date: '2026-11-19' },
      { enforceClientPortalScope: true },
    );
  });

  it('restricts subscription mutations and manual emails to admin-level permissions', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        ReportsController.prototype.updateDailyInventorySubscription,
      ),
    ).toEqual(['reports.pos_orders.read', 'tenant.manage']);
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        ReportsController.prototype.sendDailyInventoryEmail,
      ),
    ).toEqual(['reports.pos_orders.read', 'tenant.manage']);
  });
});
