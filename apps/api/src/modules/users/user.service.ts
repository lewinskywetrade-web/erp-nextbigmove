import { Injectable, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ClsService } from 'nestjs-cls';
import { CreateUserDto } from './dto/create-user.dto';
import { AddExistingUserDto } from './dto/add-existing-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';
import {
  rolePrimaryWorkspace,
  toStoredPermissionWorkspace,
  type AssignablePermissionWorkspace,
} from '../../common/rbac/permission-workspace';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  private getTenant() {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  private assertWmsRoleAssignmentAccess(wmsRoleId: string | null | undefined) {
    if (!wmsRoleId) {
      return;
    }

    throw new ForbiddenException('WMS staff access must be managed from WMS settings');
  }

  private async getValidatedRole(
    roleId: string,
    tenantId: string,
    workspace: AssignablePermissionWorkspace,
  ) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        rolePermissions: {
          include: {
            permission: {
              select: {
                key: true,
              },
            },
          },
        },
      },
    });

    if (!role || (role.tenantId && role.tenantId !== tenantId)) {
      throw new NotFoundException('Role not found');
    }

    if (rolePrimaryWorkspace(role) !== workspace) {
      throw new ForbiddenException(
        `Role does not belong to the ${workspace.toUpperCase()} workspace`,
      );
    }

    return role;
  }

  private async replaceTenantScopedRoleAssignment(
    userId: string,
    tenantId: string,
    roleId: string | undefined,
    workspace: AssignablePermissionWorkspace,
  ) {
    const storedWorkspace = toStoredPermissionWorkspace(workspace);
    const existingAssignments = await this.prisma.userRoleAssignment.findMany({
      where: {
        userId,
        tenantId,
        teamId: null,
      },
      select: {
        id: true,
        workspace: true,
      },
    });

    const assignmentIdsToDelete = existingAssignments
      .filter((assignment) => assignment.workspace === storedWorkspace)
      .map((assignment) => assignment.id);

    if (assignmentIdsToDelete.length > 0) {
      await this.prisma.userRoleAssignment.deleteMany({
        where: {
          id: {
            in: assignmentIdsToDelete,
          },
        },
      });
    }

    if (!roleId) {
      return;
    }

    await this.prisma.userRoleAssignment.create({
      data: {
        userId,
        roleId,
        workspace: storedWorkspace,
        tenantId,
        teamId: null,
      },
    });
  }

  /**
   * Add an identity that already exists to this tenant. Creates a membership
   * (and optional role/team assignments) — never a second account.
   */
  async addExisting(dto: AddExistingUserDto) {
    const tenantId = this.getTenant();
    const email = dto.email.trim().toLowerCase();

    const matches = await this.prisma.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true, tenantId: true, email: true, firstName: true, lastName: true, role: true, status: true },
      take: 2,
    });
    if (matches.length === 0) {
      throw new NotFoundException('No account with that email. Create a new user instead.');
    }
    if (matches.length > 1) {
      // Pre-membership duplicates: two rows, one email. Which identity gets the
      // grant is not ours to guess.
      throw new ConflictException('More than one account uses that email; merge them before granting access');
    }
    const identity = matches[0];
    if (identity.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('Platform administrators cannot be added to a tenant');
    }
    if (identity.tenantId === tenantId) {
      throw new ConflictException('That user already belongs to this workspace');
    }
    const existing = await this.prisma.tenantMembership.findUnique({
      where: { userId_tenantId: { userId: identity.id, tenantId } },
    });
    if (existing?.status === 'ACTIVE') {
      throw new ConflictException('That user already belongs to this workspace');
    }

    const tenantRole = dto.roleId ? await this.getValidatedRole(dto.roleId, tenantId, 'erp') : null;
    const wmsRole = dto.wmsRoleId ? await this.getValidatedRole(dto.wmsRoleId, tenantId, 'wms') : null;
    const teamRole = dto.teamRoleId ? await this.getValidatedRole(dto.teamRoleId, tenantId, 'erp') : null;

    await this.prisma.tenantMembership.upsert({
      where: { userId_tenantId: { userId: identity.id, tenantId } },
      update: { status: 'ACTIVE', defaultTeamId: dto.teamId ?? null, addedById: this.cls.get('userId') ?? null },
      create: {
        userId: identity.id, tenantId, status: 'ACTIVE',
        defaultTeamId: dto.teamId ?? null, addedById: this.cls.get('userId') ?? null,
      },
    });

    if (dto.teamId) {
      await this.prisma.teamMembership.upsert({
        where: { tenantId_userId_teamId: { tenantId, userId: identity.id, teamId: dto.teamId } },
        update: { status: 'ACTIVE', isDefault: true },
        create: { tenantId, teamId: dto.teamId, userId: identity.id, status: 'ACTIVE', isDefault: true },
      });
    }
    await this.replaceTenantScopedRoleAssignment(identity.id, tenantId, tenantRole?.id, 'erp');
    await this.replaceTenantScopedRoleAssignment(identity.id, tenantId, wmsRole?.id, 'wms');
    if (teamRole?.id && dto.teamId) {
      await this.prisma.userRoleAssignment.deleteMany({ where: { userId: identity.id, tenantId, teamId: dto.teamId } });
      await this.prisma.userRoleAssignment.create({
        data: { userId: identity.id, roleId: teamRole.id, tenantId, teamId: dto.teamId, workspace: toStoredPermissionWorkspace('erp') },
      });
    }

    return { ...identity, membershipTenantId: tenantId };
  }

  async create(dto: CreateUserDto) {
    const tenantId = this.getTenant();
    // Login lowercases the email; store it the same way so the user can sign in.
    const email = dto.email.trim().toLowerCase();

    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { tenantId: true },
    });
    if (existing) {
      // Login resolves one identity per email, so a second row in another
      // tenant would make sign-in ambiguous. Grant access instead.
      throw new ConflictException(existing.tenantId === tenantId
        ? 'Email already exists in this tenant'
        : 'An account with this email already exists. Use "Add existing user" to give it access to this tenant.');
    }

    this.assertWmsRoleAssignmentAccess(dto.wmsRoleId);

    const tenantRole = dto.roleId
      ? await this.getValidatedRole(dto.roleId, tenantId, 'erp')
      : null;
    const wmsRole = dto.wmsRoleId
      ? await this.getValidatedRole(dto.wmsRoleId, tenantId, 'wms')
      : null;

    const teamRole = dto.teamRoleId
      ? await this.getValidatedRole(dto.teamRoleId, tenantId, 'erp')
      : null;

    const isTenantAdmin = tenantRole?.key === 'TENANT_ADMIN';

    const hashed = await bcrypt.hash(dto.password, 10);

    // If TENANT_ADMIN, don't assign defaultTeamId
    const finalTeamId = isTenantAdmin ? null : (dto.teamId || null);

    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashed,
        firstName: dto.firstName,
        lastName: dto.lastName,
        // Default new tenant users to legacy USER role; dynamic permissions are assigned via roleId
        role: 'USER',
        status: 'ACTIVE',
        tenantId,
        defaultTeamId: finalTeamId,
      },
    });

    // Only create team membership if not TENANT_ADMIN and teamId is provided
    if (!isTenantAdmin && dto.teamId) {
      await this.prisma.teamMembership.upsert({
        where: {
          tenantId_userId_teamId: { tenantId, userId: user.id, teamId: dto.teamId },
        },
        update: {
          status: 'ACTIVE',
          isDefault: true,
        },
        create: {
          tenantId,
          teamId: dto.teamId,
          userId: user.id,
          status: 'ACTIVE',
          isDefault: true,
        },
      });
    }

    await this.replaceTenantScopedRoleAssignment(
      user.id,
      tenantId,
      tenantRole?.id,
      'erp',
    );
    await this.replaceTenantScopedRoleAssignment(
      user.id,
      tenantId,
      wmsRole?.id,
      'wms',
    );

    // Team-scoped role assignment
    if (teamRole?.id && dto.teamId) {
      await this.prisma.userRoleAssignment.deleteMany({
        where: {
          userId: user.id,
          tenantId,
          teamId: dto.teamId,
          workspace: toStoredPermissionWorkspace('erp'),
        },
      });
      await this.prisma.userRoleAssignment.create({
        data: {
          userId: user.id,
          roleId: teamRole.id,
          workspace: toStoredPermissionWorkspace('erp'),
          tenantId,
          teamId: dto.teamId,
        },
      });
    }

    // Never return the password hash to the client.
    const { password: _password, ...safeUser } = user;
    return safeUser;
  }

  async findAll() {
    const tenantId = this.getTenant();
    const users = await this.prisma.user.findMany({
      where: {
        // Rows homed here plus identities granted membership from elsewhere.
        OR: [
          { tenantId },
          { tenantMemberships: { some: { tenantId, status: 'ACTIVE' } } },
        ],
        NOT: {
          userRoleAssignments: {
            some: {
              workspace: toStoredPermissionWorkspace('wms'),
            },
          },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        defaultTeamId: true,
        createdAt: true,
        lastLoginAt: true,
        userRoleAssignments: {
          // Scope to the tenant being viewed: a user may hold a different role
          // in another tenant (e.g. Tenant Admin here, Creative elsewhere), and
          // an unfiltered include leaks that other assignment into this grid,
          // making the row show the wrong role.
          where: { tenantId },
          select: {
            roleId: true,
            teamId: true,
            role: {
              select: {
                id: true,
                name: true,
                key: true,
                workspace: true,
                rolePermissions: {
                  select: {
                    permission: {
                      select: {
                        key: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return users.map((user) => ({
      ...user,
      userRoleAssignments: user.userRoleAssignments
        .map((assignment) => ({
          ...assignment,
          role: assignment.role
            ? {
                id: assignment.role.id,
                name: assignment.role.name,
                key: assignment.role.key,
                workspace: rolePrimaryWorkspace(assignment.role),
              }
            : undefined,
        }))
        .filter((assignment) => assignment.role?.workspace !== 'wms'),
    }));
  }

  async update(id: string, dto: UpdateUserDto) {
    const tenantId = this.getTenant();
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        NOT: {
          userRoleAssignments: {
            some: {
              workspace: toStoredPermissionWorkspace('wms'),
            },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    this.assertWmsRoleAssignmentAccess(dto.wmsRoleId);

    const tenantRole = dto.roleId
      ? await this.getValidatedRole(dto.roleId, tenantId, 'erp')
      : null;
    const wmsRole = dto.wmsRoleId
      ? await this.getValidatedRole(dto.wmsRoleId, tenantId, 'wms')
      : null;

    const teamRole = dto.teamRoleId
      ? await this.getValidatedRole(dto.teamRoleId, tenantId, 'erp')
      : null;

    const isTenantAdmin = tenantRole?.key === 'TENANT_ADMIN';

    // If assigning TENANT_ADMIN role, automatically clear defaultTeamId
    const finalDefaultTeamId = isTenantAdmin
      ? null
      : (dto.defaultTeamId !== undefined ? dto.defaultTeamId : undefined);

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.status !== undefined ? { status: dto.status as any } : {}),
        ...(finalDefaultTeamId !== undefined ? { defaultTeamId: finalDefaultTeamId } : {}),
      },
    });

    // Handle team membership changes
    if (!isTenantAdmin && dto.defaultTeamId !== undefined) {
      if (dto.defaultTeamId) {
        // Deactivate all existing team memberships for this user (except the new one)
        await this.prisma.teamMembership.updateMany({
          where: {
            tenantId,
            userId: id,
            teamId: { not: dto.defaultTeamId },
            status: 'ACTIVE',
          },
          data: {
            status: 'INACTIVE',
            isDefault: false,
          },
        });

        // Create or activate the new team membership
        await this.prisma.teamMembership.upsert({
          where: {
            tenantId_userId_teamId: { tenantId, userId: id, teamId: dto.defaultTeamId },
          },
          update: {
            status: 'ACTIVE',
            isDefault: true,
          },
          create: {
            tenantId,
            teamId: dto.defaultTeamId,
            userId: id,
            status: 'ACTIVE',
            isDefault: true,
          },
        });
      } else {
        // If defaultTeamId is null/empty, deactivate all team memberships
        await this.prisma.teamMembership.updateMany({
          where: {
            tenantId,
            userId: id,
            status: 'ACTIVE',
          },
          data: {
            status: 'INACTIVE',
            isDefault: false,
          },
        });
      }
    }

    // Update tenant-scoped role assignment if provided
    if (dto.roleId !== undefined) {
      await this.replaceTenantScopedRoleAssignment(
        id,
        tenantId,
        tenantRole?.id,
        'erp',
      );
    }

    if (dto.wmsRoleId !== undefined) {
      await this.replaceTenantScopedRoleAssignment(
        id,
        tenantId,
        wmsRole?.id,
        'wms',
      );
    }

    // Update team-scoped role assignment if provided alongside teamId
    if (dto.teamRoleId && dto.teamId && teamRole?.id) {
      await this.prisma.userRoleAssignment.deleteMany({
        where: {
          userId: id,
          tenantId,
          teamId: dto.teamId,
          workspace: toStoredPermissionWorkspace('erp'),
        },
      });
      await this.prisma.userRoleAssignment.create({
        data: {
          userId: id,
          roleId: teamRole.id,
          workspace: toStoredPermissionWorkspace('erp'),
          tenantId,
          teamId: dto.teamId,
        },
      });
    }

    return updated;
  }

  async remove(id: string) {
    const tenantId = this.getTenant();
    const user = await this.prisma.user.findFirst({
      where: {
        id,
        tenantId,
        NOT: {
          userRoleAssignments: {
            some: {
              workspace: toStoredPermissionWorkspace('wms'),
            },
          },
        },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }
}
