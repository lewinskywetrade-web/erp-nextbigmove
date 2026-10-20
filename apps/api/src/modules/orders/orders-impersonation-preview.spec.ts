import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { OrdersService } from './orders.service';
import { AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS } from './orders.constants';

// These constructor dependencies are supplied by the fixture; avoid loading
// their external integration/cache clients for a notification boundary test.
jest.mock('../integrations/integration.service', () => ({ IntegrationService: class {} }));
jest.mock('./orders-aging-notification-cache.service', () => ({
  OrdersAgingNotificationCacheService: class {},
}));

describe('View as order notification reads', () => {
  function fixture(impersonatedBy: string | null) {
    const prisma = {
      notificationState: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 3),
      },
    };
    const cache = {
      hasRecentLazySync: jest.fn(async () => false),
      hasLazySyncLock: jest.fn(async () => false),
      setLazySyncLock: jest.fn(async () => undefined),
      setCachedBucketDetails: jest.fn(async () => undefined),
      markLazySyncFresh: jest.fn(async () => undefined),
      clearLazySyncLock: jest.fn(async () => undefined),
    };
    const cls = { get: (key: string) => key === 'impersonatedBy' ? impersonatedBy : null };
    const service = new OrdersService(
      prisma as any, cls as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, cache as any, {} as any,
    );
    const scopedShops = {
      tenantId: 'TARGET_TENANT',
      accessibleShopIds: ['TARGET_SHOP'],
      shopDisplayMap: new Map([['TARGET_SHOP', 'Target store']]),
    };
    jest.spyOn(service as any, 'resolveAccessibleAgingOrderScope').mockResolvedValue(scopedShops);
    jest.spyOn(service as any, 'loadCachedAgingOrdersBucketDetails').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadAgingOrdersBucketDetails').mockResolvedValue([]);
    const sync = jest.spyOn(service as any, 'syncAgingOrderNotificationsForTenant')
      .mockResolvedValue(undefined);
    return { service, prisma, cache, sync };
  }

  it('returns the target-scoped aging summary without regenerating notifications in preview', async () => {
    const f = fixture('ADMIN_ACTOR');
    const result = await f.service.getAgingOrdersSummary({
      thresholdDays: AGING_ORDERS_NOTIFICATION_THRESHOLD_DAYS,
    });

    expect(result.filters.shops).toEqual([
      { shop_id: 'TARGET_SHOP', shop_name: 'Target store' },
    ]);
    expect(f.prisma.notificationState.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'TARGET_TENANT', isUnread: true }),
    }));
    expect(f.sync).not.toHaveBeenCalled();
    expect(f.cache.setLazySyncLock).not.toHaveBeenCalled();
    expect(f.cache.markLazySyncFresh).not.toHaveBeenCalled();
  });

  it('returns existing unread count without changing notification rows in preview', async () => {
    const f = fixture('ADMIN_ACTOR');

    await expect(f.service.getAgingOrdersUnreadNotificationCount()).resolves.toEqual({ count: 3 });
    expect(f.prisma.notificationState.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'TARGET_TENANT', isUnread: true }),
    }));
    expect(f.sync).not.toHaveBeenCalled();
    expect(f.cache.hasRecentLazySync).not.toHaveBeenCalled();
    expect(f.cache.setLazySyncLock).not.toHaveBeenCalled();
  });

  it('keeps normal user lazy refresh and unread count behavior', async () => {
    const f = fixture(null);

    await expect(f.service.getAgingOrdersUnreadNotificationCount()).resolves.toEqual({ count: 3 });
    expect(f.sync).toHaveBeenCalledWith(
      'TARGET_TENANT', 'lazy', expect.objectContaining({ shopIds: ['TARGET_SHOP'] }),
    );
    expect(f.cache.setLazySyncLock).toHaveBeenCalledTimes(1);
    expect(f.cache.markLazySyncFresh).toHaveBeenCalledTimes(1);
    expect(f.cache.clearLazySyncLock).toHaveBeenCalledTimes(1);
  });
});
