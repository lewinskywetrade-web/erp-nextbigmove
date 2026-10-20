import { Injectable, UnauthorizedException, ConflictException, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { WmsStaffActivityOutcome } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dto';
import { toStoredPermissionWorkspace } from '../../common/rbac/permission-workspace';
import { WmsStaffActivityService } from '../../common/services/wms-staff-activity.service';
import { EffectiveAccessService } from '../../common/services/effective-access.service';

const IMPERSONATION_MAX_SECONDS = 15 * 60;
type ImpersonationClaims = {
  userId: string;
  tenantId: string | null;
  impersonatedBy?: string | null;
  originalSessionId?: string | null;
  sessionId?: string | null;
  impersonationExpiresAt?: number;
  exp?: number;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly wmsStaffActivityService: WmsStaffActivityService,
    private readonly effectiveAccessService: EffectiveAccessService,
  ) {}

  /**
   * Register a new tenant and admin user
   */
  async register(registerDto: RegisterDto) {
    const { password, firstName, lastName, tenantName, tenantSlug } = registerDto;
    const email = registerDto.email.trim().toLowerCase();

    // Check if email already exists in any tenant
    const existingUser = await this.prisma.user.findFirst({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('Email already exists');
    }

    // Check if tenant slug is available
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (existingTenant) {
      throw new ConflictException('Tenant slug already taken');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate per-tenant encryption key (32 bytes = 64 hex chars)
    const encryptionKey = crypto.randomBytes(32).toString('hex');

    // Create tenant and admin user in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // Create tenant
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: tenantSlug,
          encryptionKey,
          status: 'TRIAL',
          settings: {},
          metadata: {},
          features: [],
          maxUsers: 10,
          maxIntegrations: 5,
          planType: 'trial',
        },
      });

      const tenantAdminRole = await tx.role.findFirst({
        where: { key: 'TENANT_ADMIN', tenantId: null },
        select: { id: true },
      });

      if (!tenantAdminRole) {
        throw new BadRequestException('TENANT_ADMIN system role is missing. Run the RBAC seed first.');
      }

      // Create tenant owner user. The legacy role stays USER; tenant access comes from dynamic RBAC.
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName,
          lastName,
          tenantId: tenant.id,
          role: 'USER',
          status: 'ACTIVE',
          emailVerified: false,
        },
      });

      await tx.userRoleAssignment.create({
        data: {
          userId: user.id,
          roleId: tenantAdminRole.id,
          workspace: toStoredPermissionWorkspace('erp'),
          tenantId: tenant.id,
          teamId: null,
        },
      });

      return { tenant, user };
    });

    // Generate tokens
    const tokens = await this.generateTokens(
      result.user.id,
      result.tenant.id,
      result.user.role,
      crypto.randomUUID(),
    );

    // Update last login
    await this.prisma.user.update({
      where: { id: result.user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      user: this.sanitizeUser(result.user),
      tenant: this.sanitizeTenant(result.tenant),
      ...tokens,
    };
  }

  /**
   * Login user
   */
  async login(loginDto: LoginDto, request?: Request) {
    const email = loginDto.email.trim().toLowerCase();
    const { password } = loginDto;

    // Find user by email (across all tenants)
    const user = await this.prisma.user.findFirst({
      where: { email },
      include: { tenant: true },
    });

    if (!user) {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        actionType: 'LOGIN',
        resourceType: 'AUTH_SESSION',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'INVALID_CREDENTIALS',
        metadata: {
          email,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: user.tenantId,
        actorId: user.id,
        actionType: 'LOGIN',
        resourceType: 'AUTH_SESSION',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'INVALID_CREDENTIALS',
        metadata: {
          email,
        },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check user status
    if (user.status !== 'ACTIVE') {
      await this.wmsStaffActivityService.recordFromRequest({
        request,
        tenantId: user.tenantId,
        actorId: user.id,
        actionType: 'LOGIN',
        resourceType: 'AUTH_SESSION',
        outcome: WmsStaffActivityOutcome.REJECTED,
        reasonCode: 'ACCOUNT_INACTIVE',
      });
      throw new UnauthorizedException('Account is not active');
    }

    // ERP users are tenant-scoped. WMS staff are tenantless and authorized by WMS role assignments.
    if (user.role !== 'SUPER_ADMIN') {
      if (!user.tenantId) {
        const hasWmsAccess = await this.hasWmsWorkspaceAccess(user.id);
        if (!hasWmsAccess) {
          await this.wmsStaffActivityService.recordFromRequest({
            request,
            actorId: user.id,
            actionType: 'LOGIN',
            resourceType: 'AUTH_SESSION',
            outcome: WmsStaffActivityOutcome.REJECTED,
            reasonCode: 'NO_WORKSPACE_ACCESS',
          });
          throw new UnauthorizedException('Account has no workspace access');
        }
      } else if (!user.tenant || (user.tenant.status !== 'ACTIVE' && user.tenant.status !== 'TRIAL')) {
        await this.wmsStaffActivityService.recordFromRequest({
          request,
          tenantId: user.tenantId,
          actorId: user.id,
          actionType: 'LOGIN',
          resourceType: 'AUTH_SESSION',
          outcome: WmsStaffActivityOutcome.REJECTED,
          reasonCode: 'TENANT_INACTIVE',
        });
        throw new UnauthorizedException('Tenant account is not active');
      }
    }

    // Generate tokens
    const sessionId = crypto.randomUUID();
    const tokens = await this.generateTokens(user.id, user.tenantId, user.role, sessionId);

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: user.tenantId,
      actorId: user.id,
      sessionId,
      actionType: 'LOGIN',
      resourceType: 'AUTH_SESSION',
      resourceId: sessionId,
      metadata: {
        email,
      },
    });

    return {
      user: this.sanitizeUser(user),
      tenant: user.tenant ? this.sanitizeTenant(user.tenant) : null,
      ...tokens,
      memberships: await this.listMemberships(user.id),
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshTokenDto: RefreshTokenDto) {
    const { refreshToken } = refreshTokenDto;

    try {
      const payload = this.jwtService.verify(refreshToken, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
      });

      if (payload.impersonatedBy) {
        // Old preview refresh tokens had a seven-day expiry and lost the actor
        // on refresh. Never turn one into an ordinary target session.
        if (!Number.isInteger(payload.impersonationExpiresAt)) {
          throw new UnauthorizedException('This View As session has expired. Sign in again.');
        }
        const preview = await this.validateImpersonationSession(payload);
        const target = preview.target!;
        const tokens = await this.generateTokens(
          target.id, preview.tenant.id, target.role,
          typeof payload.sessionId === 'string' ? payload.sessionId : crypto.randomUUID(),
          {
            impersonatedBy: preview.actor.id,
            originalSessionId: payload.originalSessionId ?? null,
            impersonationExpiresAt: preview.expiresAt,
          },
        );
        return {
          user: this.sanitizeUser({ ...target, tenantId: preview.tenant.id, defaultTeamId: preview.targetDefaultTeamId }),
          tenant: this.sanitizeTenant(preview.tenant),
          memberships: this.previewMemberships(preview.tenant),
          impersonatedBy: preview.actor.id,
          impersonationReadOnly: true,
          impersonationExpiresAt: preview.expiresAt,
          ...tokens,
        };
      }

      // Verify user still exists and is active
      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        include: { tenant: true },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException('User not found or inactive');
      }

      if (user.role !== 'SUPER_ADMIN') {
        if (!user.tenantId) {
          const hasWmsAccess = await this.hasWmsWorkspaceAccess(user.id);
          if (!hasWmsAccess) {
            throw new UnauthorizedException('Account has no workspace access');
          }
        } else if (!user.tenant || (user.tenant.status !== 'ACTIVE' && user.tenant.status !== 'TRIAL')) {
          throw new UnauthorizedException('Tenant account is not active');
        }
      }

      // Keep the tenant this session was actually working in; the row only
      // records the last-active one and may have moved in another session.
      const active = await this.resolveActiveTenant(user.id, user.role, user.tenantId, payload.tenantId, user.defaultTeamId);
      const tokens = await this.generateTokens(
        user.id,
        active.tenantId,
        user.role,
        typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
          ? payload.sessionId
          : crypto.randomUUID(),
      );

      return {
        user: this.sanitizeUser(user),
        tenant: user.tenant ? this.sanitizeTenant(user.tenant) : null,
        ...tokens,
      };
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  /**
   * Validate user by ID (used by JWT strategy)
   */
  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { tenant: true },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is not active');
    }

    if (user.role !== 'SUPER_ADMIN') {
      if (!user.tenantId) {
        const hasWmsAccess = await this.hasWmsWorkspaceAccess(user.id);
        if (!hasWmsAccess) {
          throw new UnauthorizedException('Account has no workspace access');
        }
      } else if (!user.tenant || (user.tenant.status !== 'ACTIVE' && user.tenant.status !== 'TRIAL')) {
        throw new UnauthorizedException('Tenant account is not active');
      }
    }

    return user;
  }

  async logout(
    user: {
      userId?: string;
      id?: string;
      tenantId?: string | null;
      sessionId?: string | null;
    },
    request?: Request,
  ) {
    await this.wmsStaffActivityService.recordFromRequest({
      request,
      tenantId: user.tenantId ?? null,
      actorId: user.userId ?? user.id ?? null,
      sessionId: user.sessionId ?? null,
      actionType: 'LOGOUT',
      resourceType: 'AUTH_SESSION',
      resourceId: user.sessionId ?? null,
    });

    return {
      success: true,
    };
  }

  /**
   * Generate access and refresh tokens
   */
  private async generateTokens(
    userId: string,
    tenantId: string | null,
    role: string,
    sessionId: string,
    impersonation?: { impersonatedBy: string; originalSessionId: string | null; impersonationExpiresAt: number },
  ) {
    const payload = {
      userId,
      tenantId,
      role,
      sessionId,
      // Present only while viewing as someone else. The real actor travels
      // inside the token so returning does not depend on the client holding on
      // to the admin's own token.
      ...(impersonation ?? {}),
    };

    const remainingPreviewSeconds = impersonation
      ? impersonation.impersonationExpiresAt - Math.floor(Date.now() / 1000)
      : null;
    if (remainingPreviewSeconds !== null && (remainingPreviewSeconds <= 0 || remainingPreviewSeconds > IMPERSONATION_MAX_SECONDS)) {
      throw new UnauthorizedException('This View As session has expired. Sign in again.');
    }
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.secret'),
        expiresIn: remainingPreviewSeconds ?? this.configService.get<string>('jwt.expiresIn'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        expiresIn: remainingPreviewSeconds ?? this.configService.get<string>('jwt.refreshExpiresIn'),
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      sessionId,
    };
  }

  /**
   * Issue a token that acts as another user in the same tenant.
   *
   * Permissions are resolved server-side from the token's userId on every
   * request, so a token minted for the target grants exactly their access —
   * no module needs to know impersonation exists. What the token adds is the
   * real actor. JwtAuthGuard separately enforces read-only preview requests.
   */
  async impersonate(actor: { userId: string; tenantId: string | null; sessionId: string | null; impersonatedBy?: string }, targetUserId: string, request?: any) {
    if (actor.impersonatedBy) {
      throw new ForbiddenException('Already viewing as another user');
    }
    if (actor.userId === targetUserId) {
      throw new BadRequestException('You are already signed in as this user');
    }
    if (!actor.tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const expiresAt = Math.floor(Date.now() / 1000) + IMPERSONATION_MAX_SECONDS;
    const preview = await this.validateImpersonationSession({
      userId: targetUserId,
      tenantId: actor.tenantId,
      impersonatedBy: actor.userId,
      impersonationExpiresAt: expiresAt,
    });
    const target = preview.target!;
    const activeTenant = preview.tenant;

    const sessionId = crypto.randomUUID();
    const tokens = await this.generateTokens(
      target.id,
      actor.tenantId,
      target.role,
      sessionId,
      { impersonatedBy: actor.userId, originalSessionId: actor.sessionId, impersonationExpiresAt: expiresAt },
    );

    await this.recordImpersonationAudit(request, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: 'IMPERSONATION_STARTED',
      targetUserId: target.id,
      sessionId,
    });

    return {
      user: this.sanitizeUser({ ...target, tenantId: activeTenant.id, defaultTeamId: preview.targetDefaultTeamId }),
      tenant: this.sanitizeTenant(activeTenant),
      memberships: this.previewMemberships(activeTenant),
      impersonatedBy: actor.userId,
      impersonationReadOnly: true,
      impersonationExpiresAt: expiresAt,
      ...tokens,
    };
  }

  /** Hand the session back to the admin who started it. */
  async stopImpersonation(actor: ImpersonationClaims, request?: any) {
    if (!actor.impersonatedBy) {
      throw new BadRequestException('This session is not viewing as another user');
    }

    const preview = await this.validateImpersonationSession(actor, true);
    const admin = preview.actor;

    const sessionId = crypto.randomUUID();
    // The impersonated session was minted inside the admin's active tenant, so
    // that is where they return — not wherever the row's last-active pointer is.
    const returnTenantId = preview.tenant.id;
    const tokens = await this.generateTokens(admin.id, returnTenantId, admin.role, sessionId);
    const returnTenant = preview.tenant;

    await this.recordImpersonationAudit(request, {
      tenantId: returnTenantId,
      actorId: admin.id,
      action: 'IMPERSONATION_ENDED',
      targetUserId: actor.userId,
      sessionId,
    });

    return {
      user: this.sanitizeUser({ ...admin, tenantId: returnTenantId, defaultTeamId: preview.actorDefaultTeamId }),
      tenant: this.sanitizeTenant(returnTenant),
      ...tokens,
      memberships: await this.listMemberships(admin.id),
    };
  }

  /**
   * Resolve both identities against the fixed preview tenant on every request.
   * Normal-login workspace fallback must never move a preview to another tenant.
   * The exact stop route can restore the actor even after the target is removed.
   */
  async validateImpersonationSession(claims: ImpersonationClaims, stopping = false) {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = claims.impersonationExpiresAt ?? claims.exp;
    if (!claims.impersonatedBy || !claims.tenantId || !claims.userId
      || claims.impersonatedBy === claims.userId
      || !Number.isInteger(expiresAt) || expiresAt! <= now || expiresAt! > now + IMPERSONATION_MAX_SECONDS) {
      throw new UnauthorizedException('This View As session has expired or is no longer valid. Sign in again.');
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: claims.tenantId } });
    if (!tenant || !['ACTIVE', 'TRIAL'].includes(tenant.status)) {
      throw new UnauthorizedException('The preview workspace is no longer active');
    }
    const actor = await this.prisma.user.findUnique({ where: { id: claims.impersonatedBy } });
    if (!actor || actor.status !== 'ACTIVE') {
      throw new UnauthorizedException('The original administrator is no longer active');
    }
    const actorDefaultTeamId = actor.role === 'SUPER_ADMIN'
      ? (actor.tenantId === tenant.id ? actor.defaultTeamId : null)
      : await this.assertPreviewTenantMembership(actor, tenant.id);
    if (actor.role !== 'SUPER_ADMIN') {
      const actorAccess = await this.effectiveAccessService.resolveUserAccess({
        userId: actor.id, tenantId: tenant.id, basePermissions: actor.permissions ?? [], workspace: 'erp',
      });
      if (!actorAccess.permissions.includes('user.impersonate')) {
        throw new ForbiddenException('The original administrator no longer has View As access');
      }
    }
    if (stopping) return { actor, actorDefaultTeamId, tenant, target: null, targetDefaultTeamId: null, expiresAt: expiresAt! };

    const target = await this.prisma.user.findUnique({ where: { id: claims.userId } });
    if (!target) throw new NotFoundException('User not found in this workspace');
    if (target.status !== 'ACTIVE') throw new ForbiddenException('Cannot view as a deactivated user');
    if (target.role === 'SUPER_ADMIN' && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a Super Admin can preview this user');
    }
    const targetDefaultTeamId = await this.assertPreviewTenantMembership(target, tenant.id);
    const targetAccess = await this.effectiveAccessService.resolveUserAccess({
      userId: target.id, tenantId: tenant.id, basePermissions: target.permissions ?? [],
    });
    if (targetAccess.permissions.includes('user.impersonate') && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Cannot view as a user who can impersonate others');
    }
    return { actor, actorDefaultTeamId, tenant, target, targetDefaultTeamId, expiresAt: expiresAt! };
  }

  private async assertPreviewTenantMembership(user: { id: string; tenantId: string | null; defaultTeamId: string | null }, tenantId: string) {
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      select: { status: true, defaultTeamId: true },
    });
    // An explicitly revoked membership wins over the legacy row pointer.
    if (membership) {
      if (membership.status !== 'ACTIVE') throw new ForbiddenException('User no longer belongs to the preview workspace');
      return membership.defaultTeamId;
    }
    if (user.tenantId === tenantId) return user.defaultTeamId;
    throw new ForbiddenException('User does not belong to the preview workspace');
  }

  private previewMemberships(tenant: { id: string; name: string; slug: string | null }) {
    return [{ tenantId: tenant.id, name: tenant.name, slug: tenant.slug ?? null, status: 'ACTIVE' }];
  }

  async listSessionMemberships(user: { userId: string; tenantId: string | null; impersonatedBy?: string | null }) {
    if (!user.impersonatedBy) return this.listMemberships(user.userId);
    const tenant = user.tenantId ? await this.prisma.tenant.findUnique({ where: { id: user.tenantId } }) : null;
    return tenant ? this.previewMemberships(tenant) : [];
  }

  private async recordImpersonationAudit(request: any, params: {
    tenantId: string | null;
    actorId: string;
    action: string;
    targetUserId: string;
    sessionId: string;
  }) {
    if (!params.tenantId) return;
    await this.prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.actorId,
        action: params.action,
        resource: 'user',
        resourceId: params.targetUserId,
        changes: { targetUserId: params.targetUserId, sessionId: params.sessionId },
        ipAddress: request?.ip ?? null,
        userAgent: request?.headers?.['user-agent'] ?? null,
      },
    });
  }

  /** Tenants this identity may enter, for the chooser and the header switcher. */
  async listMemberships(userId: string) {
    const rows = await this.prisma.tenantMembership.findMany({
      where: { userId, status: 'ACTIVE', tenant: { status: { in: ['ACTIVE', 'TRIAL'] } } },
      select: { tenantId: true, status: true, tenant: { select: { name: true, slug: true } } },
      orderBy: { tenant: { name: 'asc' } },
    });
    return rows.map((row) => ({
      tenantId: row.tenantId,
      name: row.tenant.name,
      slug: row.tenant.slug ?? null,
      status: row.status,
    }));
  }

  /**
   * Which tenant a request is in. The token names the tenant the session chose;
   * it is honoured only when the identity holds an ACTIVE membership there —
   * otherwise the row's last-active tenant applies. SUPER_ADMIN is untouched:
   * it has no memberships and picks tenants through the WMS header instead.
   */
  async resolveActiveTenant(
    userId: string,
    role: string,
    rowTenantId: string | null,
    requestedTenantId: unknown,
    rowDefaultTeamId: string | null,
  ): Promise<{ tenantId: string | null; defaultTeamId: string | null }> {
    const requested = typeof requestedTenantId === 'string' ? requestedTenantId : null;
    if (role === 'SUPER_ADMIN' || !requested || requested === rowTenantId) {
      return { tenantId: rowTenantId, defaultTeamId: rowDefaultTeamId };
    }
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId, tenantId: requested } },
      select: { status: true, defaultTeamId: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      return { tenantId: rowTenantId, defaultTeamId: rowDefaultTeamId };
    }
    return { tenantId: requested, defaultTeamId: membership.defaultTeamId };
  }

  /**
   * Move a session to another tenant the identity belongs to.
   *
   * Reissues the token the same way impersonation does, with tenantId swapped
   * instead of userId. The row's tenantId is updated as "last active" so the
   * next plain login lands there, and the per-tenant default team is parked on
   * the membership so switching back restores it.
   */
  async switchTenant(
    actor: { userId: string; role: string; tenantId: string | null; impersonatedBy?: string | null; defaultTeamId?: string | null },
    tenantId: string,
    request?: any,
  ) {
    if (actor.impersonatedBy) {
      // Switching while impersonating would reach the target's OTHER tenants,
      // which the admin was never granted.
      throw new ForbiddenException('Exit the impersonated session before switching workspace');
    }
    if (actor.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Platform administrators select tenants through the WMS console');
    }
    const membership = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: actor.userId, tenantId } },
      include: { tenant: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new ForbiddenException('You do not belong to that workspace');
    }
    if (membership.tenant.status !== 'ACTIVE' && membership.tenant.status !== 'TRIAL') {
      throw new ForbiddenException('That workspace is not active');
    }

    const user = await this.prisma.$transaction(async (tx) => {
      // Park the outgoing tenant's default team on its membership.
      if (actor.tenantId && actor.tenantId !== tenantId) {
        await tx.tenantMembership.updateMany({
          where: { userId: actor.userId, tenantId: actor.tenantId },
          data: { defaultTeamId: actor.defaultTeamId ?? null },
        });
      }
      return tx.user.update({
        where: { id: actor.userId },
        data: { tenantId, defaultTeamId: membership.defaultTeamId ?? null },
      });
    });

    const sessionId = crypto.randomUUID();
    const tokens = await this.generateTokens(user.id, tenantId, user.role, sessionId);

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        userId: user.id,
        action: 'TENANT_SWITCHED',
        resource: 'tenant',
        resourceId: tenantId,
        changes: { fromTenantId: actor.tenantId, toTenantId: tenantId, sessionId },
        ipAddress: request?.ip ?? null,
        userAgent: request?.headers?.['user-agent'] ?? null,
      },
    });

    return {
      user: this.sanitizeUser(user),
      tenant: this.sanitizeTenant(membership.tenant),
      ...tokens,
      memberships: await this.listMemberships(user.id),
    };
  }

  /**
   * Remove sensitive data from user object
   */
  private sanitizeUser(user: any) {
    const { password, ...sanitized } = user;
    return sanitized;
  }

  /**
   * Remove sensitive data from tenant object
   */
  private sanitizeTenant(tenant: any) {
    const { encryptionKey, ...sanitized } = tenant;
    return sanitized;
  }

  private async hasWmsWorkspaceAccess(userId: string) {
    const assignment = await this.prisma.userRoleAssignment.findFirst({
      where: {
        userId,
        workspace: 'WMS',
      },
      select: { id: true },
    });

    return Boolean(assignment);
  }
}
