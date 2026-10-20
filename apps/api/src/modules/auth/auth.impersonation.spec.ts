import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { IMPERSONATION_STOP_REQUEST } from '../../common/guards/impersonation-policy';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';

describe('Read-only View As identity lifecycle', () => {
  let service: AuthService;
  let strategy: JwtStrategy;
  let jwt: JwtService;
  let prisma: any;
  let access: any;
  let users: Map<string, any>;
  let memberships: Map<string, any>;
  let tenant: any;
  const config = { get: (key: string) => ({
    'jwt.secret': 'unit-test-only-access-secret',
    'jwt.refreshSecret': 'unit-test-only-refresh-secret',
    'jwt.expiresIn': '15m',
    'jwt.refreshExpiresIn': '7d',
  })[key] };
  const actor = () => ({ userId: 'admin', tenantId, sessionId: 'original-session' });
  const claims = (extra = {}) => ({
    userId: 'target', tenantId, impersonatedBy: 'admin',
    sessionId: 'preview-session', originalSessionId: 'original-session',
    impersonationExpiresAt: Math.floor(Date.now() / 1000) + 900, ...extra,
  });
  const decoded = (token: string) => jwt.decode(token) as Record<string, any>;

  beforeEach(() => {
    users = new Map([
      ['admin', { id: 'admin', tenantId, defaultTeamId: 'admin-team', status: 'ACTIVE', role: 'USER', permissions: ['user.impersonate'], password: 'never-return' }],
      ['target', { id: 'target', tenantId, defaultTeamId: 'target-team', status: 'ACTIVE', role: 'USER', email: 'target@example.test', permissions: ['analytics.sales'], password: 'never-return' }],
    ]);
    memberships = new Map();
    tenant = { id: tenantId, name: 'Preview workspace', slug: 'preview', status: 'ACTIVE', encryptionKey: 'never-return' };
    prisma = {
      user: { findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null) },
      tenant: { findUnique: jest.fn(async ({ where }: any) => where.id === tenantId ? tenant : null) },
      tenantMembership: {
        findUnique: jest.fn(async ({ where }: any) => memberships.get(`${where.userId_tenantId.userId}:${where.userId_tenantId.tenantId}`) ?? null),
        findMany: jest.fn(async () => [{ tenantId, tenant, status: 'ACTIVE' }]),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    access = {
      resolveUserAccess: jest.fn(async ({ basePermissions }: any) => ({ permissions: basePermissions ?? [], roles: [] })),
    };
    jwt = new JwtService();
    service = new AuthService(prisma, jwt, config as never, { recordFromRequest: jest.fn() } as never, access);
    strategy = new JwtStrategy(config as never, service);
  });

  it('mints target identity, a fixed 15-minute preview and only the current membership', async () => {
    const result = await service.impersonate(actor(), 'target');
    const token = decoded(result.accessToken);
    const refresh = decoded(result.refreshToken);
    expect(token).toMatchObject({ userId: 'target', tenantId, impersonatedBy: 'admin', originalSessionId: 'original-session' });
    expect(token.impersonationExpiresAt - token.iat).toBe(900);
    expect(token.exp).toBe(token.impersonationExpiresAt);
    expect(refresh.exp).toBe(token.exp);
    expect(result.impersonationReadOnly).toBe(true);
    expect(result.user.password).toBeUndefined();
    expect(result.tenant.encryptionKey).toBeUndefined();
    expect(result.memberships).toEqual([{ tenantId, name: 'Preview workspace', slug: 'preview', status: 'ACTIVE' }]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'admin', resourceId: 'target', action: 'IMPERSONATION_STARTED' }),
    }));
  });

  it('preserves the actor and the original absolute expiry on refresh', async () => {
    const start = await service.impersonate(actor(), 'target');
    const result = await service.refreshToken({ refreshToken: start.refreshToken });
    const first = decoded(start.accessToken);
    const refreshed = decoded(result.accessToken);
    expect(refreshed).toMatchObject({
      userId: 'target', tenantId, impersonatedBy: 'admin',
      originalSessionId: 'original-session', impersonationExpiresAt: first.impersonationExpiresAt,
    });
    expect(refreshed.exp).toBe(first.exp);
    expect(decoded(result.refreshToken).exp).toBe(first.exp);
    expect(result.user.tenantId).toBe(tenantId);
  });

  it('rejects a legacy preview refresh token instead of creating an untracked target login', async () => {
    const token = jwt.sign({ userId: 'target', tenantId, impersonatedBy: 'admin' }, {
      secret: config.get('jwt.refreshSecret'), expiresIn: '7d',
    });
    await expect(service.refreshToken({ refreshToken: token })).rejects.toThrow('Invalid refresh token');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'self', actor: { userId: 'target', tenantId, sessionId: 'session' }, target: 'target' },
    { name: 'nested', actor: { userId: 'admin', tenantId, sessionId: 'session', impersonatedBy: 'another-admin' }, target: 'target' },
    { name: 'missing tenant', actor: { userId: 'admin', tenantId: null, sessionId: 'session' }, target: 'target' },
  ])('rejects $name preview creation', async ({ actor: caller, target }) => {
    await expect(service.impersonate(caller, target)).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(['SUPER_ADMIN', 'user.impersonate'])('blocks privilege escalation to %s for a tenant admin', async (privilege) => {
    if (privilege === 'SUPER_ADMIN') users.get('target').role = privilege;
    else users.get('target').permissions.push(privilege);
    await expect(service.impersonate(actor(), 'target')).rejects.toThrow();
  });

  it.each(['SUPER_ADMIN', 'user.impersonate'])('allows the platform administrator to preview %s within the same workspace', async (privilege) => {
    users.get('admin').role = 'SUPER_ADMIN';
    users.get('admin').permissions = [];
    if (privilege === 'SUPER_ADMIN') users.get('target').role = privilege;
    else users.get('target').permissions.push(privilege);
    const result = await service.impersonate(actor(), 'target');
    expect(result.impersonationReadOnly).toBe(true);
    const context = await strategy.validate({}, decoded(result.accessToken));
    expect(context.userId).toBe('target');
    expect(context.impersonationReadOnly).toBe(true);
    expect(context.tenantId).toBe(tenantId);
  });

  it('does not let even a platform administrator preview a target from another workspace', async () => {
    users.get('admin').role = 'SUPER_ADMIN';
    users.get('target').tenantId = otherTenantId;
    await expect(service.impersonate(actor(), 'target')).rejects.toThrow('preview workspace');
  });

  it('resolves the target membership/default team without using their last-active tenant', async () => {
    users.get('target').tenantId = otherTenantId;
    users.get('target').defaultTeamId = 'other-tenant-team';
    memberships.set(`target:${tenantId}`, { status: 'ACTIVE', defaultTeamId: 'preview-team' });
    const result = await service.impersonate(actor(), 'target');
    expect(result.user).toMatchObject({ tenantId, defaultTeamId: 'preview-team' });
    const requestUser = await strategy.validate({}, decoded(result.accessToken));
    expect(requestUser).toMatchObject({ tenantId, defaultTeamId: 'preview-team', permissions: ['analytics.sales'] });
    expect(requestUser.permissions).not.toContain('user.impersonate');
  });

  it('fails closed after the target membership is removed; it never falls back to their other tenant', async () => {
    users.get('target').tenantId = otherTenantId;
    memberships.set(`target:${tenantId}`, { status: 'ACTIVE', defaultTeamId: 'preview-team' });
    const result = await service.impersonate(actor(), 'target');
    memberships.delete(`target:${tenantId}`);
    await expect(strategy.validate({}, decoded(result.accessToken))).rejects.toThrow('preview workspace');
  });

  it('honors an explicit revoked membership over a legacy row pointer', async () => {
    memberships.set(`target:${tenantId}`, { status: 'INACTIVE', defaultTeamId: 'preview-team' });
    await expect(service.impersonate(actor(), 'target')).rejects.toThrow('no longer belongs');
  });

  it.each(['actor inactive', 'actor permission revoked', 'target inactive', 'target promoted', 'target can impersonate', 'tenant inactive'])(
    'revalidates %s on an existing access token and refresh token',
    async (change) => {
      const start = await service.impersonate(actor(), 'target');
      if (change === 'actor inactive') users.get('admin').status = 'INACTIVE';
      if (change === 'actor permission revoked') users.get('admin').permissions = [];
      if (change === 'target inactive') users.get('target').status = 'INACTIVE';
      if (change === 'target promoted') users.get('target').role = 'SUPER_ADMIN';
      if (change === 'target can impersonate') users.get('target').permissions.push('user.impersonate');
      if (change === 'tenant inactive') tenant.status = 'SUSPENDED';
      await expect(strategy.validate({}, decoded(start.accessToken))).rejects.toThrow();
      await expect(service.refreshToken({ refreshToken: start.refreshToken })).rejects.toThrow();
    },
  );

  it.each(['deactivated', 'deleted'])('restores the administrator through exact stop even if the target was %s', async (state) => {
    const start = await service.impersonate(actor(), 'target');
    if (state === 'deleted') users.delete('target');
    else users.get('target').status = 'INACTIVE';
    await expect(strategy.validate({}, decoded(start.accessToken))).rejects.toThrow();
    const stopContext = await strategy.validate({ [IMPERSONATION_STOP_REQUEST]: true }, decoded(start.accessToken));
    const result = await service.stopImpersonation(stopContext);
    expect(decoded(result.accessToken)).toMatchObject({ userId: 'admin', tenantId });
    expect(decoded(result.accessToken).impersonatedBy).toBeUndefined();
    expect(decoded(result.refreshToken).impersonationExpiresAt).toBeUndefined();
    expect(result.user.password).toBeUndefined();
    expect(prisma.auditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'admin', resourceId: 'target', action: 'IMPERSONATION_ENDED' }),
    }));
  });

  it('does not trust a client-spoofed stop URL/header to skip target validation', async () => {
    users.get('target').status = 'INACTIVE';
    await expect(strategy.validate({ url: '/auth/impersonate/stop', headers: { 'x-stop': 'true' } }, claims()))
      .rejects.toThrow('deactivated');
  });

  it('never restores an inactive original administrator', async () => {
    users.get('admin').status = 'INACTIVE';
    await expect(strategy.validate({ [IMPERSONATION_STOP_REQUEST]: true }, claims())).rejects.toThrow('administrator');
  });

  it.each([-1, 0, 901])('rejects expired or overlong preview expiry with offset %s', async (offset) => {
    await expect(service.validateImpersonationSession(claims({
      impersonationExpiresAt: Math.floor(Date.now() / 1000) + offset,
    }))).rejects.toThrow('expired');
  });

  it('keeps normal user tokens on the existing validation path', async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => ({
      ...users.get(where.id), tenant,
    }));
    const context = await strategy.validate({}, { userId: 'target', tenantId, sessionId: 'normal' });
    expect(context).toMatchObject({ userId: 'target', tenantId, sessionId: 'normal', impersonatedBy: null });
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
  });

  it('limits /auth/me membership discovery to the current preview workspace', async () => {
    const result = await service.listSessionMemberships({ userId: 'target', tenantId, impersonatedBy: 'admin' });
    expect(result).toHaveLength(1);
    expect(result[0].tenantId).toBe(tenantId);
    expect(prisma.tenantMembership.findMany).not.toHaveBeenCalled();
  });
});
