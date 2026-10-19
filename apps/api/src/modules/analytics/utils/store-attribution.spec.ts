import { describe, expect, it } from '@jest/globals';
import {
  resolveStoreAttribution,
  StoreAttributionIndex,
  UNATTRIBUTED_STORE_KEY,
} from './store-attribution';

function index(overrides: Partial<StoreAttributionIndex> = {}): StoreAttributionIndex {
  return {
    storeByShopId: new Map(),
    storeByAdId: new Map(),
    storeByCreativeCode: new Map(),
    storeByCodePrefix: new Map(),
    storeByLabel: new Map(),
    validStoreIds: new Set(['order-store', 'linked-store', 'sentra-store', 'chapter-store', 'legacy-store']),
    ...overrides,
  };
}

describe('resolveStoreAttribution', () => {
  it('uses the explicit ad owner independently of the purchasing shop', () => {
    expect(resolveStoreAttribution(
      { adId: 'ad-1', shops: ['shop-1'] },
      index({
        storeByShopId: new Map([['shop-1', 'order-store']]),
        storeByAdId: new Map([['ad-1', 'linked-store']]),
      }),
    )).toBe('linked-store');
  });

  it('uses a manual creative link even when the ad name has no convention', () => {
    expect(resolveStoreAttribution(
      { adId: 'ad-1', adName: 'Creative 12', shops: [] },
      index({ storeByAdId: new Map([['ad-1', 'linked-store']]) }),
    )).toBe('linked-store');
  });

  it('uses the enrolled creative for a static code with no matched orders', () => {
    expect(resolveStoreAttribution(
      { adId: 'ad-1', adName: 'ITEM_Travel Safety_SENTRA-I0065_Lyca', shops: [] },
      index({ storeByCreativeCode: new Map([['SENTRA-I0065', 'sentra-store']]) }),
    )).toBe('sentra-store');
  });

  it('uses a unique active store prefix when the exact code is not enrolled', () => {
    expect(resolveStoreAttribution(
      { adName: 'ITEM_Quiet Thinkers_CW-I0068_Lyca', shops: [] },
      index({ storeByCodePrefix: new Map([['CW', 'chapter-store']]) }),
    )).toBe('chapter-store');
  });

  it('keeps the unique legacy mapping fallback', () => {
    expect(resolveStoreAttribution(
      { adName: 'TaiSui_ThisCNY|Broad|BOF_Team2_1177_0124', mapping: 'tai sui' },
      index({ storeByLabel: new Map([['tai sui', 'legacy-store']]) }),
    )).toBe('legacy-store');
  });

  it('keeps ambiguous or missing attribution in the unattributed bucket', () => {
    expect(resolveStoreAttribution(
      { adName: 'Creative 12', mapping: 'shared-product', shops: [] },
      index({ storeByLabel: new Map([['shared-product', null]]) }),
    )).toBe(UNATTRIBUTED_STORE_KEY);
  });
});


describe('ambiguous Store ad delivery evidence', () => {
  it.each([['shop-1', 'shop-2'], ['shop-2', 'shop-1']])('never picks the first of mixed shops %j', (...shops) => {
    expect(resolveStoreAttribution({ shops }, index({ storeByShopId: new Map([
      ['shop-1', 'order-store'], ['shop-2', 'linked-store'],
    ]) }))).toBe(UNATTRIBUTED_STORE_KEY);
  });
  it('keeps known conflicting code/shop evidence unattributed', () => {
    expect(resolveStoreAttribution({ shops: ['shop-1'], adName: 'ITEM_Travel Safety_SENTRA-I0065_Lyca' },
      index({ storeByShopId: new Map([['shop-1', 'order-store']]),
        storeByCreativeCode: new Map([['SENTRA-I0065', 'sentra-store']]) }))).toBe(UNATTRIBUTED_STORE_KEY);
  });
  it('does not bypass an invalid explicit link through a plausible mapping', () => {
    expect(resolveStoreAttribution({ adId: 'ad', mapping: 'pv::order-store::variant' },
      index({ storeByAdId: new Map([['ad', null]]) }))).toBe(UNATTRIBUTED_STORE_KEY);
  });
  it('rejects a precise mapping to an unscoped store', () => {
    expect(resolveStoreAttribution({ mapping: 'pv::foreign-store::variant' }, index())).toBe(UNATTRIBUTED_STORE_KEY);
  });
  it('preserves ambiguity when an unknown shop accompanies a known one', () => {
    expect(resolveStoreAttribution({ shops: ['shop-1', 'unknown'] }, index({
      storeByShopId: new Map([['shop-1', 'order-store']]),
    }))).toBe(UNATTRIBUTED_STORE_KEY);
  });
  it('does not use the first creative code when an ad declares multiple codes', () => {
    expect(resolveStoreAttribution({ adName: 'ITEM_Title_SENTRA-I0065_CW-I0068_Name' }, index({
      storeByCreativeCode: new Map([['SENTRA-I0065', 'sentra-store']]),
    }))).toBe(UNATTRIBUTED_STORE_KEY);
  });
});
