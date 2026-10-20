import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from '@jest/globals';
import { assertImpersonationReadOnly, isExactAuthAction } from './impersonation-policy';
import { JwtAuthGuard } from './jwt-auth.guard';

const context = (method: string, controller = 'orders', path = '', requestExtra = {}) => {
  class TestController {}
  const handler = () => undefined;
  Reflect.defineMetadata(PATH_METADATA, controller, TestController);
  Reflect.defineMetadata(PATH_METADATA, path, handler);
  const request = { method, ...requestExtra };
  return {
    getClass: () => TestController,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};
const preview = { userId: 'target', role: 'SUPER_ADMIN', impersonatedBy: 'admin' };

describe('authenticated View As request policy', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('blocks %s even when the target is SUPER_ADMIN', method => {
    expect(() => assertImpersonationReadOnly(context(method), preview)).toThrow('View As is read-only');
  });

  it.each([
    ['POST', 'analytics/sales', 'reconcile'],
    ['POST', 'integrations', ':id/sync'],
    ['POST', 'auth', 'impersonate/:userId'],
    ['POST', 'auth', 'switch-tenant/:tenantId'],
    ['PATCH', 'auth', 'profile'],
    ['POST', 'stock-requests', 'payment-proof-upload'],
  ])('blocks mutation %s %s/%s', (method, controller, path) => {
    expect(() => new JwtAuthGuard().handleRequest(null, preview, null, context(method, controller, path)))
      .toThrow('View As is read-only');
  });

  it.each(['GET', 'HEAD'])('permits ordinary saved data/report %s with target identity', method => {
    const user = new JwtAuthGuard().handleRequest(null, preview, null, context(method, 'analytics/sales', 'overview'));
    expect(user).toBe(preview);
    expect(() => assertImpersonationReadOnly(context(method, 'integrations', 'pos-stores/:id/products'), preview)).not.toThrow();
  });

  it.each(['impersonate/stop', 'logout'])('permits only the exact auth %s action', path => {
    expect(() => assertImpersonationReadOnly(context('POST', 'auth', path), preview)).not.toThrow();
    expect(() => assertImpersonationReadOnly(context('POST', 'not-auth', path), preview)).toThrow();
    expect(() => assertImpersonationReadOnly(context('PATCH', 'auth', path), preview)).toThrow();
  });

  it('does not authorize arbitrary auth routes or user-provided URLs', () => {
    const spoof = context('POST', 'orders', 'update', { url: '/auth/impersonate/stop', path: '/auth/logout' });
    expect(isExactAuthAction(spoof, 'impersonate/stop')).toBe(false);
    expect(() => assertImpersonationReadOnly(spoof, preview)).toThrow();
    expect(() => assertImpersonationReadOnly(context('POST', 'auth', 'refresh'), preview)).toThrow();
  });

  it.each([
    ['integrations', 'shops/:shopId/products'],
    ['integrations', ':id/products'],
    ['integrations', ':id/meta/insights'],
    ['wms/products', 'overview'],
    ['wms/mobile', 'stock'],
    ['wms/mobile', 'home/inventory-summary'],
    ['wms/mobile', 'picking/baskets/:id/plan'],
    ['wms/mobile', 'packing/baskets/:id/plan'],
  ])('blocks the legacy GET mutation %s/%s including HEAD', (controller, path) => {
    for (const method of ['GET', 'HEAD']) {
      expect(() => assertImpersonationReadOnly(context(method, controller, path), preview)).toThrow('View As is read-only');
    }
  });

  it('does not change ordinary authenticated write behavior', () => {
    expect(() => assertImpersonationReadOnly(context('PATCH', 'auth', 'profile'), { impersonatedBy: null })).not.toThrow();
  });

  it('does not suppress an authentication error', () => {
    expect(() => new JwtAuthGuard().handleRequest(new Error('invalid token'), null, null, context('GET')))
      .toThrow('invalid token');
  });
});
