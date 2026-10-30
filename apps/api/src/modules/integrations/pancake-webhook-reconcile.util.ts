export type PancakeWebhookReconcileMode = 'incremental' | 'full_reset';
export type PancakeWebhookReconcileTrigger = 'standard' | 'destructive_order_change';

/** Upper bound for how long an ordinary order update may wait before its day
 * rollup is rebuilt. Older deployments configured a five-minute window; any
 * larger tenant/env setting is capped so reports refresh within seconds. */
export const DEFAULT_PANCAKE_RECONCILE_MAX_DELAY_MS = 10_000;
export const MIN_PANCAKE_RECONCILE_DELAY_MS = 3_000;

export function resolveAutomaticPancakeReconcileMode(
  configuredMode: PancakeWebhookReconcileMode | undefined,
  allowAutomaticFullReset: boolean,
): PancakeWebhookReconcileMode {
  if (allowAutomaticFullReset && configuredMode === 'full_reset') {
    return 'full_reset';
  }

  return 'incremental';
}

export function resolvePancakeReconcileDelayMs(params: {
  configuredMs: number;
  maxDelayMs?: number;
}): number {
  const max = Number.isFinite(params.maxDelayMs) && (params.maxDelayMs as number) > 0
    ? Math.max(MIN_PANCAKE_RECONCILE_DELAY_MS, Math.floor(params.maxDelayMs as number))
    : DEFAULT_PANCAKE_RECONCILE_MAX_DELAY_MS;
  const configured = Number.isFinite(params.configuredMs) && params.configuredMs > 0
    ? Math.floor(params.configuredMs)
    : max;
  return Math.max(MIN_PANCAKE_RECONCILE_DELAY_MS, Math.min(configured, max));
}

export function buildPancakeReconcileWindow(params: {
  tenantId: string;
  dateLocal: string;
  delayMs: number;
  trigger?: PancakeWebhookReconcileTrigger;
  nowMs?: number;
}) {
  const nowMs = params.nowMs ?? Date.now();
  const windowMs = Math.max(10_000, Math.floor(params.delayMs));
  const scheduledForMs = (Math.floor(nowMs / windowMs) + 1) * windowMs;
  const triggerSegment =
    params.trigger === 'destructive_order_change' ? ':destructive' : '';

  return {
    jobId: `pancake-reconcile${triggerSegment}:${params.tenantId}:${params.dateLocal}:${scheduledForMs}`,
    delayMs: Math.max(0, scheduledForMs - nowMs),
    scheduledFor: new Date(scheduledForMs).toISOString(),
  };
}

type ReconcileQueueJob = { getState(): Promise<string>; remove(): Promise<void> };
export type ReconcileQueueLike = {
  getJob(jobId: string): Promise<ReconcileQueueJob | null | undefined>;
  add(name: string, data: any, opts: any): Promise<unknown>;
};
export type PancakeReconcileSlotResult = 'queued' | 'queued_followup' | 'coalesced';

const PENDING_STATES = new Set(['waiting', 'delayed', 'paused', 'waiting-children']);
const FINISHED_STATES = new Set(['completed', 'failed', 'stuck', 'unknown']);

/**
 * Bounded per tenant/day coalescing: at most one queued run plus one follow-up
 * while a run is active. Order rows are written before this is called, so a
 * queued (not yet started) run is guaranteed to read the new data; only an
 * already-active run needs a follow-up. Unlike fixed time windows this can
 * never build an unbounded backlog, which allows a short delay.
 */
export async function enqueueCoalescedPancakeReconcile(params: {
  queue: ReconcileQueueLike;
  jobName: string;
  tenantId: string;
  dateLocal: string;
  delayMs: number;
  data: Record<string, any>;
  options: Record<string, any>;
  nowMs?: number;
}): Promise<PancakeReconcileSlotResult> {
  const base = `pancake-reconcile:${params.tenantId}:${params.dateLocal}`;
  const nowMs = params.nowMs ?? Date.now();
  const scheduledFor = new Date(nowMs + Math.max(0, params.delayMs)).toISOString();
  const add = async (jobId: string) => {
    await params.queue.add(params.jobName, { ...params.data, scheduledFor }, {
      ...params.options,
      jobId,
      delay: Math.max(0, params.delayMs),
    });
  };
  // Returns the slot's state after clearing a retained finished job, so a
  // failed/completed job with the same deterministic ID cannot block re-adds.
  const slotState = async (jobId: string): Promise<string | null> => {
    const job = await params.queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState();
    if (FINISHED_STATES.has(state)) {
      await job.remove().catch(() => undefined);
      return null;
    }
    return state;
  };

  const pending = await slotState(`${base}:pending`);
  if (pending !== null && PENDING_STATES.has(pending)) return 'coalesced';
  if (pending === null) {
    await add(`${base}:pending`);
    return 'queued';
  }
  // The pending slot is running and may have read rows before this update.
  const followup = await slotState(`${base}:followup`);
  if (followup !== null && PENDING_STATES.has(followup)) return 'coalesced';
  if (followup === null) {
    await add(`${base}:followup`);
    return 'queued_followup';
  }
  // Both slots active (only possible with processor concurrency > 1 or a
  // stalled-job restart): fall back to a unique time-bucketed follow-up.
  await add(`${base}:overflow:${Math.floor(nowMs / 10_000)}`);
  return 'queued_followup';
}
