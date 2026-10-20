import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import {
  PANCAKE_WEBHOOK_RECONCILE_JOB,
  PANCAKE_WEBHOOK_RECONCILE_QUEUE,
} from '../../integrations/pancake-webhook.constants';
import {
  cogsRefreshJobOptions,
  normalizeCogsRefreshDates,
  normalizeCogsRefreshJob,
  PRODUCT_COGS_REFRESH_JOB,
  PRODUCT_COGS_REFRESH_PAGE_SIZE,
  ProductCogsRefreshJobData,
} from '../../integrations/product-cogs-refresh.constants';
import { ProductCogsRecalculationService } from '../../integrations/services/product-cogs-recalculation.service';
import { isProductCogsRefreshDate, productCogsManilaDate } from '../../integrations/product-cogs-refresh-policy';

@Processor(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
export class ProductCogsRefreshProcessor {
  constructor(
    private readonly recalculation: ProductCogsRecalculationService,
    @InjectQueue(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
    private readonly queue: Queue,
  ) {}

  @Process({ name: PRODUCT_COGS_REFRESH_JOB, concurrency: 1 })
  async handleRefresh(job: Job<ProductCogsRefreshJobData>): Promise<void> {
    const data = normalizeCogsRefreshJob(job.data);
    const scope = { tenantId: data.tenantId, storeId: data.storeId, changes: data.changes };
    if (!data.cursor) {
      // The producer publishes while holding the source parent locks. Waiting
      // for those locks prevents a fast worker from observing uncommitted costs.
      await this.recalculation.waitForSourceTransaction(scope);
    }
    const result = await this.recalculation.recalculateBatch({
      ...scope,
      cursor: data.cursor,
      pageSize: PRODUCT_COGS_REFRESH_PAGE_SIZE,
    });
    // Also filter durable dates from jobs published before this policy, so an
    // older continuation cannot rebuild archived 2025 report rows.
    const today = productCogsManilaDate();
    const affectedDates = normalizeCogsRefreshDates([...data.affectedDates, ...result.affectedDates])
      .filter(date => isProductCogsRefreshDate(date, today));
    if (result.nextCursor) {
      if (result.nextCursor === data.cursor) throw new Error('COGS_REFRESH_CURSOR_DID_NOT_ADVANCE');
      const continuation = normalizeCogsRefreshJob({ ...data, cursor: result.nextCursor, affectedDates });
      await this.queue.add(PRODUCT_COGS_REFRESH_JOB, continuation,
        cogsRefreshJobOptions(`product-cogs-refresh-${data.refreshId}-${result.nextCursor}`));
      return;
    }

    // Rebuild only after the complete scoped scan. Each affected day is queued
    // once per edit; newer edits have distinct IDs and cannot be lost behind an
    // already-running reconciliation. A failed enqueue retries this same final
    // page with its durable accumulated dates, including already-correct rows.
    for (const dateLocal of affectedDates) {
      await this.queue.add(PANCAKE_WEBHOOK_RECONCILE_JOB, {
        tenantId: data.tenantId,
        teamId: null,
        dateLocal,
        reconcileMode: 'incremental',
        trigger: 'standard',
        requestId: data.refreshId,
      }, cogsRefreshJobOptions(`product-cogs-reconcile-${data.refreshId}-${dateLocal}`));
    }
    // Existing reconcile-day processing runs marketing -> sales -> attribution.
    // The last step bumps the shared tenant analytics cache version before its
    // update events are emitted, invalidating every report cache namespace.
  }
}
