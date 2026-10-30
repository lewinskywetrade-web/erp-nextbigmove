import { describe, expect, it } from '@jest/globals';
import {
  DEFAULT_PANCAKE_RECONCILE_MAX_DELAY_MS,
  buildPancakeReconcileWindow,
  enqueueCoalescedPancakeReconcile,
  resolveAutomaticPancakeReconcileMode,
  resolvePancakeReconcileDelayMs,
} from './pancake-webhook-reconcile.util';

describe('Pancake webhook reconciliation', () => {
  it('uses incremental mode by default and unless automatic full resets are explicitly enabled', () => {
    expect(resolveAutomaticPancakeReconcileMode(undefined, false)).toBe('incremental');
    expect(resolveAutomaticPancakeReconcileMode('full_reset', false)).toBe('incremental');
    expect(resolveAutomaticPancakeReconcileMode('full_reset', true)).toBe('full_reset');
  });

  it('coalesces tenant/date work into a fixed reconciliation window', () => {
    const first = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 300_000,
      nowMs: 1_000_000,
    });
    const second = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 300_000,
      nowMs: 1_100_000,
    });

    expect(first.jobId).toBe(second.jobId);
    expect(first.scheduledFor).toBe(second.scheduledFor);
    expect(second.delayMs).toBeLessThan(first.delayMs);
  });

  it('creates a trailing window for an event arriving after the boundary', () => {
    const beforeBoundary = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 300_000,
      nowMs: 1_199_999,
    });
    const afterBoundary = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 300_000,
      nowMs: 1_200_001,
    });

    expect(afterBoundary.jobId).not.toBe(beforeBoundary.jobId);
  });

  it('keeps destructive corrections separate from the normal debounce window', () => {
    const standard = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 300_000,
      nowMs: 1_000_000,
    });
    const destructive = buildPancakeReconcileWindow({
      tenantId: 'tenant-1',
      dateLocal: '2026-08-17',
      delayMs: 15_000,
      trigger: 'destructive_order_change',
      nowMs: 1_000_000,
    });

    expect(destructive.jobId).toContain('pancake-reconcile:destructive:');
    expect(destructive.jobId).not.toBe(standard.jobId);
    expect(destructive.delayMs).toBeLessThan(standard.delayMs);
  });
});

describe('bounded Pancake reconcile coalescing', () => {
  function fakeQueue(initial: Record<string, string> = {}) {
    const jobs = new Map<string, string>(Object.entries(initial));
    const removed: string[] = [];
    const added: Array<{ jobId: string; delay: number; data: any }> = [];
    const queue = {
      getJob: async (jobId: string) => jobs.has(jobId) ? {
        getState: async () => jobs.get(jobId)!,
        remove: async () => { jobs.delete(jobId); removed.push(jobId); },
      } : null,
      add: async (_name: string, data: any, opts: any) => {
        if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, 'delayed');
        added.push({ jobId: opts.jobId, delay: opts.delay, data });
      },
    };
    return { queue, jobs, removed, added };
  }
  const base = 'pancake-reconcile:t1:2026-10-30';
  const run = (queue: any, nowMs = 1_000_000) => enqueueCoalescedPancakeReconcile({
    queue, jobName: 'reconcile-day', tenantId: 't1', dateLocal: '2026-10-30', delayMs: 10_000,
    data: { tenantId: 't1', dateLocal: '2026-10-30' }, options: { attempts: 3, delay: 999_999 }, nowMs,
  });

  it('queues one short-delay pending run and coalesces later updates into it', async () => {
    const f = fakeQueue();
    expect(await run(f.queue)).toBe('queued');
    expect(await run(f.queue)).toBe('coalesced');
    expect(await run(f.queue)).toBe('coalesced');
    expect(f.added).toHaveLength(1);
    expect(f.added[0]).toMatchObject({ jobId: `${base}:pending`, delay: 10_000 });
    expect(f.added[0].data.scheduledFor).toBe(new Date(1_010_000).toISOString());
  });

  it('adds exactly one follow-up while the pending run is already active', async () => {
    const f = fakeQueue({ [`${base}:pending`]: 'active' });
    expect(await run(f.queue)).toBe('queued_followup');
    expect(await run(f.queue)).toBe('coalesced');
    expect(f.added.map(a => a.jobId)).toEqual([`${base}:followup`]);
  });

  it('clears a retained failed/completed job so its ID cannot block new work', async () => {
    const f = fakeQueue({ [`${base}:pending`]: 'failed' });
    expect(await run(f.queue)).toBe('queued');
    expect(f.removed).toEqual([`${base}:pending`]);
    expect(f.jobs.get(`${base}:pending`)).toBe('delayed');
  });

  it('never grows beyond pending + follow-up per tenant/day except when both run', async () => {
    const f = fakeQueue({ [`${base}:pending`]: 'active', [`${base}:followup`]: 'active' });
    expect(await run(f.queue, 1_234_567)).toBe('queued_followup');
    expect(f.added[0].jobId).toBe(`${base}:overflow:123`);
  });

  it('caps legacy five-minute settings to seconds', () => {
    expect(resolvePancakeReconcileDelayMs({ configuredMs: 300_000 })).toBe(DEFAULT_PANCAKE_RECONCILE_MAX_DELAY_MS);
    expect(resolvePancakeReconcileDelayMs({ configuredMs: 300_000, maxDelayMs: 20_000 })).toBe(20_000);
    expect(resolvePancakeReconcileDelayMs({ configuredMs: 5_000, maxDelayMs: 20_000 })).toBe(5_000);
    expect(resolvePancakeReconcileDelayMs({ configuredMs: 10, maxDelayMs: NaN })).toBe(3_000);
  });
});
