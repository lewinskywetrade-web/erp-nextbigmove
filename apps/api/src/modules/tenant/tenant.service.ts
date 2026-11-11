import {
  Injectable,
  ConflictException,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateTenantDto, UpdateTenantDto } from './dto';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { toStoredPermissionWorkspace } from '../../common/rbac/permission-workspace';
import { WmsFulfillmentSyncService } from '../wms-fulfillment/wms-fulfillment-sync.service';

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly wmsFulfillmentSyncService?: WmsFulfillmentSyncService,
  ) {}

  /**
   * Create a new tenant with admin user from admin panel
   */
  async createTenant(createTenantDto: CreateTenantDto) {
    const {
      tenantName,
      password,
      firstName,
      lastName,
      planType,
      status,
      maxUsers,
      maxIntegrations,
      trialDays,
      billingCompanyName,
      billingAddress,
    } = createTenantDto;
    const tenantSlug = createTenantDto.tenantSlug.trim().toLowerCase();
    // Login lowercases the email, so the owner must be stored the same way or
    // the new partner admin can never sign in.
    const email = createTenantDto.email.trim().toLowerCase();

    // Check if tenant slug already exists
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: tenantSlug },
    });

    if (existingTenant) {
      throw new ConflictException('Tenant slug already exists');
    }

    // Check if user email already exists (across all tenants, any letter case)
    const existingUser = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });

    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    const trialEndsAt = status === 'TRIAL' && trialDays && trialDays > 0
      ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)
      : null;

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Generate per-tenant encryption key
    const encryptionKey = crypto.randomBytes(32).toString('hex');

    // Create tenant and admin user in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName.trim(),
          slug: tenantSlug,
          encryptionKey,
          status: status as any,
          planType,
          maxUsers,
          maxIntegrations,
          trialEndsAt,
          billingCompanyName: billingCompanyName?.trim() || null,
          billingAddress: billingAddress?.trim() || null,
        },
      });

      // Create tenant owner user. The legacy role stays USER; tenant access comes from dynamic RBAC.
      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          tenantId: tenant.id,
          role: 'USER',
          status: 'ACTIVE',
        },
      });

      // Assign TENANT_ADMIN role to the owner user
      const tenantAdminRole = await tx.role.findFirst({
        where: { key: 'TENANT_ADMIN', tenantId: null },
      });

      if (!tenantAdminRole) {
        throw new BadRequestException('TENANT_ADMIN system role is missing. Run the RBAC seed first.');
      }

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

    return {
      tenant: this.sanitizeTenant(result.tenant),
      user: this.sanitizeUser(result.user),
    };
  }

  /**
   * Get all tenants with user and integration counts
   */
  async findAll() {
    const tenants = await this.prisma.tenant.findMany({
      include: {
        _count: {
          select: {
            users: true,
            integrations: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return tenants.map((tenant) => this.sanitizeTenant(tenant));
  }

  /**
   * Get a single tenant by ID
   */
  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            users: true,
            integrations: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return this.sanitizeTenant(tenant);
  }

  /**
   * List a partner's ERP user accounts for the WMS Partners screen: accounts
   * homed in the tenant plus identities granted active membership. Warehouse
   * staff (WMS-workspace roles) are excluded, matching the tenant's own
   * Settings → Users grid. Roles are scoped to this tenant only.
   */
  async findUsers(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { tenantId: id },
          { tenantMemberships: { some: { tenantId: id, status: 'ACTIVE' } } },
        ],
        NOT: {
          userRoleAssignments: { some: { workspace: toStoredPermissionWorkspace('wms') } },
        },
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        tenantId: true,
        createdAt: true,
        lastLoginAt: true,
        userRoleAssignments: {
          where: { tenantId: id },
          select: {
            role: { select: { name: true, key: true } },
            team: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      tenant,
      users: users.map(({ userRoleAssignments, tenantId, ...user }) => ({
        ...user,
        membership: tenantId === id ? 'HOME' : 'GRANTED',
        roles: Array.from(new Set(userRoleAssignments.map((assignment) => assignment.role?.name).filter(Boolean))),
        teams: Array.from(new Set(userRoleAssignments.map((assignment) => assignment.team?.name).filter(Boolean))),
      })),
    };
  }

  /**
   * Update a tenant
   */
  async update(id: string, updateTenantDto: UpdateTenantDto) {
    // Check if tenant exists
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { id },
    });

    if (!existingTenant) {
      throw new NotFoundException('Tenant not found');
    }

    // If slug is being updated, check for conflicts
    if (updateTenantDto.slug && updateTenantDto.slug !== existingTenant.slug) {
      const slugConflict = await this.prisma.tenant.findUnique({
        where: { slug: updateTenantDto.slug },
      });

      if (slugConflict) {
        throw new ConflictException('Tenant slug already exists');
      }
    }

    // Update tenant
    const updateData: Record<string, unknown> = {
      ...updateTenantDto,
    };

    if ('wmsFulfillmentGoLiveAt' in updateTenantDto) {
      updateData.wmsFulfillmentGoLiveAt = updateTenantDto.wmsFulfillmentGoLiveAt
        ? new Date(updateTenantDto.wmsFulfillmentGoLiveAt)
        : null;
    }

    // A trial end date only applies while the tenant is on trial.
    if (updateTenantDto.status && updateTenantDto.status !== 'TRIAL') {
      updateData.trialEndsAt = null;
    }

    const updatedTenant = await this.prisma.tenant.update({
      where: { id },
      data: updateData as any,
      include: {
        _count: {
          select: {
            users: true,
            integrations: true,
          },
        },
      },
    });

    if ('wmsFulfillmentGoLiveAt' in updateTenantDto && this.wmsFulfillmentSyncService) {
      try {
        const activeStores = await this.prisma.posStore.findMany({
          where: {
            tenantId: id,
            status: 'ACTIVE',
            NOT: { enabled: false },
          },
          select: {
            id: true,
            tenantId: true,
            shopId: true,
          },
        });
        if (activeStores.length > 0) {
          await this.wmsFulfillmentSyncService.syncConfirmedPickingOrders({
            tenantId: id,
            storeId: null,
            stores: activeStores,
            actorId: null,
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to reconcile WMS fulfillment queue after updating wmsFulfillmentGoLiveAt for tenant ${id}: ${err?.message || err}`,
        );
      }
    }

    return this.sanitizeTenant(updatedTenant);
  }

  /**
   * Delete a tenant (soft delete by setting status to CANCELLED)
   */
  async remove(id: string) {
    // Check if tenant exists
    const existingTenant = await this.prisma.tenant.findUnique({
      where: { id },
    });

    if (!existingTenant) {
      throw new NotFoundException('Tenant not found');
    }

    // For now, we'll do a soft delete by setting status to CANCELLED
    // In production, you might want to actually delete or archive the data
    const deletedTenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        status: 'CANCELLED',
      },
    });

    return this.sanitizeTenant(deletedTenant);
  }

  /**
   * Get tenant statistics
   */
  async getStats() {
    const [total, active, trial, suspended, cancelled] = await Promise.all([
      this.prisma.tenant.count(),
      this.prisma.tenant.count({ where: { status: 'ACTIVE' } }),
      this.prisma.tenant.count({ where: { status: 'TRIAL' } }),
      this.prisma.tenant.count({ where: { status: 'SUSPENDED' } }),
      this.prisma.tenant.count({ where: { status: 'CANCELLED' } }),
    ]);

    return {
      total,
      active,
      trial,
      suspended,
      cancelled,
    };
  }

  /**
   * Remove sensitive data from tenant object
   */
  private sanitizeTenant(tenant: any) {
    const { encryptionKey, ...sanitized } = tenant;
    return sanitized;
  }

  /**
   * Remove sensitive data from user object
   */
  private sanitizeUser(user: any) {
    const { password, ...sanitized } = user;
    return sanitized;
  }
}
