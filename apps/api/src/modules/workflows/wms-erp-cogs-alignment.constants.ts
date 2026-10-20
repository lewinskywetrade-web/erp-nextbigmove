import { BadRequestException } from '@nestjs/common';
import type { JobOptions } from 'bull';

export const WMS_ERP_COGS_ALIGNMENT_JOB = 'wms-erp-cogs-alignment';
export const WMS_ERP_COGS_ALIGNMENT_POLICY = 'INHOUSE_POSITIVE_ELSE_CURRENT_ERP_V1';
export const WMS_ERP_COGS_ALIGNMENT_BATCH_SIZE = 25;
export const WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS = 15 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export interface WmsErpCogsAlignmentJobData {
  jobVersion: 1;
  tenantId: string;
  runId: string;
  actorId: string | null;
  policy: typeof WMS_ERP_COGS_ALIGNMENT_POLICY;
  previewSHA256: string;
  profileIds: string[];
}

/** Fixed explicit targets only: this worker never discovers or widens a cohort. */
export function normalizeWmsErpCogsAlignmentJob(value: unknown): WmsErpCogsAlignmentJobData {
  const bad = () => { throw new BadRequestException('INVALID_WMS_ERP_COGS_ALIGNMENT_JOB'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const data = value as Record<string, unknown>;
  const keys = ['jobVersion', 'tenantId', 'runId', 'actorId', 'policy', 'previewSHA256', 'profileIds'];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(data, key))
    || data.jobVersion !== 1 || data.policy !== WMS_ERP_COGS_ALIGNMENT_POLICY
    || typeof data.tenantId !== 'string' || !UUID.test(data.tenantId)
    || typeof data.runId !== 'string' || !UUID.test(data.runId)
    || (data.actorId !== null && (typeof data.actorId !== 'string' || !UUID.test(data.actorId)))
    || typeof data.previewSHA256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.previewSHA256)
    || !Array.isArray(data.profileIds) || !data.profileIds.length || data.profileIds.length > 10_000
    || data.profileIds.some(id => typeof id !== 'string' || !UUID.test(id))) return bad();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(data)); } catch { return bad(); }
  if (bytes > 1_048_576) return bad();
  const profileIds = (data.profileIds as string[]).map(id => id.toLowerCase()).sort();
  if (new Set(profileIds).size !== profileIds.length) return bad();
  return {
    jobVersion: 1, tenantId: (data.tenantId as string).toLowerCase(), runId: (data.runId as string).toLowerCase(),
    actorId: data.actorId === null ? null : (data.actorId as string).toLowerCase(),
    policy: WMS_ERP_COGS_ALIGNMENT_POLICY, previewSHA256: data.previewSHA256 as string, profileIds,
  };
}

/** One explicit job, permanently retained for observation. No automatic retry. */
export function wmsErpCogsAlignmentJobOptions(input: WmsErpCogsAlignmentJobData): JobOptions {
  const data = normalizeWmsErpCogsAlignmentJob(input);
  return {
    jobId: `${WMS_ERP_COGS_ALIGNMENT_JOB}-${data.tenantId}-${data.runId}-${data.previewSHA256}`,
    attempts: 1, removeOnComplete: false, removeOnFail: false,
  };
}
