import {
  Injectable,
  Inject,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ClsService } from 'nestjs-cls';
import {
  IntegrationStatus,
  PosProductCogs,
  Prisma,
  WmsProductProfileStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TeamContextService } from '../../common/services/team-context.service';
import { EncryptionService } from './services/encryption.service';
import { ProviderFactory } from './providers/provider.factory';
import {
  PosOrderService,
  PosOrderUpsertOutcome,
} from './services/pos-order.service';
import {
  CreateIntegrationDto,
  UpdateIntegrationDto,
  UpdatePancakeWebhookDto,
  UpdatePancakeWebhookRelayDto,
  IntegrationResponseDto,
  IntegrationProvider,
  BulkCreatePosIntegrationDto,
  ListIntegrationsDto,
  ListPosStoresDto,
  UpdatePosStoreDto,
  ClaimPosShopOwnershipDto,
  TransferOpenPosOrdersDto,
} from './dto';
import { validate as uuidValidate } from 'uuid';
import { MetaAdsProvider } from './providers/meta-ads.provider';
import { MetaInsightService } from './services/meta-insight.service';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as dayjs from 'dayjs';
import * as utc from 'dayjs/plugin/utc';
import * as timezone from 'dayjs/plugin/timezone';
import {
  PANCAKE_WEBHOOK_AUTO_CANCEL_JOB,
  PANCAKE_WEBHOOK_JOB,
  PANCAKE_WEBHOOK_REPORTS_HYDRATE_JOB,
  PANCAKE_WEBHOOK_RECONCILE_JOB,
  PANCAKE_WEBHOOK_RECONCILE_QUEUE,
  PANCAKE_WEBHOOK_QUEUE,
  PancakeWebhookAutoCancelJobData,
  PancakeWebhookJobData,
  PancakeWebhookReportsHydrateJobData,
  PancakeWebhookReconcileJobData,
} from './pancake-webhook.constants';
import {
  buildPancakeReconcileWindow,
  resolveAutomaticPancakeReconcileMode,
} from './pancake-webhook-reconcile.util';
import { PosShopOwnershipService } from './services/pos-shop-ownership.service';
import { assertValidProductCogs } from './product-cogs-validation';
import { ProductCogsRefreshPublisherService } from './services/product-cogs-refresh-publisher.service';
import { lockCogsProduct, productCogsToday, findApplicableProductCogs, writeCurrentProductCogs } from '../product-cogs/current-product-cogs';
import { assertWmsManagedCogsEditable, WmsCogsSyncService } from '../product-cogs/wms-cogs-sync.service';
import {
  missingPancakeShopCurrency,
  normalizePancakeRetailPrice,
  normalizedPancakeRetailPriceForStorage,
  readPancakeShopCurrencyResponse,
  resolvePancakeShopCurrency,
} from './pancake-retail-price';

dayjs.extend(utc);
dayjs.extend(timezone);

// Deployment checks pin this writer policy together with the built source hash.
export const PRODUCT_COGS_WRITER_POLICY = 'ERP_COGS_DATED_PARENT_LOCK_V2';

type LockedCogsProduct = {
  id: string;
  name: string;
  productId: string;
  customId: string | null;
  teamId: string | null;
};

type PancakeWebhookSettings = {
  enabled?: boolean;
  autoCancelEnabled?: boolean;
  reconcileEnabled?: boolean;
  reconcileIntervalSeconds?: number;
  reconcileMode?: 'incremental' | 'full_reset';
  apiKeyHash?: string;
  keyLast4?: string;
  rotatedAt?: string;
  rotatedByUserId?: string;
  relayEnabled?: boolean;
  relayWebhookUrl?: string;
  relayHeaderKey?: string;
  relayApiKey?: string;
  relayApiKeyEncrypted?: string;
  relayKeyLast4?: string;
  relayUpdatedAt?: string;
  relayUpdatedByUserId?: string;
};

type PancakeWebhookReconcileTarget = {
  dateLocal: string;
  destructive: boolean;
};

type PancakeWebhookProcessStatus =
  | 'SKIPPED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'PARTIAL'
  | 'FAILED';

type PancakeWebhookRelayStatus = 'SKIPPED' | 'SUCCESS' | 'FAILED';

type PancakeWebhookOrderRef = {
  shopId: string | null;
  orderId: string | null;
  status: number | null;
};

type PancakeWebhookPayloadProcessingResult = {
  upserted: number;
  warnings: string[];
  relayStatus: PancakeWebhookRelayStatus;
  outcomes: PosOrderUpsertOutcome[];
  reconcileQueuedCount: number;
  reconcileSkippedCount: number;
};

type ReportsByPhoneMetrics = {
  orderFail: number | null;
  orderSuccess: number | null;
  warning: number | null;
};

type PancakeStoreTag = {
  tagId: string;
  name: string;
  groupId: string | null;
  groupName: string | null;
};

type PancakeStoreWarehouse = {
  warehouseId: string;
  name: string;
  customId: string | null;
  address: string | null;
  fullAddress: string | null;
  phoneNumber: string | null;
  countryCode: number | null;
  provinceId: string | null;
  districtId: string | null;
  communeId: string | null;
  postcode: string | null;
  allowCreateOrder: boolean | null;
  batchConfig: Prisma.InputJsonValue | null;
  customBatchConfig: Prisma.InputJsonValue | null;
  customShelfConfig: Prisma.InputJsonValue | null;
  shelfConfig: Prisma.InputJsonValue | null;
  hideConfigBatchShelf: boolean | null;
};

type PancakeGeoProvince = {
  id: string;
  countryCode: number;
  name: string;
  nameEn: string | null;
  newId: string | null;
  regionType: string | null;
};

type PancakeGeoDistrict = {
  id: string;
  provinceId: string;
  name: string;
  nameEn: string | null;
  postcode?: Prisma.InputJsonValue;
};

type PancakeGeoCommune = {
  id: string;
  provinceId: string;
  districtId: string;
  name: string;
  nameEn: string | null;
  newId: string | null;
  postcode?: Prisma.InputJsonValue;
};

type ListPancakeWebhookLogsParams = {
  page?: number;
  limit?: number;
  receiveStatus?: string;
  processStatus?: string;
  relayStatus?: string;
  shopId?: string;
  orderId?: string;
  requestId?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
};

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);
  private readonly PANCAKE_WEBHOOK_SETTINGS_KEY = 'pancakePosWebhook';
  private readonly POS_GEO_CACHE_VERSION_KEY = 'pos_geo:version';

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly teamContext: TeamContextService,
    private readonly encryptionService: EncryptionService,
    private readonly providerFactory: ProviderFactory,
    private readonly metaInsightService: MetaInsightService,
    private readonly posOrderService: PosOrderService,
    private readonly posShopOwnershipService: PosShopOwnershipService,
    @InjectQueue(PANCAKE_WEBHOOK_QUEUE)
    private readonly pancakeWebhookQueue: Queue<
      | PancakeWebhookJobData
      | PancakeWebhookAutoCancelJobData
      | PancakeWebhookReportsHydrateJobData
    >,
    @InjectQueue(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
    private readonly pancakeWebhookReconcileQueue: Queue<PancakeWebhookReconcileJobData>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    private readonly productCogsRefresh: ProductCogsRefreshPublisherService,
    private readonly wmsCogsSync: WmsCogsSyncService,
  ) {}

  private getPosGeoCacheTtlMs(): number {
    const ttlSecondsRaw = Number(process.env.POS_GEO_CACHE_TTL_SECONDS || '21600');
    const ttlSeconds = Number.isFinite(ttlSecondsRaw) && ttlSecondsRaw > 0
      ? Math.floor(ttlSecondsRaw)
      : 21600;
    return ttlSeconds * 1000;
  }

  private async getGeoCacheVersion(): Promise<string> {
    try {
      const cached = await this.cacheManager.get<string>(this.POS_GEO_CACHE_VERSION_KEY);
      if (typeof cached === 'string' && cached.trim().length > 0) {
        return cached.trim();
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to read POS geo cache version: ${error?.message || 'Unknown cache error'}`,
      );
    }
    return 'v1';
  }

  private async bumpGeoCacheVersion(): Promise<void> {
    try {
      await this.cacheManager.set(
        this.POS_GEO_CACHE_VERSION_KEY,
        `v${Date.now()}`,
        this.getPosGeoCacheTtlMs(),
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to bump POS geo cache version: ${error?.message || 'Unknown cache error'}`,
      );
    }
  }

  private async getGeoCacheValue<T>(key: string): Promise<T | null> {
    try {
      const cached = await this.cacheManager.get<T>(key);
      return cached ?? null;
    } catch (error: any) {
      this.logger.warn(
        `Failed to read POS geo cache key=${key}: ${error?.message || 'Unknown cache error'}`,
      );
      return null;
    }
  }

  private async setGeoCacheValue<T>(key: string, value: T): Promise<void> {
    try {
      await this.cacheManager.set(key, value, this.getPosGeoCacheTtlMs());
    } catch (error: any) {
      this.logger.warn(
        `Failed to write POS geo cache key=${key}: ${error?.message || 'Unknown cache error'}`,
      );
    }
  }

  private normalizeJsonObject(value: any): Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return { ...value };
  }

  private getPancakeWebhookSettings(settingsRaw: any): PancakeWebhookSettings {
    const settings = this.normalizeJsonObject(settingsRaw);
    const webhook = this.normalizeJsonObject(settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY]);
    const reconcileIntervalRaw = Number(webhook.reconcileIntervalSeconds);
    const configuredReconcileIntervalSeconds =
      Number.isFinite(reconcileIntervalRaw)
      && reconcileIntervalRaw >= 10
      && reconcileIntervalRaw <= 3600
        ? Math.floor(reconcileIntervalRaw)
        : undefined;
    const reconcileIntervalSeconds = Math.max(
      configuredReconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds(),
      Math.ceil(this.getMinimumWebhookReconcileDelayMs() / 1000),
    );
    const reconcileModeRaw = typeof webhook.reconcileMode === 'string' ? webhook.reconcileMode : '';
    const configuredReconcileMode: 'incremental' | 'full_reset' | undefined =
      reconcileModeRaw === 'incremental' || reconcileModeRaw === 'full_reset'
        ? reconcileModeRaw
        : undefined;
    const reconcileMode = this.getAutomaticWebhookReconcileMode(configuredReconcileMode);
    return {
      enabled: typeof webhook.enabled === 'boolean' ? webhook.enabled : false,
      autoCancelEnabled:
        typeof webhook.autoCancelEnabled === 'boolean' ? webhook.autoCancelEnabled : true,
      reconcileEnabled:
        typeof webhook.reconcileEnabled === 'boolean' ? webhook.reconcileEnabled : true,
      reconcileIntervalSeconds,
      reconcileMode,
      apiKeyHash: typeof webhook.apiKeyHash === 'string' ? webhook.apiKeyHash : undefined,
      keyLast4: typeof webhook.keyLast4 === 'string' ? webhook.keyLast4 : undefined,
      rotatedAt: typeof webhook.rotatedAt === 'string' ? webhook.rotatedAt : undefined,
      rotatedByUserId:
        typeof webhook.rotatedByUserId === 'string' ? webhook.rotatedByUserId : undefined,
      relayEnabled: typeof webhook.relayEnabled === 'boolean' ? webhook.relayEnabled : false,
      relayWebhookUrl:
        typeof webhook.relayWebhookUrl === 'string' ? webhook.relayWebhookUrl : undefined,
      relayHeaderKey:
        typeof webhook.relayHeaderKey === 'string' ? webhook.relayHeaderKey : undefined,
      relayApiKey:
        typeof webhook.relayApiKey === 'string' ? webhook.relayApiKey : undefined,
      relayApiKeyEncrypted:
        typeof webhook.relayApiKeyEncrypted === 'string'
          ? webhook.relayApiKeyEncrypted
          : undefined,
      relayKeyLast4:
        typeof webhook.relayKeyLast4 === 'string' ? webhook.relayKeyLast4 : undefined,
      relayUpdatedAt:
        typeof webhook.relayUpdatedAt === 'string' ? webhook.relayUpdatedAt : undefined,
      relayUpdatedByUserId:
        typeof webhook.relayUpdatedByUserId === 'string'
          ? webhook.relayUpdatedByUserId
          : undefined,
    };
  }

  private buildPancakeWebhookUrl(baseUrl: string, tenantId: string): string {
    const cleanBase = (baseUrl || '').replace(/\/+$/, '');
    return `${cleanBase}/api/v1/webhooks/pancake/${tenantId}`;
  }

  private async getPancakeWebhookContext(tenantIdOverride?: string) {
    const context = await this.teamContext.getContext();

    return {
      tenantId: tenantIdOverride ?? context.tenantId,
      userId: context.userId,
    };
  }

  private hashWebhookApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  private normalizeRelayWebhookUrl(urlRaw: string | undefined): string | undefined {
    if (!urlRaw) return undefined;
    const trimmed = urlRaw.trim();
    if (!trimmed) return undefined;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('Invalid relay webhook URL');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BadRequestException('Relay webhook URL must use http or https');
    }

    return trimmed;
  }

  private sanitizeRelayHeaderKey(headerKeyRaw: string | undefined): string | undefined {
    if (!headerKeyRaw) return undefined;
    const trimmed = headerKeyRaw.trim();
    if (!trimmed) return undefined;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed)) {
      return undefined;
    }
    return trimmed;
  }

  private getRelayHeaderKey(cfg: PancakeWebhookSettings): string {
    return this.sanitizeRelayHeaderKey(cfg.relayHeaderKey) || 'x-api-key';
  }

  private verifyWebhookApiKey(apiKey: string, expectedHash: string): boolean {
    if (!apiKey || !expectedHash) return false;
    const candidate = Buffer.from(this.hashWebhookApiKey(apiKey), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  }

  private normalizeWebhookHeaders(headers: Record<string, any> = {}): Record<string, string> {
    const pickedKeys = ['content-type', 'user-agent', 'x-request-id', 'x-forwarded-for'];
    const out: Record<string, string> = {};
    for (const key of pickedKeys) {
      const val = headers[key];
      if (typeof val === 'string') {
        out[key] = val;
      } else if (Array.isArray(val)) {
        out[key] = val.join(', ');
      } else if (val !== undefined && val !== null) {
        out[key] = String(val);
      }
    }
    return out;
  }

  private buildWebhookRequestId(headers: Record<string, any> = {}): string {
    const candidate =
      headers['x-request-id'] ||
      headers['x-correlation-id'] ||
      headers['cf-ray'] ||
      headers['x-amzn-trace-id'] ||
      null;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, 120);
    }
    return `pwh_${Date.now()}_${randomBytes(6).toString('hex')}`;
  }

  private toPayloadFingerprint(payload: any): { hash: string | null; bytes: number } {
    try {
      const serialized = JSON.stringify(payload ?? {});
      return {
        hash: createHash('sha256').update(serialized).digest('hex'),
        bytes: Buffer.byteLength(serialized, 'utf8'),
      };
    } catch {
      const fallback = String(payload ?? '');
      return {
        hash: createHash('sha256').update(fallback).digest('hex'),
        bytes: Buffer.byteLength(fallback, 'utf8'),
      };
    }
  }

  private extractWebhookOrderRefs(payload: any): PancakeWebhookOrderRef[] {
    const orders = this.extractWebhookOrders(payload);
    return orders.map((order) => {
      const statusRaw = Number(order?.status);
      return {
        shopId: order?.shop_id?.toString?.()?.trim?.() || order?.shopId?.toString?.()?.trim?.() || null,
        orderId: order?.id?.toString?.()?.trim?.() || order?.order_id?.toString?.()?.trim?.() || null,
        status: Number.isFinite(statusRaw) ? statusRaw : null,
      };
    });
  }

  private mapFinalProcessStatus(
    upserted: number,
    outcomes: PosOrderUpsertOutcome[],
    warnings: string[],
  ): PancakeWebhookProcessStatus {
    const hasFailed = outcomes.some((row) => row.upsertStatus === 'FAILED');
    const hasSuccess = upserted > 0;
    if (hasFailed && hasSuccess) return 'PARTIAL';
    if (hasFailed && !hasSuccess) return 'FAILED';
    if (warnings.length > 0 && hasSuccess) return 'PARTIAL';
    if (hasSuccess) return 'PROCESSED';
    return warnings.length > 0 ? 'PARTIAL' : 'PROCESSED';
  }

  private parseLogsDateBound(dateStr: string, endExclusive: boolean): Date {
    const normalized = dateStr?.trim?.() || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new BadRequestException('Invalid date format. Expected YYYY-MM-DD');
    }

    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date value');
    }
    if (!endExclusive) return date;
    date.setUTCDate(date.getUTCDate() + 1);
    return date;
  }

  private truncateMessage(message: string | undefined, max = 900): string | null {
    if (!message) return null;
    const compact = message.toString().trim();
    if (!compact) return null;
    return compact.length > max ? compact.slice(0, max) : compact;
  }

  private async persistWebhookOrderOutcomes(logId: string, outcomes: PosOrderUpsertOutcome[]) {
    await this.prisma.pancakeWebhookLogOrder.deleteMany({
      where: { logId },
    });

    if (!outcomes || outcomes.length === 0) {
      return;
    }

    await this.prisma.pancakeWebhookLogOrder.createMany({
      data: outcomes.map((row) => ({
        logId,
        shopId: row.shopId || null,
        orderId: row.orderId || null,
        status: typeof row.status === 'number' ? row.status : null,
        upsertStatus: row.upsertStatus,
        reason: row.reason || null,
        warning: this.truncateMessage(row.warning || ''),
      })),
      skipDuplicates: false,
    });
  }

  private getRelayApiKey(
    cfg: PancakeWebhookSettings,
    tenantEncryptionKey?: string,
  ): string | undefined {
    const plain = cfg.relayApiKey?.toString?.()?.trim?.() || '';
    if (plain) return plain;

    if (!cfg.relayApiKeyEncrypted || !tenantEncryptionKey) {
      return undefined;
    }

    try {
      const decrypted = this.encryptionService.decrypt(
        cfg.relayApiKeyEncrypted,
        tenantEncryptionKey,
      );
      const fallback = decrypted?.apiKey?.toString?.()?.trim?.() || '';
      return fallback || undefined;
    } catch {
      return undefined;
    }
  }

  private async forwardPancakeWebhookPayload(
    tenant: { id: string; encryptionKey: string },
    cfg: PancakeWebhookSettings,
    payload: any,
    requestId: string,
  ): Promise<{ relayStatus: PancakeWebhookRelayStatus; warning: string | null }> {
    if (!cfg.relayEnabled) return { relayStatus: 'SKIPPED', warning: null };
    if (!cfg.relayWebhookUrl) {
      return {
        relayStatus: 'FAILED',
        warning: 'Relay enabled but relay webhook URL is not configured',
      };
    }
    const relayHeaderKey = this.getRelayHeaderKey(cfg);
    const relayApiKey = this.getRelayApiKey(cfg, tenant.encryptionKey) || '';

    if (!relayApiKey) {
      return {
        relayStatus: 'FAILED',
        warning: 'Relay API key is empty',
      };
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 8000);

    try {
      const relayHeaders: Record<string, string> = {
        'content-type': 'application/json',
        'x-erp-event-id': requestId,
        'x-erp-source': 'pancake-webhook-relay',
      };
      relayHeaders[relayHeaderKey] = relayApiKey;

      const response = await fetch(cfg.relayWebhookUrl, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const compactResponse = responseText ? responseText.toString().slice(0, 180) : '';
        return {
          relayStatus: 'FAILED',
          warning: `Relay delivery failed (${response.status}${compactResponse ? `: ${compactResponse}` : ''})`,
        };
      }

      return { relayStatus: 'SUCCESS', warning: null };
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return { relayStatus: 'FAILED', warning: 'Relay delivery timed out' };
      }
      return {
        relayStatus: 'FAILED',
        warning: `Relay delivery failed: ${error?.message || 'Unknown error'}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private isWebhookOrderLike(value: any): value is Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasOrderId = value.id !== undefined || value.order_id !== undefined;
    const hasShopId = value.shop_id !== undefined || value.shopId !== undefined;
    return hasOrderId && hasShopId;
  }

  /**
   * Accept direct Pancake order payload and common wrappers from tools/middleware.
   * Supports single-order and batch payloads.
   */
  private extractWebhookOrders(payload: any): any[] {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    const queue: any[] = [payload];
    const collected: any[] = [];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;

      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }

      if (this.isWebhookOrderLike(current)) {
        const shopId = current.shop_id?.toString?.()?.trim?.() || current.shopId?.toString?.()?.trim?.() || '';
        const orderId = current.id?.toString?.()?.trim?.() || current.order_id?.toString?.()?.trim?.() || '';
        if (shopId && orderId) {
          const key = `${shopId}::${orderId}`;
          if (!seen.has(key)) {
            seen.add(key);
            collected.push(current);
          }
        }
      }

      queue.push(
        current.body,
        current.payload,
        current.order,
        current.data,
        current.orders,
      );
    }

    return collected;
  }

  private extractWebhookCustomerPhone(order: any): string | null {
    const candidates = [
      order?.customerPhone,
      order?.customer_phone,
      order?.bill_phone_number,
      order?.shipping_address?.phone_number,
      order?.shipping_address?.phone,
      order?.customer?.phone_number,
      Array.isArray(order?.customer?.phone_numbers) ? order.customer.phone_numbers[0] : null,
    ];

    for (const raw of candidates) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value) return value;
    }

    return null;
  }

  private normalizePhoneForComparison(phone: string): string {
    const trimmed = (phone || '').toString().trim();
    if (!trimmed) return '';

    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return '';

    if (digits.startsWith('63')) return digits;
    if (digits.startsWith('0') && digits.length >= 10) return `63${digits.slice(1)}`;
    if (digits.startsWith('9') && digits.length === 10) return `63${digits}`;
    return digits;
  }

  private buildPhoneSearchCandidates(phone: string): string[] {
    const raw = (phone || '').toString().trim();
    if (!raw) return [];

    const normalized = this.normalizePhoneForComparison(raw);
    const set = new Set<string>();
    set.add(raw);

    if (normalized) {
      set.add(normalized);
      set.add(`+${normalized}`);
      if (normalized.startsWith('63')) {
        set.add(`0${normalized.slice(2)}`);
      }
    }

    return Array.from(set).filter((value) => value.trim().length > 0);
  }

  private parsePancakeOrdersResponseRows(payload: any): any[] {
    if (!payload) return [];

    if (Array.isArray(payload)) {
      const rows: any[] = [];
      payload.forEach((entry: any) => {
        if (Array.isArray(entry?.data)) {
          rows.push(...entry.data);
        } else if (entry && typeof entry === 'object' && this.isWebhookOrderLike(entry)) {
          rows.push(entry);
        }
      });
      return rows;
    }

    if (Array.isArray(payload?.data)) {
      return payload.data;
    }

    if (payload && typeof payload === 'object' && this.isWebhookOrderLike(payload)) {
      return [payload];
    }

    return [];
  }

  private toNullableInt(value: any): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : null;
  }

  private extractReportsByPhoneMetrics(
    reportsByPhoneRaw: any,
    customerPhone: string,
  ): ReportsByPhoneMetrics | null {
    if (
      !reportsByPhoneRaw ||
      typeof reportsByPhoneRaw !== 'object' ||
      Array.isArray(reportsByPhoneRaw)
    ) {
      return null;
    }

    const entries = Object.entries(reportsByPhoneRaw);
    if (entries.length === 0) return null;

    const requestedCandidates = this.buildPhoneSearchCandidates(customerPhone);
    const requestedNormalized = new Set(
      requestedCandidates
        .map((candidate) => this.normalizePhoneForComparison(candidate))
        .filter((candidate) => candidate.length > 0),
    );

    let picked: any = null;
    for (const [key, value] of entries) {
      const normalized = this.normalizePhoneForComparison(key);
      if (normalized && requestedNormalized.has(normalized)) {
        picked = value;
        break;
      }
    }

    if (!picked) {
      picked = entries[0][1];
    }
    if (!picked || typeof picked !== 'object') return null;

    const metrics: ReportsByPhoneMetrics = {
      orderFail: this.toNullableInt((picked as any).order_fail),
      orderSuccess: this.toNullableInt((picked as any).order_success),
      warning: this.toNullableInt((picked as any).warning),
    };

    if (
      metrics.orderFail === null &&
      metrics.orderSuccess === null &&
      metrics.warning === null
    ) {
      return null;
    }

    return metrics;
  }

  private async fetchReportsByPhoneMetricsForOrder(
    shopId: string,
    apiKey: string,
    customerPhone: string,
    posOrderId: string,
  ): Promise<{ metrics: ReportsByPhoneMetrics | null; warning?: string }> {
    const searchCandidates = this.buildPhoneSearchCandidates(customerPhone);
    if (searchCandidates.length === 0) {
      return { metrics: null, warning: 'Missing valid customer phone for reports_by_phone lookup' };
    }

    let lastWarning: string | undefined;
    for (const search of searchCandidates) {
      const params = new URLSearchParams();
      params.set('api_key', apiKey);
      params.append('extra_fields[]', 'return_rate');
      params.set('search', search);
      params.append('fields[]', 'id');
      params.append('fields[]', 'shop_id');
      params.append('fields[]', 'reports_by_phone');

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(
          `https://pos.pancake.vn/api/v1/shops/${encodeURIComponent(shopId)}/orders?${params.toString()}`,
          {
            method: 'GET',
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          lastWarning = `reports_by_phone lookup failed (${response.status}) for shop_id=${shopId}`;
          continue;
        }

        const payload = await response.json().catch(() => null);
        const rows = this.parsePancakeOrdersResponseRows(payload);
        if (rows.length === 0) continue;

        const orderIdAsString = posOrderId.toString();
        const matchedOrder =
          rows.find((row: any) => row?.id?.toString?.() === orderIdAsString) ||
          rows[0];

        const metrics = this.extractReportsByPhoneMetrics(
          matchedOrder?.reports_by_phone,
          customerPhone,
        );
        if (metrics) {
          return { metrics };
        }
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          lastWarning = `reports_by_phone lookup timed out for shop_id=${shopId}`;
        } else {
          lastWarning = `reports_by_phone lookup error for shop_id=${shopId}: ${error?.message || 'Unknown error'}`;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    return { metrics: null, warning: lastWarning };
  }

  private async resolveStoreApiKeyForWebhook(
    tenantId: string,
    store: { id: string; integrationId: string | null; apiKey: string | null },
  ): Promise<string | null> {
    const rawStoreKey = store.apiKey?.toString?.().trim?.() || '';
    if (rawStoreKey) return rawStoreKey;

    if (!store.integrationId) return null;

    try {
      const credentials = await this.getDecryptedCredentials(store.integrationId, tenantId);
      const apiKey = credentials?.apiKey?.toString?.().trim?.() || '';
      if (!apiKey) return null;

      await this.prisma.posStore.update({
        where: { id: store.id },
        data: { apiKey },
      });

      return apiKey;
    } catch {
      return null;
    }
  }

  private shouldTriggerAutoCancelFromReports(metrics: ReportsByPhoneMetrics): boolean {
    const fail = Math.max(0, Number(metrics.orderFail ?? 0));
    const success = Math.max(0, Number(metrics.orderSuccess ?? 0));

    if (fail <= 0) return false;

    // Without successful orders, require a larger failure history before canceling.
    if (success === 0) {
      return fail >= 5;
    }

    const total = success + fail;
    if (total <= 0) return false;

    // Auto-cancel when the failure rate is within the 95-100% range.
    const returnRate = (fail / total) * 100;
    return returnRate >= 95;
  }

  /** Internal recovery uses the same scoped credential resolution as live ingest. */
  async resolvePancakeRecoveryApiKey(
    tenantId: string,
    store: { id: string; integrationId: string | null; apiKey: string | null },
  ): Promise<string | null> {
    return this.resolveStoreApiKeyForWebhook(tenantId, store);
  }

  /** Reuse report scheduling without replaying relay or auto-cancel side effects. */
  async reconcileRecoveredPancakeOrder(
    tenantId: string, rawOrder: any, recoveryId: string, destructive: boolean,
  ): Promise<{ queued: number; skipped: number }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId }, select: { settings: true },
    });
    if (!tenant) throw new Error('RECOVERY_TENANT_MISSING');
    const cfg = this.getPancakeWebhookSettings(tenant.settings);
    if (!cfg.reconcileEnabled) return { queued: 0, skipped: 0 };
    const dateLocal = this.extractWebhookOrderDateLocal(rawOrder);
    if (!dateLocal) throw new Error('RECOVERY_ORDER_DATE_INVALID');
    const result = await this.enqueueWebhookReconcileJobs(
      tenantId, new Map([[dateLocal, { dateLocal, destructive }]]),
      `recovery-${recoveryId}`, this.getWebhookReconcileDelayMs(cfg),
      cfg.reconcileMode ?? 'incremental',
    );
    if (result.warnings.length) throw new Error('RECOVERY_RECONCILE_ENQUEUE_FAILED');
    return { queued: result.queued, skipped: result.skipped };
  }

  private getPancakeAutoCancelQueueJobOptions() {
    const attempts = Math.max(1, Number(process.env.PANCAKE_AUTO_CANCEL_QUEUE_ATTEMPTS || 4));
    const backoffDelay = Math.max(
      1000,
      Number(process.env.PANCAKE_AUTO_CANCEL_QUEUE_BACKOFF_MS || 3000),
    );
    const timeout = Math.max(
      10000,
      Number(process.env.PANCAKE_AUTO_CANCEL_QUEUE_TIMEOUT_MS || 45000),
    );
    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private getPancakeReportsHydrateQueueJobOptions() {
    const delay = Math.max(
      0,
      Number(process.env.PANCAKE_REPORTS_HYDRATE_QUEUE_DELAY_MS || 20000),
    );
    const attempts = Math.max(
      1,
      Number(process.env.PANCAKE_REPORTS_HYDRATE_QUEUE_ATTEMPTS || 8),
    );
    const backoffDelay = Math.max(
      1000,
      Number(process.env.PANCAKE_REPORTS_HYDRATE_QUEUE_BACKOFF_MS || 15000),
    );
    const timeout = Math.max(
      5000,
      Number(process.env.PANCAKE_REPORTS_HYDRATE_QUEUE_TIMEOUT_MS || 30000),
    );
    return {
      delay,
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private async enqueueAutoCancelStatusJob(
    data: PancakeWebhookAutoCancelJobData,
  ): Promise<void> {
    await this.pancakeWebhookQueue.add(PANCAKE_WEBHOOK_AUTO_CANCEL_JOB, data, {
      jobId: `pancake-auto-cancel:${data.tenantId}:${data.shopId}:${data.orderId}`,
      ...this.getPancakeAutoCancelQueueJobOptions(),
    });
  }

  private async enqueueReportsHydrateJob(
    data: PancakeWebhookReportsHydrateJobData,
  ): Promise<void> {
    await this.pancakeWebhookQueue.add(PANCAKE_WEBHOOK_REPORTS_HYDRATE_JOB, data, {
      jobId: `pancake-reports-hydrate:${data.tenantId}:${data.shopId}:${data.orderId}`,
      ...this.getPancakeReportsHydrateQueueJobOptions(),
    });
  }

  async processPancakeAutoCancelJob(
    jobData: PancakeWebhookAutoCancelJobData,
  ): Promise<{ success: boolean; reason: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: jobData.tenantId },
      select: { settings: true },
    });
    const cfg = this.getPancakeWebhookSettings(tenant?.settings);
    if (cfg.autoCancelEnabled === false) {
      return { success: false, reason: 'AUTO_CANCEL_DISABLED' };
    }

    const existingOrder = await this.prisma.posOrder.findFirst({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
        posOrderId: jobData.orderId,
      },
      select: {
        status: true,
        reportsByPhoneOrderFail: true,
        reportsByPhoneOrderSuccess: true,
        reportsByPhoneWarning: true,
      },
    });

    if (!existingOrder) {
      return { success: false, reason: 'ORDER_NOT_FOUND' };
    }

    if (existingOrder.status !== 0) {
      return { success: false, reason: 'STATUS_NOT_NEW' };
    }

    const metrics: ReportsByPhoneMetrics = {
      orderFail: existingOrder.reportsByPhoneOrderFail,
      orderSuccess: existingOrder.reportsByPhoneOrderSuccess,
      warning: existingOrder.reportsByPhoneWarning,
    };
    if (!this.shouldTriggerAutoCancelFromReports(metrics)) {
      return { success: false, reason: 'CRITERIA_NOT_MET' };
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
      },
      select: {
        id: true,
        integrationId: true,
        apiKey: true,
        status: true,
        integration: {
          select: {
            status: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!store) {
      return { success: false, reason: 'STORE_NOT_FOUND' };
    }

    if (
      store.status === IntegrationStatus.DISABLED
      || store.integration?.status === IntegrationStatus.DISABLED
    ) {
      return { success: false, reason: 'INTEGRATION_DISABLED' };
    }

    const apiKey = await this.resolveStoreApiKeyForWebhook(jobData.tenantId, {
      id: store.id,
      integrationId: store.integrationId || null,
      apiKey: store.apiKey || null,
    });
    if (!apiKey) {
      throw new Error(`Missing API key for auto-cancel shop_id=${jobData.shopId}`);
    }

    const params = new URLSearchParams();
    params.set('api_key', apiKey);

    const response = await fetch(
      `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(jobData.shopId)}/orders/${encodeURIComponent(jobData.orderId)}?${params.toString()}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ status: 6 }),
      },
    );

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new Error(
        `Auto-cancel failed (${response.status}) shop_id=${jobData.shopId} order_id=${jobData.orderId}${responseText ? `: ${responseText.slice(0, 180)}` : ''}`,
      );
    }

    // No local status overwrite here; Pancake webhook callback is the source of truth.
    return { success: true, reason: 'STATUS_UPDATE_SENT' };
  }

  async processPancakeReportsHydrateJob(
    jobData: PancakeWebhookReportsHydrateJobData,
  ): Promise<{ success: boolean; reason: string; hydrated: boolean }> {
    const existingOrder = await this.prisma.posOrder.findFirst({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
        posOrderId: jobData.orderId,
      },
      select: {
        status: true,
        customerPhone: true,
        reportsByPhoneOrderFail: true,
        reportsByPhoneOrderSuccess: true,
      },
    });

    if (!existingOrder) {
      return { success: false, reason: 'ORDER_NOT_FOUND', hydrated: false };
    }

    if (existingOrder.status !== 0) {
      return { success: false, reason: 'STATUS_NOT_NEW', hydrated: false };
    }

    const alreadyHydrated =
      existingOrder.reportsByPhoneOrderFail !== null &&
      existingOrder.reportsByPhoneOrderSuccess !== null;
    if (alreadyHydrated) {
      return { success: true, reason: 'ALREADY_HYDRATED', hydrated: false };
    }

    const customerPhone =
      (jobData.customerPhone || '').toString().trim() ||
      (existingOrder.customerPhone || '').toString().trim();
    if (!customerPhone) {
      return { success: false, reason: 'MISSING_PHONE', hydrated: false };
    }

    const store = await this.prisma.posStore.findFirst({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
      },
      select: {
        id: true,
        integrationId: true,
        apiKey: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!store) {
      return { success: false, reason: 'STORE_NOT_FOUND', hydrated: false };
    }

    const apiKey = await this.resolveStoreApiKeyForWebhook(jobData.tenantId, {
      id: store.id,
      integrationId: store.integrationId || null,
      apiKey: store.apiKey || null,
    });
    if (!apiKey) {
      throw new Error(
        `Missing API key for reports hydrate shop_id=${jobData.shopId}`,
      );
    }

    const reportsResult = await this.fetchReportsByPhoneMetricsForOrder(
      jobData.shopId,
      apiKey,
      customerPhone,
      jobData.orderId,
    );
    if (!reportsResult.metrics) {
      throw new Error(
        reportsResult.warning ||
          `reports_by_phone not available yet for shop_id=${jobData.shopId} order_id=${jobData.orderId}`,
      );
    }

    await this.prisma.posOrder.updateMany({
      where: {
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
        posOrderId: jobData.orderId,
      },
      data: {
        reportsByPhoneOrderFail: reportsResult.metrics.orderFail,
        reportsByPhoneOrderSuccess: reportsResult.metrics.orderSuccess,
        reportsByPhoneWarning: reportsResult.metrics.warning,
      },
    });

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: jobData.tenantId },
      select: { settings: true },
    });
    const cfg = this.getPancakeWebhookSettings(tenant?.settings);
    if (
      cfg.autoCancelEnabled !== false &&
      this.shouldTriggerAutoCancelFromReports(reportsResult.metrics)
    ) {
      await this.enqueueAutoCancelStatusJob({
        tenantId: jobData.tenantId,
        shopId: jobData.shopId,
        orderId: jobData.orderId,
        reportsByPhoneOrderFail: reportsResult.metrics.orderFail,
        reportsByPhoneOrderSuccess: reportsResult.metrics.orderSuccess,
        reportsByPhoneWarning: reportsResult.metrics.warning,
        requestId: jobData.requestId,
        logId: jobData.logId,
      });
    }

    return { success: true, reason: 'HYDRATED', hydrated: true };
  }

  private async hydrateReportsByPhoneForWebhookOrders(
    tenantId: string,
    store: { id: string; shopId: string; integrationId: string | null; apiKey: string | null },
    orders: any[],
    outcomes: PosOrderUpsertOutcome[],
    cfg: PancakeWebhookSettings,
    requestId?: string,
    logId?: string,
  ): Promise<string[]> {
    const warnings: string[] = [];
    if (!orders?.length) return warnings;

    const upsertedKeys = new Set(
      outcomes
        .filter(
          (row) =>
            row.upsertStatus === 'UPSERTED'
            && row.reason !== 'VOID_NO_PRODUCT_ITEMS'
            && row.shopId
            && row.orderId,
        )
        .map((row) => `${row.shopId}::${row.orderId}`),
    );

    if (upsertedKeys.size === 0) return warnings;

    const apiKey = await this.resolveStoreApiKeyForWebhook(tenantId, store);
    if (!apiKey) {
      warnings.push(`Missing API key for reports_by_phone lookup shop_id=${store.shopId}`);
      return warnings;
    }

    for (const order of orders) {
      const status = Number(order?.status);
      if (status !== 0) continue;

      const shopId = order?.shop_id?.toString?.()?.trim?.() || store.shopId;
      const orderId = order?.id?.toString?.()?.trim?.();
      if (!shopId || !orderId) continue;

      if (!upsertedKeys.has(`${shopId}::${orderId}`)) continue;

      const customerPhone = this.extractWebhookCustomerPhone(order);
      if (!customerPhone) continue;

      const reportsResult = await this.fetchReportsByPhoneMetricsForOrder(
        shopId,
        apiKey,
        customerPhone,
        orderId,
      );
      if (reportsResult.warning) {
        warnings.push(reportsResult.warning);
      }

      const metrics = reportsResult.metrics;
      if (!metrics) {
        try {
          await this.enqueueReportsHydrateJob({
            tenantId,
            shopId,
            orderId,
            customerPhone,
            requestId,
            logId,
          });
        } catch (error: any) {
          const message = (error?.message || '').toString();
          const normalized = message.toLowerCase();
          if (!(normalized.includes('job') && normalized.includes('exist'))) {
            warnings.push(
              `Failed to queue reports hydrate for shop_id=${shopId} order_id=${orderId}: ${message || 'Unknown error'}`,
            );
          }
        }
        continue;
      }

      await this.prisma.posOrder.updateMany({
        where: {
          tenantId,
          shopId,
          posOrderId: orderId,
        },
        data: {
          reportsByPhoneOrderFail: metrics.orderFail,
          reportsByPhoneOrderSuccess: metrics.orderSuccess,
          reportsByPhoneWarning: metrics.warning,
        },
      });

      if (!this.shouldTriggerAutoCancelFromReports(metrics)) continue;
      if (cfg.autoCancelEnabled === false) continue;

      try {
        await this.enqueueAutoCancelStatusJob({
          tenantId,
          shopId,
          orderId,
          reportsByPhoneOrderFail: metrics.orderFail,
          reportsByPhoneOrderSuccess: metrics.orderSuccess,
          reportsByPhoneWarning: metrics.warning,
          requestId,
          logId,
        });
      } catch (error: any) {
        warnings.push(
          `Failed to queue auto-cancel for shop_id=${shopId} order_id=${orderId}: ${error?.message || 'Unknown error'}`,
        );
      }
    }

    return warnings;
  }

  private getPancakeWebhookQueueJobOptions() {
    const attempts = Math.max(1, Number(process.env.PANCAKE_WEBHOOK_QUEUE_ATTEMPTS || 5));
    const backoffDelay = Math.max(500, Number(process.env.PANCAKE_WEBHOOK_QUEUE_BACKOFF_MS || 2000));
    const timeout = Math.max(10_000, Number(process.env.PANCAKE_WEBHOOK_QUEUE_TIMEOUT_MS || 120_000));
    const removeOnComplete = Math.max(
      1,
      Number(process.env.PANCAKE_WEBHOOK_QUEUE_REMOVE_ON_COMPLETE || 1000),
    );
    const removeOnFail = Math.max(
      1,
      Number(process.env.PANCAKE_WEBHOOK_QUEUE_REMOVE_ON_FAIL || 5000),
    );

    return {
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete,
      removeOnFail,
    };
  }

  private isTransientDbError(error: any): boolean {
    const message = (error?.message || '').toString().toLowerCase();
    const code = (error?.code || '').toString().toUpperCase();
    const metaCode = (error?.meta?.code || '').toString().toUpperCase();

    return (
      code === 'P2034' ||
      code === 'P2028' ||
      code === '40001' ||
      code === '40P01' ||
      code === '55P03' ||
      code === '57014' ||
      metaCode === '40P01' ||
      metaCode === '40001' ||
      metaCode === '55P03' ||
      metaCode === '57014' ||
      message.includes('deadlock detected') ||
      message.includes('40p01') ||
      message.includes('could not serialize access due to') ||
      message.includes('40001')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async withTransientDbRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxAttempts = 3,
  ): Promise<T> {
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await operation();
      } catch (error: any) {
        if (!this.isTransientDbError(error) || attempt >= maxAttempts) {
          throw error;
        }

        const baseDelayMs = Math.min(1000, 150 * attempt);
        const delayMs = baseDelayMs + Math.floor(Math.random() * 151);
        this.logger.warn(
          `${operationName} hit transient DB error; retrying attempt ${attempt + 1}/${maxAttempts} in ${delayMs}ms: ${error?.message || 'Unknown error'}`,
        );
        await this.sleep(delayMs);
      }
    }

    throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
  }

  private extractWebhookOrderDateLocal(order: any): string | null {
    const insertedRaw =
      (typeof order?.inserted_at === 'string' && order.inserted_at.trim()) ||
      (typeof order?.insertedAt === 'string' && order.insertedAt.trim()) ||
      '';
    if (!insertedRaw) return null;

    const insertedAtUtc = dayjs.utc(insertedRaw);
    if (!insertedAtUtc.isValid()) return null;

    return insertedAtUtc.tz('Asia/Manila').format('YYYY-MM-DD');
  }

  private getPancakeWebhookReconcileQueueJobOptions(delayMs: number) {
    const attempts = Math.max(1, Number(process.env.PANCAKE_RECONCILE_QUEUE_ATTEMPTS || 3));
    const backoffDelay = Math.max(
      1000,
      Number(process.env.PANCAKE_RECONCILE_QUEUE_BACKOFF_MS || 4000),
    );
    const timeout = Math.max(
      30_000,
      Number(process.env.PANCAKE_RECONCILE_QUEUE_TIMEOUT_MS || 300_000),
    );
    return {
      delay: Math.max(0, delayMs),
      attempts,
      backoff: { type: 'exponential' as const, delay: backoffDelay },
      timeout,
      removeOnComplete: true,
      removeOnFail: 1000,
    };
  }

  private getDefaultWebhookReconcileIntervalSeconds(): number {
    const delayMs = Math.max(
      0,
      Number(process.env.PANCAKE_WEBHOOK_RECONCILE_DELAY_MS || 300000),
    );
    return Math.max(10, Math.round(delayMs / 1000));
  }

  private getMinimumWebhookReconcileDelayMs(): number {
    return Math.max(
      10_000,
      Number(process.env.PANCAKE_WEBHOOK_RECONCILE_MIN_DELAY_MS || 300000),
    );
  }

  private getWebhookReconcileDelayMs(cfg: PancakeWebhookSettings): number {
    const intervalSeconds = cfg.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds();
    return Math.max(
      Math.max(10, intervalSeconds) * 1000,
      this.getMinimumWebhookReconcileDelayMs(),
    );
  }

  private getDefaultWebhookReconcileMode(): 'incremental' | 'full_reset' {
    return 'incremental';
  }

  private getAutomaticWebhookReconcileMode(
    configuredMode: 'incremental' | 'full_reset' | undefined,
  ) {
    return resolveAutomaticPancakeReconcileMode(
      configuredMode,
      process.env.PANCAKE_WEBHOOK_ALLOW_AUTOMATIC_FULL_RESET === 'true',
    );
  }

  private async enqueueWebhookReconcileJobs(
    tenantId: string,
    targets: Map<string, PancakeWebhookReconcileTarget>,
    requestId: string,
    delayMs: number,
    reconcileMode: 'incremental' | 'full_reset',
    logId?: string,
  ): Promise<{ queued: number; skipped: number; warnings: string[] }> {
    const warnings: string[] = [];
    let queued = 0;
    let skipped = 0;

    if (targets.size === 0) {
      return { queued, skipped, warnings };
    }

    for (const target of targets.values()) {
      try {
        // A delete/void must remove its previous contribution quickly. Keep the
        // normal five-minute coalescing window for ordinary updates, while
        // destructive corrections share a small, separate window per day.
        const trigger = target.destructive
          ? 'destructive_order_change' as const
          : 'standard' as const;
        const effectiveDelayMs = target.destructive
          ? Math.min(delayMs, 15_000)
          : delayMs;
        const reconcileWindow = buildPancakeReconcileWindow({
          tenantId,
          dateLocal: target.dateLocal,
          delayMs: effectiveDelayMs,
          trigger,
        });
        const existingJob = await this.pancakeWebhookReconcileQueue.getJob(
          reconcileWindow.jobId,
        );
        if (existingJob) {
          skipped += 1;
          continue;
        }

        await this.pancakeWebhookReconcileQueue.add(
          PANCAKE_WEBHOOK_RECONCILE_JOB,
          {
            tenantId,
            teamId: null,
            dateLocal: target.dateLocal,
            reconcileMode,
            trigger,
            scheduledFor: reconcileWindow.scheduledFor,
            requestId,
            logId,
          },
          {
            jobId: reconcileWindow.jobId,
            ...this.getPancakeWebhookReconcileQueueJobOptions(reconcileWindow.delayMs),
            ...(target.destructive ? { priority: 1 } : {}),
          },
        );
        queued += 1;
      } catch (error: any) {
        const message = (error?.message || '').toString();
        const normalized = message.toLowerCase();
        if (normalized.includes('job') && normalized.includes('exist')) {
          skipped += 1;
          continue;
        }

        warnings.push(
          `Failed to queue reconcile (${target.dateLocal}): ${message || 'Unknown error'}`,
        );
      }
    }

    return { queued, skipped, warnings };
  }

  private async processPancakeWebhookPayload(
    tenant: { id: string; settings: any; encryptionKey: string },
    safePayload: any,
    requestId: string,
    logId?: string,
  ): Promise<PancakeWebhookPayloadProcessingResult> {
    const cfg = this.getPancakeWebhookSettings(tenant.settings);
    const warnings: string[] = [];
    let upserted = 0;
    const outcomes: PosOrderUpsertOutcome[] = [];
    let reconcileQueuedCount = 0;
    let reconcileSkippedCount = 0;

    const relayResult = await this.forwardPancakeWebhookPayload(
      { id: tenant.id, encryptionKey: tenant.encryptionKey },
      cfg,
      safePayload,
      requestId,
    );
    if (relayResult.warning) {
      warnings.push(relayResult.warning);
    }

    const webhookOrders = this.extractWebhookOrders(safePayload);
    if (webhookOrders.length === 0) {
      warnings.push('Missing order payload or shop_id');
      return {
        upserted,
        warnings,
        relayStatus: relayResult.relayStatus,
        outcomes,
        reconcileQueuedCount,
        reconcileSkippedCount,
      };
    }

    const routing = await this.posShopOwnershipService.resolveOrderRoutes(
      tenant.id,
      webhookOrders,
    );
    for (const issue of routing.issues) {
      warnings.push(issue.warning);
      const statusRaw = Number(issue.order?.status);
      outcomes.push({
        shopId: issue.shopId,
        orderId: issue.orderId,
        status: Number.isFinite(statusRaw) ? statusRaw : null,
        upsertStatus: 'FAILED',
        reason: issue.reason,
        warning: issue.warning,
      });
    }

    const destinationTenantIds = Array.from(
      new Set(routing.routes.map((route) => route.tenantId)),
    );
    const destinationTenants =
      destinationTenantIds.length > 0
        ? await this.prisma.tenant.findMany({
            where: { id: { in: destinationTenantIds } },
            select: { id: true, settings: true, encryptionKey: true },
          })
        : [];
    const destinationTenantById = new Map(
      destinationTenants.map((row) => [row.id, row]),
    );
    const reconcileTargetsByTenant = new Map<
      string,
      Map<string, PancakeWebhookReconcileTarget>
    >();

    for (const route of routing.routes) {
      const destinationTenant = destinationTenantById.get(route.tenantId);
      if (!destinationTenant) {
        const warning = `Destination tenant ${route.tenantId} was not found for shop ${route.shopId}`;
        warnings.push(warning);
        route.orders.forEach((order) => {
          const statusRaw = Number(order?.status);
          outcomes.push({
            shopId: route.shopId,
            orderId:
              order?.id?.toString?.()?.trim?.() ||
              order?.order_id?.toString?.()?.trim?.() ||
              null,
            status: Number.isFinite(statusRaw) ? statusRaw : null,
            upsertStatus: 'FAILED',
            reason: 'DESTINATION_TENANT_NOT_FOUND',
            warning,
          });
        });
        continue;
      }

      const destinationCfg = this.getPancakeWebhookSettings(
        destinationTenant.settings,
      );
      const reconcileTargets =
        reconcileTargetsByTenant.get(route.tenantId) ||
        new Map<string, PancakeWebhookReconcileTarget>();
      const dateLocalByOrderId = new Map<string, string>();
      for (const order of route.orders) {
        const dateLocal = this.extractWebhookOrderDateLocal(order);
        if (!dateLocal) continue;
        const orderId =
          order?.id?.toString?.()?.trim?.() ||
          order?.order_id?.toString?.()?.trim?.() ||
          '';
        if (orderId) dateLocalByOrderId.set(orderId, dateLocal);
        const existingTarget = reconcileTargets.get(dateLocal);
        reconcileTargets.set(dateLocal, {
          dateLocal,
          destructive:
            existingTarget?.destructive === true || Number(order?.status) === 7,
        });
      }
      reconcileTargetsByTenant.set(route.tenantId, reconcileTargets);

      try {
        const result = await this.withTransientDbRetry(
          () =>
            this.posOrderService.upsertPosOrdersWithOutcomes(
              route.tenantId,
              route.store.id,
              route.orders,
              route.store.teamId,
            ),
          `pancake webhook upsert tenant=${route.tenantId} shop_id=${route.shopId}`,
        );
        upserted += result.upserted;
        outcomes.push(...result.outcomes);

        for (const outcome of result.outcomes) {
          const isDestructive =
            outcome.status === 7 ||
            outcome.upsertStatus === 'DELETED' ||
            outcome.reason === 'VOID_NO_PRODUCT_ITEMS';
          if (!isDestructive || !outcome.orderId) continue;

          const dateLocal = dateLocalByOrderId.get(outcome.orderId);
          if (!dateLocal) continue;
          reconcileTargets.set(dateLocal, { dateLocal, destructive: true });
        }

        const reportsWarnings =
          await this.hydrateReportsByPhoneForWebhookOrders(
            route.tenantId,
            {
              id: route.store.id,
              shopId: route.shopId,
              integrationId: route.store.integrationId,
              apiKey: route.store.apiKey,
            },
            route.orders,
            result.outcomes,
            destinationCfg,
            requestId,
            logId,
          );
        warnings.push(...reportsWarnings);
      } catch (error: any) {
        if (this.isTransientDbError(error)) {
          throw error;
        }

        const warning = `Failed to upsert tenant=${route.tenantId} shop_id=${route.shopId}: ${error?.message || 'Unknown error'}`;
        warnings.push(warning);
        route.orders.forEach((order) => {
          const statusRaw = Number(order?.status);
          outcomes.push({
            shopId: route.shopId,
            orderId:
              order?.id?.toString?.()?.trim?.() ||
              order?.order_id?.toString?.()?.trim?.() ||
              null,
            status: Number.isFinite(statusRaw) ? statusRaw : null,
            upsertStatus: 'FAILED',
            reason: 'SHOP_UPSERT_FAILED',
            warning,
          });
        });
      }
    }

    for (const [
      destinationTenantId,
      reconcileTargets,
    ] of reconcileTargetsByTenant.entries()) {
      const destinationTenant = destinationTenantById.get(destinationTenantId);
      if (!destinationTenant) continue;
      const destinationCfg = this.getPancakeWebhookSettings(
        destinationTenant.settings,
      );

      if (destinationCfg.reconcileEnabled === false) {
        reconcileSkippedCount += reconcileTargets.size;
        continue;
      }

      const reconcileQueueResult = await this.enqueueWebhookReconcileJobs(
        destinationTenantId,
        reconcileTargets,
        requestId,
        this.getWebhookReconcileDelayMs(destinationCfg),
        this.getAutomaticWebhookReconcileMode(
          destinationCfg.reconcileMode ?? this.getDefaultWebhookReconcileMode(),
        ),
        logId,
      );
      warnings.push(...reconcileQueueResult.warnings);
      reconcileQueuedCount += reconcileQueueResult.queued;
      reconcileSkippedCount += reconcileQueueResult.skipped;
    }

    return {
      upserted,
      warnings,
      relayStatus: relayResult.relayStatus,
      outcomes,
      reconcileQueuedCount,
      reconcileSkippedCount,
    };
  }

  async processQueuedPancakeWebhookEvent(
    jobData: PancakeWebhookJobData,
    runtime?: { jobId?: string; attempts?: number },
  ): Promise<{ upserted: number; warnings: string[] }> {
    const startedAt = new Date();
    const existingLog = await this.prisma.pancakeWebhookLog.findUnique({
      where: { id: jobData.logId },
      select: { id: true, receiveDurationMs: true },
    });

    if (!existingLog) {
      throw new NotFoundException(`Webhook log ${jobData.logId} not found`);
    }
    const baseReceiveDurationMs = existingLog.receiveDurationMs || 0;

    await this.prisma.pancakeWebhookLog.update({
      where: { id: jobData.logId },
      data: {
        processStatus: 'PROCESSING',
        processingStartedAt: startedAt,
        queueJobId: runtime?.jobId || undefined,
        attempts: runtime?.attempts || undefined,
      },
    });

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: jobData.tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      const endedAt = new Date();
      await this.prisma.pancakeWebhookLog.update({
        where: { id: jobData.logId },
        data: {
          receiveStatus: 'FAILED',
          processStatus: 'FAILED',
          relayStatus: 'SKIPPED',
          errorCode: 'TENANT_NOT_FOUND',
          errorMessage: 'Tenant not found',
          processedAt: endedAt,
          processingDurationMs: endedAt.getTime() - startedAt.getTime(),
          totalDurationMs: baseReceiveDurationMs + (endedAt.getTime() - startedAt.getTime()),
        },
      });
      throw new NotFoundException(`Tenant ${jobData.tenantId} not found`);
    }

    try {
      const result = await this.processPancakeWebhookPayload(
        tenant,
        jobData.payload ?? {},
        jobData.requestId,
        jobData.logId,
      );
      const endedAt = new Date();
      const processingDurationMs = endedAt.getTime() - startedAt.getTime();
      const finalProcessStatus = this.mapFinalProcessStatus(
        result.upserted,
        result.outcomes,
        result.warnings,
      );

      await this.persistWebhookOrderOutcomes(jobData.logId, result.outcomes);

      await this.prisma.pancakeWebhookLog.update({
        where: { id: jobData.logId },
        data: {
          receiveStatus: 'ACCEPTED',
          receiveHttpStatus: 202,
          processStatus: finalProcessStatus,
          relayStatus: result.relayStatus,
          upsertedCount: result.upserted,
          warningCount: result.warnings.length,
          reconcileQueuedCount: result.reconcileQueuedCount,
          reconcileSkippedCount: result.reconcileSkippedCount,
          errorCode: finalProcessStatus === 'FAILED' ? 'PROCESS_FAILED' : null,
          errorMessage:
            finalProcessStatus === 'FAILED'
              ? this.truncateMessage(result.warnings[0] || 'Webhook processing failed')
              : result.warnings.length > 0
                ? this.truncateMessage(result.warnings.join(' | '))
                : null,
          processedAt: endedAt,
          processingDurationMs,
          totalDurationMs: baseReceiveDurationMs + processingDurationMs,
        },
      });

      if (result.warnings.length > 0) {
        this.logger.warn(
          `Webhook log ${jobData.logId} processed with warnings: ${result.warnings.join(' | ')}`,
        );
      }

      return { upserted: result.upserted, warnings: result.warnings };
    } catch (error: any) {
      const endedAt = new Date();
      const processingDurationMs = endedAt.getTime() - startedAt.getTime();

      await this.prisma.pancakeWebhookLog.update({
        where: { id: jobData.logId },
        data: {
          receiveStatus: 'FAILED',
          processStatus: 'FAILED',
          relayStatus: 'FAILED',
          errorCode: 'PROCESS_EXCEPTION',
          errorMessage: this.truncateMessage(error?.message || 'Unknown processing error'),
          processedAt: endedAt,
          processingDurationMs,
          totalDurationMs: baseReceiveDurationMs + processingDurationMs,
        },
      });

      throw error;
    }
  }

  async getPancakeWebhookConfig(baseUrl: string, tenantIdOverride?: string) {
    const { tenantId } = await this.getPancakeWebhookContext(tenantIdOverride);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const cfg = this.getPancakeWebhookSettings(tenant.settings);
    const relayApiKey = this.getRelayApiKey(cfg, tenant.encryptionKey) || null;
    return {
      enabled: !!cfg.enabled,
      autoCancelEnabled: cfg.autoCancelEnabled !== false,
      reconcileEnabled: cfg.reconcileEnabled !== false,
      reconcileIntervalSeconds:
        cfg.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds(),
      reconcileMode: cfg.reconcileMode ?? this.getDefaultWebhookReconcileMode(),
      hasApiKey: !!cfg.apiKeyHash,
      keyLast4: cfg.keyLast4 || null,
      rotatedAt: cfg.rotatedAt || null,
      rotatedByUserId: cfg.rotatedByUserId || null,
      headerKey: 'x-api-key',
      webhookUrl: this.buildPancakeWebhookUrl(baseUrl, tenant.id),
      relayEnabled: !!cfg.relayEnabled,
      relayWebhookUrl: cfg.relayWebhookUrl || null,
      relayHeaderKey: this.getRelayHeaderKey(cfg),
      relayApiKey,
      relayHasApiKey: !!relayApiKey,
      relayKeyLast4: cfg.relayKeyLast4 || null,
      relayUpdatedAt: cfg.relayUpdatedAt || null,
      relayUpdatedByUserId: cfg.relayUpdatedByUserId || null,
    };
  }

  async getPancakeWebhookLogs(params: ListPancakeWebhookLogsParams) {
    const { tenantId } = await this.teamContext.getContext();
    const page = Math.max(1, Number(params.page || 1));
    const limit = Math.min(100, Math.max(1, Number(params.limit || 20)));
    const skip = (page - 1) * limit;

    const andFilters: Prisma.PancakeWebhookLogWhereInput[] = [{ tenantId }];

    const receiveStatus = params.receiveStatus?.trim();
    if (receiveStatus) {
      andFilters.push({ receiveStatus: { equals: receiveStatus.toUpperCase() } });
    }

    const processStatus = params.processStatus?.trim();
    if (processStatus) {
      andFilters.push({ processStatus: { equals: processStatus.toUpperCase() } });
    }

    const relayStatus = params.relayStatus?.trim();
    if (relayStatus) {
      andFilters.push({ relayStatus: { equals: relayStatus.toUpperCase() } });
    }

    const requestId = params.requestId?.trim();
    if (requestId) {
      andFilters.push({
        requestId: { contains: requestId, mode: 'insensitive' },
      });
    }

    const startDate = params.startDate?.trim();
    const endDate = params.endDate?.trim();
    if (startDate || endDate) {
      const receivedAtFilter: Prisma.DateTimeFilter = {};
      if (startDate) {
        receivedAtFilter.gte = this.parseLogsDateBound(startDate, false);
      }
      if (endDate) {
        receivedAtFilter.lt = this.parseLogsDateBound(endDate, true);
      }
      andFilters.push({ receivedAt: receivedAtFilter });
    }

    const shopId = params.shopId?.trim();
    if (shopId) {
      andFilters.push({
        orders: {
          some: {
            shopId: { contains: shopId, mode: 'insensitive' },
          },
        },
      });
    }

    const orderId = params.orderId?.trim();
    if (orderId) {
      andFilters.push({
        orders: {
          some: {
            orderId: { contains: orderId, mode: 'insensitive' },
          },
        },
      });
    }

    const search = params.search?.trim();
    if (search) {
      andFilters.push({
        OR: [
          { requestId: { contains: search, mode: 'insensitive' } },
          { queueJobId: { contains: search, mode: 'insensitive' } },
          { errorMessage: { contains: search, mode: 'insensitive' } },
          {
            orders: {
              some: {
                OR: [
                  { shopId: { contains: search, mode: 'insensitive' } },
                  { orderId: { contains: search, mode: 'insensitive' } },
                ],
              },
            },
          },
        ],
      });
    }

    const where: Prisma.PancakeWebhookLogWhereInput =
      andFilters.length === 1 ? andFilters[0] : { AND: andFilters };

    const [total, logs] = await Promise.all([
      this.prisma.pancakeWebhookLog.count({ where }),
      this.prisma.pancakeWebhookLog.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }],
        skip,
        take: limit,
        select: {
          id: true,
          requestTenantId: true,
          requestId: true,
          source: true,
          receiveHttpStatus: true,
          receiveStatus: true,
          processStatus: true,
          relayStatus: true,
          payloadHash: true,
          payloadBytes: true,
          orderCount: true,
          upsertedCount: true,
          warningCount: true,
          reconcileQueuedCount: true,
          reconcileSkippedCount: true,
          attempts: true,
          queueJobId: true,
          errorCode: true,
          errorMessage: true,
          receiveDurationMs: true,
          processingDurationMs: true,
          totalDurationMs: true,
          receivedAt: true,
          processingStartedAt: true,
          processedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { orders: true },
          },
        },
      }),
    ]);

    const logIds = logs.map((row) => row.id);
    const orderRows =
      logIds.length > 0
        ? await this.prisma.pancakeWebhookLogOrder.findMany({
            where: { logId: { in: logIds } },
            orderBy: [{ createdAt: 'asc' }],
            select: {
              id: true,
              logId: true,
              shopId: true,
              orderId: true,
              status: true,
              upsertStatus: true,
              reason: true,
              warning: true,
              createdAt: true,
            },
          })
        : [];

    const ordersByLogId = new Map<string, typeof orderRows>();
    orderRows.forEach((row) => {
      const list = ordersByLogId.get(row.logId) || [];
      list.push(row);
      ordersByLogId.set(row.logId, list);
    });

    return {
      items: logs.map((row) => ({
        ...row,
        orders: ordersByLogId.get(row.id) || [],
        orderRowsCount: row._count.orders,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async rotatePancakeWebhookApiKey(baseUrl: string, tenantIdOverride?: string) {
    const { tenantId, userId } = await this.getPancakeWebhookContext(tenantIdOverride);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const settings = this.normalizeJsonObject(tenant.settings);
    const existing = this.getPancakeWebhookSettings(tenant.settings);
    const apiKey = `nbm_${randomBytes(24).toString('hex')}`;
    const nowIso = new Date().toISOString();

    settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY] = {
      enabled: existing.enabled ?? true,
      autoCancelEnabled: existing.autoCancelEnabled ?? true,
      reconcileEnabled: existing.reconcileEnabled ?? true,
      reconcileIntervalSeconds:
        existing.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds(),
      reconcileMode: existing.reconcileMode ?? this.getDefaultWebhookReconcileMode(),
      apiKeyHash: this.hashWebhookApiKey(apiKey),
      keyLast4: apiKey.slice(-4),
      rotatedAt: nowIso,
      rotatedByUserId: userId || null,
      relayEnabled: existing.relayEnabled ?? false,
      relayWebhookUrl: existing.relayWebhookUrl,
      relayHeaderKey: existing.relayHeaderKey,
      relayApiKey: existing.relayApiKey,
      relayApiKeyEncrypted: existing.relayApiKeyEncrypted,
      relayKeyLast4: existing.relayKeyLast4,
      relayUpdatedAt: existing.relayUpdatedAt,
      relayUpdatedByUserId: existing.relayUpdatedByUserId,
    };

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    return {
      enabled: settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY].enabled,
      autoCancelEnabled:
        settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY].autoCancelEnabled !== false,
      reconcileEnabled: settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY].reconcileEnabled,
      reconcileIntervalSeconds:
        settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY].reconcileIntervalSeconds,
      reconcileMode:
        settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY].reconcileMode
        || this.getDefaultWebhookReconcileMode(),
      headerKey: 'x-api-key',
      apiKey,
      keyLast4: apiKey.slice(-4),
      rotatedAt: nowIso,
      rotatedByUserId: userId || null,
      webhookUrl: this.buildPancakeWebhookUrl(baseUrl, tenant.id),
      relayEnabled: !!existing.relayEnabled,
      relayWebhookUrl: existing.relayWebhookUrl || null,
      relayHeaderKey: this.getRelayHeaderKey(existing),
      relayApiKey: this.getRelayApiKey(existing, tenant.encryptionKey) || null,
      relayHasApiKey: !!this.getRelayApiKey(existing, tenant.encryptionKey),
      relayKeyLast4: existing.relayKeyLast4 || null,
      relayUpdatedAt: existing.relayUpdatedAt || null,
      relayUpdatedByUserId: existing.relayUpdatedByUserId || null,
    };
  }

  async updatePancakeWebhookEnabled(
    dto: UpdatePancakeWebhookDto,
    baseUrl: string,
    tenantIdOverride?: string,
  ) {
    const { tenantId } = await this.getPancakeWebhookContext(tenantIdOverride);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const settings = this.normalizeJsonObject(tenant.settings);
    const existing = this.getPancakeWebhookSettings(tenant.settings);
    const hasEnabledUpdate = typeof dto.enabled === 'boolean';
    const hasAutoCancelUpdate = typeof dto.autoCancelEnabled === 'boolean';
    const hasReconcileUpdate = typeof dto.reconcileEnabled === 'boolean';
    const hasReconcileIntervalUpdate = typeof dto.reconcileIntervalSeconds === 'number';
    const hasReconcileModeUpdate = typeof dto.reconcileMode === 'string';
    if (
      !hasEnabledUpdate
      && !hasAutoCancelUpdate
      && !hasReconcileUpdate
      && !hasReconcileIntervalUpdate
      && !hasReconcileModeUpdate
    ) {
      throw new BadRequestException('At least one setting must be provided');
    }

    const enabled = hasEnabledUpdate ? !!dto.enabled : !!existing.enabled;
    const autoCancelEnabled = hasAutoCancelUpdate
      ? !!dto.autoCancelEnabled
      : existing.autoCancelEnabled !== false;
    const reconcileEnabled = hasReconcileUpdate
      ? !!dto.reconcileEnabled
      : existing.reconcileEnabled !== false;
    const reconcileIntervalSeconds = hasReconcileIntervalUpdate
      ? Math.floor(dto.reconcileIntervalSeconds as number)
      : existing.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds();
    const requestedReconcileMode = hasReconcileModeUpdate
      ? (dto.reconcileMode as 'incremental' | 'full_reset')
      : existing.reconcileMode ?? this.getDefaultWebhookReconcileMode();
    const reconcileMode = this.getAutomaticWebhookReconcileMode(requestedReconcileMode);

    settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY] = {
      enabled,
      autoCancelEnabled,
      reconcileEnabled,
      reconcileIntervalSeconds,
      reconcileMode,
      apiKeyHash: existing.apiKeyHash,
      keyLast4: existing.keyLast4,
      rotatedAt: existing.rotatedAt,
      rotatedByUserId: existing.rotatedByUserId,
      relayEnabled: existing.relayEnabled ?? false,
      relayWebhookUrl: existing.relayWebhookUrl,
      relayHeaderKey: existing.relayHeaderKey,
      relayApiKey: existing.relayApiKey,
      relayApiKeyEncrypted: existing.relayApiKeyEncrypted,
      relayKeyLast4: existing.relayKeyLast4,
      relayUpdatedAt: existing.relayUpdatedAt,
      relayUpdatedByUserId: existing.relayUpdatedByUserId,
    };

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    return {
      enabled,
      autoCancelEnabled,
      reconcileEnabled,
      reconcileIntervalSeconds,
      reconcileMode,
      hasApiKey: !!existing.apiKeyHash,
      keyLast4: existing.keyLast4 || null,
      rotatedAt: existing.rotatedAt || null,
      rotatedByUserId: existing.rotatedByUserId || null,
      headerKey: 'x-api-key',
      webhookUrl: this.buildPancakeWebhookUrl(baseUrl, tenant.id),
      relayEnabled: !!existing.relayEnabled,
      relayWebhookUrl: existing.relayWebhookUrl || null,
      relayHeaderKey: this.getRelayHeaderKey(existing),
      relayApiKey: this.getRelayApiKey(existing, tenant.encryptionKey) || null,
      relayHasApiKey: !!this.getRelayApiKey(existing, tenant.encryptionKey),
      relayKeyLast4: existing.relayKeyLast4 || null,
      relayUpdatedAt: existing.relayUpdatedAt || null,
      relayUpdatedByUserId: existing.relayUpdatedByUserId || null,
    };
  }

  async updatePancakeWebhookRelayConfig(
    dto: UpdatePancakeWebhookRelayDto,
    baseUrl: string,
    tenantIdOverride?: string,
  ) {
    const { tenantId, userId } = await this.getPancakeWebhookContext(tenantIdOverride);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const settings = this.normalizeJsonObject(tenant.settings);
    const existing = this.getPancakeWebhookSettings(tenant.settings);
    const nowIso = new Date().toISOString();
    const relayWebhookUrl = this.normalizeRelayWebhookUrl(dto.webhookUrl);
    const relayHeaderKeyRaw = dto.headerKey;
    const relayHeaderKeyFromInput = this.sanitizeRelayHeaderKey(relayHeaderKeyRaw);
    if (
      typeof relayHeaderKeyRaw === 'string'
      && relayHeaderKeyRaw.trim().length > 0
      && !relayHeaderKeyFromInput
    ) {
      throw new BadRequestException('Invalid relay header key');
    }

    let relayApiKey = this.getRelayApiKey(existing, tenant.encryptionKey) || '';
    let relayKeyLast4 = existing.relayKeyLast4;
    const apiKeyRaw = dto.apiKey?.trim() || '';
    if (apiKeyRaw) {
      relayApiKey = apiKeyRaw;
      relayKeyLast4 = apiKeyRaw.slice(-4);
    }

    const finalRelayWebhookUrl = relayWebhookUrl ?? existing.relayWebhookUrl;
    const finalRelayHeaderKey = relayHeaderKeyFromInput ?? this.getRelayHeaderKey(existing);
    if (dto.enabled && !finalRelayWebhookUrl) {
      throw new BadRequestException('Relay webhook URL is required when relay is enabled');
    }
    if (dto.enabled && !relayApiKey) {
      throw new BadRequestException('Relay API key is required when relay is enabled');
    }

    settings[this.PANCAKE_WEBHOOK_SETTINGS_KEY] = {
      enabled: existing.enabled ?? false,
      autoCancelEnabled: existing.autoCancelEnabled ?? true,
      reconcileEnabled: existing.reconcileEnabled ?? true,
      reconcileIntervalSeconds:
        existing.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds(),
      reconcileMode: existing.reconcileMode ?? this.getDefaultWebhookReconcileMode(),
      apiKeyHash: existing.apiKeyHash,
      keyLast4: existing.keyLast4,
      rotatedAt: existing.rotatedAt,
      rotatedByUserId: existing.rotatedByUserId,
      relayEnabled: dto.enabled,
      relayWebhookUrl: finalRelayWebhookUrl,
      relayHeaderKey: finalRelayHeaderKey,
      relayApiKey,
      relayKeyLast4,
      relayUpdatedAt: nowIso,
      relayUpdatedByUserId: userId || null,
    };

    await this.prisma.tenant.update({
      where: { id: tenant.id },
      data: { settings: settings as Prisma.InputJsonValue },
    });

    const updated = this.getPancakeWebhookSettings(settings);
    const resolvedRelayApiKey = this.getRelayApiKey(updated, tenant.encryptionKey) || null;
    return {
      enabled: !!updated.enabled,
      autoCancelEnabled: updated.autoCancelEnabled !== false,
      reconcileEnabled: updated.reconcileEnabled !== false,
      reconcileIntervalSeconds:
        updated.reconcileIntervalSeconds ?? this.getDefaultWebhookReconcileIntervalSeconds(),
      reconcileMode: updated.reconcileMode ?? this.getDefaultWebhookReconcileMode(),
      hasApiKey: !!updated.apiKeyHash,
      keyLast4: updated.keyLast4 || null,
      rotatedAt: updated.rotatedAt || null,
      rotatedByUserId: updated.rotatedByUserId || null,
      headerKey: 'x-api-key',
      webhookUrl: this.buildPancakeWebhookUrl(baseUrl, tenant.id),
      relayEnabled: !!updated.relayEnabled,
      relayWebhookUrl: updated.relayWebhookUrl || null,
      relayHeaderKey: this.getRelayHeaderKey(updated),
      relayApiKey: resolvedRelayApiKey,
      relayHasApiKey: !!resolvedRelayApiKey,
      relayKeyLast4: updated.relayKeyLast4 || null,
      relayUpdatedAt: updated.relayUpdatedAt || null,
      relayUpdatedByUserId: updated.relayUpdatedByUserId || null,
    };
  }

  async receivePancakeOrderWebhook(
    tenantId: string,
    apiKey: string | undefined,
    payload: any,
    headers: Record<string, any>,
  ) {
    const receivedAt = new Date();
    const normalizedHeaders = this.normalizeWebhookHeaders(headers);
    const requestId = this.buildWebhookRequestId(headers);

    let safePayload: any = payload ?? {};
    try {
      safePayload = JSON.parse(JSON.stringify(payload ?? {}));
    } catch {
      safePayload = { raw: String(payload ?? '') };
    }

    const payloadFingerprint = this.toPayloadFingerprint(safePayload);
    const orderRefs = this.extractWebhookOrderRefs(safePayload);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, settings: true, encryptionKey: true },
    });

    if (!tenant) {
      const endedAt = new Date();
      const receiveDurationMs = endedAt.getTime() - receivedAt.getTime();
      await this.prisma.pancakeWebhookLog.create({
        data: {
          tenantId: null,
          requestTenantId: tenantId,
          requestId,
          source: IntegrationProvider.PANCAKE_POS,
          receiveHttpStatus: 404,
          receiveStatus: 'INVALID_TENANT',
          processStatus: 'FAILED',
          relayStatus: 'SKIPPED',
          payloadHash: payloadFingerprint.hash,
          payloadBytes: payloadFingerprint.bytes,
          orderCount: orderRefs.length,
          upsertedCount: 0,
          warningCount: 1,
          errorCode: 'INVALID_TENANT',
          errorMessage: 'Invalid tenant',
          headersSnapshot: normalizedHeaders as Prisma.InputJsonValue,
          receiveDurationMs,
          totalDurationMs: receiveDurationMs,
          receivedAt,
          processedAt: endedAt,
        },
      });
      throw new NotFoundException('Invalid tenant');
    }

    const cfg = this.getPancakeWebhookSettings(tenant.settings);
    const log = await this.prisma.pancakeWebhookLog.create({
      data: {
        tenantId: tenant.id,
        requestTenantId: tenantId,
        requestId,
        source: IntegrationProvider.PANCAKE_POS,
        receiveStatus: 'RECEIVED',
        processStatus: 'SKIPPED',
        relayStatus: 'SKIPPED',
        payloadHash: payloadFingerprint.hash,
        payloadBytes: payloadFingerprint.bytes,
        orderCount: orderRefs.length,
        headersSnapshot: normalizedHeaders as Prisma.InputJsonValue,
        receivedAt,
      },
      select: { id: true, receivedAt: true },
    });

    if (orderRefs.length > 0) {
      await this.persistWebhookOrderOutcomes(
        log.id,
        orderRefs.map((row) => ({
          shopId: row.shopId,
          orderId: row.orderId,
          status: row.status,
          upsertStatus: 'SKIPPED',
          reason: 'NOT_PROCESSED',
        })),
      );
    }

    if (!cfg.enabled) {
      const endedAt = new Date();
      const receiveDurationMs = endedAt.getTime() - receivedAt.getTime();
      await this.prisma.pancakeWebhookLog.update({
        where: { id: log.id },
        data: {
          receiveHttpStatus: 403,
          receiveStatus: 'DISABLED',
          processStatus: 'SKIPPED',
          errorCode: 'WEBHOOK_DISABLED',
          errorMessage: 'Webhook is disabled',
          warningCount: 1,
          processedAt: endedAt,
          receiveDurationMs,
          totalDurationMs: receiveDurationMs,
        },
      });
      throw new ForbiddenException('Webhook is disabled');
    }
    if (!cfg.apiKeyHash) {
      const endedAt = new Date();
      const receiveDurationMs = endedAt.getTime() - receivedAt.getTime();
      await this.prisma.pancakeWebhookLog.update({
        where: { id: log.id },
        data: {
          receiveHttpStatus: 401,
          receiveStatus: 'AUTH_FAILED',
          processStatus: 'SKIPPED',
          errorCode: 'API_KEY_MISSING',
          errorMessage: 'Webhook API key is not configured',
          warningCount: 1,
          processedAt: endedAt,
          receiveDurationMs,
          totalDurationMs: receiveDurationMs,
        },
      });
      throw new UnauthorizedException('Webhook API key is not configured');
    }
    if (!apiKey || !this.verifyWebhookApiKey(apiKey, cfg.apiKeyHash)) {
      const endedAt = new Date();
      const receiveDurationMs = endedAt.getTime() - receivedAt.getTime();
      await this.prisma.pancakeWebhookLog.update({
        where: { id: log.id },
        data: {
          receiveHttpStatus: 401,
          receiveStatus: 'AUTH_FAILED',
          processStatus: 'SKIPPED',
          errorCode: 'API_KEY_INVALID',
          errorMessage: 'Invalid webhook API key',
          warningCount: 1,
          processedAt: endedAt,
          receiveDurationMs,
          totalDurationMs: receiveDurationMs,
        },
      });
      throw new UnauthorizedException('Invalid webhook API key');
    }

    const inlinePreferred = process.env.PANCAKE_WEBHOOK_PROCESS_INLINE === 'true';
    const inlineFallback = process.env.PANCAKE_WEBHOOK_INLINE_FALLBACK !== 'false';

    if (!inlinePreferred) {
      try {
        const queuedJob = await this.pancakeWebhookQueue.add(
          PANCAKE_WEBHOOK_JOB,
          {
            logId: log.id,
            requestId,
            tenantId: tenant.id,
            payload: safePayload,
          },
          {
            jobId: log.id,
            ...this.getPancakeWebhookQueueJobOptions(),
          },
        );

        const receiveDurationMs = Date.now() - receivedAt.getTime();
        await this.prisma.pancakeWebhookLog.update({
          where: { id: log.id },
          data: {
            receiveHttpStatus: 202,
            receiveStatus: 'ACCEPTED',
            processStatus: 'QUEUED',
            queueJobId: queuedJob?.id?.toString?.() || null,
            receiveDurationMs,
            totalDurationMs: receiveDurationMs,
          },
        });

        return {
          accepted: true,
          queued: true,
          eventId: log.id,
          requestId,
          receivedAt: log.receivedAt.toISOString(),
          message: 'Webhook received and queued',
          upserted: 0,
          warning: null,
        };
      } catch (error: any) {
        this.logger.error(
          `Failed to enqueue webhook log ${log.id}: ${error?.message || 'Unknown error'}`,
          error?.stack,
        );

        if (!inlineFallback) {
          const endedAt = new Date();
          const receiveDurationMs = endedAt.getTime() - receivedAt.getTime();
          await this.prisma.pancakeWebhookLog.update({
            where: { id: log.id },
            data: {
              receiveHttpStatus: 503,
              receiveStatus: 'FAILED',
              processStatus: 'FAILED',
              relayStatus: 'SKIPPED',
              errorCode: 'QUEUE_UNAVAILABLE',
              errorMessage: this.truncateMessage(error?.message || 'Webhook queue unavailable'),
              warningCount: 1,
              processedAt: endedAt,
              receiveDurationMs,
              totalDurationMs: receiveDurationMs,
            },
          });
          throw new ServiceUnavailableException('Webhook queue unavailable');
        }
      }
    }

    const processingStartedAt = new Date();
    await this.prisma.pancakeWebhookLog.update({
      where: { id: log.id },
      data: {
        receiveHttpStatus: 202,
        receiveStatus: 'ACCEPTED',
        processStatus: 'PROCESSING',
        processingStartedAt,
        attempts: 1,
        queueJobId: inlinePreferred ? 'inline' : 'inline_fallback',
      },
    });

    try {
      const result = await this.processPancakeWebhookPayload(
        tenant,
        safePayload,
        requestId,
        log.id,
      );
      const queueFallbackWarning = inlinePreferred
        ? null
        : 'Queue enqueue failed; processed inline fallback';
      const allWarnings = queueFallbackWarning
        ? [queueFallbackWarning, ...result.warnings]
        : result.warnings;
      const processedAt = new Date();
      const receiveDurationMs = processingStartedAt.getTime() - receivedAt.getTime();
      const processingDurationMs = processedAt.getTime() - processingStartedAt.getTime();
      const finalProcessStatus = this.mapFinalProcessStatus(
        result.upserted,
        result.outcomes,
        allWarnings,
      );

      await this.persistWebhookOrderOutcomes(log.id, result.outcomes);

      await this.prisma.pancakeWebhookLog.update({
        where: { id: log.id },
        data: {
          processStatus: finalProcessStatus,
          relayStatus: result.relayStatus,
          upsertedCount: result.upserted,
          warningCount: allWarnings.length,
          reconcileQueuedCount: result.reconcileQueuedCount,
          reconcileSkippedCount: result.reconcileSkippedCount,
          errorCode: finalProcessStatus === 'FAILED' ? 'INLINE_PROCESS_FAILED' : null,
          errorMessage:
            allWarnings.length > 0 ? this.truncateMessage(allWarnings.join(' | ')) : null,
          processedAt,
          receiveDurationMs,
          processingDurationMs,
          totalDurationMs: receiveDurationMs + processingDurationMs,
        },
      });

      return {
        accepted: true,
        queued: false,
        eventId: log.id,
        requestId,
        receivedAt: log.receivedAt.toISOString(),
        message:
          allWarnings.length > 0
            ? 'Webhook received with inline processing warning'
            : 'Webhook received and upserted',
        upserted: result.upserted,
        warning: allWarnings.length > 0 ? allWarnings.join(' | ') : null,
      };
    } catch (error: any) {
      const processedAt = new Date();
      const receiveDurationMs = processingStartedAt.getTime() - receivedAt.getTime();
      const processingDurationMs = processedAt.getTime() - processingStartedAt.getTime();

      await this.prisma.pancakeWebhookLog.update({
        where: { id: log.id },
        data: {
          receiveStatus: 'FAILED',
          processStatus: 'FAILED',
          relayStatus: 'FAILED',
          errorCode: 'INLINE_PROCESS_EXCEPTION',
          errorMessage: this.truncateMessage(error?.message || 'Unknown processing error'),
          warningCount: 1,
          processedAt,
          receiveDurationMs,
          processingDurationMs,
          totalDurationMs: receiveDurationMs + processingDurationMs,
        },
      });

      throw error;
    }
  }

  /**
   * Build an access-aware where clause for integrations, respecting team scope and sharing.
   */
  private async buildIntegrationAccessWhere(additional: any = {}) {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];
    const restrictAdminToScope = isAdmin && allowedTeams.length > 0;
    const base: any = { tenantId, ...additional };

    if (!tenantHasTeams) {
      return { where: base, tenantId, allowedTeams: [], tenantHasTeams };
    }

    // A user on no team is scoped to the tenant, not to a team: they see every
    // integration in it. This is deliberately WIDER than a team member's view,
    // whose scope is unchanged. Permissions still gate what they can do.
    if (!isAdmin && allowedTeams.length === 0) {
      return { where: base, tenantId, allowedTeams, tenantHasTeams };
    }

    if (isAdmin && !restrictAdminToScope) {
      return { where: base, tenantId, allowedTeams, tenantHasTeams };
    }

    if (allowedTeams.length === 0) {
      return { where: base, tenantId, allowedTeams, tenantHasTeams };
    }

    return {
      tenantId,
      allowedTeams,
      tenantHasTeams,
      where: {
        ...base,
        OR: [
          { teamId: { in: allowedTeams } },
          { sharedTeams: { some: { teamId: { in: allowedTeams } } } },
        ],
      },
    };
  }


  /**
   * Create a new integration for the current tenant
   */
  async create(createIntegrationDto: CreateIntegrationDto): Promise<IntegrationResponseDto> {
    const { tenantId } = await this.teamContext.getContext();
    const { name, provider, description, credentials, config, teamId: payloadTeamId, sharedTeamIds } =
      createIntegrationDto;

    // Validate and get effective team ID - restricts non-admins to their teams only
    const effectiveTeamId = await this.teamContext.validateAndGetTeamId(payloadTeamId);

    // Get tenant's encryption key
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // For PANCAKE_POS, check for duplicate API keys/shop IDs
    // For META_ADS, allow multiple integrations (different access tokens)
    if (provider === 'PANCAKE_POS') {
      const apiKey = credentials?.apiKey;
      const shopId = config?.shopId?.toString();

      if (apiKey) {
        const existingStore = await this.prisma.posStore.findFirst({
          where: {
            tenantId,
            ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
            apiKey,
          },
        });

        if (existingStore) {
          throw new ConflictException('Store with this API key already exists for this tenant');
        }
      }

      if (shopId) {
        await this.posShopOwnershipService.assertShopCanBeRegistered(tenantId, shopId);

        const existingStoreByShop = await this.prisma.posStore.findFirst({
          where: {
            tenantId,
            ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
            shopId,
          },
        });

        if (existingStoreByShop) {
          throw new ConflictException('Store with this shop ID already exists for this tenant');
        }
      }
    }

    // Derive a friendly name for Meta based on /me if available
    let finalName = name;
    if (provider === 'META_ADS' && credentials?.accessToken) {
      try {
        const meRes = await fetch(
          `https://graph.facebook.com/v23.0/me?fields=name&access_token=${credentials.accessToken}`,
        );
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData?.name) {
            finalName = meData.name;
          }
        }
      } catch {
        // Ignore and fall back to provided name
      }
    }

    // Encrypt credentials
    const encryptedCredentials = this.encryptionService.encrypt(credentials, tenant.encryptionKey);

    // Validate shared team ids (same tenant)
    const validSharedIds =
      Array.isArray(sharedTeamIds) && sharedTeamIds.length > 0
        ? (
            await this.prisma.team.findMany({
              where: { tenantId, id: { in: sharedTeamIds } },
              select: { id: true },
            })
          ).map((t) => t.id)
        : [];

    // Create integration with shared teams
    const integration = await this.prisma.$transaction(async (tx) => {
      const created = await tx.integration.create({
        data: {
          name: finalName,
          provider,
          description,
          credentials: encryptedCredentials,
          config: config || {},
          tenantId,
          teamId: effectiveTeamId,
          status: 'ACTIVE',
          enabled: false,
          sharedTeams:
            validSharedIds.length > 0
              ? {
                  createMany: {
                    data: validSharedIds.map((tid) => ({ teamId: tid })),
                    skipDuplicates: true,
                  },
                }
              : undefined,
        },
        include: { sharedTeams: true },
      });
      return created;
    });

    // Create POS store record for Pancake POS
    if (provider === 'PANCAKE_POS') {
      await this.prisma.posStore.create({
        data: {
          tenantId,
          teamId: effectiveTeamId,
          integrationId: integration.id,
          name,
          shopId: config?.shopId?.toString() || '',
          shopName: config?.shopName || name,
          shopAvatarUrl: config?.shopAvatarUrl || null,
          apiKey: credentials?.apiKey || '',
          description,
          status: 'ACTIVE',
          enabled: null,
        },
      });
    }

    // Auto-fetch data after creation (best-effort, don't fail the creation)
    try {
      if (provider === 'META_ADS') {
        await this.syncMetaAdAccounts(integration.id);
        this.logger.log(`Auto-synced Meta ad accounts for integration ${integration.id}`);
      } else if (provider === 'PANCAKE_POS') {
        await this.fetchPancakeProductsByIntegrationId(integration.id);
        this.logger.log(`Auto-fetched POS products for integration ${integration.id}`);
        const linkedStore = await this.prisma.posStore.findFirst({
          where: {
            tenantId,
            integrationId: integration.id,
          },
          select: { id: true },
        });
        if (linkedStore) {
          const tagsResult = await this.syncPancakeTagsByStoreId(linkedStore.id);
          this.logger.log(
            `Auto-synced POS tags for integration ${integration.id} (synced=${tagsResult.synced})`,
          );
          const warehousesResult = await this.syncPancakeWarehousesByStoreId(linkedStore.id);
          this.logger.log(
            `Auto-synced POS warehouses for integration ${integration.id} (synced=${warehousesResult.synced})`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Auto-fetch after integration creation failed for ${integration.id}: ${error.message}`,
      );
    }

    return new IntegrationResponseDto(integration);
  }

  /**
   * Bulk import POS integrations from a list of API keys.
   * For each key, discovers shops via Pancake API, creates integration + store, and auto-fetches products.
   */
  async bulkCreatePosIntegrations(dto: BulkCreatePosIntegrationDto, tenantIdOverride?: string) {
    const context = tenantIdOverride ? null : await this.teamContext.getContext();
    const tenantId = tenantIdOverride ?? context!.tenantId;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    const effectiveTeamId = tenantIdOverride
      ? null
      : await this.teamContext.validateAndGetTeamId(dto.teamId);

    // Validate shared team ids
    const validSharedIds =
      !tenantIdOverride && Array.isArray(dto.sharedTeamIds) && dto.sharedTeamIds.length > 0
        ? (
            await this.prisma.team.findMany({
              where: { tenantId, id: { in: dto.sharedTeamIds } },
              select: { id: true },
            })
          ).map((t) => t.id)
        : [];

    const results: any[] = [];

    for (const entry of dto.integrations) {
      const maskedKey = entry.apiKey.length > 8
        ? entry.apiKey.slice(0, 4) + '...' + entry.apiKey.slice(-4)
        : '****';

      // 1. Discover shops from this API key
      let shops: any[];
      try {
        const response = await fetch(
          `https://pos.pages.fm/api/v1/shops?api_key=${entry.apiKey}`,
        );

        if (!response.ok) {
          results.push({ status: 'failed', apiKey: maskedKey, reason: `API returned ${response.status}` });
          continue;
        }

        const data = await response.json();
        if (!data.success || !Array.isArray(data.shops) || data.shops.length === 0) {
          results.push({ status: 'failed', apiKey: maskedKey, reason: 'No shops found for this API key' });
          continue;
        }

        shops = data.shops;
      } catch (error) {
        results.push({ status: 'failed', apiKey: maskedKey, reason: error.message });
        continue;
      }

      // 2. Create integration + store for each shop
      for (const shop of shops) {
        const shopId = shop.id?.toString() || '';
        const shopName = shop.name || 'Unnamed Shop';
        const shopAvatarUrl = shop.avatar_url || null;

        try {
          await this.posShopOwnershipService.assertShopCanBeRegistered(tenantId, shopId);
        } catch (error: any) {
          results.push({
            status: 'skipped',
            apiKey: maskedKey,
            shopId,
            shopName,
            reason: error?.message || 'Shop is active under another partner',
          });
          continue;
        }

        // Duplicate check: shopId
        const existingByShopId = await this.prisma.posStore.findFirst({
          where: { tenantId, shopId },
        });
        if (existingByShopId) {
          results.push({ status: 'skipped', apiKey: maskedKey, shopId, shopName, reason: 'Shop ID already exists' });
          continue;
        }

        // Duplicate check: apiKey
        const existingByApiKey = await this.prisma.posStore.findFirst({
          where: {
            tenantId,
            apiKey: entry.apiKey,
            shopId,
          },
        });
        if (existingByApiKey) {
          results.push({ status: 'skipped', apiKey: maskedKey, shopId, shopName, reason: 'API key + shop already exists' });
          continue;
        }

        try {
          const encryptedCredentials = this.encryptionService.encrypt(
            { apiKey: entry.apiKey },
            tenant.encryptionKey,
          );

          // Create integration with shared teams
          const integration = await this.prisma.$transaction(async (tx) => {
            const created = await tx.integration.create({
              data: {
                name: shopName,
                provider: 'PANCAKE_POS',
                credentials: encryptedCredentials,
                config: { shopId, shopName, shopAvatarUrl },
                tenantId,
                teamId: effectiveTeamId,
                status: 'ACTIVE',
                enabled: false,
                sharedTeams:
                  validSharedIds.length > 0
                    ? {
                        createMany: {
                          data: validSharedIds.map((tid) => ({ teamId: tid })),
                          skipDuplicates: true,
                        },
                      }
                    : undefined,
              },
            });
            return created;
          });

          // Create POS store
          const createdStore = await this.prisma.posStore.create({
            data: {
              tenantId,
              teamId: effectiveTeamId,
              integrationId: integration.id,
              name: shopName,
              shopId,
              shopName,
              shopAvatarUrl,
              apiKey: entry.apiKey,
              status: 'ACTIVE',
              enabled: null,
            },
          });

          // Auto-fetch products (best-effort)
          try {
            await this.syncPancakeProductsByStoreId(createdStore.id, tenantId);
            await this.syncPancakeTagsByStoreId(createdStore.id, tenantId);
            await this.syncPancakeWarehousesByStoreId(createdStore.id, tenantId);
          } catch (fetchError) {
            this.logger.warn(
              `Bulk import: product/tag/warehouse fetch failed for integration ${integration.id}: ${fetchError.message}`,
            );
          }

          results.push({
            status: 'created',
            apiKey: maskedKey,
            shopId,
            shopName,
            integrationId: integration.id,
          });
        } catch (error) {
          results.push({ status: 'failed', apiKey: maskedKey, shopId, shopName, reason: error.message });
        }
      }
    }

    const created = results.filter((r) => r.status === 'created').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return {
      summary: { total: results.length, created, skipped, failed },
      results,
    };
  }

  /**
   * Get all integrations for the current tenant
   * Non-admins only see integrations from their teams
   */
  async findAll(
    params: ListIntegrationsDto,
  ): Promise<IntegrationResponseDto[]> {
    const { search } = params || {};

    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    let baseWhere: any = { tenantId };
    const shouldRestrictAdminToScope = isAdmin && allowedTeams.length > 0;
    if (tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || shouldRestrictAdminToScope)) {
      if (allowedTeams.length === 0) {
        // Teamless: tenant-scoped, no team restriction.
        baseWhere = { tenantId };
      } else {
        baseWhere = {
          tenantId,
          OR: [
            { teamId: { in: allowedTeams } },
            { sharedTeams: { some: { teamId: { in: allowedTeams } } } },
          ],
        };
      }
    }

    let where: any = baseWhere;
    if (search) {
      const searchFilter = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { provider: { contains: search, mode: 'insensitive' } },
        ],
      };
      where = { AND: [baseWhere, searchFilter] };
    }

    const rows = await this.prisma.integration.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { sharedTeams: true },
    });

    return rows.map((integration) => new IntegrationResponseDto(integration));
  }

  async listPosStores(
    params: ListPosStoresDto,
  ): Promise<any[]> {
    const { search } = params || {};

    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    // Admins with no scope see all; otherwise restrict to owned or shared integrations
    let where: any = { tenantId };
    // A teamless user is tenant-scoped, so no team restriction applies.
    const shouldRestrict = tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || (isAdmin && allowedTeams.length > 0));
    if (shouldRestrict) {
      where = {
        tenantId,
        OR: [
          { teamId: { in: allowedTeams } },
          // Integration owned by allowed teams
          { integration: { teamId: { in: allowedTeams } } },
          // Integration shared to allowed teams
          { integration: { sharedTeams: { some: { teamId: { in: allowedTeams } } } } },
        ],
      };
    }

    if (search) {
      const s = search.trim();
      if (s.length > 0) {
        const searchFilter = {
          OR: [
            { name: { contains: s, mode: 'insensitive' } },
            { shopName: { contains: s, mode: 'insensitive' } },
            { shopId: { contains: s, mode: 'insensitive' } },
            { description: { contains: s, mode: 'insensitive' } },
          ],
        };
        where = { AND: [where, searchFilter] };
      }
    }

    return this.prisma.posStore.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { integration: { include: { sharedTeams: true } } },
    });
  }

  async getPosStore(id: string) {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    // Admins with no scope see all; otherwise restrict to owned or shared integrations
    let where: any = { id, tenantId };
    // A teamless user is tenant-scoped, so no team restriction applies.
    const shouldRestrict = tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || (isAdmin && allowedTeams.length > 0));
    if (shouldRestrict) {
      // No team means no team-owned records to match; the null-team branch in
      // the filter below is what such a user can legitimately reach.

      where = {
        id,
        tenantId,
        OR: [
          { teamId: { in: allowedTeams } },
          { integration: { teamId: { in: allowedTeams } } },
          { integration: { sharedTeams: { some: { teamId: { in: allowedTeams } } } } },
        ],
      };
    }

    const store = await this.prisma.posStore.findFirst({
      where,
      include: { integration: { include: { sharedTeams: true } } },
    });

    if (!store) {
      throw new NotFoundException(`Store with ID ${id} not found`);
    }

    return store;
  }

  async updatePosStore(id: string, dto: UpdatePosStoreDto) {
    const store = await this.getPosStore(id);

    const initialValueOffer =
      dto.initialValueOffer === undefined ? undefined : dto.initialValueOffer;

    return this.prisma.posStore.update({
      where: { id: store.id },
      data: {
        ...(initialValueOffer !== undefined
          ? { initialValueOffer: initialValueOffer === null ? null : initialValueOffer }
          : {}),
      },
    });
  }

  async claimPosShopOwnership(id: string, dto: ClaimPosShopOwnershipDto) {
    const role = this.cls.get('userRole');
    const userId = this.cls.get('userId');
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Only a super administrator can move active POS shop ownership between partners',
      );
    }

    return this.posShopOwnershipService.claimShopOwnership({
      storeId: id,
      claimedById: userId || null,
      reason: dto.reason || null,
    });
  }

  async transferOpenPosOrders(id: string, dto: TransferOpenPosOrdersDto) {
    const role = this.cls.get('userRole');
    const userId = this.cls.get('userId');
    if (role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Only a super administrator can transfer open POS orders between partners',
      );
    }

    return this.posShopOwnershipService.transferOpenOrders({
      sourceStoreId: dto.sourceStoreId,
      targetStoreId: id,
      requestedById: userId || null,
      reason: dto.reason || null,
      dryRun: dto.dryRun,
    });
  }

  async listPosStoreProducts(id: string) {
    const store = await this.getPosStore(id); // validates access including shared integrations

    return this.prisma.posProduct.findMany({
      where: { storeId: store.id },
      orderBy: { name: 'asc' },
    });
  }

  async listPosStoreTags(id: string) {
    const store = await this.getPosStore(id); // validates access including shared integrations
    const { tenantId } = await this.teamContext.getContext();

    return this.prisma.posTag.findMany({
      where: {
        tenantId,
        storeId: store.id,
      },
      orderBy: [
        { groupName: 'asc' },
        { name: 'asc' },
      ],
    });
  }

  async listPosStoreWarehouses(id: string) {
    const store = await this.getPosStore(id); // validates access including shared integrations

    return this.prisma.posWarehouse.findMany({
      where: { storeId: store.id },
      orderBy: { name: 'asc' },
    });
  }

  async listPosGeoProvinces(countryCodeRaw: string | number = '63') {
    const countryCode = this.normalizeGeoCountryCode(countryCodeRaw);
    const cacheVersion = await this.getGeoCacheVersion();
    const cacheKey = `pos_geo:${cacheVersion}:provinces:${countryCode}`;
    const cached = await this.getGeoCacheValue<{
      country_code: number;
      items: Array<{
        id: string;
        name: string;
        name_en: string | null;
        new_id: string | null;
        region_type: string | null;
      }>;
      total: number;
    }>(cacheKey);
    if (cached) return cached;

    const rows = await this.prisma.posProvince.findMany({
      where: { countryCode },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        countryCode: true,
        name: true,
        nameEn: true,
        newId: true,
        regionType: true,
      },
    });

    const response = {
      country_code: countryCode,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        name_en: row.nameEn,
        new_id: row.newId,
        region_type: row.regionType,
      })),
      total: rows.length,
    };
    await this.setGeoCacheValue(cacheKey, response);
    return response;
  }

  async listPosGeoDistricts(provinceIdRaw: string) {
    const provinceId = provinceIdRaw?.toString?.().trim?.() || '';
    if (!provinceId) {
      throw new BadRequestException('province_id is required');
    }

    const cacheVersion = await this.getGeoCacheVersion();
    const cacheKey = `pos_geo:${cacheVersion}:districts:${provinceId}`;
    const cached = await this.getGeoCacheValue<{
      country_code: number;
      province_id: string;
      province_name: string;
      items: Array<{
        id: string;
        name: string;
        name_en: string | null;
        postcode: Prisma.JsonValue | null;
      }>;
      total: number;
    }>(cacheKey);
    if (cached) return cached;

    const province = await this.prisma.posProvince.findUnique({
      where: { id: provinceId },
      select: {
        id: true,
        countryCode: true,
        name: true,
      },
    });

    if (!province) {
      throw new NotFoundException('Province not found');
    }

    const rows = await this.prisma.posDistrict.findMany({
      where: { provinceId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        provinceId: true,
        name: true,
        nameEn: true,
        postcode: true,
      },
    });

    const response = {
      country_code: province.countryCode,
      province_id: province.id,
      province_name: province.name,
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        name_en: row.nameEn,
        postcode: row.postcode,
      })),
      total: rows.length,
    };
    await this.setGeoCacheValue(cacheKey, response);
    return response;
  }

  async listPosGeoCommunes(provinceIdRaw: string, districtIdRaw?: string) {
    const provinceId = provinceIdRaw?.toString?.().trim?.() || '';
    if (!provinceId) {
      throw new BadRequestException('province_id is required');
    }

    const districtId = districtIdRaw?.toString?.().trim?.() || undefined;
    const cacheVersion = await this.getGeoCacheVersion();
    const cacheKey = `pos_geo:${cacheVersion}:communes:${provinceId}:${districtId || 'all'}`;
    const cached = await this.getGeoCacheValue<{
      country_code: number;
      province_id: string;
      province_name: string;
      district_id: string | null;
      items: Array<{
        id: string;
        district_id: string;
        name: string;
        name_en: string | null;
        new_id: string | null;
        postcode: Prisma.JsonValue | null;
      }>;
      total: number;
    }>(cacheKey);
    if (cached) return cached;

    const province = await this.prisma.posProvince.findUnique({
      where: { id: provinceId },
      select: {
        id: true,
        countryCode: true,
        name: true,
      },
    });

    if (!province) {
      throw new NotFoundException('Province not found');
    }

    if (districtId) {
      const district = await this.prisma.posDistrict.findUnique({
        where: { id: districtId },
        select: {
          id: true,
          provinceId: true,
        },
      });
      if (!district || district.provinceId !== provinceId) {
        throw new BadRequestException('district_id does not belong to province_id');
      }
    }

    const rows = await this.prisma.posCommune.findMany({
      where: {
        provinceId,
        ...(districtId ? { districtId } : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        provinceId: true,
        districtId: true,
        name: true,
        nameEn: true,
        newId: true,
        postcode: true,
      },
    });

    const response = {
      country_code: province.countryCode,
      province_id: province.id,
      province_name: province.name,
      district_id: districtId || null,
      items: rows.map((row) => ({
        id: row.id,
        district_id: row.districtId,
        name: row.name,
        name_en: row.nameEn,
        new_id: row.newId,
        postcode: row.postcode,
      })),
      total: rows.length,
    };
    await this.setGeoCacheValue(cacheKey, response);
    return response;
  }

  async syncPancakeGeoData(countryCodeRaw: string | number = '63', force = false) {
    const countryCode = this.normalizeGeoCountryCode(countryCodeRaw);

    const existingProvinces = await this.prisma.posProvince.findMany({
      where: { countryCode },
      select: { id: true },
    });
    const existingProvinceIds = existingProvinces.map((row) => row.id);

    if (!force && existingProvinceIds.length > 0) {
      const [districtCount, communeCount] = await this.prisma.$transaction([
        this.prisma.posDistrict.count({
          where: { provinceId: { in: existingProvinceIds } },
        }),
        this.prisma.posCommune.count({
          where: { provinceId: { in: existingProvinceIds } },
        }),
      ]);

      return {
        country_code: countryCode,
        synced: false,
        skipped: true,
        reason: 'ALREADY_SYNCED',
        message: 'Geo data already exists. Use force=true to refresh.',
        provinces: existingProvinceIds.length,
        districts: districtCount,
        communes: communeCount,
      };
    }

    const provinces = await this.fetchGeoProvincesFromPancake(countryCode);
    const provinceIdSet = new Set(provinces.map((row) => row.id));
    const districtMap = new Map<string, PancakeGeoDistrict>();
    const communeMap = new Map<string, PancakeGeoCommune>();
    let requestCount = 1; // provinces request

    for (const province of provinces) {
      const [districts, communes] = await Promise.all([
        this.fetchGeoDistrictsFromPancake(province.id),
        this.fetchGeoCommunesFromPancake(province.id),
      ]);
      requestCount += 2;

      for (const district of districts) {
        if (!provinceIdSet.has(district.provinceId)) continue;
        districtMap.set(district.id, district);
      }

      for (const commune of communes) {
        if (!provinceIdSet.has(commune.provinceId)) continue;
        communeMap.set(commune.id, commune);
      }
    }

    const districts = Array.from(districtMap.values());
    const districtIdSet = new Set(districts.map((row) => row.id));
    const communes = Array.from(communeMap.values()).filter((row) => districtIdSet.has(row.districtId));
    const skippedCommunes = communeMap.size - communes.length;

    await this.prisma.$transaction(
      async (tx) => {
        if (existingProvinceIds.length > 0) {
          await tx.posCommune.deleteMany({
            where: { provinceId: { in: existingProvinceIds } },
          });
          await tx.posDistrict.deleteMany({
            where: { provinceId: { in: existingProvinceIds } },
          });
          await tx.posProvince.deleteMany({
            where: { id: { in: existingProvinceIds } },
          });
        }

        for (const chunk of this.chunkRows(provinces, 200)) {
          await tx.posProvince.createMany({
            data: chunk.map((row) => ({
              id: row.id,
              countryCode: row.countryCode,
              name: row.name,
              nameEn: row.nameEn,
              newId: row.newId,
              regionType: row.regionType,
            })),
            skipDuplicates: true,
          });
        }

        for (const chunk of this.chunkRows(districts, 1000)) {
          await tx.posDistrict.createMany({
            data: chunk.map((row) => ({
              id: row.id,
              provinceId: row.provinceId,
              name: row.name,
              nameEn: row.nameEn,
              ...(row.postcode !== undefined ? { postcode: row.postcode } : {}),
            })),
            skipDuplicates: true,
          });
        }

        for (const chunk of this.chunkRows(communes, 1000)) {
          await tx.posCommune.createMany({
            data: chunk.map((row) => ({
              id: row.id,
              provinceId: row.provinceId,
              districtId: row.districtId,
              name: row.name,
              nameEn: row.nameEn,
              newId: row.newId,
              ...(row.postcode !== undefined ? { postcode: row.postcode } : {}),
            })),
            skipDuplicates: true,
          });
        }
      },
      {
        timeout: 240000,
        maxWait: 10000,
      },
    );

    const [provinceCount, districtCount, communeCount] = await this.prisma.$transaction([
      this.prisma.posProvince.count({ where: { countryCode } }),
      this.prisma.posDistrict.count({ where: { province: { countryCode } } }),
      this.prisma.posCommune.count({ where: { province: { countryCode } } }),
    ]);

    await this.bumpGeoCacheVersion();

    return {
      country_code: countryCode,
      synced: true,
      skipped: false,
      force,
      requests_made: requestCount,
      provinces: provinceCount,
      districts: districtCount,
      communes: communeCount,
      skipped_communes_missing_district: skippedCommunes,
    };
  }

  async syncPancakeTagsByStoreId(storeId: string, tenantIdOverride?: string) {
    const store = tenantIdOverride
      ? await this.prisma.posStore.findFirst({
          where: {
            id: storeId,
            tenantId: tenantIdOverride,
          },
        })
      : await this.getPosStore(storeId); // validates access including shared integrations
    const tenantId = tenantIdOverride ?? (await this.teamContext.getContext()).tenantId;

    if (!store) {
      throw new NotFoundException(`Store with ID ${storeId} not found`);
    }

    const apiKey = await this.resolveStoreApiKeyForWebhook(tenantId, {
      id: store.id,
      integrationId: store.integrationId,
      apiKey: store.apiKey,
    });

    if (!apiKey) {
      throw new ConflictException('Missing API key for this store');
    }

    const tags = await this.fetchTagsFromPancake(store.shopId, apiKey);
    await this.upsertStoreTags(
      { id: store.id, tenantId, teamId: store.teamId ?? null },
      tags,
    );

    const grouped = tags.filter((tag) => !!tag.groupId).length;
    const individual = tags.length - grouped;

    return {
      synced: tags.length,
      grouped,
      individual,
      storeId: store.id,
      shopId: store.shopId,
    };
  }

  async syncPancakeWarehousesByStoreId(storeId: string, tenantIdOverride?: string) {
    const store = tenantIdOverride
      ? await this.prisma.posStore.findFirst({
          where: {
            id: storeId,
            tenantId: tenantIdOverride,
          },
        })
      : await this.getPosStore(storeId); // validates access including shared integrations
    const tenantId = tenantIdOverride ?? (await this.teamContext.getContext()).tenantId;

    if (!store) {
      throw new NotFoundException(`Store with ID ${storeId} not found`);
    }

    const apiKey = await this.resolveStoreApiKeyForWebhook(tenantId, {
      id: store.id,
      integrationId: store.integrationId,
      apiKey: store.apiKey,
    });

    if (!apiKey) {
      throw new ConflictException('Missing API key for this store');
    }

    const warehouses = await this.fetchWarehousesFromPancake(store.shopId, apiKey);
    await this.upsertStoreWarehouses(store.id, warehouses);

    return {
      synced: warehouses.length,
      storeId: store.id,
      shopId: store.shopId,
    };
  }

  async listPosStoreOrders(id: string, dateFrom?: string, dateTo?: string) {
    const store = await this.getPosStore(id); // validates access including shared integrations
    const { tenantId } = await this.teamContext.getContext();

    const where: any = {
      tenantId,
      shopId: store.shopId,
    };

    // Do not further restrict by team here; store access has already been validated

    if (dateFrom || dateTo) {
      where.dateLocal = {};
      if (dateFrom) where.dateLocal.gte = dateFrom;
      if (dateTo) where.dateLocal.lte = dateTo;
    }

    return this.prisma.posOrder.findMany({
      where,
      orderBy: [{ dateLocal: 'desc' }, { insertedAt: 'desc' }],
    });
  }

  async bulkUpdateProductMapping(storeId: string, productIds: string[], mapping: string) {
    const store = await this.getPosStore(storeId); // validates access including shared integrations

    // Update all products in the list
    const result = await this.prisma.posProduct.updateMany({
      where: {
        id: { in: productIds },
        storeId: store.id,
      },
      data: {
        mapping,
      },
    });

    return {
      success: true,
      updated: result.count,
      message: `Updated ${result.count} product(s)`,
    };
  }

  async bulkUpdateProductCogs(storeId: string, productIds: string[], cogs: number) {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      throw new BadRequestException('productIds must contain at least one product');
    }

    assertValidProductCogs(cogs);

    const store = await this.getPosStore(storeId); // validates access including shared integrations
    const uniqueProductIds = Array.from(
      new Set(productIds.filter((value) => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())),
    );

    if (uniqueProductIds.length === 0) {
      throw new BadRequestException('productIds must contain valid product IDs');
    }

    return this.prisma.$transaction(async (tx) => {
      const products: LockedCogsProduct[] = [];
      const failedProducts: Array<{ id: string; name: null; productId: null; customId: null; reason: string }> = [];
      // Every writer locks parents before reading history. A stable order also
      // prevents two overlapping bulk edits from taking opposite parent locks.
      for (const productId of [...uniqueProductIds].sort()) {
        const product = await this.lockCogsProduct(tx, productId, store);
        if (product) products.push(product);
        else failedProducts.push({ id: productId, name: null, productId: null, customId: null, reason: 'Product not found in this store' });
      }
      if (products.length === 0) throw new NotFoundException('No matching products found in this store');
      const today = await this.productCogsToday(tx);
      const newProducts: Array<{ id: string; name: string; productId: string; customId: string | null }> = [];
      const updatedProducts: typeof newProducts = [];
      for (const product of products) {
        const result = await this.writeCurrentProductCogs(tx, product, store, cogs, today);
        const summary = { id: product.id, name: product.name, productId: product.productId, customId: product.customId };
        (result.hadHistory ? updatedProducts : newProducts).push(summary);
      }
      await this.wmsCogsSync.syncAfterErpWrites(tx, store, products.map(p => p.id), (this.cls.get('userId') as string | undefined) ?? null);
      await this.productCogsRefresh.enqueue({ tenantId: store.tenantId, storeId: store.id,
        changes: products.map(product => ({ productId: product.id, fromDate: today.toISOString().slice(0, 10), toDate: null })) });
      // A history conflict throws and rolls back the whole bulk operation.
      return {
        success: true, updated: updatedProducts.length, created: newProducts.length,
        processed: products.length, requested: uniqueProductIds.length, matched: products.length,
        summary: { new: newProducts, updated: updatedProducts, failed: failedProducts },
        message: `Processed ${products.length} product(s)`,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });
  }

  async checkPosDuplicate(apiKey?: string, shopId?: string) {
    const { tenantId } = await this.teamContext.getContext();
    const where = await this.teamContext.buildTeamWhereClause();

    if (!tenantId || !uuidValidate(tenantId)) {
      throw new ForbiddenException('Tenant context is required');
    }

    if (apiKey) {
      const existingApiKey = await this.prisma.posStore.findFirst({
        where: {
          ...where,
          apiKey,
        },
        select: { id: true, shopName: true },
      });

      if (existingApiKey) {
        return {
          duplicate: true,
          reason: 'Store with this API key already exists for this tenant',
        };
      }
    }

    if (shopId) {
      const ownership = await this.prisma.posShopOwnership.findUnique({
        where: { shopId: shopId.trim() },
        select: { tenantId: true },
      });
      if (ownership && ownership.tenantId !== tenantId) {
        return {
          duplicate: true,
          reason: 'This shop is actively owned by another partner',
        };
      }

      const existingShop = await this.prisma.posStore.findFirst({
        where: {
          ...where,
          shopId,
        },
        select: { id: true, shopName: true },
      });

      if (existingShop) {
        return {
          duplicate: true,
          reason: 'Store with this shop ID already exists for this tenant',
        };
      }
    }

    return { duplicate: false };
  }


  /**
   * Get a single integration by ID
   */
  async findOne(id: string): Promise<IntegrationResponseDto> {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    const where: any = { id, tenantId };
    const shouldRestrictAdminToScope = isAdmin && allowedTeams.length > 0;
    if (tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || shouldRestrictAdminToScope)) {
      // No team means no team-owned records to match; the null-team branch in
      // the filter below is what such a user can legitimately reach.

      where.OR = [
        { teamId: { in: allowedTeams } },
        { sharedTeams: { some: { teamId: { in: allowedTeams } } } },
      ];
    }

    const integration = await this.prisma.integration.findFirst({
      where,
      include: { sharedTeams: true },
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    return new IntegrationResponseDto(integration);
  }

  /**
   * Update an integration
   */
  async update(id: string, updateIntegrationDto: UpdateIntegrationDto): Promise<IntegrationResponseDto> {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    const where: any = { id, tenantId };
    const shouldRestrictAdminToScope = isAdmin && allowedTeams.length > 0;
    if (tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || shouldRestrictAdminToScope)) {
      // No team means no team-owned records to match; the null-team branch in
      // the filter below is what such a user can legitimately reach.

      where.OR = [
        { teamId: { in: allowedTeams } },
        { sharedTeams: { some: { teamId: { in: allowedTeams } } } },
      ];
    }

    // Verify integration exists and user has access to it
    const existingIntegration = await this.prisma.integration.findFirst({
      where,
      include: { sharedTeams: true },
    });

    if (!existingIntegration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    const { name, description, credentials, config, enabled, teamId: payloadTeamId, sharedTeamIds } =
      updateIntegrationDto;

    // Validate and get effective team ID - restricts non-admins to their teams only
    const effectiveTeamId = await this.teamContext.validateAndGetTeamId(payloadTeamId);

    // Prepare update data
    const updateData: any = {
      ...(name && { name }),
      ...(description !== undefined && { description }),
      ...(config && { config }),
      ...(enabled !== undefined && { enabled }),
      teamId: effectiveTeamId,
    };

    // If credentials are being updated, encrypt them
    if (credentials) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { encryptionKey: true },
      });

      if (!tenant) {
        throw new NotFoundException('Tenant not found');
      }

      updateData.credentials = this.encryptionService.encrypt(
        credentials,
        tenant.encryptionKey,
      );
    }

    // Validate shared team ids (same tenant)
    const validSharedIds =
      Array.isArray(sharedTeamIds) && sharedTeamIds.length > 0
        ? (
            await this.prisma.team.findMany({
              where: { tenantId, id: { in: sharedTeamIds } },
              select: { id: true },
            })
          ).map((t) => t.id)
        : [];

    const updatedIntegration = await this.prisma.$transaction(async (tx) => {
      await tx.integration.update({
        where: { id },
        data: updateData,
      });

      // Cascade team changes to related records
      if (updateIntegrationDto.teamId !== undefined) {
        await tx.posStore.updateMany({
          where: { integrationId: id },
          data: { teamId: effectiveTeamId },
        });
        await tx.metaAdAccount.updateMany({
          where: { integrationId: id },
          data: { teamId: effectiveTeamId },
        });
      }

      // Sync shared teams if provided
      if (sharedTeamIds !== undefined) {
        // Remove links not in the new list
        await tx.integrationSharedTeam.deleteMany({
          where: {
            integrationId: id,
            ...(validSharedIds.length > 0 ? { teamId: { notIn: validSharedIds } } : {}),
          },
        });
        // Add new links
        if (validSharedIds.length > 0) {
          await tx.integrationSharedTeam.createMany({
            data: validSharedIds.map((tid) => ({ integrationId: id, teamId: tid })),
            skipDuplicates: true,
          });
        } else {
          // If empty array was provided, clear all shares
          await tx.integrationSharedTeam.deleteMany({ where: { integrationId: id } });
        }
      }

      return tx.integration.findUnique({
        where: { id },
        include: { sharedTeams: true },
      });
    });

    return new IntegrationResponseDto(updatedIntegration);
  }

  /**
   * Delete an integration
   */
  async remove(id: string): Promise<void> {
    const { teamIds, userTeams, isAdmin, tenantId, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    let where: any = { id, tenantId };
    const shouldRestrictAdminToScope = isAdmin && allowedTeams.length > 0;
    if (tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || shouldRestrictAdminToScope)) {
      // No team means no team-owned records to match; the null-team branch in
      // the filter below is what such a user can legitimately reach.

      where = {
        ...where,
        OR: [
          { teamId: { in: allowedTeams } },
          { sharedTeams: { some: { teamId: { in: allowedTeams } } } },
        ],
      };
    }

    // Verify integration exists and user has access
    const integration = await this.prisma.integration.findFirst({
      where,
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    await this.prisma.$transaction(async (tx) => {
      if (integration.provider === 'PANCAKE_POS') {
        const stores = await tx.posStore.findMany({
          where: { tenantId, integrationId: id },
          select: { id: true, shopId: true },
        });
        if (stores.length > 0) {
          const shopIds = stores.map((s) => s.shopId).filter(Boolean);
          if (shopIds.length > 0) {
            await tx.posOrder.deleteMany({
              where: { tenantId, shopId: { in: shopIds } },
            });
          }
          await tx.posStore.deleteMany({
            where: { id: { in: stores.map((s) => s.id) } },
          });
        }
      }

      // Delete integration
      await tx.integration.delete({
        where: { id },
      });
    });
  }

  /**
   * Enable an integration
   */
  async enable(id: string): Promise<IntegrationResponseDto> {
    const where = await this.teamContext.buildTeamWhereClause({ id });

    const integration = await this.prisma.integration.findFirst({
      where,
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    const updatedIntegration = await this.prisma.integration.update({
      where: { id },
      data: {
        enabled: true,
        status: 'ACTIVE',
      },
    });

    return new IntegrationResponseDto(updatedIntegration);
  }

  /**
   * Disable an integration
   */
  async disable(id: string): Promise<IntegrationResponseDto> {
    const where = await this.teamContext.buildTeamWhereClause({ id });

    const integration = await this.prisma.integration.findFirst({
      where,
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    const updatedIntegration = await this.prisma.integration.update({
      where: { id },
      data: {
        enabled: false,
        status: 'DISABLED',
      },
    });

    return new IntegrationResponseDto(updatedIntegration);
  }

  private async fetchProductsFromPancake(shopId: string, apiKey: string): Promise<any[]> {
    const baseUrl = `https://pos.pages.fm/api/v1/shops/${shopId}/products`;
    // Provider catalog amounts use the current shop currency (e.g. PHP100).
    // Fetch once per import, not per product, and keep unavailable prices untouched.
    let currency = missingPancakeShopCurrency(shopId, 'SHOP_CURRENCY_FETCH_UNAVAILABLE');
    try {
      const params = new URLSearchParams({ api_key: apiKey });
      const response = await fetch(`https://pos.pages.fm/api/v1/shops?${params}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      currency = resolvePancakeShopCurrency(await readPancakeShopCurrencyResponse(response), shopId);
    } catch {
      // Do not log provider errors/URLs; they can contain the credential.
    }
    if (currency.reason) {
      this.logger.warn(`Catalog price currency unavailable for shop=${shopId}; existing prices will be preserved`);
    }
    const products: any[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const params = new URLSearchParams();
      params.set('api_key', apiKey);
      params.set('page_number', String(page));
      params.append('extra_fields[]', 'retail_price');

      const url = `${baseUrl}?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        throw new ConflictException(errorText || 'Failed to fetch products from Pancake POS');
      }

      const data = await response.json().catch(() => null);
      const apiError = this.extractPancakeProductsApiError(data);
      if (apiError) {
        throw new ConflictException(apiError);
      }

      const envelope = this.extractProductEnvelope(data);
      const pageProducts = this.extractProductRows(data, envelope);
      const mappedProducts = pageProducts
        .map((item: any) => {
          const productId = this.extractProductIdFromPancakeProduct(item);
          const variationId = this.extractVariationIdFromPancakeProduct(item);
          if (!productId) return null;
          const price = normalizePancakeRetailPrice(
            item, { shopId, productId, variationId }, currency, [envelope, envelope?.data],
          );

          return {
            productId,
            variationId,
            warehouseId: this.extractWarehouseIdFromPancakeProduct(item),
            productSnapshot: {
              ...this.extractProductSnapshotFromPancakeProduct(item),
              erpRetailPrice: price.evidence,
            },
            customId:
              item?.custom_id ||
              item?.code ||
              null,
            name:
              item?.name ||
              item?.variation_info?.name ||
              item?.product?.name ||
              'Unnamed product',
            retailPrice: price.retailPrice,
            retailPriceEvidence: price.evidence,
          };
        })
        .filter(Boolean);

      if (pageProducts.length > 0 && mappedProducts.length === 0) {
        this.logger.warn(
          `Pancake products parse produced 0 mapped rows for shop=${shopId} page=${page} rawRows=${pageProducts.length}`,
        );
      }

      products.push(...mappedProducts);

      const currentPageRaw = envelope?.page_number ?? envelope?.pageNumber ?? page;
      const totalPagesRaw = envelope?.total_pages ?? envelope?.totalPages ?? currentPageRaw;
      const currentPage = Math.max(
        1,
        Number.parseInt(currentPageRaw?.toString?.() || `${page}`, 10) || page,
      );
      totalPages = Math.max(
        currentPage,
        Number.parseInt(totalPagesRaw?.toString?.() || `${currentPage}`, 10) || currentPage,
      );
      if (currentPage >= totalPages) {
        break;
      }

      page += 1;
    }

    const unique = new Map<string, any>();
    for (const row of products) {
      const variationId = row?.variationId?.toString?.().trim?.() || '';
      const productId = row?.productId?.toString?.().trim?.() || '';
      const key = variationId || `product:${productId}`;
      if (!key) continue;
      const previous = unique.get(key);
      if (previous && (
        previous.productId !== row.productId ||
        previous.retailPriceEvidence.status !== row.retailPriceEvidence.status ||
        previous.retailPriceEvidence.normalizedAmount !== row.retailPriceEvidence.normalizedAmount
      )) {
        row.retailPrice = null;
        row.retailPriceEvidence = {
          ...row.retailPriceEvidence, status: 'SKIPPED',
          reason: 'DUPLICATE_PROVIDER_VARIATION_PRICE_CONFLICT', normalizedAmount: null,
        };
        row.productSnapshot.erpRetailPrice = row.retailPriceEvidence;
      }
      unique.set(key, row);
    }

    return Array.from(unique.values());
  }

  private extractProductEnvelope(payload: any): any {
    if (!Array.isArray(payload)) {
      return payload ?? {};
    }

    const objectRows = payload.filter((entry: any) => entry && typeof entry === 'object');
    const explicitEnvelope = objectRows.find(
      (entry: any) =>
        entry?.data !== undefined ||
        entry?.products !== undefined ||
        entry?.page_number !== undefined ||
        entry?.total_pages !== undefined,
    );

    return explicitEnvelope ?? {};
  }

  private isPancakeProductLike(value: any): value is Record<string, any> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasIdentity =
      value?.id !== undefined ||
      value?.product_id !== undefined ||
      value?.productId !== undefined ||
      value?.variation_id !== undefined ||
      value?.variationId !== undefined;
    if (!hasIdentity) return false;

    const hasProductSignals =
      value?.product !== undefined ||
      value?.variation_info !== undefined ||
      value?.images !== undefined ||
      value?.retail_price !== undefined ||
      value?.retailPrice !== undefined ||
      value?.barcode !== undefined ||
      value?.remain_quantity !== undefined;

    return !!hasProductSignals;
  }

  private extractProductRows(payload: any, envelope: any): any[] {
    const directRows =
      envelope?.products ??
      envelope?.data?.products ??
      envelope?.data ??
      payload?.products ??
      payload?.data?.products ??
      payload?.data ??
      [];

    const expandedDirectRows = this.expandPancakeProductRows(
      Array.isArray(directRows) ? directRows : [],
    );
    if (
      Array.isArray(expandedDirectRows)
      && expandedDirectRows.some((row) => this.isPancakeProductLike(row))
    ) {
      return expandedDirectRows.filter((row) => this.isPancakeProductLike(row));
    }

    const queue: any[] = [payload, envelope];
    const rows: any[] = [];
    const seen = new Set<object>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }

      if (typeof current !== 'object') continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (this.isPancakeProductLike(current)) {
        // Retain distinct rows for the final conflicting-price check, including
        // duplicate identities; only avoid revisiting the same payload object.
        rows.push(current);
      }

      queue.push(
        current?.body,
        current?.payload,
        current?.result,
        current?.products,
        current?.data,
        current?.items,
        current?.variations,
      );
    }

    const expandedRows = this.expandPancakeProductRows(rows);
    return expandedRows.filter((row) => this.isPancakeProductLike(row));
  }

  private expandPancakeProductRows(rows: any[]): any[] {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const expanded: any[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

      const variations = Array.isArray((row as any)?.variations)
        ? (row as any).variations
        : [];
      if (variations.length === 0) {
        expanded.push(row);
        continue;
      }

      const { variations: _omitVariations, ...parentProduct } = row as Record<string, any>;
      for (const variation of variations) {
        if (!variation || typeof variation !== 'object' || Array.isArray(variation)) continue;

        expanded.push({
          ...variation,
          product_id:
            variation?.product_id ??
            variation?.productId ??
            row?.id ??
            row?.product_id ??
            row?.productId ??
            null,
          product: variation?.product ?? parentProduct,
          custom_id: variation?.custom_id ?? row?.custom_id ?? null,
          // Keep product-level fallback names available for mapping.
          name: variation?.name ?? row?.name ?? null,
        });
      }
    }

    return expanded;
  }

  private extractPancakeProductsApiError(payload: any): string | null {
    const candidates: any[] = [];
    if (Array.isArray(payload)) {
      candidates.push(...payload);
    } else if (payload && typeof payload === 'object') {
      candidates.push(payload);
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const success = candidate?.success;
      if (success === false) {
        const message =
          candidate?.message ||
          candidate?.error ||
          candidate?.error_message ||
          candidate?.detail;
        if (typeof message === 'string' && message.trim()) {
          return message.trim();
        }
        return 'Failed to fetch products from Pancake POS';
      }
    }

    return null;
  }

  private normalizeGeoCountryCode(countryCodeRaw: string | number): number {
    const parsed =
      typeof countryCodeRaw === 'number'
        ? countryCodeRaw
        : Number.parseInt(countryCodeRaw?.toString?.().trim?.() || '', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException('country_code must be a positive integer');
    }
    return Math.floor(parsed);
  }

  private chunkRows<T>(rows: T[], size: number): T[][] {
    const chunkSize = Math.max(1, Math.floor(size));
    const chunks: T[][] = [];
    for (let index = 0; index < rows.length; index += chunkSize) {
      chunks.push(rows.slice(index, index + chunkSize));
    }
    return chunks;
  }

  private parsePancakeGeoResponseRows(payload: any): any[] {
    if (!payload) return [];

    if (Array.isArray(payload)) {
      const nestedRows = payload.flatMap((entry) => {
        if (Array.isArray(entry?.data)) return entry.data;
        return [];
      });
      if (nestedRows.length > 0) return nestedRows;
    }

    if (Array.isArray(payload?.data)) return payload.data;
    return [];
  }

  private asOptionalString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const text = value.toString().trim();
    return text ? text : null;
  }

  private asOptionalJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === null || value === undefined) return undefined;

    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
      || Array.isArray(value)
      || (typeof value === 'object' && value !== null)
    ) {
      return value as Prisma.InputJsonValue;
    }

    return undefined;
  }

  private normalizePancakeGeoProvinceRow(row: any, countryCode: number): PancakeGeoProvince | null {
    const id = this.asOptionalString(row?.id);
    const name = this.asOptionalString(row?.name);
    if (!id || !name) return null;

    const rowCountryCode = Number.parseInt(
      this.asOptionalString(row?.country_code) || String(countryCode),
      10,
    );

    return {
      id,
      countryCode: Number.isFinite(rowCountryCode) ? rowCountryCode : countryCode,
      name,
      nameEn: this.asOptionalString(row?.name_en),
      newId: this.asOptionalString(row?.new_id),
      regionType: this.asOptionalString(row?.region_type),
    };
  }

  private normalizePancakeGeoDistrictRow(
    row: any,
    fallbackProvinceId: string,
  ): PancakeGeoDistrict | null {
    const id = this.asOptionalString(row?.id);
    const name = this.asOptionalString(row?.name);
    const provinceId = this.asOptionalString(row?.province_id) || fallbackProvinceId;
    if (!id || !name || !provinceId) return null;

    return {
      id,
      provinceId,
      name,
      nameEn: this.asOptionalString(row?.name_en),
      postcode: this.asOptionalJsonValue(row?.postcode),
    };
  }

  private normalizePancakeGeoCommuneRow(
    row: any,
    fallbackProvinceId: string,
  ): PancakeGeoCommune | null {
    const id = this.asOptionalString(row?.id);
    const name = this.asOptionalString(row?.name);
    const districtId = this.asOptionalString(row?.district_id);
    const provinceId = this.asOptionalString(row?.province_id) || fallbackProvinceId;
    if (!id || !name || !districtId || !provinceId) return null;

    return {
      id,
      provinceId,
      districtId,
      name,
      nameEn: this.asOptionalString(row?.name_en),
      newId: this.asOptionalString(row?.new_id),
      postcode: this.asOptionalJsonValue(row?.postcode),
    };
  }

  private async fetchGeoProvincesFromPancake(countryCode: number): Promise<PancakeGeoProvince[]> {
    const params = new URLSearchParams();
    params.set('country_code', String(countryCode));

    const response = await fetch(
      `https://pos.pages.fm/api/v1/geo/provinces?${params.toString()}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConflictException(errorText || 'Failed to fetch provinces from Pancake POS');
    }

    const payload = await response.json().catch(() => null);
    const rows = this.parsePancakeGeoResponseRows(payload);
    const map = new Map<string, PancakeGeoProvince>();

    for (const row of rows) {
      const normalized = this.normalizePancakeGeoProvinceRow(row, countryCode);
      if (!normalized) continue;
      map.set(normalized.id, normalized);
    }

    return Array.from(map.values());
  }

  private async fetchGeoDistrictsFromPancake(provinceId: string): Promise<PancakeGeoDistrict[]> {
    const params = new URLSearchParams();
    params.set('province_id', provinceId);

    const response = await fetch(
      `https://pos.pages.fm/api/v1/geo/districts?${params.toString()}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConflictException(
        errorText || `Failed to fetch districts for province ${provinceId}`,
      );
    }

    const payload = await response.json().catch(() => null);
    const rows = this.parsePancakeGeoResponseRows(payload);
    const map = new Map<string, PancakeGeoDistrict>();

    for (const row of rows) {
      const normalized = this.normalizePancakeGeoDistrictRow(row, provinceId);
      if (!normalized) continue;
      map.set(normalized.id, normalized);
    }

    return Array.from(map.values());
  }

  private async fetchGeoCommunesFromPancake(provinceId: string): Promise<PancakeGeoCommune[]> {
    const params = new URLSearchParams();
    params.set('province_id', provinceId);

    const response = await fetch(
      `https://pos.pages.fm/api/v1/geo/communes?${params.toString()}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConflictException(
        errorText || `Failed to fetch communes for province ${provinceId}`,
      );
    }

    const payload = await response.json().catch(() => null);
    const rows = this.parsePancakeGeoResponseRows(payload);
    const map = new Map<string, PancakeGeoCommune>();

    for (const row of rows) {
      const normalized = this.normalizePancakeGeoCommuneRow(row, provinceId);
      if (!normalized) continue;
      map.set(normalized.id, normalized);
    }

    return Array.from(map.values());
  }

  private parsePancakeTagsResponseRows(payload: any): any[] {
    if (!payload) return [];

    if (Array.isArray(payload)) {
      const nestedRows = payload.flatMap((entry) => {
        if (Array.isArray(entry?.data)) return entry.data;
        return [];
      });
      if (nestedRows.length > 0) return nestedRows;
    }

    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.tags)) return payload.tags;
    return [];
  }

  private normalizePancakeTagRow(row: any): PancakeStoreTag | null {
    const tagIdRaw = row?.id;
    const nameRaw = row?.name;

    if (tagIdRaw === null || tagIdRaw === undefined) return null;
    if (typeof nameRaw !== 'string' || !nameRaw.trim()) return null;

    const tagId = tagIdRaw.toString().trim();
    const name = nameRaw.trim();
    if (!tagId || !name) return null;

    const groups = Array.isArray(row?.groups) ? row.groups : [];
    const firstGroup = groups.length > 0 ? groups[0] : null;

    const groupIdRaw = firstGroup?.id;
    const groupNameRaw = firstGroup?.name;

    const groupId =
      groupIdRaw === null || groupIdRaw === undefined
        ? null
        : groupIdRaw.toString().trim() || null;
    const groupName =
      typeof groupNameRaw === 'string' && groupNameRaw.trim()
        ? groupNameRaw.trim()
        : null;

    return {
      tagId,
      name,
      groupId,
      groupName,
    };
  }

  private async fetchTagsFromPancake(shopId: string, apiKey: string): Promise<PancakeStoreTag[]> {
    const params = new URLSearchParams();
    params.set('api_key', apiKey);

    const response = await fetch(
      `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(shopId)}/orders/tags?${params.toString()}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConflictException(errorText || 'Failed to fetch tags from Pancake POS');
    }

    const payload = await response.json().catch(() => null);
    const rows = this.parsePancakeTagsResponseRows(payload);
    const map = new Map<string, PancakeStoreTag>();

    for (const row of rows) {
      const normalized = this.normalizePancakeTagRow(row);
      if (!normalized) continue;

      const existing = map.get(normalized.tagId);
      if (!existing) {
        map.set(normalized.tagId, normalized);
        continue;
      }

      // Prefer grouped tag metadata when duplicate tag IDs appear.
      if (!existing.groupId && normalized.groupId) {
        map.set(normalized.tagId, normalized);
      }
    }

    return Array.from(map.values());
  }

  private async upsertStoreTags(
    store: { id: string; tenantId: string; teamId: string | null },
    tags: PancakeStoreTag[],
  ): Promise<void> {
    const uniqueTags = tags.filter((tag) => tag.tagId && tag.name);
    const tagIds = uniqueTags.map((tag) => tag.tagId);

    await this.prisma.$transaction(async (tx) => {
      await tx.posTag.deleteMany({
        where: {
          tenantId: store.tenantId,
          storeId: store.id,
          ...(tagIds.length > 0 ? { tagId: { notIn: tagIds } } : {}),
        },
      });

      if (uniqueTags.length === 0) return;

      for (const tag of uniqueTags) {
        await tx.posTag.upsert({
          where: {
            tenantId_storeId_tagId: {
              tenantId: store.tenantId,
              storeId: store.id,
              tagId: tag.tagId,
            },
          },
          update: {
            teamId: store.teamId,
            name: tag.name,
            groupId: tag.groupId,
            groupName: tag.groupName,
          },
          create: {
            tenantId: store.tenantId,
            teamId: store.teamId,
            storeId: store.id,
            tagId: tag.tagId,
            name: tag.name,
            groupId: tag.groupId,
            groupName: tag.groupName,
          },
        });
      }
    });
  }

  private parsePancakeWarehousesResponseRows(payload: any): any[] {
    if (!payload) return [];

    if (Array.isArray(payload)) {
      const nestedRows = payload.flatMap((entry) => {
        if (Array.isArray(entry?.data)) return entry.data;
        return [];
      });
      if (nestedRows.length > 0) return nestedRows;
    }

    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.warehouses)) return payload.warehouses;
    return [];
  }

  private normalizePancakeWarehouseJson(value: any): Prisma.InputJsonValue | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      return null;
    }

    try {
      JSON.stringify(value);
      return value as Prisma.InputJsonValue;
    } catch {
      return null;
    }
  }

  private normalizePancakeWarehouseRow(row: any): PancakeStoreWarehouse | null {
    const warehouseIdRaw = row?.id;
    const nameRaw = row?.name;

    if (warehouseIdRaw === null || warehouseIdRaw === undefined) return null;
    const warehouseId = warehouseIdRaw.toString().trim();
    if (!warehouseId) return null;

    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) return null;

    const toNullableString = (value: any): string | null => {
      if (value === null || value === undefined) return null;
      const text = value.toString().trim();
      return text.length > 0 ? text : null;
    };

    const toNullableBoolean = (value: any): boolean | null => {
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1') return true;
      if (value === 0 || value === '0') return false;
      return null;
    };

    const countryCodeRaw = row?.country_code;
    const parsedCountryCode =
      countryCodeRaw === null || countryCodeRaw === undefined || countryCodeRaw === ''
        ? Number.NaN
        : Number.parseInt(countryCodeRaw.toString(), 10);
    const countryCode = Number.isFinite(parsedCountryCode) ? parsedCountryCode : null;

    return {
      warehouseId,
      name,
      customId: toNullableString(row?.custom_id),
      address: toNullableString(row?.address),
      fullAddress: toNullableString(row?.full_address),
      phoneNumber: toNullableString(row?.phone_number),
      countryCode,
      provinceId: toNullableString(row?.province_id),
      districtId: toNullableString(row?.district_id),
      communeId: toNullableString(row?.commune_id),
      postcode: toNullableString(row?.postcode),
      allowCreateOrder: toNullableBoolean(row?.allow_create_order),
      batchConfig: this.normalizePancakeWarehouseJson(row?.batch_config),
      customBatchConfig: this.normalizePancakeWarehouseJson(row?.custom_batch_config),
      customShelfConfig: this.normalizePancakeWarehouseJson(row?.custom_shelf_config),
      shelfConfig: this.normalizePancakeWarehouseJson(row?.shelf_config),
      hideConfigBatchShelf: toNullableBoolean(row?.hide_config_batch_shelf),
    };
  }

  private async fetchWarehousesFromPancake(
    shopId: string,
    apiKey: string,
  ): Promise<PancakeStoreWarehouse[]> {
    const params = new URLSearchParams();
    params.set('api_key', apiKey);

    const response = await fetch(
      `https://pos.pages.fm/api/v1/shops/${encodeURIComponent(shopId)}/warehouses?${params.toString()}`,
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new ConflictException(errorText || 'Failed to fetch warehouses from Pancake POS');
    }

    const payload = await response.json().catch(() => null);
    const rows = this.parsePancakeWarehousesResponseRows(payload);
    const unique = new Map<string, PancakeStoreWarehouse>();

    for (const row of rows) {
      const normalized = this.normalizePancakeWarehouseRow(row);
      if (!normalized) continue;
      unique.set(normalized.warehouseId, normalized);
    }

    return Array.from(unique.values());
  }

  private async upsertStoreWarehouses(
    storeId: string,
    warehouses: PancakeStoreWarehouse[],
  ): Promise<void> {
    const uniqueWarehouses = warehouses.filter((row) => row.warehouseId && row.name);
    const warehouseIds = uniqueWarehouses.map((row) => row.warehouseId);

    await this.prisma.$transaction(async (tx) => {
      await tx.posWarehouse.deleteMany({
        where: {
          storeId,
          ...(warehouseIds.length > 0 ? { warehouseId: { notIn: warehouseIds } } : {}),
        },
      });

      if (uniqueWarehouses.length === 0) return;

      for (const warehouse of uniqueWarehouses) {
        const batchConfig =
          warehouse.batchConfig === null ? Prisma.JsonNull : warehouse.batchConfig;
        const customBatchConfig =
          warehouse.customBatchConfig === null
            ? Prisma.JsonNull
            : warehouse.customBatchConfig;
        const customShelfConfig =
          warehouse.customShelfConfig === null
            ? Prisma.JsonNull
            : warehouse.customShelfConfig;
        const shelfConfig =
          warehouse.shelfConfig === null ? Prisma.JsonNull : warehouse.shelfConfig;

        await tx.posWarehouse.upsert({
          where: {
            storeId_warehouseId: {
              storeId,
              warehouseId: warehouse.warehouseId,
            },
          },
          update: {
            name: warehouse.name,
            customId: warehouse.customId,
            address: warehouse.address,
            fullAddress: warehouse.fullAddress,
            phoneNumber: warehouse.phoneNumber,
            countryCode: warehouse.countryCode,
            provinceId: warehouse.provinceId,
            districtId: warehouse.districtId,
            communeId: warehouse.communeId,
            postcode: warehouse.postcode,
            allowCreateOrder: warehouse.allowCreateOrder,
            batchConfig,
            customBatchConfig,
            customShelfConfig,
            shelfConfig,
            hideConfigBatchShelf: warehouse.hideConfigBatchShelf,
          },
          create: {
            storeId,
            warehouseId: warehouse.warehouseId,
            name: warehouse.name,
            customId: warehouse.customId,
            address: warehouse.address,
            fullAddress: warehouse.fullAddress,
            phoneNumber: warehouse.phoneNumber,
            countryCode: warehouse.countryCode,
            provinceId: warehouse.provinceId,
            districtId: warehouse.districtId,
            communeId: warehouse.communeId,
            postcode: warehouse.postcode,
            allowCreateOrder: warehouse.allowCreateOrder,
            batchConfig,
            customBatchConfig,
            customShelfConfig,
            shelfConfig,
            hideConfigBatchShelf: warehouse.hideConfigBatchShelf,
          },
        });
      }
    });
  }

  private async upsertStoreProducts(storeId: string, products: any[]) {
    if (!products?.length) return;

    await this.prisma.$transaction(async (tx) => {
      const store = await tx.posStore.findUnique({
        where: { id: storeId },
        select: { tenantId: true, shopId: true },
      });

      if (!store) {
        throw new NotFoundException('POS store not found');
      }

      const filteredProducts = products.filter(
        (p: any) =>
          typeof p?.productId === 'string'
          && p.productId.trim().length > 0,
      );

      for (const p of filteredProducts) {
        const productId = p.productId.toString().trim();
        const variationIdRaw = p?.variationId?.toString?.().trim?.() || '';
        const variationId = variationIdRaw.length > 0 ? variationIdRaw : null;
        const hasStockableVariation = Boolean(variationId) && variationId !== productId;
        const parsedRetailPrice = normalizedPancakeRetailPriceForStorage(
          p.retailPrice, p.retailPriceEvidence, { shopId: store.shopId, productId, variationId },
        );
        const productSnapshot = p?.productSnapshot ?? null;
        const existing = variationId
          ? await tx.posProduct.findFirst({
              where: {
                storeId,
                OR: [
                  { variationId },
                  {
                    AND: [
                      { productId },
                      {
                        OR: [
                          { variationId: null },
                          { variationId: productId },
                        ],
                      },
                    ],
                  },
                ],
              },
              select: { id: true },
            })
          : await tx.posProduct.findFirst({
              where: {
                storeId,
                productId,
                variationId: null,
              },
              select: { id: true },
            });

        if (existing) {
          const updated = await tx.posProduct.update({
            where: { id: existing.id },
            data: {
              productId,
              variationId,
              warehouseId: p.warehouseId || null,
              productSnapshot,
              customId: p.customId || null,
              name: p.name || 'Unnamed product',
              ...(parsedRetailPrice !== null ? { retailPrice: parsedRetailPrice } : {}),
            },
          });

          if (hasStockableVariation) {
            await tx.wmsProductProfile.upsert({
              where: {
                posProductId: updated.id,
              },
              update: {
                tenantId: store.tenantId,
                storeId,
                productId,
                variationId,
                posWarehouseRef: p.warehouseId || null,
              },
              create: {
                tenantId: store.tenantId,
                storeId,
                posProductId: updated.id,
                productId,
                variationId,
                posWarehouseRef: p.warehouseId || null,
                status: WmsProductProfileStatus.DEFAULT,
                isSerialized: true,
              },
            });
          }
          continue;
        }

        const created = await tx.posProduct.create({
          data: {
            storeId,
            productId,
            variationId,
            warehouseId: p.warehouseId || null,
            productSnapshot,
            customId: p.customId || null,
            name: p.name || 'Unnamed product',
            retailPrice: parsedRetailPrice,
          },
        });

        if (hasStockableVariation) {
          await tx.wmsProductProfile.create({
            data: {
              tenantId: store.tenantId,
              storeId,
              posProductId: created.id,
              productId,
              variationId,
              posWarehouseRef: p.warehouseId || null,
              status: WmsProductProfileStatus.DEFAULT,
              isSerialized: true,
            },
          });
        }
      }
    });
  }

  private extractProductIdFromPancakeProduct(item: any): string | null {
    const raw =
      item?.product_id ??
      item?.productId ??
      item?.product?.id ??
      item?.variation_info?.product_id ??
      item?.variation_info?.productId ??
      null;

    if (raw === null || raw === undefined) return null;
    const value = raw.toString().trim();
    return value.length > 0 ? value : null;
  }

  private extractVariationIdFromPancakeProduct(item: any): string | null {
    const explicitRaw =
      item?.variation_id ??
      item?.variationId ??
      item?.variation?.id ??
      item?.variation?.variation_id ??
      item?.variation?.variationId ??
      null;
    if (explicitRaw !== null && explicitRaw !== undefined) {
      const explicitValue = explicitRaw.toString().trim();
      if (explicitValue.length > 0) {
        return explicitValue;
      }
    }

    const candidateRaw = item?.id ?? item?._id ?? item?.uuid ?? null;
    if (candidateRaw === null || candidateRaw === undefined) return null;
    const candidateValue = candidateRaw.toString().trim();
    if (!candidateValue) return null;

    const productId = this.extractProductIdFromPancakeProduct(item);
    if (productId && candidateValue === productId) {
      return null;
    }

    return candidateValue;
  }

  private extractWarehouseIdFromPancakeProduct(item: any): string | null {
    const rows = [
      ...(Array.isArray(item?.variations_warehouses) ? item.variations_warehouses : []),
      ...(Array.isArray(item?.variation_info?.variations_warehouses)
        ? item.variation_info.variations_warehouses
        : []),
    ];

    for (const row of rows) {
      const raw = row?.warehouse_id ?? row?.warehouseId ?? row?.id ?? null;
      if (raw === null || raw === undefined) continue;
      const value = raw.toString().trim();
      if (value.length > 0) return value;
    }

    return null;
  }

  private extractProductSnapshotFromPancakeProduct(item: any): Record<string, any> {
    const displayId =
      item?.display_id ??
      item?.product_display_id ??
      item?.product?.display_id ??
      null;
    const product =
      item?.product && typeof item.product === 'object' && !Array.isArray(item.product)
        ? {
            ...item.product,
            ...(displayId !== null && displayId !== undefined ? { display_id: displayId } : {}),
          }
        : displayId !== null && displayId !== undefined
          ? { display_id: displayId }
          : null;

    return {
      product,
      ...(displayId !== null && displayId !== undefined ? { display_id: displayId } : {}),
      images: this.normalizeProductImages(
        item?.images ?? product?.images ?? product?.image ?? null,
      ),
    };
  }

  private normalizeProductImages(raw: any): string[] {
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return values
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
  }

  async fetchPancakeProductsByIntegrationId(id: string): Promise<any[]> {
    const { tenantId } = await this.teamContext.getContext();

    // Use sharing-aware access check (same as buildIntegrationAccessWhere)
    const access = await this.buildIntegrationAccessWhere({ id });
    if (!access.where) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    const integration = await this.prisma.integration.findFirst({
      where: access.where,
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    if (integration.provider !== 'PANCAKE_POS') {
      throw new ConflictException('Products can only be fetched for Pancake POS integrations');
    }

    const credentials = await this.getDecryptedCredentials(id, tenantId);
    const apiKey = credentials?.apiKey;
    const config = integration.config as any;
    const shopId = config?.shopId;

    if (!apiKey || !shopId) {
      throw new ConflictException('Missing API key or shop ID for this integration');
    }

    const products = await this.fetchProductsFromPancake(shopId, apiKey);

    // Find store with sharing-aware access (owned or shared via integration)
    const store = await this.prisma.posStore.findFirst({
      where: {
        tenantId,
        integrationId: integration.id,
      },
    });

    if (store) {
      await this.upsertStoreProducts(store.id, products);

      return this.prisma.posProduct.findMany({
        where: { storeId: store.id },
        orderBy: { name: 'asc' },
      });
    }

    return products;
  }

  async fetchPancakeProductsByShopId(shopId: string, overrideApiKey?: string): Promise<any[]> {
    const { tenantId, teamIds, userTeams, isAdmin, tenantHasTeams } = await this.teamContext.getContext();
    const allowedTeams = (teamIds && teamIds.length > 0 ? teamIds : userTeams) || [];

    // Build sharing-aware where clause (same logic as listPosStores/getPosStore)
    let where: any = { tenantId, shopId: shopId.toString() };
    // A teamless user is tenant-scoped, so no team restriction applies.
    const shouldRestrict = tenantHasTeams && allowedTeams.length > 0 && (!isAdmin || (isAdmin && allowedTeams.length > 0));
    if (shouldRestrict) {
      // No team means no team-owned records to match; the null-team branch in
      // the filter below is what such a user can legitimately reach.

      where = {
        tenantId,
        shopId: shopId.toString(),
        OR: [
          { teamId: { in: allowedTeams } },
          // Integration owned by allowed teams
          { integration: { teamId: { in: allowedTeams } } },
          // Integration shared to allowed teams
          { integration: { sharedTeams: { some: { teamId: { in: allowedTeams } } } } },
        ],
      };
    }

    const store = await this.prisma.posStore.findFirst({
      where,
    });

    if (!store) {
      throw new NotFoundException(`Store with shop ID ${shopId} not found`);
    }

    let apiKeyToUse = overrideApiKey || store.apiKey;

    // Fallback: use integration credentials if store apiKey is missing
    if (!apiKeyToUse && store.integrationId) {
      try {
        const creds = await this.getDecryptedCredentials(store.integrationId, tenantId);
        if (creds?.apiKey) {
          apiKeyToUse = creds.apiKey;
          // Persist so future calls don't need the fallback
          await this.prisma.posStore.update({
            where: { id: store.id },
            data: { apiKey: apiKeyToUse },
          });
        }
      } catch {
        // swallow and fall through to conflict if still missing
      }
    }

    if (!apiKeyToUse) {
      throw new ConflictException('Missing API key for this store');
    }

    const products = await this.fetchProductsFromPancake(shopId, apiKeyToUse);

    await this.upsertStoreProducts(store.id, products);

    return this.prisma.posProduct.findMany({
      where: { storeId: store.id },
      orderBy: { name: 'asc' },
    });
  }

  async syncPancakeProductsByStoreId(storeId: string, tenantIdOverride?: string) {
    const store = tenantIdOverride
      ? await this.prisma.posStore.findFirst({
          where: {
            id: storeId,
            tenantId: tenantIdOverride,
          },
        })
      : await this.getPosStore(storeId);

    if (!store) {
      throw new NotFoundException(`Store with ID ${storeId} not found`);
    }

    let apiKeyToUse = store.apiKey;

    if (!apiKeyToUse && store.integrationId) {
      try {
        const creds = await this.getDecryptedCredentials(store.integrationId, store.tenantId);
        if (creds?.apiKey) {
          apiKeyToUse = creds.apiKey;
          await this.prisma.posStore.update({
            where: { id: store.id },
            data: { apiKey: apiKeyToUse },
          });
        }
      } catch {
        // Fall through to conflict below.
      }
    }

    if (!apiKeyToUse) {
      throw new ConflictException('Missing API key for this store');
    }

    const products = await this.fetchProductsFromPancake(store.shopId, apiKeyToUse);
    await this.upsertStoreProducts(store.id, products);

    return {
      storeId: store.id,
      syncedCount: products.length,
    };
  }

  /**
   * Get decrypted credentials for an integration (internal use only)
   * This method should NEVER be exposed via API
   */
  async getDecryptedCredentials(
    integrationId: string,
    tenantIdOverride?: string,
  ): Promise<any> {
    // Accept explicit tenantId override (recommended for background jobs)
    // Fallback to integration.tenantId if not provided
    const integration = await this.prisma.integration.findUnique({
      where: { id: integrationId },
      select: { id: true, tenantId: true, credentials: true, teamId: true },
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${integrationId} not found`);
    }

    const tenantId = tenantIdOverride || integration.tenantId || this.cls.get('tenantId');
    const teamId = this.cls.get('teamId') || integration.teamId || null;
    if (!tenantId) {
      this.logger.error(
        `Missing tenantId when decrypting credentials for integration ${integrationId}. ` +
        `override=${tenantIdOverride ?? 'undefined'} integrationTenant=${integration.tenantId ?? 'undefined'} clsTenant=${this.cls.get('tenantId') ?? 'undefined'}`,
      );
      throw new ForbiddenException(
        `Tenant context is required to decrypt credentials for integration ${integrationId}`,
      );
    }

    // Enforce tenant match when override is provided
    if (tenantIdOverride && integration.tenantId && tenantIdOverride !== integration.tenantId) {
      throw new ForbiddenException('Integration does not belong to the provided tenant');
    }

    // Set CLS context when we have an explicit tenant (helps downstream callers)
    this.cls.set('tenantId', tenantId);
    this.cls.set('userRole', this.cls.get('userRole') || 'SYSTEM');
    if (teamId) {
      this.cls.set('teamId', teamId);
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { encryptionKey: true },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return this.encryptionService.decrypt(
      integration.credentials,
      tenant.encryptionKey,
    );
  }

  /**
   * Test connection for an integration
   */
  async testConnection(id: string): Promise<any> {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }

    // Get integration
    const integration = await this.prisma.integration.findFirst({
      where: {
        id,
        tenantId,
      },
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${id} not found`);
    }

    // Get decrypted credentials
    const credentials = await this.getDecryptedCredentials(id, tenantId);

    // Create provider instance
    const provider = this.providerFactory.createProvider(
      integration.provider as any,
      credentials,
      integration.config as any,
    );

    // Test connection
    const result = await provider.testConnection();

    // Update integration status based on test result
    if (result.success) {
      const updateData: any = {
        status: 'ACTIVE',
      };

      // For Meta Ads, store user info in config
      if (integration.provider === 'META_ADS' && result.details) {
        updateData.config = {
          ...(integration.config as any),
          userId: result.details.userId,
          userName: result.details.userName,
        };
      }

      await this.prisma.integration.update({
        where: { id },
        data: updateData,
      });
    } else {
      await this.prisma.integration.update({
        where: { id },
        data: {
          status: 'ERROR',
        },
      });
    }

    return result;
  }

  /**
   * Sync Meta ad accounts from Meta API for a specific integration
   * Similar to Laravel Action - fetches and stores all ad accounts
   */
  async syncMetaAdAccounts(integrationId: string): Promise<number> {
    const { tenantId } = await this.teamContext.getContext();
    const access = await this.buildIntegrationAccessWhere({ id: integrationId });
    if (!access.where) {
      throw new NotFoundException('Integration not found');
    }

    const integration = await this.prisma.integration.findFirst({
      where: access.where,
    });

    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    if (integration.provider !== 'META_ADS') {
      throw new ConflictException('This operation is only for Meta Ads integrations');
    }

    // Get decrypted credentials
    const credentials = await this.getDecryptedCredentials(integrationId, tenantId);
    const provider = this.providerFactory.createProvider(
      IntegrationProvider.META_ADS,
      credentials,
      integration.config as any,
    ) as MetaAdsProvider;

    // Fetch ad accounts from Meta API
    const accounts = await provider.fetchAdAccounts();

    // Store in database (upsert pattern like Laravel)
    let synced = 0;
    const ownerTeamId = integration.teamId ?? null;
    for (const account of accounts) {
      await this.prisma.metaAdAccount.upsert({
        where: {
          tenantId_accountId: {
            tenantId,
            accountId: account.account_id,
          },
        },
        create: {
          tenantId,
          teamId: ownerTeamId,
          integrationId,
          accountId: account.account_id,
          name: account.name,
          currency: account.currency,
          currencyMultiplier: null,
          timezone: account.timezone_name,
          accountStatus: account.account_status,
          status: 'ACTIVE',
          enabled: null,
        },
        update: {
          name: account.name,
          currency: account.currency,
          timezone: account.timezone_name,
          accountStatus: account.account_status,
          status: 'ACTIVE',
          enabled: null,
          lastSyncAt: new Date(),
          teamId: ownerTeamId,
        },
      });
      synced++;
    }

    return synced;
  }

  /**
   * List all Meta ad accounts for current tenant
   * Non-admins only see accounts from their teams
   */
  async listMetaAdAccounts(): Promise<any[]> {
    const { where, tenantId, allowedTeams } = await this.buildIntegrationAccessWhere();
    if (!where) return [];

    let accountWhere: any = { tenantId };
    // Restrict by teams or shared teams when scoped
    const restrict = allowedTeams && allowedTeams.length > 0;
    if (restrict) {
      accountWhere = {
        tenantId,
        OR: [
          { teamId: { in: allowedTeams } },
          { integration: { sharedTeams: { some: { teamId: { in: allowedTeams } } } } },
        ],
      };
    }

    return this.prisma.metaAdAccount.findMany({
      where: accountWhere,
      include: {
        integration: {
          select: { id: true, name: true, enabled: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get Meta ad accounts for a specific integration
   */
  async getMetaAdAccountsByIntegration(integrationId: string): Promise<any[]> {
    const access = await this.buildIntegrationAccessWhere({ id: integrationId });
    if (!access.where) {
      throw new NotFoundException('Integration not found');
    }

    return this.prisma.metaAdAccount.findMany({
      where: { tenantId: access.tenantId, integrationId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Update currency multiplier for selected Meta ad accounts (non-PHP only)
   */
  async updateMetaAdAccountMultipliers(
    integrationId: string,
    accountIds: string[],
    multiplier: number,
  ) {
    if (!accountIds || accountIds.length === 0) {
      return { updated: 0 };
    }
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new BadRequestException('multiplier must be a positive number');
    }

    const access = await this.buildIntegrationAccessWhere({ id: integrationId });
    if (!access.where) {
      throw new NotFoundException('Integration not found');
    }

    const result = await this.prisma.metaAdAccount.updateMany({
      where: {
        tenantId: access.tenantId,
        integrationId,
        accountId: { in: accountIds },
        currency: { not: 'PHP' },
      },
      data: { currencyMultiplier: multiplier },
    });

    return { updated: result.count };
  }

  // ============================================================================
  // COGS (Cost of Goods Sold) Management
  // ============================================================================

  private lockCogsProduct(tx: Prisma.TransactionClient, productId: string, store: { id: string; tenantId: string }) {
    return lockCogsProduct(tx, productId, store).then(async product => {
      if (product) await assertWmsManagedCogsEditable(tx, productId, store);
      return product;
    });
  }
  private productCogsToday(client: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) { return productCogsToday(client); }
  private findApplicableProductCogs(client: Pick<Prisma.TransactionClient, 'posProductCogs'>, productId: string, store: { id: string; tenantId: string }, date: Date) {
    return findApplicableProductCogs(client, productId, store, date);
  }
  private writeCurrentProductCogs(tx: Prisma.TransactionClient, product: LockedCogsProduct, store: { id: string; tenantId: string }, cogs: number, today: Date) {
    return writeCurrentProductCogs(tx, product, store, cogs, today);
  }

  private productCogsRefreshRange(entry: Pick<PosProductCogs, 'productId' | 'startDate' | 'endDate'>) {
    return { productId: entry.productId, fromDate: entry.startDate?.toISOString().slice(0, 10) ?? null,
      toDate: entry.endDate?.toISOString().slice(0, 10) ?? null };
  }

  /**
   * Get COGS history for a product in a store
   */
  async getProductCogsHistory(productId: string, storeId: string) {
    const store = await this.getPosStore(storeId); // validates access including shared integrations

    // Verify product belongs to this store
    const product = await this.prisma.posProduct.findFirst({
      where: { id: productId, storeId: store.id },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found in this store`);
    }

    return this.prisma.posProductCogs.findMany({
      where: {
        tenantId: store.tenantId,
        productId,
        storeId: store.id,
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Get current active COGS for a product in a store
   */
  async getCurrentCogs(productId: string, storeId: string) {
    const store = await this.getPosStore(storeId); // validates access including shared integrations

    const product = await this.prisma.posProduct.findFirst({
      where: { id: productId, storeId: store.id },
      select: { id: true },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found in this store`);
    }

    return this.findApplicableProductCogs(this.prisma, productId, store, await this.productCogsToday(this.prisma));
  }

  /**
   * Get COGS for a product on a specific date (used in Meta attribution)
   */
  async getCogsForDate(productId: string, storeId: string, date: Date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new BadRequestException('Invalid COGS date');
    const store = await this.getPosStore(storeId);
    const product = await this.prisma.posProduct.findFirst({ where: { id: productId, storeId: store.id }, select: { id: true } });
    if (!product) throw new NotFoundException(`Product with ID ${productId} not found in this store`);
    const calendarDate = new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const entry = await this.findApplicableProductCogs(this.prisma, productId, store, calendarDate);
    return entry?.cogs ?? null;
  }

  /**
   * Set today's current COGS while preserving earlier dated and legacy costs.
   */
  async addCogsEntry(
    productId: string,
    storeId: string,
    cogs: number,
  ) {
    assertValidProductCogs(cogs);
    const store = await this.getPosStore(storeId); // validates access including shared integrations
    return this.prisma.$transaction(async (tx) => {
      const product = await this.lockCogsProduct(tx, productId, store);
      if (!product) throw new NotFoundException(`Product with ID ${productId} not found in this store`);
      const today = await this.productCogsToday(tx);
      const result = await this.writeCurrentProductCogs(tx, product, store, cogs, today);
      await this.wmsCogsSync.syncAfterErpWrites(tx, store, [productId], (this.cls.get('userId') as string | undefined) ?? null);
      // Publish while the parent lock is held; the worker barrier waits for
      // commit. A queue failure rolls back the cost edit instead of losing it.
      await this.productCogsRefresh.enqueue({ tenantId: store.tenantId, storeId: store.id,
        changes: [{ productId, fromDate: today.toISOString().slice(0, 10), toDate: null }] });
      return result.entry;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });
  }

  /**
   * Update existing COGS entry
   */
  async updateCogsEntry(
    storeId: string,
    productId: string,
    cogsId: string,
    cogs: number,
  ) {
    assertValidProductCogs(cogs);
    const store = await this.getPosStore(storeId); // validates access including shared integrations
    return this.prisma.$transaction(async (tx) => {
      if (!await this.lockCogsProduct(tx, productId, store)) throw new NotFoundException(`Product with ID ${productId} not found in this store`);
      const entry = await tx.posProductCogs.findFirst({ where: { id: cogsId, tenantId: store.tenantId, storeId: store.id, productId } });
      if (!entry) throw new NotFoundException('COGS entry not found');
      // Explicit entry editing retains its intentional historical-edit contract.
      const updated = await tx.posProductCogs.update({
        where: { id: cogsId, tenantId: store.tenantId, storeId: store.id, productId, updatedAt: entry.updatedAt }, data: { cogs },
      });
      await this.wmsCogsSync.syncAfterErpWrites(tx, store, [productId], (this.cls.get('userId') as string | undefined) ?? null);
      // Preserve both effective ranges if this entry editor later gains date editing.
      const changes = [...new Map([entry, updated].map(row => {
        const range = this.productCogsRefreshRange(row);
        return [JSON.stringify(range), range] as const;
      })).values()];
      await this.productCogsRefresh.enqueue({ tenantId: store.tenantId, storeId: store.id, changes });
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });
  }

  /**
   * Delete COGS entry
   * Explicit deletion does not reopen or rewrite another historical interval.
   */
  async deleteCogsEntry(storeId: string, productId: string, cogsId: string): Promise<void> {
    const store = await this.getPosStore(storeId); // validates access including shared integrations
    await this.prisma.$transaction(async (tx) => {
      if (!await this.lockCogsProduct(tx, productId, store)) throw new NotFoundException(`Product with ID ${productId} not found in this store`);
      const entry = await tx.posProductCogs.findFirst({ where: { id: cogsId, tenantId: store.tenantId, storeId: store.id, productId } });
      if (!entry) throw new NotFoundException('COGS entry not found');
      await tx.posProductCogs.delete({ where: { id: cogsId, tenantId: store.tenantId, storeId: store.id, productId, updatedAt: entry.updatedAt } });
      await this.wmsCogsSync.syncAfterErpWrites(tx, store, [productId], (this.cls.get('userId') as string | undefined) ?? null);
      await this.productCogsRefresh.enqueue({ tenantId: store.tenantId, storeId: store.id,
        changes: [this.productCogsRefreshRange(entry)] });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 10000, timeout: 30000 });
  }

  async getMetaInsightsByIntegration(
    integrationId: string,
    accountId?: string,
    dateFrom?: string,
    dateTo?: string,
  ) {
    const access = await this.buildIntegrationAccessWhere({ id: integrationId });
    if (!access.where) {
      throw new NotFoundException(`Integration with ID ${integrationId} not found`);
    }

    const integration = await this.prisma.integration.findFirst({
      where: access.where,
    });

    if (!integration) {
      throw new NotFoundException(`Integration with ID ${integrationId} not found`);
    }

    const accounts = await this.prisma.metaAdAccount.findMany({
      where: { tenantId: access.tenantId, integrationId },
      select: { tenantId: true, accountId: true, teamId: true },
    });

    // Backfill existing insights that are missing teamId so they show up under team scope
    await this.metaInsightService.backfillTeamIdsForAccounts(accounts);

    const accountIds = accounts.map((a) => a.accountId);
    if (accountIds.length === 0) {
      return [];
    }

    const normalizedAccountId = accountId ? accountId.replace(/^act_/, '') : undefined;
    const accountFilter =
      normalizedAccountId && accountIds.includes(normalizedAccountId)
        ? normalizedAccountId
        : undefined;

    const insightsWhere: any = {
      tenantId: access.tenantId,
      accountId: accountFilter ? accountFilter : { in: accountIds },
    };

    if (dateFrom || dateTo) {
      insightsWhere.date = {};
      if (dateFrom) insightsWhere.date.gte = new Date(dateFrom);
      if (dateTo) insightsWhere.date.lte = new Date(dateTo);
    }

    return this.prisma.metaAdInsight.findMany({
      where: insightsWhere,
      orderBy: [{ date: 'desc' }, { spend: 'desc' }],
      take: 500,
    });
  }
}
