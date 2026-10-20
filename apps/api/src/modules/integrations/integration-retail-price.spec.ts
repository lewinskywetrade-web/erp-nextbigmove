import 'reflect-metadata';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { IntegrationService } from './integration.service';
import { PANCAKE_RETAIL_PRICE_POLICY } from './pancake-retail-price';

const providerRow = (id: string, price: unknown) => ({
  id, product_id: `parent-${id}`, name: id, retail_price: price,
});
const response = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 503 });

function harness() {
  const saved = new Map<string, any>();
  const changes: any[] = [];
  const tx = {
    posStore: { findUnique: jest.fn(async () => ({ tenantId: 'tenant', shopId: '101' })) },
    posProduct: {
      findFirst: jest.fn(async (args: any) => {
        const variationId = args.where.OR?.[0]?.variationId;
        return saved.has(variationId) ? { id: variationId } : null;
      }),
      update: jest.fn(async (args: any) => {
        changes.push(args.data);
        const updated = { ...saved.get(args.where.id), ...args.data };
        saved.set(args.where.id, updated);
        return { id: args.where.id, ...updated };
      }),
      create: jest.fn(async (args: any) => {
        changes.push(args.data);
        saved.set(args.data.variationId, args.data);
        return { id: args.data.variationId, ...args.data };
      }),
    },
    wmsProductProfile: { upsert: jest.fn(async () => ({})), create: jest.fn(async () => ({})) },
  };
  const service = Object.create(IntegrationService.prototype) as any;
  service.logger = { warn: jest.fn() };
  service.prisma = { $transaction: jest.fn(async (callback: any) => callback(tx)) };
  return { service, tx, saved, changes };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('Pancake retail price import', () => {
  it('fetches one exact-shop currency for all catalog pages and persists normalized prices once', async () => {
    const { service, saved, changes } = harness();
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async input => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/shops') {
        return response({ success: true, shops: [{ id: 999, currency: 'PHP' }, { id: 101, currency: 'PHP100' }] });
      }
      const page = Number(url.searchParams.get('page_number'));
      return response({ success: true, page_number: page, total_pages: 2,
        data: page === 1 ? [providerRow('a', 104900), providerRow('zero', 0)] : [providerRow('b', 74900)] });
    });
    for (let run = 0; run < 2; run++) {
      const products = await service.fetchProductsFromPancake('101', 'fixture-key');
      await service.upsertStoreProducts('store', products);
      expect(saved.get('a').retailPrice.toFixed(2)).toBe('1049.00');
      expect(saved.get('b').retailPrice.toFixed(2)).toBe('749.00');
      expect(saved.get('zero').retailPrice.toFixed(2)).toBe('0.00');
    }
    expect(fetchMock.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/v1/shops')).toHaveLength(2);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(saved.get('a').productSnapshot.erpRetailPrice).toMatchObject({
      policy: PANCAKE_RETAIL_PRICE_POLICY, rawAmount: '104900', divisor: '100', normalizedAmount: '1049.00',
    });
    for (const change of changes) {
      expect(change).not.toHaveProperty('cogs');
      expect(change).not.toHaveProperty('cogsHistory');
    }
  });

  it.each(['missing', 'http-error', 'network-error', 'invalid-json', 'conflicting'])(
    'keeps existing price and still imports product metadata when shop currency is %s', async mode => {
      const { service, saved } = harness();
      saved.set('a', { retailPrice: new Prisma.Decimal(899), name: 'old-name' });
      jest.spyOn(global, 'fetch').mockImplementation(async input => {
        if (new URL(String(input)).pathname === '/api/v1/shops') {
          if (mode === 'network-error') throw new Error('fixture-key must not be logged');
          if (mode === 'http-error') return response({}, false);
          if (mode === 'invalid-json') return new Response('invalid json');
          return response({ success: true, shops: [{ id: 101, ...(mode === 'conflicting' ? { currency: 'PHP100', currency_divisor: 1 } : {}) }] });
        }
        return response({ success: true, data: [providerRow('a', 104900), providerRow('new', 74900)] });
      });
      await service.upsertStoreProducts('store', await service.fetchProductsFromPancake('101', 'fixture-key'));
      expect(saved.get('a').retailPrice.toFixed(2)).toBe('899.00');
      expect(saved.get('a').name).toBe('a');
      expect(saved.get('new').retailPrice).toBeNull();
      expect(saved.get('a').productSnapshot.erpRetailPrice.status).toBe('SKIPPED');
      expect(JSON.stringify(service.logger.warn.mock.calls)).not.toContain('fixture-key');
    },
  );

  it('preserves plain PHP retail prices irrespective of magnitude', async () => {
    const { service } = harness();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(response({ success: true, shops: [{ id: 101, currency: 'PHP' }] }))
      .mockResolvedValueOnce(response({ data: [providerRow('a', 899), providerRow('b', 100000)] }));
    const rows = await service.fetchProductsFromPancake('101', 'fixture-key');
    expect(rows.map((r: any) => r.retailPrice.toFixed(2))).toEqual(['899.00', '100000.00']);
  });

  it('expands variants independently and never fills a missing sibling price from the parent', async () => {
    const { service } = harness();
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(response({ success: true, shops: [{ id: 101, currency: 'PHP100' }] }))
      .mockResolvedValueOnce(response({ data: [{
        id: 'parent', name: 'multi-variant', retail_price: 99900,
        variations: [{ id: 'a', retail_price: 74900 }, { id: 'b', retail_price: null }],
      }] }));
    const rows = await service.fetchProductsFromPancake('101', 'fixture-key');
    expect(rows[0].retailPrice.toFixed(2)).toBe('749.00');
    expect(rows[1].retailPrice).toBeNull();
    expect(rows[1].productSnapshot.erpRetailPrice.reason).toBe('PRICE_MISSING_FOR_EXACT_VARIATION');
  });

  it.each(['envelope', 'root-array'])('preserves existing price when duplicate rows in %s disagree', async shape => {
    const { service, saved } = harness();
    saved.set('a', { retailPrice: new Prisma.Decimal(500) });
    jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(response({ success: true, shops: [{ id: 101, currency: 'PHP100' }] }))
      .mockResolvedValueOnce(response(shape === 'envelope'
        ? { data: [providerRow('a', 74900), providerRow('a', 89900), providerRow('a', 74900)] }
        : [providerRow('a', 74900), providerRow('a', 89900), providerRow('a', 74900)]));
    await service.upsertStoreProducts('store', await service.fetchProductsFromPancake('101', 'fixture-key'));
    expect(saved.get('a').retailPrice.toFixed(2)).toBe('500.00');
    expect(saved.get('a').productSnapshot.erpRetailPrice.reason).toBe('DUPLICATE_PROVIDER_VARIATION_PRICE_CONFLICT');
  });
});
