import 'reflect-metadata';
import { describe, expect, it, jest } from '@jest/globals';
import { Controller, ExecutionContext, ForbiddenException, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { WmsAccessGuard } from '../guards/wms-access.guard';
import { WmsPartnerCostInterceptor, assertPartnerCostInput, hasInternalWmsCostAccess, partnerCostResponse } from './wms-partner-cost.interceptor';

@Controller('stock-requests') class Requests {}
@Controller('wms/mobile') class Mobile {}
@Controller('analytics') class Analytics {}
const partner = { userId: 'partner', tenantId: 'tenant', role: 'ADMIN' };
function context(user: unknown = partner, controller = Requests, body?: unknown) {
  const setHeader = jest.fn(), vary = jest.fn();
  return { setHeader, vary, ctx: {
    getType: () => 'http', getClass: () => controller, getHandler: () => function handler() {},
    switchToHttp: () => ({ getRequest: () => ({ user, body }), getResponse: () => ({ setHeader, vary }) }),
  } as unknown as ExecutionContext };
}
const boundary = new WmsPartnerCostInterceptor();

describe('partner WMS cost API boundary', () => {
  it('removes internal valuation and opaque nested source/event/note data without mutating cached source objects', async () => {
    const source = { partnerUnitCost: 359, retailPrice: 899, inhouseUnitCost: 100,
      landed_cost: 80, supplierUnitCost: 70, marginPct: 60,
      lines: [{ partnerUnitCost: 359, sourceSnapshot: { originalSupplierUnitCost: 70 }, notes: 'landed price 80', unitCost: 80 }],
      events: [{ id: 'event', eventType: 'UPDATED', message: 'supplier price 70', payload: { price: 70 } }],
      metadata: { arbitraryName: 80 }, wmsNotes: 'internal costs',
      invoice: { unitRate: 359, amount: 718, subtotal: 718, total: 800, vatAmount: 82, lineSnapshot: { cost: 80 } } };
    const copy = JSON.stringify(source);
    const f = context();
    const actual = await firstValueFrom(boundary.intercept(f.ctx, { handle: () => of(source) }));
    expect(actual).toEqual({ partnerUnitCost: 359, retailPrice: 899, lines: [{ partnerUnitCost: 359 }],
      events: [{ id: 'event', eventType: 'UPDATED' }], invoice: { unitRate: 359, amount: 718, subtotal: 718, total: 800, vatAmount: 82 } });
    expect(JSON.stringify(source)).toBe(copy);
    expect(f.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(f.vary).toHaveBeenCalledWith('Authorization');
  });

  it.each(['USER', 'VIEWER', 'ADMIN'])('does not treat a tenant %s or selected tenant header as warehouse staff', role => {
    expect(hasInternalWmsCostAccess({ ...partner, role })).toBe(false);
    expect(hasInternalWmsCostAccess({ userId: 'missing-scope', role })).toBe(false);
  });

  it.each([{ ...partner, role: 'SUPER_ADMIN' }, { userId: 'staff', role: 'USER', tenantId: null }])('retains the existing internal account full response and mutation scope', async user => {
    const source = { supplierUnitCost: 10, inhouseUnitCost: 20, notes: 'warehouse', sourceSnapshot: { raw: true } };
    const f = context(user, Mobile, source);
    expect(await firstValueFrom(boundary.intercept(f.ctx, { handle: () => of(source) }))).toBe(source);
    expect(f.setHeader).toHaveBeenCalled();
  });

  it.each([
    { supplierUnitCost: 1 }, { lines: [{ sourceSnapshot: { originalSupplierUnitCost: 1 } }] },
    { rows: [{ metadata: { landed_cost: 1 } }] }, { inhouseUnitCost: null }, { wmsNotes: 'change landed cost' },
    { sourceSnapshot: { changes: { unitCost: 1 } } },
  ])('rejects internal cost injection before any handler or database mutation: %j', body => {
    const next = { handle: jest.fn(() => of({ success: true })) };
    expect(() => boundary.intercept(context(partner, Requests, body).ctx, next)).toThrow(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('allows public partner charge fields and self-buy actual partner price input', () => {
    expect(() => assertPartnerCostInput({ partnerUnitCost: 359, originalPartnerUnitCost: 359,
      invoiceAmount: 718, lines: [{ partnerUnitCost: 359, sourceSnapshot: { productId: 'id', originalPartnerUnitCost: 359 } }], partnerNotes: 'request' })).not.toThrow();
  });

  it('preserves only public original quote/quantity scalars needed to review a pricing revision, including zero', () => {
    expect(partnerCostResponse({ sourceSnapshot: { originalPartnerUnitCost: 0, originalApprovedQuantity: 3,
      originalSupplierUnitCost: 80, hidden: 'landed price 70', raw: { sourceCost: 70 } } })).toEqual({
      sourceSnapshot: { originalPartnerUnitCost: 0, originalApprovedQuantity: 3 },
    });
  });

  it('removes internal supplier documents and attachment URLs while preserving the partner payment proof and billed invoice charges', () => {
    expect(partnerCostResponse({ paymentProofImageUrl: 'partner-payment.png', invoiceNumber: 'PARTNER-1', invoiceAmount: 359,
      supplierInvoiceUrl: 'private-supplier.pdf', attachments: [{ url: 'private-warehouse.png' }],
      invoice: { supplierInvoiceAssetId: 'private', lines: [{ unitRate: 359, amount: 359, lineSnapshot: { invoiceUrl: 'private.pdf' } }] },
    })).toEqual({ paymentProofImageUrl: 'partner-payment.png', invoiceNumber: 'PARTNER-1', invoiceAmount: 359,
      invoice: { lines: [{ unitRate: 359, amount: 359 }] } });
  });

  it.each([Buffer.from('secret CSV'), new StreamableFile(Buffer.from('secret PDF')), 'secret HTML'])('refuses opaque future exports instead of leaking internal content', async value => {
    await expect(firstValueFrom(boundary.intercept(context().ctx, { handle: () => of(value) }))).rejects.toThrow(ForbiddenException);
  });

  it('sanitizes JSON serializer results, preserving public decimal and date semantics', () => {
    expect(partnerCostResponse({ invoice: { toJSON: () => ({ unitRate: '359.00', landedCost: 20 }) },
      createdAt: new Date('2026-10-20T00:00:00.000Z') })).toEqual({ invoice: { unitRate: '359.00' }, createdAt: '2026-10-20T00:00:00.000Z' });
  });

  it('does not change unrelated ERP analytics responses', async () => {
    const source = { cogs: 40, margin: 20 };
    const f = context(partner, Analytics);
    expect(await firstValueFrom(boundary.intercept(f.ctx, { handle: () => of(source) }))).toBe(source);
    expect(f.setHeader).not.toHaveBeenCalled();
  });

  it('preserves direct WMS access denial for partner accounts and existing permission checks for staff', async () => {
    const cls = { set: jest.fn() };
    const access = { resolveUserAccess: jest.fn(async () => ({ permissions: ['wms.products.read'] })) };
    const guard = new WmsAccessGuard({ getAllAndOverride: () => ['wms.products.read'] } as unknown as Reflector, cls as never, {} as never, access as never);
    await expect(guard.canActivate(context(partner, Mobile).ctx)).rejects.toThrow('Use a WMS staff account');
    expect(access.resolveUserAccess).not.toHaveBeenCalled();
    expect(await guard.canActivate(context({ userId: 'staff', role: 'USER', tenantId: null }, Mobile).ctx)).toBe(true);
    access.resolveUserAccess.mockResolvedValueOnce({ permissions: [] });
    await expect(guard.canActivate(context({ userId: 'staff', role: 'USER', tenantId: null }, Mobile).ctx)).rejects.toThrow('Insufficient WMS permissions');
  });
});
