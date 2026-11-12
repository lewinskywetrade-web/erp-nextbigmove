import { InjectQueue, Process, Processor, OnQueueFailed } from '@nestjs/bull';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { shouldRunPancakeWorkers } from '../../../common/runtime/process-role';
import { IntegrationService } from '../integration.service';
import {
  PANCAKE_WEBHOOK_AUTO_CANCEL_JOB,
  PANCAKE_WEBHOOK_JOB,
  PANCAKE_WEBHOOK_QUEUE,
  PANCAKE_WEBHOOK_REPORTS_HYDRATE_JOB,
  PancakeWebhookAutoCancelJobData,
  PancakeWebhookJobData,
  PancakeWebhookReportsHydrateJobData,
} from '../pancake-webhook.constants';

function positiveIntegerFromEnv(name: string, fallback: number) {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : fallback;
}

const PANCAKE_WEBHOOK_PROCESSOR_CONCURRENCY = positiveIntegerFromEnv(
  'PANCAKE_WEBHOOK_PROCESSOR_CONCURRENCY',
  2,
);
const PANCAKE_AUTO_CANCEL_PROCESSOR_CONCURRENCY = positiveIntegerFromEnv(
  'PANCAKE_AUTO_CANCEL_PROCESSOR_CONCURRENCY',
  1,
);
const PANCAKE_REPORTS_HYDRATE_PROCESSOR_CONCURRENCY = positiveIntegerFromEnv(
  'PANCAKE_REPORTS_HYDRATE_PROCESSOR_CONCURRENCY',
  1,
);
const QUEUE_METRICS_INTERVAL_MS = 30_000;

@Processor(PANCAKE_WEBHOOK_QUEUE)
export class PancakeWebhookQueueProcessor implements OnModuleInit {
  private readonly logger = new Logger(PancakeWebhookQueueProcessor.name);
  private lastQueueMetricsAt = 0;

  constructor(
    private readonly integrationService: IntegrationService,
    @InjectQueue(PANCAKE_WEBHOOK_QUEUE)
    private readonly pancakeWebhookQueue: Queue,
  ) {}

  onModuleInit() {
    if (!shouldRunPancakeWorkers()) {
      return;
    }
    const timer = setTimeout(() => {
      void this.purgeLegacyReportsNotAvailableFailedJobs();
    }, 5_000);
    timer.unref?.();
  }

  async purgeLegacyReportsNotAvailableFailedJobs(): Promise<number> {
    if (typeof this.pancakeWebhookQueue?.getFailed !== 'function') {
      return 0;
    }
    try {
      const failedJobs = await this.pancakeWebhookQueue.getFailed(0, 2000);
      let purged = 0;
      for (const job of failedJobs) {
        const reason = typeof job?.failedReason === 'string' ? job.failedReason : '';
        if (reason.includes('reports_by_phone not available yet')) {
          try {
            await job.remove();
            purged += 1;
          } catch {
            // Ignore race if job was already cleaned up
          }
        }
      }
      if (purged > 0) {
        this.logger.log(
          `Purged ${purged} legacy "reports_by_phone not available yet" failed jobs from ${PANCAKE_WEBHOOK_QUEUE}`,
        );
      }
      return purged;
    } catch (error) {
      this.logger.warn(
        `Skipped legacy reports_by_phone failed-job cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  @Process({
    name: PANCAKE_WEBHOOK_JOB,
    concurrency: PANCAKE_WEBHOOK_PROCESSOR_CONCURRENCY,
  })
  async handleIngest(job: Job<PancakeWebhookJobData>) {
    const startedAt = Date.now();
    const { logId, tenantId, requestId } = job.data;

    this.logger.debug(
      `Processing Pancake webhook job ${job.id} log=${logId} tenant=${tenantId}`,
    );

    const result = await this.integrationService.processQueuedPancakeWebhookEvent(job.data, {
      jobId: job.id?.toString?.() || String(job.id),
      attempts: (job.attemptsMade || 0) + 1,
    });
    const durationMs = Date.now() - startedAt;

    this.logger.log(
      `Processed Pancake webhook log=${logId} request=${requestId} tenant=${tenantId} upserted=${result.upserted} warnings=${result.warnings.length} queueLagMs=${this.getQueueLagMs(job)} durationMs=${durationMs}`,
    );
    void this.logQueueMetrics();

    return result;
  }

  @Process({
    name: PANCAKE_WEBHOOK_AUTO_CANCEL_JOB,
    concurrency: PANCAKE_AUTO_CANCEL_PROCESSOR_CONCURRENCY,
  })
  async handleAutoCancel(job: Job<PancakeWebhookAutoCancelJobData>) {
    const startedAt = Date.now();
    const { tenantId, shopId, orderId } = job.data;

    this.logger.debug(
      `Processing auto-cancel job ${job.id} tenant=${tenantId} shop=${shopId} order=${orderId}`,
    );

    const result = await this.integrationService.processPancakeAutoCancelJob(job.data);
    const durationMs = Date.now() - startedAt;

    if (result.success) {
      this.logger.log(
        `Auto-cancel sent tenant=${tenantId} shop=${shopId} order=${orderId} durationMs=${durationMs}`,
      );
    } else {
      this.logger.debug(
        `Auto-cancel skipped tenant=${tenantId} shop=${shopId} order=${orderId} reason=${result.reason} durationMs=${durationMs}`,
      );
    }

    return result;
  }

  @Process({
    name: PANCAKE_WEBHOOK_REPORTS_HYDRATE_JOB,
    concurrency: PANCAKE_REPORTS_HYDRATE_PROCESSOR_CONCURRENCY,
  })
  async handleReportsHydrate(job: Job<PancakeWebhookReportsHydrateJobData>) {
    const startedAt = Date.now();
    const { tenantId, shopId, orderId } = job.data;

    this.logger.debug(
      `Processing reports hydrate job ${job.id} tenant=${tenantId} shop=${shopId} order=${orderId}`,
    );

    const result = await this.integrationService.processPancakeReportsHydrateJob(job.data);
    const durationMs = Date.now() - startedAt;

    if (result.success) {
      this.logger.log(
        `Reports hydrate done tenant=${tenantId} shop=${shopId} order=${orderId} hydrated=${result.hydrated ? 1 : 0} durationMs=${durationMs}`,
      );
    } else {
      this.logger.debug(
        `Reports hydrate skipped tenant=${tenantId} shop=${shopId} order=${orderId} reason=${result.reason} durationMs=${durationMs}`,
      );
    }

    return result;
  }

  @OnQueueFailed()
  onFailed(
    job: Job<
      PancakeWebhookJobData
      | PancakeWebhookAutoCancelJobData
      | PancakeWebhookReportsHydrateJobData
    >,
    error: any,
  ) {
    const { logId, tenantId, requestId } = (job?.data || {}) as PancakeWebhookJobData;
    const asAutoCancel = (job?.data || {}) as PancakeWebhookAutoCancelJobData;
    const asReportsHydrate = (job?.data || {}) as PancakeWebhookReportsHydrateJobData;
    this.logger.error(
      `Pancake webhook job failed log=${logId || 'n/a'} request=${requestId || 'n/a'} tenant=${tenantId || asAutoCancel.tenantId || asReportsHydrate.tenantId || 'n/a'} shop=${asAutoCancel.shopId || asReportsHydrate.shopId || 'n/a'} order=${asAutoCancel.orderId || asReportsHydrate.orderId || 'n/a'}: ${error?.message || 'Unknown error'}`,
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
      const counts = await this.pancakeWebhookQueue.getJobCounts();
      this.logger.log(
        `Pancake webhook queue waiting=${counts.waiting ?? 0} active=${counts.active ?? 0} delayed=${counts.delayed ?? 0} failed=${counts.failed ?? 0}`,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to read Pancake webhook queue metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
