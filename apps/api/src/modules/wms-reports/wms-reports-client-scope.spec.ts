import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import {
  TenantStatus,
  UserRole,
  WmsInventoryMovementType,
  WmsInventoryUnitStatus,
} from '@prisma/client';
import { GetWmsDailyInventoryMovementsDto } from './dto/get-wms-daily-inventory-movements.dto';
import { WmsReportsService } from './wms-reports.service';
import { WmsDailyInventoryEmailService } from './wms-daily-inventory-email.service';

type AsyncMock = jest.Mock<(...args: any[]) => Promise<any>>;
const mockAsync = (value?: unknown): AsyncMock =>
  jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(value);

describe('WmsReportsService & WmsDailyInventoryEmailService client portal isolation', () => {
  const makeQuery = (
    overrides: Partial<GetWmsDailyInventoryMovementsDto> = {},
  ): GetWmsDailyInventoryMovementsDto =>
    Object.assign(new GetWmsDailyInventoryMovementsDto(), {
      startDate: '2026-11-19',
      endDate: '2026-11-19',
      tenantIds: [],
      storeIds: [],
      ...overrides,
    });

  const createCls = (values: Record<string, unknown>) => ({
    get: jest.fn((key: string) => values[key]),
  });

  const createPrismaMock = () => ({
    tenant: {
      findMany: mockAsync([
        { id: 'tenant-a', name: 'Next Big Move', slug: 'next-big-move', status: TenantStatus.ACTIVE, settings: {} },
      ]),
      findUnique: mockAsync({
        id: 'tenant-a',
        name: 'Next Big Move',
        settings: {},
      }),
      update: mockAsync({ id: 'tenant-a' }),
    },
    user: {
      findMany: mockAsync([
        { email: 'owner@nextbigmove.com', firstName: 'Owner', lastName: 'Admin', role: UserRole.ADMIN },
      ]),
    },
    posStore: {
      findMany: mockAsync([]),
    },
    posProduct: {
      findMany: mockAsync([]),
    },
    wmsInventoryUnit: {
      groupBy: mockAsync([]),
    },
    wmsInventoryMovement: {
      findMany: mockAsync([]),
    },
    wmsSystemSetting: {
      findUnique: mockAsync(null),
    },
    team: {
      count: mockAsync(2),
    },
  });

  const createTeamContext = (overrides: Partial<{
    tenantId: string | undefined;
    teamId: string | undefined;
    teamIds: string[] | undefined;
    userId: string | undefined;
    role: string | undefined;
    isAdmin: boolean;
    userTeams: string[];
    tenantHasTeams: boolean;
  }> = {}) => ({
    getContext: mockAsync({
      tenantId: 'tenant-a',
      teamId: undefined,
      teamIds: [],
      userId: 'user-1',
      role: UserRole.USER,
      isAdmin: false,
      userTeams: [],
      tenantHasTeams: true,
      ...overrides,
    }),
  });

  it('prevents SUPER_ADMIN with wmsGlobalAccess from seeing other tenants or warehouseSubscription in client portal scope', async () => {
    const prisma = createPrismaMock();
    const cls = createCls({
      tenantId: 'tenant-a',
      userRole: UserRole.SUPER_ADMIN,
      wmsGlobalAccess: true,
    });
    const teamContext = createTeamContext({ isAdmin: true, role: UserRole.SUPER_ADMIN });
    const service = new WmsReportsService(prisma as any, cls as any, teamContext as any);

    await expect(
      service.getDailyInventoryMovementsReport(
        makeQuery({ tenantIds: ['tenant-b'] }),
        { enforceClientPortalScope: true },
      ),
    ).rejects.toThrow(ForbiddenException);

    const ownReport = await service.getDailyInventoryMovementsReport(
      makeQuery(),
      { enforceClientPortalScope: true },
    );

    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'tenant-a' }),
      }),
    );
    expect((ownReport as { warehouseSubscription?: unknown }).warehouseSubscription).toBeUndefined();
    expect(prisma.wmsSystemSetting.findUnique).not.toHaveBeenCalled();
  });

  it('scopes products, totals, and recentMovements strictly to the user teams and excludes shared/other stores, disabled stores, and internal excluded stores', async () => {
    const prisma = createPrismaMock();
    prisma.posStore.findMany.mockResolvedValue([
      {
        id: 'store-team-1',
        tenantId: 'tenant-a',
        teamId: 'team-1',
        shopId: 'shop-1',
        name: 'Team 1 Direct Store',
        shopName: 'Team 1 Direct Store',
        enabled: true,
        integration: null,
        tenant: { name: 'Next Big Move' },
      },
      {
        id: 'store-shared-1',
        tenantId: 'tenant-a',
        teamId: 'team-2',
        shopId: 'shop-shared',
        name: 'Shared Team 1 Store',
        shopName: 'Shared Team 1 Store',
        enabled: true,
        integration: {
          teamId: 'team-2',
          sharedTeams: [{ teamId: 'team-1' }],
        },
        tenant: { name: 'Next Big Move' },
      },
      {
        id: 'store-other-team',
        tenantId: 'tenant-a',
        teamId: 'team-2',
        shopId: 'shop-2',
        name: 'Team 2 Private Store',
        shopName: 'Team 2 Private Store',
        enabled: true,
        integration: { teamId: 'team-2', sharedTeams: [] },
        tenant: { name: 'Next Big Move' },
      },
      {
        id: 'store-disabled',
        tenantId: 'tenant-a',
        teamId: 'team-1',
        shopId: 'shop-disabled',
        name: 'Disabled Store',
        shopName: 'Disabled Store',
        enabled: false,
        integration: null,
        tenant: { name: 'Next Big Move' },
      },
      {
        id: 'store-ogimi',
        tenantId: 'tenant-a',
        teamId: 'team-1',
        shopId: 'ogimi-shop',
        name: 'Ogimi Wellness',
        shopName: 'Ogimi Wellness',
        enabled: true,
        integration: null,
        tenant: { name: 'Next Big Move' },
      },
    ]);

    prisma.posProduct.findMany.mockResolvedValue([
      {
        id: 'prod-1',
        storeId: 'store-team-1',
        productId: 'p-1',
        variationId: 'v-1',
        customId: 'SKU-T1',
        name: 'Team 1 Cream',
        productSnapshot: null,
      },
      {
        id: 'prod-shared',
        storeId: 'store-shared-1',
        productId: 'p-shared',
        variationId: 'v-shared',
        customId: 'SKU-SH',
        name: 'Shared Soap',
        productSnapshot: null,
      },
      {
        id: 'prod-foreign-bleed',
        storeId: 'store-other-team',
        productId: 'p-other',
        variationId: 'v-other',
        customId: 'SKU-T2',
        name: 'Other Store Secret Product',
        productSnapshot: null,
      },
    ]);

    prisma.wmsInventoryUnit.groupBy
      .mockResolvedValueOnce([
        { posProductId: 'prod-1', status: WmsInventoryUnitStatus.PUTAWAY, _count: { _all: 10 } },
        { posProductId: 'prod-foreign-bleed', status: WmsInventoryUnitStatus.PUTAWAY, _count: { _all: 99 } },
      ])
      .mockResolvedValueOnce([
        { posProductId: 'prod-1', _count: { _all: 10 } },
        { posProductId: 'prod-foreign-bleed', _count: { _all: 99 } },
      ]);

    const movementTime = new Date('2026-11-19T02:00:00.000Z');
    prisma.wmsInventoryMovement.findMany.mockResolvedValue([
      {
        id: 'mov-valid-in',
        tenantId: 'tenant-a',
        movementType: WmsInventoryMovementType.RECEIPT,
        fromStatus: null,
        toStatus: WmsInventoryUnitStatus.RECEIVED,
        referenceCode: 'RCV-101',
        notes: null,
        createdAt: movementTime,
        fromLocation: null,
        toLocation: { code: 'STAGE-01', name: 'Staging' },
        actor: { firstName: 'WMS', lastName: 'Staff', email: 'wms@test.com' },
        inventoryUnit: {
          id: 'unit-1',
          code: 'U-1',
          tenantId: 'tenant-a',
          storeId: 'store-team-1',
          posProductId: 'prod-1',
          productId: 'p-1',
          variationId: 'v-1',
          posProduct: {
            id: 'prod-1',
            storeId: 'store-team-1',
            name: 'Team 1 Cream',
            customId: 'SKU-T1',
            productSnapshot: null,
            store: { tenantId: 'tenant-a' },
          },
        },
      },
      {
        // Defense-in-depth: mismatched posProduct.storeId must NEVER bleed in
        id: 'mov-mismatched-product',
        tenantId: 'tenant-a',
        movementType: WmsInventoryMovementType.DISPATCH,
        fromStatus: WmsInventoryUnitStatus.PACKED,
        toStatus: WmsInventoryUnitStatus.DISPATCHED,
        referenceCode: 'DSP-BLEED',
        notes: null,
        createdAt: movementTime,
        fromLocation: null,
        toLocation: null,
        actor: null,
        inventoryUnit: {
          id: 'unit-bleed',
          code: 'U-BLEED',
          tenantId: 'tenant-a',
          storeId: 'store-team-1',
          posProductId: 'prod-cross-store',
          productId: 'p-bleed',
          variationId: 'v-bleed',
          posProduct: {
            id: 'prod-cross-store',
            storeId: 'store-other-team',
            name: 'Cross Store Bleed Product',
            customId: 'BLEED-01',
            productSnapshot: null,
            store: { tenantId: 'tenant-a' },
          },
        },
      },
      {
        // Foreign tenant movement mock must be ignored
        id: 'mov-foreign-tenant',
        tenantId: 'tenant-b',
        movementType: WmsInventoryMovementType.DISPATCH,
        fromStatus: WmsInventoryUnitStatus.PACKED,
        toStatus: WmsInventoryUnitStatus.DISPATCHED,
        referenceCode: 'DSP-999',
        notes: null,
        createdAt: movementTime,
        fromLocation: null,
        toLocation: null,
        actor: null,
        inventoryUnit: {
          id: 'unit-2',
          code: 'U-2',
          tenantId: 'tenant-b',
          storeId: 'store-other-team',
          posProductId: 'prod-foreign-bleed',
          productId: 'p-other',
          variationId: 'v-other',
          posProduct: {
            id: 'prod-foreign-bleed',
            storeId: 'store-other-team',
            name: 'Other Tenant Product',
            customId: 'TENANT-B',
            productSnapshot: null,
            store: { tenantId: 'tenant-b' },
          },
        },
      },
    ]);

    const cls = createCls({
      tenantId: 'tenant-a',
      userRole: 'TEAM_LEAD',
      teamIds: ['team-1'],
    });
    const teamContext = createTeamContext({
      isAdmin: false,
      userTeams: ['team-1'],
      teamIds: ['team-1'],
    });
    const service = new WmsReportsService(prisma as any, cls as any, teamContext as any);

    const report = await service.getDailyInventoryMovementsReport(
      makeQuery(),
      { enforceClientPortalScope: true },
    );

    expect(report.filters.stores.map((s) => s.id)).toEqual(['store-team-1', 'store-shared-1']);
    expect((report.filters as { isTeamScoped?: boolean }).isTeamScoped).toBe(true);
    expect(
      (report.filters as { canManageEmailSubscription?: boolean }).canManageEmailSubscription,
    ).toBe(false);
    expect(report.subscriptions).toEqual([]);
    expect(report.rows.map((r) => r.variantName)).toEqual(['Team 1 Cream', 'Shared Soap']);
    expect(report.totals.totalInQty).toBe(1);
    expect(report.totals.totalOutQty).toBe(0);
    expect(report.recentMovements.map((m) => m.id)).toEqual(['mov-valid-in']);

    // Verify Prisma queries enforced both tenant relation and allowed storeIds
    expect(prisma.posProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: { in: ['store-team-1', 'store-shared-1'] },
          store: { is: { tenantId: { in: ['tenant-a'] } } },
        }),
      }),
    );

    // Selecting an unauthorized storeId from Team 2 must throw ForbiddenException
    await expect(
      service.getDailyInventoryMovementsReport(
        makeQuery({ storeIds: ['store-other-team'] }),
        { enforceClientPortalScope: true },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns zero stores and zero products when a non-admin in a teamed tenant has no team assignments', async () => {
    const prisma = createPrismaMock();
    const cls = createCls({ tenantId: 'tenant-a', userRole: UserRole.USER });
    const teamContext = createTeamContext({
      isAdmin: false,
      userTeams: [],
      teamIds: [],
      tenantHasTeams: true,
    });
    const service = new WmsReportsService(prisma as any, cls as any, teamContext as any);

    const report = await service.getDailyInventoryMovementsReport(
      makeQuery(),
      { enforceClientPortalScope: true },
    );

    expect(prisma.posStore.findMany).not.toHaveBeenCalled();
    expect(prisma.posProduct.findMany).not.toHaveBeenCalled();
    expect(report.filters.stores).toEqual([]);
    expect(report.rows).toEqual([]);
    expect(report.recentMovements).toEqual([]);
    expect(report.subscriptions).toEqual([]);

    await expect(
      service.getDailyInventoryMovementsReport(
        makeQuery({ storeIds: ['store-team-1'] }),
        { enforceClientPortalScope: true },
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('forbids team-scoped or non-admin users from modifying or triggering tenant-wide daily emails, while allowing unrestricted TENANT_ADMIN', async () => {
    const prisma = createPrismaMock();
    const cls = createCls({
      tenantId: 'tenant-a',
      userRole: UserRole.ADMIN,
      teamIds: ['team-1'],
    });
    // Admin currently filtered to team-1 via X-Team-ID must not send tenant-wide email
    const filteredAdminCtx = createTeamContext({
      isAdmin: true,
      role: UserRole.ADMIN,
      teamIds: ['team-1'],
    });
    const service = new WmsReportsService(prisma as any, cls as any, filteredAdminCtx as any);
    const emailService = new WmsDailyInventoryEmailService(prisma as any, service);

    await expect(
      service.updateDailyEmailSubscription(
        { enabled: true, recipients: ['a@b.com'] },
        { enforceClientPortalScope: true },
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      emailService.sendNow(
        { startDate: '2026-11-19', endDate: '2026-11-19' },
        { enforceClientPortalScope: true },
      ),
    ).rejects.toThrow(ForbiddenException);

    // Unrestricted TENANT_ADMIN (All Teams) can save subscription and still enforces client scope
    const fullAdminCtx = createTeamContext({
      isAdmin: true,
      role: UserRole.ADMIN,
      teamIds: [],
    });
    const fullAdminService = new WmsReportsService(prisma as any, cls as any, fullAdminCtx as any);
    const updated = await fullAdminService.updateDailyEmailSubscription(
      { enabled: true, recipients: ['ops@nextbigmove.com'] },
      { enforceClientPortalScope: true },
    );
    expect(prisma.tenant.update).toHaveBeenCalled();
    expect(updated.subscription.tenantId).toBe('tenant-a');
  });
});
