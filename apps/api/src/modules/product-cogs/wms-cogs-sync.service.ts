import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, WmsProductProfile } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProductCogsRefreshPublisherService } from '../integrations/services/product-cogs-refresh-publisher.service';
import { LockedCogsProduct, productCogsToday, validateCurrentCogsHistory, writeCurrentProductCogs } from './current-product-cogs';

export const WMS_ERP_COGS_POLICY = 'INHOUSE_POSITIVE_ELSE_CURRENT_ERP_V1';
const MAX_ERP_COST = new Prisma.Decimal('9999999999.99');
type Tx = Prisma.TransactionClient;
type Source = 'WMS_PROFILE_EDIT' | 'WMS_PURCHASING_LINE' | 'WMS_PROCUREMENT_ACCEPTED' | 'WMS_BULK_ALIGNMENT' | 'ERP_COST_EDIT';
export type CogsSyncMetadata = { source: Source; sourceRef: string; actorId: string | null; runId?: string };
type Product = LockedCogsProduct & { storeId: string; tenantId: string; variationId: string | null };
type Outcome = { profileId: string; productId: string | null; status: 'SYNCED_FROM_WMS' | 'FILLED_WMS_FROM_ERP' | 'ALREADY_EQUAL' | 'SKIPPED'; reason?: string; auditLogId?: string; replayed?: boolean; selectedCogs?: string; basis?: 'WMS_INHOUSE' | 'ERP_CURRENT_FALLBACK' };
export type WmsCogsSyncResult = { policy: typeof WMS_ERP_COGS_POLICY; enabled: boolean; outcomes: Outcome[]; perProduct: Outcome[] };
export type PreparedWmsCogsSync = Readonly<{ enabled: boolean; tenantId: string }>;
type Context = { tx: Tx; profileIds: string[]; products: Map<string, Product>; profiles: Map<string, WmsProductProfile> };

function settingEnabled(settings: Prisma.JsonValue | undefined): boolean {
  const s = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings.wmsToErpCogs : null;
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.enabled !== true) return false;
  if (s.source !== 'INHOUSE_UNIT_COST' || s.policy !== WMS_ERP_COGS_POLICY || s.policyVersion !== 1) {
    throw new ConflictException('WMS to ERP COGS synchronization settings require review');
  }
  return true;
}

export async function assertWmsManagedCogsEditable(tx: Tx, productId: string, store: { id: string; tenantId: string }) {
  const tenant = await tx.tenant.findUnique({ where: { id: store.tenantId }, select: { settings: true } });
  if (!settingEnabled(tenant?.settings)) return;
  const profile = await tx.wmsProductProfile.findUnique({ where: { posProductId: productId }, include: { posProduct: { select: { storeId: true, productId: true, variationId: true } } } });
  const p = profile?.posProduct;
  if (!profile || profile.tenantId !== store.tenantId || profile.storeId !== store.id || profile.status === 'ARCHIVED' || !p?.variationId
    || p.variationId === p.productId || profile.productId !== p.productId || profile.variationId !== p.variationId || p.storeId !== store.id) return;
  const value = profile.inhouseUnitCost;
  if (value && value.isFinite() && value.gt(0) && value.lte(MAX_ERP_COST) && value.decimalPlaces() <= 2) {
    throw new ConflictException('This product COGS is managed by WMS. Change its Inhouse COGS in WMS.');
  }
}

@Injectable()
export class WmsCogsSyncService {
  private readonly contexts = new WeakMap<PreparedWmsCogsSync, Context>();
  constructor(private readonly prisma: PrismaService, private readonly publisher: ProductCogsRefreshPublisherService) {}

  /** Call before any mutation in the owning WMS transaction. No nested transaction. */
  async prepare(tx: Tx, tenantId: string, inputIds: string[]): Promise<PreparedWmsCogsSync> {
    const profileIds = [...new Set(inputIds)].sort();
    // Same table-before-parent order as ERP writers and reviewed repair tools.
    await tx.$executeRawUnsafe('LOCK TABLE pos_product_cogs IN ROW EXCLUSIVE MODE');
    const [tenant] = await tx.$queryRawUnsafe<Array<{ settings: Prisma.JsonValue; status: string }>>(
      'SELECT settings,status FROM tenants WHERE id=$1::uuid FOR SHARE', tenantId);
    const prepared = Object.freeze({ enabled: settingEnabled(tenant?.settings), tenantId });
    const context: Context = { tx, profileIds, products: new Map(), profiles: new Map() };
    this.contexts.set(prepared, context);
    if (!prepared.enabled || !profileIds.length) return prepared;
    // A procurement request may have >100 profiles. Lock its complete parent set
    // once in sorted order; never interleave separately locked chunks.
    if (profileIds.length > 5000) throw new ConflictException('COGS synchronization request exceeds 5000 profiles');
    if (!tenant || !['ACTIVE', 'TRIAL'].includes(tenant.status)) throw new ConflictException('Active tenant scope is required for COGS synchronization');
    const products = await tx.$queryRawUnsafe<Product[]>(`
      SELECT p.id,p.name,p."storeId",p."productId",p."variationId",p."customId",s."tenantId",s."teamId"
      FROM pos_products p JOIN pos_stores s ON s.id=p."storeId"
      JOIN wms_product_profiles w ON w."posProductId"=p.id
      WHERE w.id=ANY($1::uuid[]) AND w."tenantId"=$2::uuid AND s."tenantId"=$2::uuid
      ORDER BY p.id FOR UPDATE OF p FOR SHARE OF s`, profileIds, tenantId);
    const profiles = await tx.$queryRawUnsafe<WmsProductProfile[]>(`
      SELECT * FROM wms_product_profiles WHERE id=ANY($1::uuid[]) AND "tenantId"=$2::uuid ORDER BY id FOR UPDATE`, profileIds, tenantId);
    context.products = new Map(products.map(p => [p.id, p]));
    context.profiles = new Map(profiles.map(p => [p.id, p]));
    return prepared;
  }

  /** Source-edit requests must reject bad links before touching their WMS row; bulk alignment reports skips instead. */
  assertSourceProfiles(prepared: PreparedWmsCogsSync) {
    const c = this.contexts.get(prepared);
    if (!c) throw new ConflictException('Original locked COGS source context is required');
    if (!prepared.enabled) return;
    for (const id of c.profileIds) {
      const w = c.profiles.get(id), p = w ? c.products.get(w.posProductId) : undefined;
      if (!w || !p || w.tenantId !== prepared.tenantId || w.storeId !== p.storeId || w.productId !== p.productId || w.variationId !== p.variationId
        || !p.variationId?.trim() || p.variationId === p.productId) throw new ConflictException('WMS cost edit requires the exact tenant, store and modern product variant');
    }
  }

  async syncAfter(tx: Tx, prepared: PreparedWmsCogsSync, metadata: CogsSyncMetadata): Promise<WmsCogsSyncResult> {
    const context = this.contexts.get(prepared);
    if (!context || context.tx !== tx) throw new ConflictException('COGS synchronization requires the original locked transaction');
    const validRun = typeof metadata.runId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(metadata.runId);
    if ((metadata.source === 'WMS_BULK_ALIGNMENT' && !validRun) || (metadata.runId !== undefined && metadata.source !== 'WMS_BULK_ALIGNMENT')) throw new ConflictException('Explicit bulk run identity is required');
    const outcomes: Outcome[] = [];
    const result: WmsCogsSyncResult = { policy: WMS_ERP_COGS_POLICY, enabled: prepared.enabled, outcomes, perProduct: outcomes };
    if (!prepared.enabled) return result;
    const today = await productCogsToday(tx);
    const rows = await tx.wmsProductProfile.findMany({ where: { id: { in: context.profileIds }, tenantId: prepared.tenantId } });
    const profiles = new Map(rows.map(p => [p.id, p]));
    const changes = new Map<string, string[]>();
    for (const profileId of context.profileIds) {
      const old = context.profiles.get(profileId), profile = profiles.get(profileId);
      const product = profile ? context.products.get(profile.posProductId) : undefined;
      const outcome: Outcome = { profileId, productId: product?.id ?? null, status: 'SKIPPED' };
      if (metadata.runId) {
        const existing = await tx.auditLog.findUnique({ where: { id: this.decisionId(metadata.runId, profileId) } });
        if (existing) {
          const decision = existing.changes as Prisma.JsonObject;
          if (existing.tenantId !== prepared.tenantId || decision.policy !== WMS_ERP_COGS_POLICY || decision.runId !== metadata.runId || decision.profileId !== profileId
            || decision.source !== metadata.source || decision.sourceRef !== metadata.sourceRef || !decision.outcome || typeof decision.outcome !== 'object' || Array.isArray(decision.outcome)) throw new ConflictException('Bulk COGS decision identity conflicts with its audit');
          result.outcomes.push({ ...(decision.outcome as unknown as Outcome), auditLogId: existing.id, replayed: true }); continue;
        }
      }
      const skip = async (reason: string) => { outcome.reason = reason; result.outcomes.push(outcome); await this.audit(tx, prepared.tenantId, metadata, outcome, {}); };
      if (!old || !profile || !product || profile.posProductId !== old.posProductId || profile.tenantId !== prepared.tenantId || profile.storeId !== product.storeId
        || profile.productId !== product.productId || profile.variationId !== product.variationId || !product.variationId?.trim() || product.variationId === product.productId) {
        await skip('EXACT_MODERN_PRODUCT_IDENTITY_REQUIRED'); continue;
      }
      if (profile.status === 'ARCHIVED') { await skip('ARCHIVED_WMS_PROFILE'); continue; }
      const history = await tx.posProductCogs.findMany({ where: { productId: product.id } });
      try { validateCurrentCogsHistory(history, product.id, { id: product.storeId, tenantId: prepared.tenantId }, today); }
      catch (error) { if (!(error instanceof ConflictException)) throw error; await skip('ERP_HISTORY_REQUIRES_REVIEW'); continue; }
      let wms: Prisma.Decimal | null;
      try { wms = profile.inhouseUnitCost === null ? null : new Prisma.Decimal(profile.inhouseUnitCost.toString()); }
      catch { await skip('INVALID_WMS_INHOUSE_COST'); continue; }
      if (wms && (!wms.isFinite() || wms.isNegative() || wms.decimalPlaces() > 2 || wms.gt(MAX_ERP_COST))) { await skip('WMS_INHOUSE_COST_NOT_REPRESENTABLE_IN_ERP'); continue; }
      const dated = history.filter(h => h.startDate && h.startDate <= today && (!h.endDate || h.endDate >= today));
      const defaults = history.filter(h => h.startDate === null && (!h.endDate || h.endDate >= today));
      const applicable = dated.length ? dated : defaults;
      const fallback = !wms || wms.isZero();
      const selected = fallback && applicable.length === 1 ? new Prisma.Decimal(applicable[0].cogs.toString()) : wms;
      if (!selected || !selected.isFinite() || !selected.gt(0) || selected.gt(MAX_ERP_COST) || selected.decimalPlaces() > 2) {
        await skip('BOTH_WMS_AND_CURRENT_ERP_COST_MISSING'); continue;
      }
      if (fallback) await tx.wmsProductProfile.update({ where: { id: profile.id, tenantId: prepared.tenantId, posProductId: product.id, updatedAt: profile.updatedAt }, data: { inhouseUnitCost: selected } });
      const written = await writeCurrentProductCogs(tx, product, { id: product.storeId, tenantId: prepared.tenantId }, selected, today);
      const sourceChanged = String(old.inhouseUnitCost) !== selected.toString();
      outcome.status = fallback ? 'FILLED_WMS_FROM_ERP' : written.changed ? 'SYNCED_FROM_WMS' : 'ALREADY_EQUAL';
      outcome.selectedCogs = selected.toFixed(2); outcome.basis = fallback ? 'ERP_CURRENT_FALLBACK' : 'WMS_INHOUSE';
      result.outcomes.push(outcome);
      if (written.changed || fallback || sourceChanged || metadata.runId) await this.audit(tx, prepared.tenantId, metadata, outcome, {
        effectiveManilaDate: today.toISOString().slice(0, 10), historicalRatesInferred: false,
        sourceBefore: old.inhouseUnitCost?.toString() ?? null, sourceAfter: selected.toFixed(2), fallbackFromCurrentErp: fallback,
        erpHistoryBefore: this.historyEvidence(written.historyBefore), erpHistoryAfter: this.historyEvidence(await tx.posProductCogs.findMany({ where: { productId: product.id } })),
      });
      if (written.changed) changes.set(product.storeId, [...(changes.get(product.storeId) ?? []), product.id]);
    }
    for (const [storeId, ids] of changes) await this.publisher.enqueue({ tenantId: prepared.tenantId, storeId,
      changes: [...new Set(ids)].map(productId => ({ productId, fromDate: today.toISOString().slice(0, 10), toDate: null })) });
    return result;
  }

  /** Internal bounded entry for a future explicit bulk job; no public route/startup. */
  async alignExistingProfiles(input: { tenantId: string; profileIds: string[]; runId: string; sourceRef: string; actorId: string | null }) {
    if (new Set(input.profileIds).size > 100) throw new ConflictException('Background COGS alignment batch exceeds 100 profiles');
    return this.prisma.$transaction(async tx => {
      const prepared = await this.prepare(tx, input.tenantId, input.profileIds);
      return this.syncAfter(tx, prepared, { source: 'WMS_BULK_ALIGNMENT', sourceRef: input.sourceRef, actorId: input.actorId, runId: input.runId });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });
  }

  /** ERP remains the fallback only while WMS is missing/zero. Uses current applicable history after the edit. */
  async syncAfterErpWrites(tx: Tx, store: { id: string; tenantId: string }, productIds: string[], actorId: string | null) {
    const tenant = await tx.tenant.findUnique({ where: { id: store.tenantId }, select: { settings: true } });
    if (!settingEnabled(tenant?.settings)) return;
    const profiles = await tx.wmsProductProfile.findMany({ where: { posProductId: { in: productIds } } });
    if (!profiles.length) return;
    const prepared = await this.prepare(tx, store.tenantId, profiles.map(p => p.id));
    return this.syncAfter(tx, prepared, { source: 'ERP_COST_EDIT', sourceRef: productIds.join(','), actorId });
  }

  private historyEvidence(rows: Array<{ id: string; cogs: Prisma.Decimal; startDate: Date | null; endDate: Date | null; updatedAt: Date }>) {
    return rows.map(r => ({ id: r.id, cogs: r.cogs.toString(), startDate: r.startDate?.toISOString().slice(0, 10) ?? null, endDate: r.endDate?.toISOString().slice(0, 10) ?? null, updatedAt: r.updatedAt.toISOString() }));
  }
  private async audit(tx: Tx, tenantId: string, metadata: CogsSyncMetadata, outcome: Outcome, evidence: object) {
    const id = metadata.runId ? this.decisionId(metadata.runId, outcome.profileId) : randomUUID(); outcome.auditLogId = id;
    await tx.auditLog.create({ data: { id, tenantId, userId: metadata.actorId, action: outcome.status === 'SKIPPED' ? 'WMS_ERP_COGS_SYNC_SKIPPED' : 'WMS_ERP_COGS_SYNC',
      resource: 'PosProduct', resourceId: outcome.productId ?? outcome.profileId,
      changes: { policy: WMS_ERP_COGS_POLICY, ...metadata, ...outcome, outcome: { ...outcome }, ...evidence } as Prisma.InputJsonValue } });
  }
  private decisionId(runId: string, profileId: string) {
    const h = createHash('sha256').update(`${WMS_ERP_COGS_POLICY}:${runId}:${profileId}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}
