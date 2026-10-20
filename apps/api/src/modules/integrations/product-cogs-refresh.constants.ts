import { BadRequestException } from '@nestjs/common';
import type { JobOptions } from 'bull';
import type { ProductCogsRefreshChange } from './services/product-cogs-recalculation.service';

export const PRODUCT_COGS_REFRESH_JOB = 'refresh-product-cogs';
// Runtime inspection distinguishes ERP reporting costs from warehouse costs.
export const PRODUCT_COGS_REPORTING_POLICY = 'ERP_PRODUCT_COGS_REPORTING_V3';
export const PRODUCT_COGS_REFRESH_PAGE_SIZE = 200;
const MAX_REFRESH_CHANGES = 10_000;
const MAX_AFFECTED_DATES = 20_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProductCogsRefreshScope {
  tenantId: string;
  storeId: string;
  changes: ProductCogsRefreshChange[];
}

export interface ProductCogsRefreshJobData extends ProductCogsRefreshScope {
  refreshId: string;
  cursor?: string;
  affectedDates: string[];
}

export function isCogsRefreshDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function normalizeCogsRefreshScope(scope: ProductCogsRefreshScope): ProductCogsRefreshScope {
  if (!scope || !UUID.test(scope.tenantId ?? '') || !UUID.test(scope.storeId ?? '')
    || !Array.isArray(scope.changes) || scope.changes.length === 0 || scope.changes.length > MAX_REFRESH_CHANGES) {
    throw new BadRequestException('Invalid product COGS refresh scope');
  }
  const changes = new Map<string, ProductCogsRefreshChange>();
  for (const change of scope.changes) {
    if (!change || !UUID.test(change.productId ?? '')
      || (change.zeroOnly !== undefined && typeof change.zeroOnly !== 'boolean')
      || (change.fromDate !== null && !isCogsRefreshDate(change.fromDate))
      || (change.toDate !== null && !isCogsRefreshDate(change.toDate))
      || (change.fromDate !== null && change.toDate !== null && change.fromDate > change.toDate)) {
      throw new BadRequestException('Invalid product COGS refresh interval');
    }
    const normalized = { productId: change.productId, fromDate: change.fromDate, toDate: change.toDate,
      ...(change.zeroOnly !== undefined ? { zeroOnly: change.zeroOnly } : {}) };
    changes.set(JSON.stringify(normalized), normalized);
  }
  return { tenantId: scope.tenantId, storeId: scope.storeId, changes: [...changes.values()] };
}

export function normalizeCogsRefreshDates(dates: string[]): string[] {
  if (!Array.isArray(dates) || dates.length > MAX_AFFECTED_DATES * 2 || dates.some(date => !isCogsRefreshDate(date))) {
    throw new BadRequestException('Invalid product COGS refresh dates');
  }
  const unique = [...new Set(dates)].sort();
  if (unique.length > MAX_AFFECTED_DATES) throw new BadRequestException('Too many product COGS refresh dates');
  return unique;
}

export function normalizeCogsRefreshJob(data: ProductCogsRefreshJobData): ProductCogsRefreshJobData {
  const scope = normalizeCogsRefreshScope(data);
  if (!UUID.test(data.refreshId ?? '') || (data.cursor !== undefined && !UUID.test(data.cursor))) {
    throw new BadRequestException('Invalid product COGS refresh job');
  }
  return { ...scope, refreshId: data.refreshId, ...(data.cursor ? { cursor: data.cursor } : {}),
    affectedDates: normalizeCogsRefreshDates(data.affectedDates) };
}

export function cogsRefreshJobOptions(jobId: string, delay = 0): JobOptions {
  return {
    jobId,
    delay,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5_000 },
    // Keeping completed pages makes a retried parent idempotent after an
    // uncertain Redis acknowledgement. Failed jobs remain available for retry.
    removeOnComplete: { age: 86_400, count: 10_000 },
    removeOnFail: false,
  };
}
