import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClsService } from 'nestjs-cls';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { AddTeamMemberDto } from './dto/add-team-member.dto';
import { isSuperAdminOnlyTeam } from '../../common/utils/super-admin-only-teams';

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  private getContext() {
    const tenantId = this.cls.get('tenantId');
    const userId = this.cls.get('userId');
    const role = this.cls.get('userRole');
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return { tenantId, userId, role };
  }

  /**
   * Get teams that the user belongs to
   * Returns all teams for admins, only member teams for regular users
   */
  async getMyTeams(userId: string, tenantId: string) {
    const role = this.cls.get('userRole');
    const isSuperAdmin = role === 'SUPER_ADMIN';
    const teams = await this.prisma.team.findMany({
      where: {
        tenantId,
        members: {
          some: {
            userId,
            status: 'ACTIVE',
          },
        },
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        teamCode: true,
      },
    });

    return isSuperAdmin ? teams : teams.filter((team) => !isSuperAdminOnlyTeam(team));
  }

  async createTeam(dto: CreateTeamDto) {
    const { tenantId } = this.getContext();
    const nextCode = await this.generateTeamCode(tenantId);
    return this.prisma.team.create({
      data: {
        tenantId,
        name: dto.name,
        teamCode: nextCode,
        description: dto.description || null,
        status: 'ACTIVE',
      },
    });
  }

  private async generateTeamCode(tenantId: string): Promise<string> {
    const teams = await this.prisma.team.findMany({
      where: { tenantId, teamCode: { not: null } },
      select: { teamCode: true },
    });
    let max = 0;
    for (const t of teams) {
      const code = t.teamCode || '';
      const match = code.match(/TEAM(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!isNaN(num)) max = Math.max(max, num);
      }
    }
    return `TEAM${max + 1}`;
  }

  async listTeams() {
    const { tenantId, userId, role } = this.getContext();
    const isLegacyAdmin = role === 'SUPER_ADMIN';

    // Check if user has tenant-wide admin access via dynamic roles
    let hasTenantWideAccess = false;
    if (!isLegacyAdmin && userId) {
      const adminPermKeys = new Set(['team.manage', 'permission.assign', 'user.manage']);

      // Check role assignments for tenant-wide permissions
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
            hasTenantWideAccess = true;
            break;
          }
        }
        if (hasTenantWideAccess) break;
      }
    }

    const isAdmin = isLegacyAdmin || hasTenantWideAccess;

    // Admins see all teams; others only their memberships
    const teams = await this.prisma.team.findMany({
      where: {
        tenantId,
        ...(isAdmin
          ? {}
          : {
              teamMemberships: {
                some: {
                  userId,
                  status: 'ACTIVE',
                },
              },
            }),
      },
      orderBy: { createdAt: 'desc' },
    });

    return isLegacyAdmin ? teams : teams.filter((team) => !isSuperAdminOnlyTeam(team));
  }

  async updateTeam(id: string, dto: UpdateTeamDto) {
    const { tenantId } = this.getContext();
    const existing = await this.prisma.team.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Team not found');
    }
    return this.prisma.team.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.status !== undefined ? { status: dto.status as any } : {}),
      },
    });
  }

  async deleteTeam(id: string) {
    const { tenantId } = this.getContext();
    const existing = await this.prisma.team.findFirst({
      where: { id, tenantId },
    });
    if (!existing) {
      throw new NotFoundException('Team not found');
    }
    await this.prisma.team.delete({ where: { id } });
    return { success: true };
  }

  async addMember(teamId: string, dto: AddTeamMemberDto) {
    const { tenantId } = this.getContext();

    const team = await this.prisma.team.findFirst({
      where: { id: teamId, tenantId },
    });
    if (!team) {
      throw new NotFoundException('Team not found');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: dto.userId, tenantId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.teamMembership.upsert({
      where: {
        tenantId_userId_teamId: { tenantId, userId: dto.userId, teamId },
      },
      update: {
        status: 'ACTIVE',
        isDefault: false,
        roleId: dto.roleId || null,
      },
      create: {
        tenantId,
        teamId,
        userId: dto.userId,
        status: 'ACTIVE',
        isDefault: false,
        roleId: dto.roleId || null,
      },
    });
  }

  async listMembers(teamId: string) {
    const { tenantId } = this.getContext();
    return this.prisma.teamMembership.findMany({
      where: { teamId, tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            role: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
