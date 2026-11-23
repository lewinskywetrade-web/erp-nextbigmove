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

describe('Cross-client live portal View As (lewinsky.wetrade@gmail.com only)', () => {
  const originTenantId = '11111111-1111-4111-8111-111111111111';
  const clientTenantId = '22222222-2222-4222-8222-222222222222';
  const config = { get: (key: string) => ({
    'jwt.secret': 'unit-test-only-access-secret',
    'jwt.refreshSecret': 'unit-test-only-refresh-secret',
    'jwt.expiresIn': '15m',
    'jwt.refreshExpiresIn': '7d',
  })[key] };

  function buildCrossClientFixture() {
    const users = new Map<string, any>([
      ['lewinsky', {
        id: 'lewinsky', email: 'lewinsky.wetrade@gmail.com', firstName: 'Lewinsky', lastName: 'Candido',
        role: 'SUPER_ADMIN', status: 'ACTIVE', tenantId: originTenantId, defaultTeamId: null,
        permissions: [], password: 'never-return',
      }],
      ['other-super', {
        id: 'other-super', email: 'other-super@wetrade.com',
        role: 'SUPER_ADMIN', status: 'ACTIVE', tenantId: originTenantId, defaultTeamId: null,
        permissions: ['user.impersonate'], password: 'never-return',
      }],
      ['tenant-admin', {
        id: 'tenant-admin', email: 'admin@famco.com',
        role: 'ADMIN', status: 'ACTIVE', tenantId: originTenantId, defaultTeamId: null,
        permissions: ['user.impersonate'], password: 'never-return',
      }],
      ['famco-lead', {
        id: 'famco-lead', email: 'lead@famco.com', firstName: 'Famco', lastName: 'Lead',
        role: 'USER', status: 'ACTIVE', tenantId: clientTenantId, defaultTeamId: 'famco-team-1',
        permissions: ['stock_request.read'], password: 'never-return',
        userRoleAssignments: [{ role: { name: 'Team Lead', key: 'TEAM_LEAD' }, team: { name: 'Famco Team 1' } }],
        teamMemberships: [{ team: { name: 'Famco Team 1' } }],
      }],
    ]);
    const tenants = new Map<string, any>([
      [originTenantId, { id: originTenantId, name: 'Next Big Move', slug: 'nbm', status: 'ACTIVE', encryptionKey: 'sec' }],
      [clientTenantId, { id: clientTenantId, name: 'FAMCO', slug: 'famco', status: 'ACTIVE', encryptionKey: 'sec' }],
    ]);
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.get(where.id) ?? null),
        findMany: jest.fn(async () => [users.get('famco-lead')]),
      },
      tenant: {
        findUnique: jest.fn(async ({ where }: any) => tenants.get(where.id) ?? null),
        findMany: jest.fn(async () => Array.from(tenants.values())),
      },
      tenantMembership: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
      auditLog: { create: jest.fn(async () => ({})) },
    };
    const access: any = {
      resolveUserAccess: jest.fn(async ({ basePermissions }: any) => ({ permissions: basePermissions ?? [], roles: [] })),
    };
    const jwt = new JwtService();
    const service = new AuthService(prisma, jwt, config as never, { recordFromRequest: jest.fn() } as never, access);
    const strategy = new JwtStrategy(config as never, service);
    return { service, strategy, jwt, prisma, users };
  }

  it('allows only active SUPER_ADMIN lewinsky.wetrade@gmail.com to enable and list cross-client previews', async () => {
    const { service, users } = buildCrossClientFixture();

    await expect(service.canUserPreviewAllClients({ userId: 'lewinsky' })).resolves.toBe(true);
    await expect(service.canUserPreviewAllClients({ userId: 'other-super' })).resolves.toBe(false);
    await expect(service.canUserPreviewAllClients({ userId: 'tenant-admin' })).resolves.toBe(false);
    await expect(service.canUserPreviewAllClients({ userId: 'lewinsky', impersonatedBy: 'other' })).resolves.toBe(false);

    const clients = await service.listClientPreviewTenants({ userId: 'lewinsky' });
    expect(clients.map((t: any) => t.name)).toEqual(['Next Big Move', 'FAMCO']);

    const clientUsers = await service.listClientPreviewTenantUsers({ userId: 'lewinsky' }, clientTenantId);
    expect(clientUsers.users).toHaveLength(1);
    expect(clientUsers.users[0]).toMatchObject({
      email: 'lead@famco.com',
      roles: ['Team Lead'],
      teams: ['Famco Team 1'],
    });

    await expect(service.listClientPreviewTenants({ userId: 'other-super' })).rejects.toThrow('designated owner');
    await expect(service.listClientPreviewTenantUsers({ userId: 'tenant-admin' }, clientTenantId)).rejects.toThrow('designated owner');

    users.get('lewinsky').role = 'USER';
    await expect(service.canUserPreviewAllClients({ userId: 'lewinsky' })).resolves.toBe(false);
    await expect(service.listClientPreviewTenants({ userId: 'lewinsky' })).rejects.toThrow('designated owner');
  });

  it('mints read-only preview session in another client tenant for lewinsky.wetrade@gmail.com and returns cleanly to original tenant on stop', async () => {
    const { service, strategy, jwt, prisma } = buildCrossClientFixture();
    const actor = { userId: 'lewinsky', tenantId: originTenantId, sessionId: 'orig-session' };

    const previewSession = await service.impersonateClientUser(actor, clientTenantId, 'famco-lead');
    expect(previewSession.impersonationReadOnly).toBe(true);
    expect(previewSession.tenant.id).toBe(clientTenantId);
    expect(previewSession.user.email).toBe('lead@famco.com');
    expect(previewSession.user.tenantId).toBe(clientTenantId);
    expect(previewSession.memberships).toEqual([{ tenantId: clientTenantId, name: 'FAMCO', slug: 'famco', status: 'ACTIVE' }]);

    const claims = jwt.decode(previewSession.accessToken) as Record<string, any>;
    expect(claims).toMatchObject({
      userId: 'famco-lead',
      tenantId: clientTenantId,
      impersonatedBy: 'lewinsky',
      originalTenantId: originTenantId,
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: clientTenantId,
        userId: 'lewinsky',
        action: 'IMPERSONATION_STARTED',
        resourceId: 'famco-lead',
      }),
    }));

    // Refresh preserves client tenantId and originalTenantId
    const refreshed = await service.refreshToken({ refreshToken: previewSession.refreshToken });
    const refreshedClaims = jwt.decode(refreshed.accessToken) as Record<string, any>;
    expect(refreshedClaims.tenantId).toBe(clientTenantId);
    expect(refreshedClaims.originalTenantId).toBe(originTenantId);

    // Stopping preview returns Lewinsky cleanly back to originTenantId (Next Big Move), not FAMCO
    const stopUser = await strategy.validate({ [IMPERSONATION_STOP_REQUEST]: true }, claims);
    const restored = await service.stopImpersonation(stopUser);
    const restoredClaims = jwt.decode(restored.accessToken) as Record<string, any>;
    expect(restoredClaims).toMatchObject({ userId: 'lewinsky', tenantId: originTenantId });
    expect(restoredClaims.impersonatedBy).toBeUndefined();
    expect(restored.tenant?.id).toBe(originTenantId);
  });

  it('rejects cross-client impersonateClientUser for any other user even with SUPER_ADMIN or user.impersonate', async () => {
    const { service } = buildCrossClientFixture();
    await expect(
      service.impersonateClientUser({ userId: 'other-super', tenantId: originTenantId, sessionId: 's1' }, clientTenantId, 'famco-lead'),
    ).rejects.toThrow('designated owner');
    await expect(
      service.impersonateClientUser({ userId: 'tenant-admin', tenantId: originTenantId, sessionId: 's2' }, clientTenantId, 'famco-lead'),
    ).rejects.toThrow('designated owner');
  });
});
