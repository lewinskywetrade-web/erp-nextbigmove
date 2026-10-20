import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

// A server-only request property. Clients cannot set it with a URL/header/body.
export const IMPERSONATION_STOP_REQUEST = Symbol('impersonation-stop-request');
export const READ_ONLY_USER_PREVIEW_POLICY = 'READ_ONLY_USER_PREVIEW_V1';

// These older read routes also synchronize live business data. The ordinary
// saved-product/report readers remain available in preview.
const MUTATING_GET_ROUTES = new Set([
  'integrations|shops/:shopId/products',
  'integrations|:id/products',
  'integrations|:id/meta/insights',
  'wms/products|overview',
  'wms/mobile|stock',
  'wms/mobile|home/inventory-summary',
  'wms/mobile|picking/baskets/:id/plan',
  'wms/mobile|packing/baskets/:id/plan',
]);

export function isExactAuthAction(context: ExecutionContext, action: string): boolean {
  return context.switchToHttp().getRequest().method === 'POST'
    && Reflect.getMetadata(PATH_METADATA, context.getClass()) === 'auth'
    && Reflect.getMetadata(PATH_METADATA, context.getHandler()) === action;
}

export function assertImpersonationReadOnly(context: ExecutionContext, user: { impersonatedBy?: string | null }): void {
  if (!user?.impersonatedBy) return;
  const method = context.switchToHttp().getRequest().method;
  const route = `${Reflect.getMetadata(PATH_METADATA, context.getClass())}|${Reflect.getMetadata(PATH_METADATA, context.getHandler())}`;
  if (['GET', 'HEAD'].includes(method) && !MUTATING_GET_ROUTES.has(route)) return;
  if (isExactAuthAction(context, 'impersonate/stop') || isExactAuthAction(context, 'logout')) return;
  throw new ForbiddenException({
    code: READ_ONLY_USER_PREVIEW_POLICY,
    message: 'View As is read-only. Return to your account to make changes.',
  });
}
