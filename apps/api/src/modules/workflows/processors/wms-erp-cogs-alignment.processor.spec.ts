import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'crypto';
import { WmsErpCogsAlignmentProcessor } from './wms-erp-cogs-alignment.processor';
import {
  normalizeWmsErpCogsAlignmentJob, wmsErpCogsAlignmentJobOptions, WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS,
  WMS_ERP_COGS_ALIGNMENT_POLICY, WmsErpCogsAlignmentJobData,
} from '../wms-erp-cogs-alignment.constants';
import { WMS_ERP_COGS_POLICY } from '../../product-cogs/wms-cogs-sync.service';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const payload = (count = 1): WmsErpCogsAlignmentJobData => ({ jobVersion: 1, tenantId: id(90000), runId: id(90001),
  actorId: null, policy: WMS_ERP_COGS_ALIGNMENT_POLICY, previewSHA256: 'a'.repeat(64),
  profileIds: Array.from({ length: count }, (_, n) => id(n + 1)).reverse() });
const statuses = ['SYNCED_FROM_WMS', 'FILLED_WMS_FROM_ERP', 'ALREADY_EQUAL', 'SKIPPED'] as const;
const response = (input: any) => ({ enabled: true, policy: WMS_ERP_COGS_ALIGNMENT_POLICY,
  outcomes: input.profileIds.map((profileId: string) => {
    const n = Number(profileId.slice(-12)); const status = statuses[(n - 1) % 4];
    return { profileId, productId: id(n + 20000), status, auditLogId: id(n + 30000),
      ...(status === 'SKIPPED' ? { reason: 'BOTH_WMS_AND_CURRENT_ERP_COST_MISSING' } : {}) };
  }) });

describe('explicit WMS ERP COGS alignment worker', () => {
  type AsyncMock = ReturnType<typeof jest.fn<(...args: any[]) => Promise<any>>>;
  let sync: { alignExistingProfiles: AsyncMock };
  let processor: WmsErpCogsAlignmentProcessor;
  const job = (data: any = payload(), opts: any = wmsErpCogsAlignmentJobOptions(payload())) => ({ data, opts,
    progress: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined) } as any);

  beforeEach(() => {
    sync = { alignExistingProfiles: jest.fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async input => response(input)) };
    processor = new WmsErpCogsAlignmentProcessor(sync as any);
  });

  it('keeps the shared policy exact and validates an explicit unique ordered cohort', () => {
    expect(WMS_ERP_COGS_ALIGNMENT_POLICY).toBe(WMS_ERP_COGS_POLICY);
    const input = payload(3); expect(normalizeWmsErpCogsAlignmentJob(input).profileIds).toEqual([id(1), id(2), id(3)]);
    expect(input.profileIds).toEqual([id(3), id(2), id(1)]);
    expect(normalizeWmsErpCogsAlignmentJob(payload(10000)).profileIds).toHaveLength(10000);
  });

  it('rejects scope widening, duplicate targets, missing actors, wrong policy and excessive cohorts before mutation', async () => {
    const bad: any[] = [{ ...payload(), tenantId: 'other' }, { ...payload(), actorId: undefined },
      { ...payload(), profileIds: [id(1), id(1).toUpperCase()] }, { ...payload(), profileIds: [] },
      { ...payload(), runId: '------------------------------------' }, { ...payload(), policy: 'ERP_ONLY' },
      { ...payload(), sourceRef: 'other' }, { ...payload(), previewSHA256: 'bad' }, payload(10001)];
    for (const value of bad) await expect(processor.handleAlignment(job(value))).rejects.toThrow('INVALID_WMS_ERP_COGS_ALIGNMENT_JOB');
    expect(sync.alignExistingProfiles).not.toHaveBeenCalled();
  });

  it('requires one permanently retained job and exposes no automatic retry or timeout option', async () => {
    const options = wmsErpCogsAlignmentJobOptions(payload());
    expect(options).toEqual(expect.objectContaining({ attempts: 1, removeOnComplete: false, removeOnFail: false }));
    expect(options).not.toHaveProperty('timeout'); expect(options).not.toHaveProperty('backoff');
    for (const opts of [{ ...options, attempts: 2 }, { ...options, removeOnComplete: true }, { ...options, removeOnFail: true },
      { ...options, timeout: 1000 }, { ...options, repeat: { every: 1000 } }]) {
      await expect(processor.handleAlignment(job(payload(), opts))).rejects.toThrow('REQUIRES_RETAINED_SINGLE_ATTEMPT_JOB');
    }
    expect(sync.alignExistingProfiles).not.toHaveBeenCalled();
  });

  it('binds deterministic job identity to exact tenant, run and reviewed preview', () => {
    const a = payload(); expect(wmsErpCogsAlignmentJobOptions(a).jobId).toBe(wmsErpCogsAlignmentJobOptions({ ...a }).jobId);
    expect(wmsErpCogsAlignmentJobOptions({ ...a, previewSHA256: 'b'.repeat(64) }).jobId).not.toBe(wmsErpCogsAlignmentJobOptions(a).jobId);
    expect(wmsErpCogsAlignmentJobOptions({ ...a, tenantId: id(90002) }).jobId).not.toBe(wmsErpCogsAlignmentJobOptions(a).jobId);
  });

  it('processes exact ordered batches25/25/1, awaiting each and counting skip/equal/source/fallback decisions honestly', async () => {
    const data = payload(51), j = job(data); const result = await processor.handleAlignment(j);
    expect(sync.alignExistingProfiles.mock.calls.map(c => c[0].profileIds.length)).toEqual([25, 25, 1]);
    for (const [input] of sync.alignExistingProfiles.mock.calls) expect(input).toEqual(expect.objectContaining({ tenantId: data.tenantId,
      runId: data.runId, actorId: null, sourceRef: data.previewSHA256 }));
    expect(sync.alignExistingProfiles.mock.calls.flatMap(c => c[0].profileIds)).toEqual(normalizeWmsErpCogsAlignmentJob(data).profileIds);
    expect(result.complete).toBe(true); expect(result.completedProfileCount).toBe(51); expect(result.remainingProfileCount).toBe(0);
    expect(result.statusCounts).toEqual({ SYNCED_FROM_WMS: 13, FILLED_WMS_FROM_ERP: 13, ALREADY_EQUAL: 13, SKIPPED: 12 });
    expect(result.skippedReasons).toEqual({ BOTH_WMS_AND_CURRENT_ERP_COST_MISSING: 12 });
    expect(result.completedProfileIdsSHA256).toBe(digest(normalizeWmsErpCogsAlignmentJob(data).profileIds));
    expect(result.currentAlignmentVerified).toBe(false); expect(result.reportCompletionVerified).toBe(false);
    expect(result.orderRecalculationCompletionVerified).toBe(false); expect(result.automaticContinuationScheduled).toBe(false);
    expect(j.progress.mock.calls.filter((c: any[]) => c[0].phase === 'BEFORE_BATCH')).toHaveLength(3);
  });

  it('fails disabled synchronization without pretending empty decisions covered requested profiles', async () => {
    sync.alignExistingProfiles.mockResolvedValue({ enabled: false, policy: WMS_ERP_COGS_ALIGNMENT_POLICY, outcomes: [] });
    const j = job(); await expect(processor.handleAlignment(j)).rejects.toThrow('DISABLED_OR_POLICY_CHANGED');
    expect(j.progress.mock.calls[j.progress.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({ complete: false, completedProfileCount: 0,
      inFlightProfileIds: [id(1)], auditRecoveryRequiredForInFlightProfiles: true }));
  });

  it('refuses missing, duplicate, foreign or unaudited batch outcomes without advancing its prefix', async () => {
    const data = payload(2), base = response({ profileIds: [id(1), id(2)] });
    const bad = [{ ...base, outcomes: base.outcomes.slice(0, 1) },
      { ...base, outcomes: [base.outcomes[0], base.outcomes[0]] },
      { ...base, outcomes: [base.outcomes[0], { ...base.outcomes[1], profileId: id(99) }] },
      { ...base, outcomes: [base.outcomes[0], { ...base.outcomes[1], auditLogId: undefined }] },
      { ...base, outcomes: [base.outcomes[0], { ...base.outcomes[1], auditLogId: base.outcomes[0].auditLogId }] }];
    for (const value of bad) {
      sync.alignExistingProfiles.mockResolvedValue(value); const j = job(data);
      await expect(processor.handleAlignment(j)).rejects.toThrow('WMS_ERP_COGS_ALIGNMENT_');
      expect(j.progress.mock.calls[j.progress.mock.calls.length - 1]?.[0].completedProfileCount).toBe(0);
    }
  });

  it('records a batch failure as uncertain while preserving completed decisions and never starting another batch', async () => {
    sync.alignExistingProfiles.mockImplementationOnce(async input => response(input)).mockRejectedValueOnce(new Error('commit acknowledgement lost'));
    const j = job(payload(51)); await expect(processor.handleAlignment(j)).rejects.toThrow('commit acknowledgement lost');
    expect(sync.alignExistingProfiles).toHaveBeenCalledTimes(2);
    expect(j.progress.mock.calls[j.progress.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({ complete: false, completedProfileCount: 25,
      remainingProfileCount: 26, auditRecoveryRequiredForInFlightProfiles: true, inFlightProfileIds: Array.from({ length: 25 }, (_, n) => id(n + 26)) }));
  });

  it('preserves committed progress when its Redis acknowledgement fails; no implicit replay is started', async () => {
    const j = job(payload(26)); j.progress.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('progress ACK lost'));
    await expect(processor.handleAlignment(j)).rejects.toThrow('progress ACK lost');
    expect(sync.alignExistingProfiles).toHaveBeenCalledTimes(1);
    expect(j.progress.mock.calls[j.progress.mock.calls.length - 1]?.[0]).toEqual(expect.objectContaining({ completedProfileCount: 25, remainingProfileCount: 1, complete: false }));
  });

  it('does not abandon an in-flight transaction on a timer or start a new batch near the 15min bound', async () => {
    let clock = 0; jest.spyOn(processor as any, 'now').mockImplementation(() => clock);
    sync.alignExistingProfiles.mockImplementation(async input => { clock = WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS - 1; return response(input); });
    const j = job(payload(26)); await expect(processor.handleAlignment(j)).rejects.toThrow('TIME_BOUND_REQUIRES_AUDIT_REVIEW');
    expect(sync.alignExistingProfiles).toHaveBeenCalledTimes(1); expect(j.progress.mock.calls[j.progress.mock.calls.length - 1]?.[0].completedProfileCount).toBe(25);
  });

  it('can report durable replay decisions from the same explicit job without changing the decision digest', async () => {
    const first = await processor.handleAlignment(job(payload(4)));
    sync.alignExistingProfiles.mockImplementation(async input => ({ ...response(input), outcomes: response(input).outcomes.map((v: any) => ({ ...v, replayed: true })) }));
    const replay = await processor.handleAlignment(job(payload(4)));
    expect(replay.replayedDecisions).toBe(4); expect(replay.statusCounts).toEqual(first.statusCounts);
    expect(replay.completedDecisionAuditIdsSHA256).toBe(first.completedDecisionAuditIdsSHA256);
  });
});
