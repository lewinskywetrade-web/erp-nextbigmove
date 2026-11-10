import { describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { TenantService } from './tenant.service';

describe('TenantService.findUsers', () => {
  it('lists home and granted users with roles/teams scoped to the partner', async () => {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ id: 't1', name: 'Next Big Move' })) },
      user: {
        findMany: jest.fn(async () => [
          { id: 'u1', email: 'a@x.com', firstName: 'A', lastName: 'B', role: 'USER', status: 'ACTIVE', tenantId: 't1',
            createdAt: new Date(), lastLoginAt: null,
            userRoleAssignments: [
              { role: { name: 'Tenant Admin', key: 'TENANT_ADMIN' }, team: null },
              { role: { name: 'Tenant Admin', key: 'TENANT_ADMIN' }, team: { name: 'Zenith' } },
            ] },
          { id: 'u2', email: 'b@x.com', firstName: null, lastName: null, role: 'USER', status: 'INVITED', tenantId: 'other',
            createdAt: new Date(), lastLoginAt: null, userRoleAssignments: [] },
        ]),
      },
    };
    const result = await new TenantService(prisma).findUsers('t1');
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ tenantId: 't1' }, { tenantMemberships: { some: { tenantId: 't1', status: 'ACTIVE' } } }]);
    expect(prisma.user.findMany.mock.calls[0][0].select.userRoleAssignments.where).toEqual({ tenantId: 't1' });
    expect(prisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('password');
    expect(result.users[0]).toMatchObject({ membership: 'HOME', roles: ['Tenant Admin'], teams: ['Zenith'] });
    expect(result.users[0]).not.toHaveProperty('tenantId');
    expect(result.users[1]).toMatchObject({ membership: 'GRANTED', roles: [], teams: [] });
  });

  it('returns 404 for an unknown partner', async () => {
    const prisma: any = { tenant: { findUnique: jest.fn(async () => null) }, user: { findMany: jest.fn() } };
    await expect(new TenantService(prisma).findUsers('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
