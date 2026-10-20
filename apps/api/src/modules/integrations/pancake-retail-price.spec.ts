import { describe, expect, it } from '@jest/globals';
import { Prisma } from '@prisma/client';
import {
  missingPancakeShopCurrency,
  normalizePancakeRetailPrice,
  normalizedPancakeRetailPriceForStorage,
  PANCAKE_RETAIL_PRICE_POLICY,
  readPancakeShopCurrencyResponse,
  resolvePancakeShopCurrency,
} from './pancake-retail-price';

const scope = { shopId: '101', productId: 'parent-a', variationId: 'variant-a' };
const currentCurrency = (currency: unknown = 'PHP100') =>
  resolvePancakeShopCurrency({ success: true, shops: [{ id: 101, currency }] }, '101');
const row = (price: unknown, overrides: Record<string, unknown> = {}) => ({
  id: 'variant-a', product_id: 'parent-a', retail_price: price, ...overrides,
});

describe('Pancake catalog retail currency normalization', () => {
  it.each([
    ['PHP100', 104900, '1049.00'],
    ['PHP100', 74900, '749.00'],
    ['PHP', 899, '899.00'],
    ['PHP', 100000, '100000.00'],
    ['PHP1', '899.25', '899.25'],
    ['PHP100', '104901', '1049.01'],
    ['PHP100', 0, '0.00'],
    ['PHP', '0.00', '0.00'],
  ])('normalizes only explicit %s units for %p', (currency, price, expected) => {
    const result = normalizePancakeRetailPrice(row(price), scope, currentCurrency(currency));
    expect(result.retailPrice?.toFixed(2)).toBe(expected);
    expect(result.evidence).toMatchObject({
      policy: PANCAKE_RETAIL_PRICE_POLICY, status: 'NORMALIZED',
      ...scope, sourcePath: 'row.retail_price', normalizedCurrency: 'PHP', normalizedAmount: expected,
    });
  });

  it.each([null, undefined, '', 'USD', 'PHP0', 'PHP1000', 'PHP0.01', 100])(
    'does not infer units from unsupported/missing currency %p', currency => {
      const context = resolvePancakeShopCurrency({ success: true, shops: [{ id: 101, currency }] }, '101');
      const result = normalizePancakeRetailPrice(row(104900), scope, context);
      expect(result.retailPrice).toBeNull();
      expect(result.evidence.status).toBe('SKIPPED');
    },
  );

  it('requires a successful response and one exact current shop identity', () => {
    for (const payload of [
      { success: false, shops: [{ id: 101, currency: 'PHP100' }] },
      { success: true, shops: [{ id: 102, currency: 'PHP100' }] },
      { success: true, shops: [{ id: 101, currency: 'PHP' }, { id: 101, currency: 'PHP100' }] },
    ]) expect(resolvePancakeShopCurrency(payload, '101').currency).toBeNull();
  });

  it.each([
    { currency: 'PHP100', currency_divisor: 1 },
    { currency: 'PHP100', currency_code: 'PHP' },
    { currency: 'PHP100', currencyMultiplier: 10 },
    { currency: 'PHP100', money_unit: 'major' },
  ])('fails closed on conflicting shop metadata %p', metadata => {
    expect(resolvePancakeShopCurrency({ success: true, shops: [{ id: 101, ...metadata }] }, '101').currency).toBeNull();
  });

  it.each([
    { currency: 'PHP' },
    { variation_info: { id: 'variant-a', currency: 'USD' } },
    { variation: { id: 'variant-a', currency_divisor: 1 } },
    { product: { id: 'parent-a', currency: 'PHP' } },
  ])('does not silently prefer shop units over conflicting row metadata %p', metadata => {
    expect(normalizePancakeRetailPrice(row(104900, metadata), scope, currentCurrency()).retailPrice).toBeNull();
  });

  it('validates monetary-object and response-level metadata', () => {
    const result = normalizePancakeRetailPrice(
      row({ amount: '104900', currency: 'PHP100' }), scope, currentCurrency(),
    );
    expect(result.retailPrice?.toFixed(2)).toBe('1049.00');
    expect(result.evidence.sourcePath).toBe('row.retail_price.amount');
    expect(normalizePancakeRetailPrice(
      row({ amount: '104900', currency: 'PHP' }), scope, currentCurrency(),
    ).retailPrice).toBeNull();
    expect(normalizePancakeRetailPrice(row(104900), scope, currentCurrency(), [{ currency: 'PHP' }]).retailPrice).toBeNull();
    expect(normalizePancakeRetailPrice(
      row({ amount: '104900', value: '1049' }), scope, currentCurrency(),
    ).retailPrice).toBeNull();
    expect(normalizePancakeRetailPrice(
      row({ amount: '104900', value: 104900 }), scope, currentCurrency(),
    ).retailPrice?.toFixed(2)).toBe('1049.00');
  });

  it('rejects an explicit current-currency price map contradiction without treating foreign-currency prices as the selected price', () => {
    const valid = normalizePancakeRetailPrice(row(104900, {
      retail_price_by_currency: { PHP100: 104900, PHP: 1049 },
    }), scope, currentCurrency());
    expect(valid.retailPrice?.toFixed(2)).toBe('1049.00');
    for (const map of [
      { PHP100: 119900 },
      { PHP100: null },
      [{ currency: 'PHP100', retail_price: 119900 }],
      [{ currency: 'PHP100', currency_divisor: 1, retail_price: 104900 }],
      [{ currency_code: 'PHP100', value: { amount: 104900, currency: 'PHP' } }],
    ]) {
      const result = normalizePancakeRetailPrice(row(104900, {
        retail_price_by_currency: map,
      }), scope, currentCurrency());
      expect(result.retailPrice).toBeNull();
      expect(result.evidence.reason).toBe('PRICE_CURRENT_CURRENCY_MAP_CONFLICT');
    }
  });

  it('bounds the newly fetched shop metadata body before parsing', async () => {
    await expect(readPancakeShopCurrencyResponse(new Response('{"success":true}'))).resolves.toEqual({ success: true });
    await expect(readPancakeShopCurrencyResponse(new Response('{}', { headers: { 'content-length': '9000000' } })))
      .rejects.toThrow('SHOP_CURRENCY_RESPONSE_UNAVAILABLE');
    await expect(readPancakeShopCurrencyResponse(new Response(' '.repeat(8 * 1024 * 1024 + 1))))
      .rejects.toThrow('SHOP_CURRENCY_RESPONSE_TOO_LARGE');
  });

  it.each([
    -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 'PHP 1,049', '1,049.00',
    '1e3', '--1', '10foo', true, {}, { amount: { value: 10 } },
    '999999999999999999999999999999999999', '1000000000000', '104900.5',
  ])('rejects malformed, unsafe, out-of-range or sub-cent values %p', price => {
    expect(normalizePancakeRetailPrice(row(price), scope, currentCurrency()).retailPrice).toBeNull();
  });

  it('does not round-trip exact decimal text through Number', () => {
    const result = normalizePancakeRetailPrice(row('999999999999'), scope, currentCurrency());
    expect(result.retailPrice?.toFixed(2)).toBe('9999999999.99');
  });

  it('keeps the exact variation zero rather than falling back to another price', () => {
    const result = normalizePancakeRetailPrice(row(0, {
      price: 104900, variations: [{ id: 'sibling', retail_price: 99900 }],
    }), scope, currentCurrency());
    expect(result.retailPrice?.toFixed(2)).toBe('0.00');
  });

  it('does not use a parent or first sibling price for a missing variant price', () => {
    const result = normalizePancakeRetailPrice(row(null, {
      product: { id: 'parent-a', retail_price: 104900 },
      variations: [{ id: 'sibling', retail_price: 99900 }],
      variation_infos: [{ id: 'sibling', retail_price: 99900 }],
      items: [{ id: 'sibling', retail_price: 99900 }],
    }), scope, currentCurrency());
    expect(result.retailPrice).toBeNull();
  });

  it.each([
    { id: 'sibling' },
    { variation_id: 'sibling' },
    { product_id: 'different-parent' },
    { variation_info: { id: 'sibling', retail_price: 104900 } },
    { product: { id: 'different-parent' } },
  ])('rejects conflicting exact identity %p', metadata => {
    expect(normalizePancakeRetailPrice(row(104900, metadata), scope, currentCurrency()).retailPrice).toBeNull();
  });

  it('accepts a matching nested variation amount and records its path', () => {
    const result = normalizePancakeRetailPrice(row(null, {
      variation_info: { id: 'variant-a', retail_price: 104900 },
    }), scope, currentCurrency());
    expect(result.retailPrice?.toFixed(2)).toBe('1049.00');
    expect(result.evidence.sourcePath).toBe('row.variation_info.retail_price');
  });

  it('does not reuse a currency context from another shop or historical snapshot', () => {
    expect(normalizePancakeRetailPrice(row(104900), scope, { ...currentCurrency(), shopId: '102' }).retailPrice).toBeNull();
    expect(normalizePancakeRetailPrice(row(104900, {
      productSnapshot: { order_currency: 'PHP100', currency_divisor: 100 },
    }), scope, missingPancakeShopCurrency('101', 'unavailable')).retailPrice).toBeNull();
  });

  it('persists a normalized Decimal without dividing again and rejects unproven or mismatched values', () => {
    const result = normalizePancakeRetailPrice(row(104900), scope, currentCurrency());
    const stored = normalizedPancakeRetailPriceForStorage(result.retailPrice, result.evidence, scope);
    expect(stored?.toFixed(2)).toBe('1049.00');
    expect(normalizedPancakeRetailPriceForStorage(stored, result.evidence, scope)?.toFixed(2)).toBe('1049.00');
    expect(normalizedPancakeRetailPriceForStorage(new Prisma.Decimal(104900), result.evidence, scope)).toBeNull();
    expect(normalizedPancakeRetailPriceForStorage(stored, undefined, scope)).toBeNull();
    expect(normalizedPancakeRetailPriceForStorage(stored, result.evidence, { ...scope, shopId: '102' })).toBeNull();
    expect(normalizedPancakeRetailPriceForStorage(stored, result.evidence, { ...scope, variationId: 'sibling' })).toBeNull();
  });
});
