import { CallHandler, ExecutionContext, ForbiddenException, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { map } from 'rxjs/operators';

type CostUser = { userId?: string; id?: string; role?: string; tenantId?: string | null };

// WmsAccessGuard's existing account boundary is preserved: platform admins and
// null-tenant warehouse staff are internal; tenant-bound accounts are partners.
// Missing account context fails closed. Selecting a tenant in headers/CLS never
// turns a warehouse staff account into a partner, or a partner into staff.
export function hasInternalWmsCostAccess(user?: CostUser | null): boolean {
  return !!(user && (user.userId || user.id)
    && (user.role === 'SUPER_ADMIN' || (user.tenantId === null && ['ADMIN', 'USER', 'VIEWER'].includes(user.role ?? ''))));
}

const keyOf = (key: string) => key.replace(/[^a-z0-9]/gi, '').toLowerCase();
const INTERNAL_COST_FIELDS = new Set([
  'inhouseUnitCost', 'inhouseCost', 'inhouseCogs', 'supplierUnitCost', 'supplierCost', 'supplierCogs', 'supplierPrice',
  'landedCost', 'landedUnitCost', 'unitLandedCost', 'landedPrice', 'totalLandedCost', 'landedTotal',
  'unitCost', 'actualUnitCost', 'actualCost', 'sourceCost', 'sourceUnitCost', 'purchaseCost', 'purchasePrice', 'costPrice', 'internalCost', 'warehouseCost',
  'originalSupplierUnitCost', 'originalInhouseUnitCost', 'originalUnitCost', 'oldUnitCost', 'newUnitCost',
  'unitCostBefore', 'unitCostAfter', 'oldCost', 'newCost', 'sourceBefore', 'sourceAfter',
  'totalCost', 'totalUnitCost', 'averageUnitCost', 'supplierTotal', 'inventoryValue', 'stockValue', 'totalStockValue', 'valuation',
  'margin', 'marginPct', 'marginPercent', 'partnerMargin', 'profitMargin', 'grossMargin', 'netMargin',
  'markup', 'markupPct', 'grossProfit', 'netProfit', 'profit', 'selectedCogs', 'costBasis', 'costSource', 'costBreakdown',
  'cogs', 'cogsHistory', 'erpHistoryBefore', 'erpHistoryAfter', 'cogsSync', 'fallbackFromCurrentErp',
].map(keyOf));
const PRIVATE_ENVELOPES = new Set([
  'sourceSnapshot', 'productSnapshot', 'lineSnapshot', 'orderSnapshot', 'rawSnapshot', 'sourceRaw', 'rawPayload',
  'rawResponse', 'raw', 'payload', 'changes', 'metadata', 'audit', 'auditLog', 'auditLogs',
  'supplierInvoice', 'supplierInvoices', 'supplierInvoiceUrl', 'supplierInvoiceImageUrl', 'supplierInvoicePdfUrl',
  'supplierInvoiceAsset', 'supplierInvoiceAssetId', 'supplierInvoiceNumber', 'supplierReceipt', 'supplierReceiptUrl',
  'supplierDocuments', 'purchaseInvoice', 'purchaseInvoiceUrl', 'sourceInvoice', 'sourceInvoiceUrl',
  'costAttachments', 'internalAttachments', 'attachments',
  'wmsNotes', 'internalNotes', 'notes', 'footerNotes', 'remarks', 'comment', 'comments', 'message',
].map(keyOf));
const INTERNAL_INPUT_FIELDS = new Set(['wmsNotes', 'internalNotes'].map(keyOf));

// Partner prices, invoice unitRate/amount/subtotal/total, tax and retailPrice are
// deliberately retained. They are commercial charges, not warehouse valuation.
export function assertPartnerCostInput(value: unknown, depth = 0): void {
  if (value === null || typeof value !== 'object') return;
  if (depth > 64) throw new ForbiddenException('Partner request nesting exceeds the supported limit');
  if (Array.isArray(value)) { value.forEach(row => assertPartnerCostInput(row, depth + 1)); return; }
  for (const [key, child] of Object.entries(value)) {
    if ((INTERNAL_COST_FIELDS.has(keyOf(key)) || INTERNAL_INPUT_FIELDS.has(keyOf(key))) && child !== undefined) {
      throw new ForbiddenException('Internal WMS cost fields cannot be submitted by partners');
    }
    assertPartnerCostInput(child, depth + 1);
  }
}

export function partnerCostResponse(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 64) throw new ForbiddenException('Partner response nesting exceeds the supported limit');
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer
    || value instanceof StreamableFile || typeof (value as { pipe?: unknown }).pipe === 'function') {
    throw new ForbiddenException('This warehouse export is restricted to internal WMS staff');
  }
  if (Array.isArray(value)) return value.map(row => partnerCostResponse(row, depth + 1));
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return partnerCostResponse((value as { toJSON(): unknown }).toJSON(), depth + 1);
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (keyOf(key) === 'sourcesnapshot') {
      // The revision screen needs the original partner quote. Expose only these
      // two public scalars, never the raw supplier/source snapshot.
      if (child && typeof child === 'object' && !Array.isArray(child)) {
        const snapshot = child as Record<string, unknown>;
        const quote: Record<string, number> = {};
        for (const field of ['originalPartnerUnitCost', 'originalApprovedQuantity']) {
          const amount = snapshot[field];
          if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) quote[field] = amount;
        }
        if (Object.keys(quote).length) result[key] = quote;
      }
      continue;
    }
    if (!INTERNAL_COST_FIELDS.has(keyOf(key)) && !PRIVATE_ENVELOPES.has(keyOf(key))) {
      result[key] = partnerCostResponse(child, depth + 1);
    }
  }
  return result;
}

@Injectable()
export class WmsPartnerCostInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const paths = [Reflect.getMetadata(PATH_METADATA, context.getClass())].flat();
    const scoped = paths.some(path => typeof path === 'string'
      && (path === 'wms' || path.startsWith('wms/') || path === 'stock-requests'));
    const request = context.switchToHttp().getRequest<{ user?: CostUser; body?: unknown }>();
    if (!scoped) return next.handle();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void; vary?(name: string): void }>();
    response.setHeader('Cache-Control', 'private, no-store');
    response.vary?.('Authorization');
    if (hasInternalWmsCostAccess(request.user)) return next.handle();
    assertPartnerCostInput(request.body);
    return next.handle().pipe(map(value => {
      if (typeof value === 'string') throw new ForbiddenException('Partner warehouse responses must use structured data');
      return partnerCostResponse(value);
    }));
  }
}
