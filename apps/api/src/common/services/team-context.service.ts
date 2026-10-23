import { Injectable, ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { isSuperAdminOnlyTeamId } from '../utils/super-admin-only-teams';

@Injectable()
export class TeamContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Return the mandatory tenant boundary without resolving any team state.
   *
   * Analytics is tenant-wide. Keeping this path separate prevents analytics
   * requests from querying team memberships or accidentally re-applying team
   * filters while the rest of the application transitions away from teams.
   */
  getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  buildTenantWhereClause(additionalWhere: any = {}): any {
    return {
      ...additionalWhere,
      tenantId: this.getTenantId(),
    };
  }

  private async tenantHasActiveTeams(tenantId: string): Promise<boolean> {
    const cached = this.cls.get('tenantHasActiveTeams');
    if (typeof cached === 'boolean') {
      return cached;
    }

    const count = await this.prisma.team.count({
      where: {
        tenantId,
        status: 'ACTIVE',
      },
    });

    const hasActiveTeams = count > 0;
    this.cls.set('tenantHasActiveTeams', hasActiveTeams);
    return hasActiveTeams;
  }

  /**
   * Get user's team memberships for the current tenant
   */
  async getUserTeamMemberships(userId: string, tenantId: string): Promise<string[]> {
    const memberships = await this.prisma.teamMembership.findMany({
      where: {
        userId,
        tenantId,
        status: 'ACTIVE',
        team: {
          status: 'ACTIVE',
        },
      },
      select: {
        teamId: true,
      },
    });

    const role = this.cls.get('userRole');
    const teamIds = memberships.map((m) => m.teamId);
    return role === 'SUPER_ADMIN'
      ? teamIds
      : teamIds.filter((id) => !isSuperAdminOnlyTeamId(id));
  }

  /**
   * Check if user has tenant-wide admin access via dynamic roles
   */
  async checkTenantWideAccess(userId: string, tenantId: string): Promise<boolean> {
    const adminPermKeys = new Set(['team.manage', 'permission.assign', 'user.manage', 'team.read_all']);

    const assignments = await this.prisma.userRoleAssignment.findMany({
      where: { userId, tenantId, teamId: null },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: { permission: true },
            },
          },
        },
      },
    });

    for (const a of assignments) {
      for (const rp of a.role.rolePermissions) {
        if (adminPermKeys.has(rp.permission.key)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Validate that a user can access a specific team
   * Returns true if:
   * - User is a tenant-wide admin, OR
   * - User is a member of the specified team, OR
   * - User is SUPER_ADMIN
   */
  async canAccessTeam(userId: string, tenantId: string, teamId: string | null): Promise<boolean> {
    const role = this.cls.get('userRole');

    // SUPER_ADMIN bypasses all checks
    if (role === 'SUPER_ADMIN') {
      return true;
    }

    if (isSuperAdminOnlyTeamId(teamId)) {
      return false;
    }

    // If no team specified, check tenant-wide access
    if (!teamId) {
      return this.checkTenantWideAccess(userId, tenantId);
    }

    // Check tenant-wide admin access first
    const isAdmin = await this.checkTenantWideAccess(userId, tenantId);
    if (isAdmin) {
      return true;
    }

    // Check team membership
    const userTeams = await this.getUserTeamMemberships(userId, tenantId);
    return userTeams.includes(teamId);
  }

  /**
   * Get context with team validation
   * Returns: { tenantId, teamId, userId, isAdmin, userTeams }
   */
  async getContext() {
    const tenantId = this.cls.get('tenantId');
    const teamId = this.cls.get('teamId');
    const teamIds: string[] | undefined = this.cls.get('teamIds');
    const userId = this.cls.get('userId');
    const role = this.cls.get('userRole');
    const isSuperAdmin = role === 'SUPER_ADMIN';

    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    const tenantHasTeams = await this.tenantHasActiveTeams(tenantId);

    // SUPER_ADMIN is always admin
    if (isSuperAdmin) {
      return {
        tenantId,
        teamId,
        teamIds: teamIds || [],
        userId,
        role,
        isAdmin: true,
        userTeams: [],
        tenantHasTeams,
      };
    }

    // Check if user has tenant-wide admin access via dynamic roles
    let hasTenantWideAccess = false;
    let userTeams: string[] = [];

    if (userId) {
      hasTenantWideAccess = await this.checkTenantWideAccess(userId, tenantId);
      userTeams = await this.getUserTeamMemberships(userId, tenantId);
    }

    const isAdmin = hasTenantWideAccess;
    const sanitizedTeamId = isSuperAdminOnlyTeamId(teamId) ? null : teamId;
    const sanitizedTeamIds = (teamIds || []).filter((id) => !isSuperAdminOnlyTeamId(id));

    return {
      tenantId,
      teamId: sanitizedTeamId,
      teamIds: sanitizedTeamIds,
      userId,
      role,
      isAdmin,
      userTeams,
      tenantHasTeams,
    };
  }

  /**
   * Validate and get effective team ID
   * - For admins: allow any team or null
   * - For team members: only allow their teams
   */
  async validateAndGetTeamId(payloadTeamId: string | undefined | null): Promise<string | null> {
    const { teamId, role, isAdmin, userTeams, tenantHasTeams } = await this.getContext();

    const candidate = payloadTeamId !== undefined ? payloadTeamId : teamId;

    if (!tenantHasTeams) {
      return null;
    }

    if (role !== 'SUPER_ADMIN' && isSuperAdminOnlyTeamId(candidate)) {
      throw new ForbiddenException('You do not have access to this team');
    }

    // Admins can use any team or null
    if (isAdmin) {
      return candidate || null;
    }

    // A non-admin who belongs to no team writes with a null team, which makes
    // the record tenant-wide. Requiring a team here would leave such a user
    // able to read the workspace but never to create anything in it.
    if (!candidate) {
      if (userTeams.length === 0) return null;
      throw new ForbiddenException('Team context is required');
    }

    if (!userTeams.includes(candidate)) {
      throw new ForbiddenException('You do not have access to this team');
    }

    return candidate;
  }

  /**
   * Build where clause for team-scoped queries
   */
  async buildTeamWhereClause(additionalWhere: any = {}, allowedTeamIds?: string[]): Promise<any> {
    const { tenantId, teamIds, isAdmin, userTeams, tenantHasTeams } = await this.getContext();

    const where: any = {
      tenantId,
      ...additionalWhere,
    };

    if (!tenantHasTeams) {
      return where;
    }

    if (Array.isArray(allowedTeamIds) && allowedTeamIds.length > 0) {
      where.teamId = allowedTeamIds.length === 1 ? allowedTeamIds[0] : { in: allowedTeamIds };
      return where;
    }

    // When multiple teamIds are set in context (header), respect them
    if (Array.isArray(teamIds) && teamIds.length > 0) {
      where.teamId = teamIds.length === 1 ? teamIds[0] : { in: teamIds };
      return where;
    }

    if (isAdmin) {
      return where;
    }

    // Non-admins only see their teams
    if (userTeams.length === 0) {
      where.teamId = 'impossible-team-id';
    } else if (userTeams.length === 1) {
      where.teamId = userTeams[0];
    } else {
      where.teamId = { in: userTeams };
    }

    return where;
  }

  /**
   * For analytics modules, expand effective teams with shares.
   */
  async getAnalyticsTeamIds(scope: 'sales' | 'marketing' | 'both'): Promise<string[] | null> {
    void scope;
    this.getTenantId();
    return null;
  }
}
