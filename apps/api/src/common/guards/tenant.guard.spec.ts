import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TeamContextService } from '../services/team-context.service';
import { TenantGuard } from './tenant.guard';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';

describe('TenantGuard authenticated tenant context', () => {
  let values: Map<string, unknown>;
  let cls: { set: ReturnType<typeof jest.fn>; get: ReturnType<typeof jest.fn> };
  let prisma: { tenant: { findUnique: ReturnType<typeof jest.fn> } };
  let guard: TenantGuard;
  const context = (user: unknown, headers = {}) => ({
    switchToHttp: () => ({ getRequest: () => ({ user, headers }) }),
  } as ExecutionContext);

  beforeEach(() => {
    values = new Map();
    cls = {
      set: jest.fn((key: string, value: unknown) => { values.set(key, value); }),
      get: jest.fn((key: string) => values.get(key)),
    };
    prisma = { tenant: { findUnique: jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: tenantId, status: 'ACTIVE' }) } };
    guard = new TenantGuard(cls as never, prisma as never);
  });

  it('makes a tenant-scoped SUPER_ADMIN usable by the actual analytics tenant reader without memberships', async () => {
    const user = { userId: 'owner', role: 'SUPER_ADMIN', tenantId, permissions: [], sessionId: 'session', impersonatedBy: 'actor' };
    await expect(guard.canActivate(context(user, { 'x-tenant-id': otherTenantId }))).resolves.toBe(true);
    const analyticsContext = new TeamContextService(prisma as never, cls as never);
    expect(analyticsContext.getTenantId()).toBe(tenantId);
    expect(analyticsContext.buildTenantWhereClause({ tenantId: otherTenantId, dateLocal: '2026-10-19' }))
      .toEqual({ tenantId, dateLocal: '2026-10-19' });
    expect(Object.fromEntries(values)).toEqual({
      tenantId, userId: 'owner', userRole: 'SUPER_ADMIN', userPermissions: [], sessionId: 'session', impersonatedBy: 'actor',
    });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('keeps a global SUPER_ADMIN unscoped and clears stale tenant context for %s', async (storedTenant) => {
    values.set('tenantId', otherTenantId);
    await expect(guard.canActivate(context({ userId: 'owner', role: 'SUPER_ADMIN', tenantId: storedTenant }, { 'x-tenant-id': tenantId })))
      .resolves.toBe(true);
    expect(values.get('tenantId')).toBeNull();
    expect(() => new TeamContextService(prisma as never, cls as never).getTenantId()).toThrow('Tenant context is required');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it.each(['', 'not-a-uuid', [tenantId]])('rejects a malformed stored SUPER_ADMIN tenant instead of trusting a header: %s', async (storedTenant) => {
    await expect(guard.canActivate(context({ userId: 'owner', role: 'SUPER_ADMIN', tenantId: storedTenant }, { 'x-tenant-id': tenantId })))
      .rejects.toThrow(ForbiddenException);
    expect(values.has('tenantId')).toBe(false);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it.each(['ACTIVE', 'TRIAL'])('preserves ordinary-user scope and existing %s tenant validation', async (status) => {
    prisma.tenant.findUnique.mockResolvedValue({ id: tenantId, status } as never);
    await expect(guard.canActivate(context({ userId: 'user', role: 'USER', tenantId, permissions: ['analytics.sales'] }, { 'x-tenant-id': otherTenantId })))
      .resolves.toBe(true);
    expect(values.get('tenantId')).toBe(tenantId);
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({ where: { id: tenantId } });
  });

  it.each([null, { id: tenantId, status: 'SUSPENDED' }])('preserves rejection of missing/inactive ordinary-user tenants', async (tenant) => {
    prisma.tenant.findUnique.mockResolvedValue(tenant as never);
    await expect(guard.canActivate(context({ userId: 'user', role: 'ADMIN', tenantId }))).rejects.toThrow(ForbiddenException);
  });

  it('does not accept an ordinary user with no tenant or an unauthenticated request', async () => {
    await expect(guard.canActivate(context(undefined))).rejects.toThrow('User context is required');
    await expect(guard.canActivate(context({ userId: 'user', role: 'USER', tenantId: null }, { 'x-tenant-id': tenantId })))
      .rejects.toThrow('Tenant context is required');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
