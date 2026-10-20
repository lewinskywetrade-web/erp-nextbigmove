import { describe, expect, it, jest } from '@jest/globals';
import { SalesAnalyticsController } from './sales-analytics.controller';

describe('Business Performance explicit selection and exclusion parameters', () => {
  it.each(['getOverview', 'getStoreOverview'])('%s distinguishes None from All and preserves false flags', async method => {
    const getOverview = jest.fn<any>().mockResolvedValue({}), getStoreOverview = jest.fn<any>().mockResolvedValue({});
    const controller: any = new SalesAnalyticsController({ getOverview, getStoreOverview } as any);
    const values = ['2026-10-01', '2026-10-19', undefined, 'false', 'false', 'false', 'false', 'false', 'true', 'true', 'none'];
    await controller[method](...values);
    const call = (method === 'getOverview' ? getOverview : getStoreOverview).mock.calls[0][0];
    expect(call).toMatchObject({ emptySelection: true, excludeCancel: false, excludeRestocking: false,
      excludeAbandoned: false, excludeRts: false, excludeRepurchase: false, includeTax12: true, includeTax1: true });
    await controller[method](...values, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa, bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(((method === 'getOverview' ? getOverview : getStoreOverview).mock.calls[1][0] as any).teamIds).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    await expect(controller[method](...values, ['bad-header'])).rejects.toThrow('Select valid tenant teams.');
    await controller[method]();
    expect((method === 'getOverview' ? getOverview : getStoreOverview).mock.calls[2][0]).toMatchObject({ emptySelection: false, mappings: [] });
  });
});
