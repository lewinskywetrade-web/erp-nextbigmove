import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { PANCAKE_WEBHOOK_RECONCILE_QUEUE } from '../../integrations/pancake-webhook.constants';
import { WmsCogsSyncService } from '../../product-cogs/wms-cogs-sync.service';
import {
  normalizeWmsErpCogsAlignmentJob, WMS_ERP_COGS_ALIGNMENT_BATCH_SIZE, WMS_ERP_COGS_ALIGNMENT_JOB,
  WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS, WmsErpCogsAlignmentJobData,
} from '../wms-erp-cogs-alignment.constants';

const STATUSES = ['SYNCED_FROM_WMS', 'FILLED_WMS_FROM_ERP', 'ALREADY_EQUAL', 'SKIPPED'] as const;
type Status = typeof STATUSES[number];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (value: unknown, code: string) => { if (!value) throw new Error(code); };

@Processor(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
export class WmsErpCogsAlignmentProcessor {
  constructor(private readonly sync: WmsCogsSyncService) {}
  private now() { return performance.now(); }

  @Process({ name: WMS_ERP_COGS_ALIGNMENT_JOB, concurrency: 1 })
  async handleAlignment(job: Job<WmsErpCogsAlignmentJobData>) {
    const data = normalizeWmsErpCogsAlignmentJob(job.data);
    check(job.opts.attempts === 1 && job.opts.removeOnComplete === false && job.opts.removeOnFail === false
      && job.opts.timeout === undefined && job.opts.repeat === undefined,
      'WMS_ERP_COGS_ALIGNMENT_REQUIRES_RETAINED_SINGLE_ATTEMPT_JOB');
    const started = this.now();
    const counts: Record<Status, number> = { SYNCED_FROM_WMS: 0, FILLED_WMS_FROM_ERP: 0, ALREADY_EQUAL: 0, SKIPPED: 0 };
    const skippedReasons: Record<string, number> = {};
    const completed: string[] = [];
    const decisions: Array<{ profileId: string; status: Status; auditLogId: string }> = [];
    const auditIds = new Set<string>();
    let inFlight: string[] = [];
    let batchesCompleted = 0;
    let replayedDecisions = 0;
    const progress = (phase: string, complete = false, stopReason?: string) => ({
      progressVersion: 1, phase, policy: data.policy, tenantId: data.tenantId, runId: data.runId,
      previewSHA256: data.previewSHA256, requestedProfileCount: data.profileIds.length,
      requestedProfileIdsSHA256: digest(data.profileIds), completedProfileCount: completed.length,
      completedProfileIdsSHA256: digest(completed), completedDecisionAuditIdsSHA256: digest(decisions),
      remainingProfileCount: data.profileIds.length - completed.length,
      lastCompletedProfileId: completed[completed.length - 1] ?? null,
      inFlightProfileIds: [...inFlight], batchesCompleted, statusCounts: { ...counts }, skippedReasons: { ...skippedReasons },
      replayedDecisions, complete, stopReason: stopReason ?? null,
      elapsedMs: Math.floor(this.now() - started), oneGlobalSnapshot: false,
      currentAlignmentVerified: false, orderRecalculationCompletionVerified: false, reportCompletionVerified: false,
      automaticContinuationScheduled: false, automaticRetryScheduled: false,
      auditRecoveryRequiredForInFlightProfiles: !!stopReason && inFlight.length > 0,
    });
    await job.progress(progress('VALIDATED'));
    try {
      for (let offset = 0; offset < data.profileIds.length; offset += WMS_ERP_COGS_ALIGNMENT_BATCH_SIZE) {
        // The service transaction is bounded to 30s. Do not start another near
        // the 15min boundary; never abandon a live transaction with Promise.race.
        check(this.now() - started < WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS - 30_000,
          'WMS_ERP_COGS_ALIGNMENT_TIME_BOUND_REQUIRES_AUDIT_REVIEW');
        inFlight = data.profileIds.slice(offset, offset + WMS_ERP_COGS_ALIGNMENT_BATCH_SIZE);
        await job.progress(progress('BEFORE_BATCH'));
        const result = await this.sync.alignExistingProfiles({ tenantId: data.tenantId, profileIds: inFlight,
          runId: data.runId, sourceRef: data.previewSHA256, actorId: data.actorId });
        check(result.enabled === true && result.policy === data.policy,
          'WMS_ERP_COGS_ALIGNMENT_DISABLED_OR_POLICY_CHANGED');
        check(Array.isArray(result.outcomes) && result.outcomes.length === inFlight.length,
          'WMS_ERP_COGS_ALIGNMENT_INCOMPLETE_DECISION_SET');
        const byId = new Map(result.outcomes.map(outcome => [outcome.profileId, outcome]));
        check(byId.size === inFlight.length && inFlight.every(id => byId.has(id)),
          'WMS_ERP_COGS_ALIGNMENT_DECISION_SCOPE_CHANGED');
        // Validate the whole returned batch before advancing its prefix. A
        // failure after commit remains recoverable through deterministic audits.
        const nextAuditIds = new Set<string>();
        for (const id of inFlight) {
          const row = byId.get(id)!;
          check(STATUSES.includes(row.status) && UUID.test(row.auditLogId ?? '')
            && !auditIds.has(row.auditLogId!) && !nextAuditIds.has(row.auditLogId!),
            'WMS_ERP_COGS_ALIGNMENT_ATOMIC_AUDIT_DECISION_REQUIRED');
          nextAuditIds.add(row.auditLogId!);
          check(row.status !== 'SKIPPED' || (typeof row.reason === 'string' && /^[A-Z0-9_]{1,100}$/.test(row.reason)),
            'WMS_ERP_COGS_ALIGNMENT_EXPLICIT_SKIP_REASON_REQUIRED');
        }
        for (const id of inFlight) {
          const row = byId.get(id)!;
          counts[row.status]++;
          if (row.status === 'SKIPPED') skippedReasons[row.reason!] = (skippedReasons[row.reason!] ?? 0) + 1;
          if (row.replayed) replayedDecisions++;
          auditIds.add(row.auditLogId!);
          decisions.push({ profileId: id, status: row.status, auditLogId: row.auditLogId! });
          completed.push(id);
        }
        inFlight = []; batchesCompleted++;
        await job.progress(progress('BATCH_DECISIONS_COMMITTED'));
        check(this.now() - started < WMS_ERP_COGS_ALIGNMENT_MAX_RUN_MS,
          'WMS_ERP_COGS_ALIGNMENT_TIME_BOUND_REQUIRES_AUDIT_REVIEW');
      }
      const result = progress('DECISIONS_COMPLETE', true);
      await job.progress(result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const reason = /^[A-Z][A-Z0-9_]{0,120}$/.test(message)
        ? message : 'WMS_ERP_COGS_ALIGNMENT_FAILED_REQUIRES_AUDIT_REVIEW';
      try { await job.progress(progress('STOPPED_REQUIRES_AUDIT_REVIEW', false, reason)); } catch { /* Atomic audits remain authoritative. */ }
      throw error;
    }
  }
}
