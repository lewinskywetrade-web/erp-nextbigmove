import { Prisma, WmsPurchasingRequestType } from '@prisma/client';
import { describe, expect, it, jest } from '@jest/globals';
import { currentPartnerPrice } from './partner-price';
import { WmsPurchasingService } from './wms-purchasing.service';
import { StockRequestsController } from './stock-requests.controller';

const scope = { productId: 'pos', tenantId: 'tenant', storeId: 'store' };
const row = (extra: Record<string, unknown> = {}) => ({ ...scope, cogs: new Prisma.Decimal('359.00'), startDate: null, endDate: null, ...extra });
const today = '2026-10-20';
describe('current ERP partner quote', () => {
  it('uses one current dated history ahead of an undated default, never a future row', () => {
    expect(currentPartnerPrice([row({ cogs: '80.00' }), row({ startDate: '2026-10-01', endDate: '2026-10-20' }),
      row({ startDate: '2026-10-21', cogs: '500.00' })], scope, today)).toBe(359);
  });
  it('uses a unique unexpired default when no dated cost is applicable', () => {
    expect(currentPartnerPrice([row(), row({ startDate: '2026-10-21', cogs: 400 })], scope, today)).toBe(359);
  });
  it('preserves an explicitly configured zero instead of treating free partner-supplied stock as missing', () => {
    expect(currentPartnerPrice([row({ cogs: '0.00' })], scope, today)).toBe(0);
  });
  it.each([
    [], [row({ cogs: -1 })], [row({ cogs: '1.234' })], [row({ cogs: '10000000000.00' })],
    [row({ cogs: 'NaN' })], [row({ endDate: '2026-10-19' })], [row({ startDate: '2026-10-21' })],
    [row(), row()], [row({ startDate: '2026-10-01' }), row({ startDate: '2026-10-10' })],
    [row({ tenantId: 'other' })], [row({ storeId: 'other' })], [row({ startDate: 'invalid' })],
    [row({ startDate: '2026-10-21', endDate: '2026-10-01' })],
  ].map(rows => ({ rows })))('keeps missing, invalid, ambiguous or foreign prices unavailable: %j', ({ rows }) => {
    expect(currentPartnerPrice(rows as never, scope, today)).toBeNull();
  });
});

function serviceFixture() {
  const product = { id: 'pos', productId: 'external-product', variationId: 'variant' };
  const prisma = {
    $queryRawUnsafe: jest.fn(async () => [{ businessDate: today }]),
    posProductCogs: { findMany: jest.fn(async () => [row()]) },
    posProduct: { findFirst: jest.fn(async () => product) },
  };
  const service: any = new WmsPurchasingService(prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never);
  return { service, prisma, product };
}
const managedLine = { requestedQuantity: 2, productId: 'external-product', variationId: 'variant', resolvedPosProductId: 'pos', partnerUnitCost: 1 };

describe('partner-managed procurement uses a server quote', () => {
  it('keeps an all-zero invoice explicit while refusing to convert missing or invalid line prices to zero', () => {
    const f = serviceFixture();
    const line = { requestedQuantity: 2, approvedQuantity: null, partnerUnitCost: new Prisma.Decimal(0) };
    expect(f.service.computeInvoiceAmountFromLines([line])).toBe(0);
    expect(f.service.computeInvoiceAmountFromLines([line, { ...line, partnerUnitCost: new Prisma.Decimal('12.34') }])).toBe(24.68);
    for (const price of [null, undefined, -1, NaN, Infinity, 0.001]) {
      expect(f.service.computeInvoiceAmountFromLines([line, { ...line, partnerUnitCost: price }])).toBeNull();
    }
    expect(f.service.computeInvoiceAmountFromLines([])).toBeNull();
    expect(f.service.computeInvoiceAmountFromLines([{ ...line, requestedQuantity: -1 }])).toBeNull();
  });
  it('ignores a tampered posted price and captures the authoritative current ERP price in line and original snapshot', async () => {
    const f = serviceFixture();
    const [line] = await f.service.normalizeCreateLines({ tenantId: 'tenant', storeId: 'store', requestType: WmsPurchasingRequestType.PROCUREMENT,
      useCurrentPartnerPrices: true, lines: [managedLine] });
    expect(line.partnerUnitCost).toBe(359);
    expect(line.sourceSnapshot.originalPartnerUnitCost).toBe(359);
    expect(f.prisma.posProduct.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pos', storeId: 'store', store: { tenantId: 'tenant' } } }));
    expect(f.prisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("AT TIME ZONE 'Asia/Manila'"));
  });
  it('does not manufacture a price or use supplier price for missing ERP history', async () => {
    const f = serviceFixture(); f.prisma.posProductCogs.findMany.mockResolvedValueOnce([]);
    await expect(f.service.normalizeCreateLines({ tenantId: 'tenant', storeId: 'store', requestType: WmsPurchasingRequestType.PROCUREMENT,
      useCurrentPartnerPrices: true, lines: [managedLine] })).rejects.toThrow('current ERP partner cost is unavailable');
  });
  it('accepts a server-derived explicit zero for managed partner-supplied stock', async () => {
    const f = serviceFixture(); f.prisma.posProductCogs.findMany.mockResolvedValueOnce([row({ cogs: '0.00' })]);
    const [line] = await f.service.normalizeCreateLines({ tenantId: 'tenant', storeId: 'store', requestType: WmsPurchasingRequestType.PROCUREMENT,
      useCurrentPartnerPrices: true, lines: [managedLine] });
    expect(line.partnerUnitCost).toBe(0);
    expect(line.sourceSnapshot.originalPartnerUnitCost).toBe(0);
  });
  it.each([{ resolvedPosProductId: undefined }, { productId: 'wrong' }, { variationId: 'wrong' }])('rejects unbound or conflicting product identity: %j', override => {
    const f = serviceFixture();
    return expect(f.service.normalizeCreateLines({ tenantId: 'tenant', storeId: 'store', requestType: WmsPurchasingRequestType.PROCUREMENT,
      useCurrentPartnerPrices: true, lines: [{ ...managedLine, ...override }] })).rejects.toThrow();
  });
  it('preserves legitimate self-buy actual cost and existing internal manual procurement pricing', async () => {
    const f = serviceFixture();
    for (const [requestType, useCurrentPartnerPrices] of [[WmsPurchasingRequestType.SELF_BUY, true], [WmsPurchasingRequestType.PROCUREMENT, false]]) {
      const [line] = await f.service.normalizeCreateLines({ tenantId: 'tenant', storeId: 'store', requestType, useCurrentPartnerPrices, lines: [{ ...managedLine, partnerUnitCost: 25 }] });
      expect(line.partnerUnitCost).toBe(25);
    }
    expect(f.prisma.posProductCogs.findMany).not.toHaveBeenCalled();
  });
  it('enables authoritative pricing at the real stock-request controller boundary', async () => {
    const service = { createBatch: jest.fn(async () => ({})) };
    await new StockRequestsController(service as never).createBatch({ user: { tenantId: 'tenant' } }, {} as never);
    expect(service.createBatch).toHaveBeenCalledWith({}, 'tenant', true);
  });
  it('quotes product options from ERP histories and preserves null/zero, excluding inconsistent profile identity', async () => {
    const f = serviceFixture();
    const profile = { id: 'profile', tenantId: 'tenant', storeId: 'store', productId: 'external-product', variationId: 'variant',
      inhouseUnitCost: 90, supplierUnitCost: 70, posProduct: { ...f.product, name: 'Product', customId: null, productSnapshot: null,
        retailPrice: 500, store: { id: 'store', tenantId: 'tenant', name: 'Store', shopName: null } } };
    f.service.prisma.posStore = { findMany: jest.fn(async () => [{ id: 'store', name: 'Store', shopName: null }]) };
    f.service.prisma.wmsProductProfile = { findMany: jest.fn(async () => [profile, { ...profile, id: 'wrong', variationId: 'wrong' }]) };
    f.service.resolveTenantScope = jest.fn(async () => ({ activeTenantId: 'tenant', tenants: [] }));
    for (const expected of [359, 0, null]) {
      f.prisma.posProductCogs.findMany.mockResolvedValueOnce(expected === null ? [] : [row({ cogs: expected })]);
      const result = await f.service.getProductOptions({});
      expect(result.pagination.total).toBe(1);
      expect(result.products[0].partnerUnitCost).toBe(expected);
      expect(result.products[0].inhouseUnitCost).toBe(90); // internal service scope retained; HTTP boundary strips it for partners
    }
    expect(f.service.prisma.wmsProductProfile.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant', posProduct: { store: { tenantId: 'tenant' } } }),
    }));
  });
});
