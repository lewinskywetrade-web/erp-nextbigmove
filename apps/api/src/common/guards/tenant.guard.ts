import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PrismaService } from '../prisma/prisma.service';
import { validate as uuidValidate } from 'uuid';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User context is required');
    }

    // Skip tenant validation for SUPER_ADMIN (platform administrators)
    if (user.role === 'SUPER_ADMIN') {
      if (user.tenantId !== null && user.tenantId !== undefined && !uuidValidate(user.tenantId)) {
        throw new ForbiddenException('Tenant context is required');
      }
      // Keep tenant-scoped services in the administrator's stored workspace.
      // Global administrators remain unscoped; request headers cannot select it.
      this.cls.set('tenantId', user.tenantId ?? null);
      this.cls.set('userId', user.userId);
      this.cls.set('userRole', user.role);
      this.cls.set('userPermissions', user.permissions || []);
      this.cls.set('sessionId', user.sessionId || null);
      // Carried so audit rows can name the admin behind an impersonated write.
      this.cls.set('impersonatedBy', user.impersonatedBy || null);
      return true;
    }

    // For non-SUPER_ADMIN users, tenant context is required
    if (!user.tenantId || !uuidValidate(user.tenantId)) {
      throw new ForbiddenException('Tenant context is required');
    }

    // Set tenant context in CLS
    this.cls.set('tenantId', user.tenantId);
    this.cls.set('userId', user.userId);
    this.cls.set('userRole', user.role);
    this.cls.set('userPermissions', user.permissions || []);
    this.cls.set('sessionId', user.sessionId || null);
    // Carried so audit rows can name the admin behind an impersonated write.
    this.cls.set('impersonatedBy', user.impersonatedBy || null);

    // Verify tenant is active
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
    });

    if (!tenant) {
      throw new ForbiddenException('Tenant not found');
    }

    if (tenant.status !== 'ACTIVE' && tenant.status !== 'TRIAL') {
      throw new ForbiddenException('Tenant account is not active');
    }

    return true;
  }
}
