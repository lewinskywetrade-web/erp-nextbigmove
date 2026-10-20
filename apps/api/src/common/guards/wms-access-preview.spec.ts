import { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import { WmsAccessGuard } from './wms-access.guard';

describe('ERP View As stays outside the global WMS staff surface', () => {
  it.each(['SUPER_ADMIN', 'USER'])('blocks preview target role %s before any WMS tenant selection', async (role) => {
    const prisma = { tenant: { findUnique: jest.fn() } };
    const cls = { set: jest.fn() };
    const access = { resolveUserAccess: jest.fn() };
    const guard = new WmsAccessGuard({ getAllAndOverride: () => [] } as never, cls as never, prisma as never, access as never);
    const context = {
      getHandler: () => ({}), getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: 'target', role, tenantId: 'tenant', impersonatedBy: 'admin' },
          headers: { 'x-tenant-id': 'another-tenant' }, query: { tenantIds: ['other-a', 'other-b'] },
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).rejects.toThrow('View As is available for ERP');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(cls.set).not.toHaveBeenCalled();
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('retains ordinary Super Admin WMS access', async () => {
    const guard = new WmsAccessGuard({ getAllAndOverride: () => [] } as never, { set: jest.fn() } as never, {} as never, {} as never);
    const context = {
      getHandler: () => ({}), getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user: { userId: 'admin', role: 'SUPER_ADMIN', tenantId: null } }) }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
