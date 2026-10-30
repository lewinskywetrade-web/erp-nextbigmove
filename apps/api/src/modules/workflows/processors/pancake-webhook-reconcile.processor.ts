import { InjectQueue, Process, Processor, OnQueueFailed } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { ReconcileMarketingService } from '../services/reconcile-marketing.service';
import { ReconcileSalesService } from '../services/reconcile-sales.service';
import { ReconcileSalesAttributionService } from '../services/reconcile-sales-attribution.service';
import { WorkflowExecutionGateway } from '../gateways/workflow-execution.gateway';
import {
  PANCAKE_WEBHOOK_RECONCILE_JOB,
  PANCAKE_WEBHOOK_RECONCILE_QUEUE,
  PancakeWebhookReconcileJobData,
} from '../../integrations/pancake-webhook.constants';

const PANCAKE_RECONCILE_PROCESSOR_CONCURRENCY = (() => {
  const configured = Number(process.env.PANCAKE_RECONCILE_PROCESSOR_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 1;
})();
const QUEUE_METRICS_INTERVAL_MS = 30_000;
export const RECONCILE_METRICS_KEY = 'erp:metrics:pancake-reconcile';

@Processor(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
export class PancakeWebhookReconcileProcessor {
  private readonly logger = new Logger(PancakeWebhookReconcileProcessor.name);
  private lastQueueMetricsAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconcileMarketingService: ReconcileMarketingService,
    private readonly reconcileSalesService: ReconcileSalesService,
    private readonly reconcileSalesAttributionService: ReconcileSalesAttributionService,
    private readonly executionGateway: WorkflowExecutionGateway,
    @InjectQueue(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
    private readonly reconcileQueue: Queue,
  ) {}

  @Process({
    name: PANCAKE_WEBHOOK_RECONCILE_JOB,
    concurrency: PANCAKE_RECONCILE_PROCESSOR_CONCURRENCY,
  })
  async handleReconcile(job: Job<PancakeWebhookReconcileJobData>) {
    const startedAt = Date.now();
    const { tenantId, dateLocal, requestId, logId, trigger } = job.data;
    const reconcileMode = job.data.reconcileMode === 'incremental' ? 'incremental' : 'full_reset';

    this.logger.debug(
      `Processing webhook reconcile job ${job.id} tenant=${tenantId} date=${dateLocal} mode=${reconcileMode} trigger=${trigger || 'standard'} request=${requestId || 'n/a'} log=${logId || 'n/a'}`,
    );

    if (reconcileMode === 'full_reset') {
      const dayStart = new Date(`${dateLocal}T00:00:00.000Z`);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      // Mirror manual reconcile behavior: reset day rows first, then rebuild.
      await this.prisma.$transaction([
        this.prisma.reconcileSales.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        }),
        this.prisma.reconcileSalesAttribution.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        }),
        this.prisma.reconcileMarketing.deleteMany({
          where: {
            tenantId,
            date: {
              gte: dayStart,
              lt: dayEnd,
            },
          },
        }),
      ]);
    }

    await this.reconcileMarketingService.reconcileDay(tenantId, dateLocal);
    await this.reconcileSalesService.aggregateDay(tenantId, dateLocal);
    await this.reconcileSalesAttributionService.aggregateDay(tenantId, dateLocal);

    this.executionGateway.emitTenantEvent(
      tenantId,
      null,
      'orders:confirmation:updated',
      {
        tenantId,
        teamId: null,
        date: dateLocal,
        source: 'pancake_webhook_reconcile',
      },
    );

    this.executionGateway.emitTenantEvent(
      tenantId,
      null,
      'marketing:updated',
      {
        tenantId,
        teamId: null,
        date: dateLocal,
        source: 'pancake_webhook_reconcile',
      },
    );

    this.logger.log(
      `Processed webhook reconcile tenant=${tenantId} date=${dateLocal} mode=${reconcileMode} scheduledFor=${job.data.scheduledFor ?? 'n/a'} queueLagMs=${this.getQueueLagMs(job)} durationMs=${Date.now() - startedAt}`,
    );
    void this.recordFreshnessMetric(job, startedAt);
    void this.logQueueMetrics();
  }

  /** Keeps the latest reconcile timings (job creation = first order update
   * of the batch -> rollup rebuilt) for freshness diagnostics. Best effort. */
  private async recordFreshnessMetric(job: Job<PancakeWebhookReconcileJobData>, startedAt: number) {
    try {
      const finishedAt = Date.now();
      const client: any = (this.reconcileQueue as any)?.client;
      if (!client?.lpush) return;
      await client.lpush(RECONCILE_METRICS_KEY, JSON.stringify({
        tenantId: job.data.tenantId,
        dateLocal: job.data.dateLocal,
        jobId: String(job.id ?? ''),
        createdAt: job.timestamp,
        finishedAt,
        durationMs: finishedAt - startedAt,
        createdToDoneMs: Math.max(0, finishedAt - (Number(job.timestamp) || finishedAt)),
      }));
      await client.ltrim(RECONCILE_METRICS_KEY, 0, 1999);
    } catch {
      // Diagnostics must never affect reconciliation.
    }
  }

  @OnQueueFailed()
  onFailed(job: Job<PancakeWebhookReconcileJobData>, error: any) {
    const data = job?.data || ({} as PancakeWebhookReconcileJobData);
    this.logger.error(
      `Webhook reconcile job failed job=${job?.id} tenant=${data.tenantId} date=${data.dateLocal}: ${error?.message || 'Unknown error'}`,
      error?.stack,
    );
    void this.logQueueMetrics();
  }

  private getQueueLagMs(job: Job) {
    const scheduledAt = job.timestamp + Math.max(Number(job.opts.delay) || 0, 0);
    const processedAt = job.processedOn ?? Date.now();
    return Math.max(processedAt - scheduledAt, 0);
  }

  private async logQueueMetrics() {
    const now = Date.now();
    if (now - this.lastQueueMetricsAt < QUEUE_METRICS_INTERVAL_MS) {
      return;
    }
    this.lastQueueMetricsAt = now;

    try {
      const counts = await this.reconcileQueue.getJobCounts();
      this.logger.log(
        `Pancake reconcile queue waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0} failed=${counts.failed ?? 0}`,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to read Pancake reconcile queue metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
