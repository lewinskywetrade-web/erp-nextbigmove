import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AuthController } from './auth.controller';
import { PermissionWorkspaceQueryDto } from '../../common/dto/permission-workspace-query.dto';

describe('AuthController workspace permissions', () => {
  let registry: { key: string }[];
  let prisma: { permission: { findMany: ReturnType<typeof jest.fn> } };
  let access: { resolveUserAccess: ReturnType<typeof jest.fn> };
  let controller: AuthController;
  const query = (workspace?: string) => ({ workspace } as PermissionWorkspaceQueryDto);

  beforeEach(() => {
    registry = [{ key: 'analytics.sales' }, { key: 'integration.read' }, { key: 'wms.inventory.read' }, { key: 'wms.receiving.read' }];
    prisma = { permission: { findMany: jest.fn(async () => registry) } };
    access = { resolveUserAccess: jest.fn(async () => ({ permissions: ['analytics.sales'], roles: [] })) };
    controller = new AuthController({} as never, prisma as never, access as never);
  });

  it.each([
    ['erp', ['analytics.sales', 'integration.read']],
    ['wms', ['wms.inventory.read', 'wms.receiving.read']],
    ['all', ['analytics.sales', 'integration.read', 'wms.inventory.read', 'wms.receiving.read']],
    [undefined, ['analytics.sales', 'integration.read']],
  ])('expands only registered SUPER_ADMIN keys for workspace %s', async (workspace, expected) => {
    const request = { user: { userId: 'owner', tenantId: 'tenant-a', role: 'SUPER_ADMIN', permissions: ['unregistered.permission'] } };
    await expect(controller.getPermissions(request, query(workspace as string | undefined))).resolves.toEqual({ permissions: expected });
    expect(prisma.permission.findMany).toHaveBeenCalledWith({ select: { key: true }, orderBy: { key: 'asc' } });
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('allows global SUPER_ADMIN registry discovery without inventing a tenant', async () => {
    await expect(controller.getPermissions({ user: { id: 'owner', tenantId: null, role: 'SUPER_ADMIN', permissions: [] } }, query('erp')))
      .resolves.toEqual({ permissions: ['analytics.sales', 'integration.read'] });
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('returns an empty registry honestly instead of fabricating grants', async () => {
    registry = [];
    await expect(controller.getPermissions({ user: { userId: 'owner', tenantId: 'tenant-a', role: 'SUPER_ADMIN' } }, query('all')))
      .resolves.toEqual({ permissions: [] });
  });

  it.each(['USER', 'ADMIN', 'VIEWER'])('preserves effective-permission scope and denial logic for ordinary role %s', async (role) => {
    await expect(controller.getPermissions({ user: { userId: 'user', tenantId: 'tenant-a', role, permissions: ['own.base.permission'] } }, query('erp')))
      .resolves.toEqual({ permissions: ['analytics.sales'] });
    expect(access.resolveUserAccess).toHaveBeenCalledWith({ userId: 'user', tenantId: 'tenant-a', basePermissions: ['own.base.permission'], workspace: 'erp' });
    expect(prisma.permission.findMany).not.toHaveBeenCalled();
  });

  it('preserves tenantless ordinary WMS permission resolution', async () => {
    await expect(controller.getPermissions({ user: { id: 'staff', role: 'USER', tenantId: null } }, query('wms')))
      .resolves.toEqual({ permissions: ['analytics.sales'] });
    expect(access.resolveUserAccess).toHaveBeenCalledWith({ userId: 'staff', basePermissions: [], workspace: 'wms' });
    expect(prisma.permission.findMany).not.toHaveBeenCalled();
  });

  it('keeps tenantless ordinary ERP users and identities without an ID from registry expansion', async () => {
    await expect(controller.getPermissions({ user: { userId: 'staff', role: 'USER', tenantId: null } }, query('erp'))).resolves.toEqual({ permissions: [] });
    await expect(controller.getPermissions({ user: { role: 'SUPER_ADMIN', tenantId: 'tenant-a' } }, query('erp'))).resolves.toEqual({ permissions: [] });
    expect(prisma.permission.findMany).not.toHaveBeenCalled();
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
  });
});
