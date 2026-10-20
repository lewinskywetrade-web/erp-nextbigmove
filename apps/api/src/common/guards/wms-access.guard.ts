import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantStatus } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { validate as uuidValidate } from 'uuid';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { EffectiveAccessService } from '../services/effective-access.service';

@Injectable()
export class WmsAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cls: ClsService,
    private readonly prisma: PrismaService,
    private readonly effectiveAccessService: EffectiveAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }
    if (user.impersonatedBy) {
      // ERP preview never opens the globally scoped warehouse staff surface.
      throw new ForbiddenException('View As is available for ERP. Return to your account to access WMS.');
    }

    const userId = user.userId || user.id;
    if (!userId) {
      throw new ForbiddenException('User context is required');
    }

    const selectedTenantId = this.readRequestedTenantId(request);
    if (selectedTenantId) {
      await this.assertActiveTenant(selectedTenantId);
      this.cls.set('tenantId', selectedTenantId);
    }

    this.cls.set('userId', userId);
    this.cls.set('userRole', user.role);
    this.cls.set('userPermissions', user.permissions || []);
    this.cls.set('sessionId', user.sessionId || null);
    this.cls.set('wmsGlobalAccess', user.role === 'SUPER_ADMIN' || !user.tenantId);

    if (user.role === 'SUPER_ADMIN') {
      return true;
    }

    if (user.tenantId) {
      throw new ForbiddenException('Use a WMS staff account to access WMS');
    }

    if (!required || required.length === 0) {
      return true;
    }

    const access = await this.effectiveAccessService.resolveUserAccess({
      userId,
      basePermissions: Array.isArray(user.permissions) ? user.permissions : [],
      workspace: 'wms',
    });
    const permissionSet = new Set(access.permissions);
    const hasAnyPermission = required.some((permission) => permissionSet.has(permission));

    if (!hasAnyPermission) {
      throw new ForbiddenException('Insufficient WMS permissions');
    }

    return true;
  }

  private readRequestedTenantId(request: {
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
    params?: Record<string, unknown>;
  }) {
    const raw =
      request.headers?.['x-tenant-id']
      ?? request.query?.tenantId
      ?? request.body?.tenantId
      ?? request.params?.tenantId
      ?? null;
    const tenantId = Array.isArray(raw) ? raw[0] : raw;

    if (tenantId === null || tenantId === undefined || tenantId === '') {
      return null;
    }

    if (typeof tenantId !== 'string' || !uuidValidate(tenantId)) {
      throw new ForbiddenException('Invalid partner context');
    }

    return tenantId;
  }

  private async assertActiveTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, status: true },
    });

    if (!tenant) {
      throw new ForbiddenException('Partner not found');
    }

    if (tenant.status !== TenantStatus.ACTIVE && tenant.status !== TenantStatus.TRIAL) {
      throw new ForbiddenException('Partner account is not active');
    }
  }
}
