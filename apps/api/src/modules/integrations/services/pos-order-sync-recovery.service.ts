import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { Prisma, PosOrderSyncRecovery } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { Queue } from 'bull';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { shouldRunApiBackgroundServices } from '../../../common/runtime/process-role';
import { IntegrationService } from '../integration.service';
import { PANCAKE_WEBHOOK_QUEUE, POS_ORDER_RECOVERY_JOB, POS_ORDER_RECOVERY_QUEUE } from '../pancake-webhook.constants';
import { PosOrderService } from './pos-order.service';
import { PosShopOwnershipService } from './pos-shop-ownership.service';
import { normalizePancakeSourceVersion } from './pos-order-freshness.util';

const BATCH_SIZE = 20;
const LEASE_MS = 5 * 60_000;
const BLOCKED_RECHECK_MS = 60 * 60_000;
const SOURCE_TIMEOUT_MS = 25_000;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TRANSIENT_MESSAGE = /55P03|40P01|40001|57014|P2034|P2028|deadlock detected|could not obtain lock|could not serialize|lock timeout|connection.*(?:closed|reset|refused)|timed?\s*out/i;

type FailedOrder = { tenantId: string; shopId: string; posOrderId: string; failedLogId: string; failedReceivedAt: Date; queueJobId: string | null };
export class PosOrderRecoveryError extends Error {
  constructor(readonly code: string, readonly blocked = false) { super(code); }
}

/** Bounded work per attempt; transient retries keep running at the cap. */
export function recoveryRetryDelay(attempt: number, random = Math.random): number {
  const base = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 12));
  return Math.min(30 * 60_000, base + Math.floor(base * 0.2 * random()));
}

export function validateRecoveryOrder(raw: any, scope: { shopId: string; posOrderId: string }): string {
  if (!raw || Array.isArray(raw) || String(raw.id) !== scope.posOrderId || String(raw.shop_id) !== scope.shopId) {
    throw new PosOrderRecoveryError('SOURCE_SCOPE_MISMATCH', true);
  }
  const version = normalizePancakeSourceVersion(raw.updated_at);
  if (!version || !normalizePancakeSourceVersion(raw.inserted_at)) {
    throw new PosOrderRecoveryError('SOURCE_TIMESTAMP_INVALID', true);
  }
  if (!Number.isInteger(raw.status) || raw.status < 0 || !Array.isArray(raw.items)) {
    throw new PosOrderRecoveryError('SOURCE_SNAPSHOT_INCOMPLETE', true);
  }
  let quantity = 0;
  for (const item of raw.items) {
    const product = item?.product_id ?? item?.productId;
    const variation = item?.variation_id ?? item?.variationId;
    const qty = typeof item?.quantity === 'string' && /^\d+$/.test(item.quantity) ? Number(item.quantity) : item?.quantity;
    if (product == null || variation == null || !String(product).trim() || !String(variation).trim()
      || !Number.isSafeInteger(qty) || qty <= 0) {
      throw new PosOrderRecoveryError('SOURCE_ITEMS_INVALID', true);
    }
    quantity += qty;
  }
  const total = Number(raw.total_quantity);
  if (raw.total_quantity == null || !Number.isSafeInteger(total) || total < 0 || total !== quantity) {
    throw new PosOrderRecoveryError('SOURCE_QUANTITY_MISMATCH', true);
  }
  return version;
}

@Injectable()
export class PosOrderSyncRecoveryService {
  private readonly logger = new Logger(PosOrderSyncRecoveryService.name);
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integration: IntegrationService,
    private readonly orders: PosOrderService,
    private readonly ownership: PosShopOwnershipService,
    @InjectQueue(PANCAKE_WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(POS_ORDER_RECOVERY_QUEUE) private readonly queue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (process.env.POS_ORDER_RECOVERY_ENABLED === 'false' || !shouldRunApiBackgroundServices() || this.ticking) return;
    this.ticking = true;
    try {
      // Dispatch previously discovered work even when historical scan/Redis inspection fails.
      await this.recoverExpiredLeases();
      await this.reserveDue();
      await this.dispatchOutbox();
      await this.discoverFailures();
    } catch {
      // Never log upstream bodies, URLs with API keys, customer payloads or DB error detail.
      this.logger.warn('POS order recovery scheduler deferred; durable work will be checked next minute');
    } finally { this.ticking = false; }
  }

  async discoverFailures(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 5 * 60_000);
    const lookback = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    // The anti-join consumes every older receipt for a coalesced scope, including
    // successful or blocked recoveries. Repeated oldest successes cannot starve
    // the next page. A later receipt reopens the row. The horizon bounds history.
    const candidates = await this.prisma.$queryRaw<FailedOrder[]>(Prisma.sql`
      SELECT l."tenantId", o."shopId", o."orderId" AS "posOrderId",
        l.id AS "failedLogId", l."receivedAt" AS "failedReceivedAt", l."queueJobId"
      FROM pancake_webhook_logs l
      JOIN pancake_webhook_log_orders o ON o."logId" = l.id
      WHERE l.source = 'PANCAKE_POS' AND l."tenantId" IS NOT NULL
        AND l."receivedAt" >= (${lookback}::timestamptz AT TIME ZONE 'UTC')
        AND l."receivedAt" <= (${cutoff}::timestamptz AT TIME ZONE 'UTC')
        AND l."processStatus" IN ('FAILED', 'PARTIAL', 'PROCESSED')
        AND o."shopId" IS NOT NULL AND o."shopId" <> '' AND o."orderId" IS NOT NULL AND o."orderId" <> ''
        AND ((o."upsertStatus" IN ('SKIPPED', 'FAILED') AND o.reason IN ('SOURCE_VERSION_REQUIRED', 'INVALID_SOURCE_VERSION'))
          OR (o."upsertStatus" = 'FAILED' AND o.reason IN (
            'ORDER_UPSERT_FAILED', 'SHOP_UPSERT_FAILED', 'OUTBOUND_PROJECTION_FAILED',
            'AMBIGUOUS_HISTORICAL_OWNER', 'ROUTING_STORE_NOT_FOUND', 'ACTIVE_OWNER_DISABLED', 'DESTINATION_TENANT_NOT_FOUND'))
          OR (l."processStatus" = 'FAILED' AND o."upsertStatus" = 'SKIPPED' AND o.reason = 'NOT_PROCESSED'
            AND COALESCE(l."errorMessage", '') ~* '55P03|40P01|40001|57014|P2034|P2028|deadlock|could not obtain lock|could not serialize|lock timeout|timed? out'))
        AND NOT EXISTS (
          SELECT 1 FROM pos_order_sync_recoveries r
          WHERE r."tenantId" = l."tenantId" AND r."shopId" = o."shopId" AND r."posOrderId" = o."orderId"
            AND (r."failedReceivedAt" > l."receivedAt"
              OR (r."failedReceivedAt" = l."receivedAt" AND r."failedLogId" >= l.id))
        )
      ORDER BY l."receivedAt" ASC, l.id ASC, o.id ASC LIMIT ${BATCH_SIZE}
    `);
    for (const candidate of candidates) {
      // Atomic upsert coalesces API replicas and never invalidates an active
      // worker lease. Completion CAS notices a newer failed receipt and reopens.
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO pos_order_sync_recoveries
          (id, "tenantId", "shopId", "posOrderId", "failedLogId", "failedReceivedAt", state, "nextAttemptAt", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${candidate.tenantId}::uuid, ${candidate.shopId}, ${candidate.posOrderId},
          ${candidate.failedLogId}::uuid, (${candidate.failedReceivedAt}::timestamptz AT TIME ZONE 'UTC'),
          'PENDING', (${now}::timestamptz AT TIME ZONE 'UTC'), (${now}::timestamptz AT TIME ZONE 'UTC'))
        ON CONFLICT ("tenantId", "shopId", "posOrderId") DO UPDATE SET
          "failedLogId" = EXCLUDED."failedLogId", "failedReceivedAt" = EXCLUDED."failedReceivedAt",
          state = CASE WHEN pos_order_sync_recoveries.state IN ('RUNNING', 'QUEUED')
            THEN pos_order_sync_recoveries.state ELSE 'PENDING' END,
          "attemptCount" = CASE WHEN pos_order_sync_recoveries.state = 'RUNNING'
            THEN pos_order_sync_recoveries."attemptCount" ELSE 0 END,
          "nextAttemptAt" = EXCLUDED."nextAttemptAt", "recoveredAt" = NULL, "updatedAt" = EXCLUDED."updatedAt"
        WHERE (pos_order_sync_recoveries."failedReceivedAt", pos_order_sync_recoveries."failedLogId")
          < (EXCLUDED."failedReceivedAt", EXCLUDED."failedLogId")
      `);
    }
  }

  async recoverExpiredLeases(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.posOrderSyncRecovery.findMany({
      where: { state: 'RUNNING', leaseUntil: { lt: now } }, orderBy: { leaseUntil: 'asc' }, take: BATCH_SIZE,
      select: { id: true, leaseToken: true },
    });
    for (const row of rows) await this.prisma.posOrderSyncRecovery.updateMany({
      where: { id: row.id, state: 'RUNNING', leaseToken: row.leaseToken, leaseUntil: { lt: now } },
      data: { state: 'PENDING', nextAttemptAt: now, leaseToken: null, leaseUntil: null,
        queueJobId: null, lastErrorCode: 'WORKER_LEASE_EXPIRED', lastErrorAt: now },
    });
  }

  async reserveDue(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.posOrderSyncRecovery.findMany({
      where: { state: { in: ['PENDING', 'BLOCKED'] }, nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: BATCH_SIZE,
      select: { id: true, updatedAt: true },
    });
    for (const row of rows) await this.prisma.posOrderSyncRecovery.updateMany({
      where: { id: row.id, state: { in: ['PENDING', 'BLOCKED'] }, updatedAt: row.updatedAt, nextAttemptAt: { lte: now } },
      data: { state: 'QUEUED', queueJobId: randomUUID(), queuedAt: now, leaseToken: null, leaseUntil: null },
    });
  }

  async dispatchOutbox(): Promise<void> {
    const rows = await this.prisma.posOrderSyncRecovery.findMany({
      where: { state: 'QUEUED' }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: BATCH_SIZE,
      select: { id: true, queueJobId: true },
    });
    for (const row of rows) {
      if (!row.queueJobId) continue;
      try {
        const job = await this.queue.getJob(row.queueJobId);
        if (job) {
          if (['completed', 'failed'].includes(await job.getState())) {
            // Transport/claim failure before RUNNING: reserve a new dispatch on
            // the next tick. The old terminal job cannot claim the new ID.
            await this.prisma.posOrderSyncRecovery.updateMany({
              where: { id: row.id, state: 'QUEUED', queueJobId: row.queueJobId },
              data: { state: 'PENDING', nextAttemptAt: new Date(Date.now() + 60_000), queueJobId: null,
                lastErrorCode: 'QUEUE_JOB_ENDED_BEFORE_CLAIM', lastErrorAt: new Date() },
            });
          }
          continue;
        }
        await this.queue.add(POS_ORDER_RECOVERY_JOB, { recoveryId: row.id }, {
          jobId: row.queueJobId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000,
        });
      } catch {
        // Unknown enqueue acknowledgement keeps the same persisted job ID.
        // Redis add(jobId) deduplicates the next dispatcher; no new ID is made.
        this.logger.warn(`POS recovery dispatch deferred recovery=${row.id}`);
      }
    }
  }

  async process(recoveryId: string, queueJobId: string): Promise<{ state: string; code?: string }> {
    if (process.env.POS_ORDER_RECOVERY_ENABLED === 'false') return { state: 'SKIPPED', code: 'RECOVERY_DISABLED' };
    const before = await this.prisma.posOrderSyncRecovery.findUnique({ where: { id: recoveryId } });
    if (!before || before.state !== 'QUEUED' || before.queueJobId !== queueJobId) return { state: 'SKIPPED' };
    const token = randomUUID();
    const claimed = await this.prisma.posOrderSyncRecovery.updateMany({
      where: { id: recoveryId, state: 'QUEUED', queueJobId, failedLogId: before.failedLogId },
      data: { state: 'RUNNING', leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), attemptCount: { increment: 1 } },
    });
    if (claimed.count !== 1) return { state: 'SKIPPED' };
    let leaseLost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.prisma.posOrderSyncRecovery.updateMany({
        where: { id: recoveryId, state: 'RUNNING', leaseToken: token },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      }).then(result => { if (result.count !== 1) leaseLost = true; })
        .catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, 30_000);
    heartbeat.unref?.();
    let auditId: string | undefined;
    let sourceStatus: number | undefined;
    try {
      const audit = await this.prisma.pancakeWebhookLog.create({ data: {
        tenantId: before.tenantId, requestTenantId: before.tenantId,
        requestId: `recovery-${recoveryId}-${before.attemptCount + 1}`,
        source: 'PANCAKE_POS_RECOVERY', receiveStatus: 'ACCEPTED', receiveHttpStatus: 202,
        processStatus: 'PROCESSING', relayStatus: 'SKIPPED', orderCount: 1,
        attempts: before.attemptCount + 1, queueJobId, processingStartedAt: new Date(),
        headersSnapshot: { recoveryId, failedLogId: before.failedLogId },
        orders: { create: { shopId: before.shopId, orderId: before.posOrderId,
          upsertStatus: 'SKIPPED', reason: 'RECOVERY_FETCH_PENDING' } },
      }, select: { id: true } });
      auditId = audit.id;
      const original = await this.prisma.pancakeWebhookLog.findUnique({
        where: { id: before.failedLogId }, select: { queueJobId: true },
      });
      if (original?.queueJobId) {
        const job = await this.webhookQueue.getJob(original.queueJobId);
        if (job && ['active', 'waiting', 'delayed', 'paused'].includes(await job.getState())) {
          throw new PosOrderRecoveryError('ORIGINAL_INGEST_PENDING');
        }
      }
      const tenant = await this.prisma.tenant.findUnique({ where: { id: before.tenantId }, select: { status: true, settings: true } });
      const settings = tenant?.settings as any;
      if (!tenant || !['ACTIVE', 'TRIAL'].includes(tenant.status) || settings?.pancakePosWebhook?.enabled !== true) {
        throw new PosOrderRecoveryError('CONNECTION_DISABLED', true);
      }
      const routing = await this.ownership.resolveOrderRoutes(before.tenantId, [{ id: before.posOrderId, shop_id: before.shopId }]);
      const route = routing.routes[0];
      if (routing.issues.length || routing.routes.length !== 1 || !route
        || route.shopId !== before.shopId || route.store.status !== 'ACTIVE' || route.store.enabled === false) {
        throw new PosOrderRecoveryError('OWNERSHIP_UNAVAILABLE', true);
      }
      const targetTenantId = route.tenantId;
      if (targetTenantId !== before.tenantId) {
        const destination = await this.prisma.tenant.findUnique({ where: { id: targetTenantId }, select: { status: true } });
        if (!destination || !['ACTIVE', 'TRIAL'].includes(destination.status)) {
          throw new PosOrderRecoveryError('DESTINATION_TENANT_DISABLED', true);
        }
        await this.prisma.pancakeWebhookLog.update({ where: { id: auditId }, data: { tenantId: targetTenantId } });
      }
      const stores = await this.prisma.posStore.findMany({
        where: { tenantId: targetTenantId, shopId: before.shopId },
        select: { id: true, integration: { select: { status: true } } },
      });
      if (stores.length !== 1 || stores[0].id !== route.store.id || stores[0].integration?.status === 'DISABLED') {
        throw new PosOrderRecoveryError('STORE_SCOPE_AMBIGUOUS_OR_DISABLED', true);
      }
      const apiKey = await this.integration.resolvePancakeRecoveryApiKey(targetTenantId, route.store);
      if (!apiKey) throw new PosOrderRecoveryError('SOURCE_CREDENTIALS_MISSING', true);
      const raw = await this.fetchOrder(before, apiKey);
      const version = validateRecoveryOrder(raw, before);
      sourceStatus = raw.status;
      const serialized = JSON.stringify(raw);
      await this.prisma.pancakeWebhookLog.update({ where: { id: auditId }, data: {
        payloadHash: createHash('sha256').update(serialized).digest('hex'),
        payloadBytes: Buffer.byteLength(serialized),
      } });
      if (leaseLost) throw new PosOrderRecoveryError('WORKER_LEASE_LOST');
      const liveLease = await this.prisma.posOrderSyncRecovery.findFirst({
        where: { id: recoveryId, state: 'RUNNING', leaseToken: token, leaseUntil: { gt: new Date() } }, select: { id: true },
      });
      if (!liveLease) throw new PosOrderRecoveryError('WORKER_LEASE_LOST');
      const currentRouting = await this.ownership.resolveOrderRoutes(before.tenantId, [raw]);
      if (currentRouting.issues.length || currentRouting.routes.length !== 1
        || currentRouting.routes[0].tenantId !== targetTenantId || currentRouting.routes[0].store.id !== route.store.id) {
        throw new PosOrderRecoveryError('OWNERSHIP_CHANGED', true);
      }
      const result = await this.orders.upsertPosOrdersWithOutcomes(
        targetTenantId, route.store.id, [raw], route.store.teamId, { requireProjectionSuccess: true },
      );
      const outcome = result.outcomes[0];
      const superseded = outcome?.upsertStatus === 'SKIPPED' && ['STALE_SOURCE_VERSION', 'SOURCE_DELETED'].includes(outcome.reason || '');
      const excluded = outcome?.upsertStatus === 'SKIPPED' && ['ABANDONED_CHECKOUT', 'SOURCE_EXCLUDED_TIKTOK', 'SOURCE_EXCLUDED_SHOPEE'].includes(outcome.reason || '');
      if (result.outcomes.length !== 1 || (!superseded && !excluded && !['UPSERTED', 'DELETED'].includes(outcome?.upsertStatus))) {
        const transient = TRANSIENT_MESSAGE.test(outcome?.warning || '');
        throw new PosOrderRecoveryError('ORDER_INGEST_REJECTED', !transient);
      }
      // Strict projection success precedes reports. On any later failure a new
      // attempt refetches current source and safely repeats idempotent hooks.
      const reconciliation = !superseded && !excluded ? await this.integration.reconcileRecoveredPancakeOrder(
        targetTenantId, raw, recoveryId, outcome.upsertStatus === 'DELETED' || raw.status === 7,
      ) : { queued: 0, skipped: 0 };
      await this.prisma.pancakeWebhookLogOrder.updateMany({ where: { logId: auditId }, data: {
        status: raw.status, upsertStatus: outcome.upsertStatus, reason: outcome.reason || null,
      } });
      await this.prisma.pancakeWebhookLog.update({ where: { id: auditId }, data: {
        processStatus: 'PROCESSED', processedAt: new Date(), upsertedCount: result.upserted,
        reconcileQueuedCount: reconciliation.queued, reconcileSkippedCount: reconciliation.skipped,
      } });
      await this.finish(before, token, {
        state: 'SUCCEEDED', storeId: route.store.id, lastSourceVersion: version, lastSourceStatus: raw.status,
        recoveredAt: new Date(), lastErrorCode: superseded ? 'SUPERSEDED_BY_NEWER_SOURCE' : excluded ? 'BUSINESS_RULE_EXCLUDED' : null,
      });
      this.logger.log(`POS recovery completed recovery=${recoveryId} status=${raw.status}`);
      return { state: 'SUCCEEDED' };
    } catch (error) {
      const known = error instanceof PosOrderRecoveryError ? error : new PosOrderRecoveryError('RECOVERY_PROCESS_FAILED');
      const state = known.blocked ? 'BLOCKED' : 'PENDING';
      const delay = known.blocked ? BLOCKED_RECHECK_MS : recoveryRetryDelay(before.attemptCount + 1);
      if (auditId) {
        await this.prisma.pancakeWebhookLogOrder.updateMany({ where: { logId: auditId }, data: {
          ...(sourceStatus !== undefined ? { status: sourceStatus } : {}),
          upsertStatus: 'FAILED', reason: known.code,
        } });
        await this.prisma.pancakeWebhookLog.update({ where: { id: auditId }, data: {
          processStatus: 'FAILED', processedAt: new Date(), errorCode: known.code,
          errorMessage: known.blocked ? 'Recovery blocked; automatic recheck in one hour' : 'Recovery deferred; automatic retry scheduled',
        } });
      }
      await this.finish(before, token, {
        state, nextAttemptAt: new Date(Date.now() + delay), lastErrorCode: known.code, lastErrorAt: new Date(),
      });
      this.logger.warn(`POS recovery deferred recovery=${recoveryId} code=${known.code} state=${state}`);
      return { state, code: known.code };
    } finally { clearInterval(heartbeat); }
  }

  private async finish(before: PosOrderSyncRecovery, token: string, data: Prisma.PosOrderSyncRecoveryUpdateManyMutationInput): Promise<void> {
    const result = await this.prisma.posOrderSyncRecovery.updateMany({
      where: { id: before.id, state: 'RUNNING', leaseToken: token, failedLogId: before.failedLogId },
      data: { ...data, leaseToken: null, leaseUntil: null, queueJobId: null },
    });
    if (result.count === 0) {
      // A newer failed receipt arrived while this attempt ran. Only our own
      // lease may be released; never mark that newer receipt recovered.
      await this.prisma.posOrderSyncRecovery.updateMany({
        where: { id: before.id, state: 'RUNNING', leaseToken: token },
        data: { state: 'PENDING', nextAttemptAt: new Date(), leaseToken: null, leaseUntil: null, queueJobId: null },
      });
    }
  }

  async fetchOrder(scope: { shopId: string; posOrderId: string }, apiKey: string): Promise<any> {
    const params = new URLSearchParams({ api_key: apiKey });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(`https://pos.pages.fm/api/v1/shops/${encodeURIComponent(scope.shopId)}/orders/${encodeURIComponent(scope.posOrderId)}?${params}`, {
        method: 'GET', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) throw new PosOrderRecoveryError(`SOURCE_HTTP_${response.status}`);
        throw new PosOrderRecoveryError(`SOURCE_HTTP_${response.status}`, true);
      }
      if (!response.body) throw new PosOrderRecoveryError('SOURCE_BODY_EMPTY', true);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_SOURCE_BYTES) { controller.abort(); throw new PosOrderRecoveryError('SOURCE_BODY_TOO_LARGE', true); }
        chunks.push(part.value);
      }
      let body: any;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new PosOrderRecoveryError('SOURCE_JSON_INVALID', true); }
      if (body?.success !== true || !body.data || Array.isArray(body.data)) throw new PosOrderRecoveryError('SOURCE_RESPONSE_INVALID', true);
      return body.data;
    } catch (error) {
      if (error instanceof PosOrderRecoveryError) throw error;
      throw new PosOrderRecoveryError('SOURCE_REQUEST_FAILED');
    } finally { clearTimeout(timer); }
  }
}
