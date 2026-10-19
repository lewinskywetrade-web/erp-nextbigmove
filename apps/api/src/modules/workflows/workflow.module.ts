import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { WorkflowProcessorService } from './services/workflow-processor.service';
import { WorkflowSchedulerService } from './services/workflow-scheduler.service';
import { DateRangeService } from './services/date-range.service';
import { WorkflowExecutionGateway } from './gateways/workflow-execution.gateway';
import { WorkflowQueueProcessor } from './processors/workflow.processor';
import { MANUAL_META_UPLOAD_QUEUE, WORKFLOW_QUEUE } from './workflow.constants';
import { WorkflowLogService } from './services/workflow-log.service';
import { WorkflowProgressCacheService } from './services/workflow-progress-cache.service';
import { WorkflowExecutionReconcilerService } from './services/workflow-execution-reconciler.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { IntegrationModule } from '../integrations/integration.module';
import { ReconcileMarketingService } from './services/reconcile-marketing.service';
import { ReconcileSalesService } from './services/reconcile-sales.service';
import { ReconcileSalesAttributionService } from './services/reconcile-sales-attribution.service';
import { PancakeWebhookReconcileProcessor } from './processors/pancake-webhook-reconcile.processor';
import { ProductCogsRefreshProcessor } from './processors/product-cogs-refresh.processor';
import { PANCAKE_WEBHOOK_RECONCILE_QUEUE } from '../integrations/pancake-webhook.constants';
import { ManualMetaUploadProcessor } from './processors/manual-meta-upload.processor';
import {
  shouldRunApiBackgroundServices,
  shouldRunPancakeWorkers,
} from '../../common/runtime/process-role';

@Module({
  imports: [
    PrismaModule,
    IntegrationModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: WORKFLOW_QUEUE,
    }),
    BullModule.registerQueue({
      name: PANCAKE_WEBHOOK_RECONCILE_QUEUE,
    }),
    BullModule.registerQueue({
      name: MANUAL_META_UPLOAD_QUEUE,
    }),
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    WorkflowProcessorService,
    WorkflowSchedulerService,
    DateRangeService,
    WorkflowExecutionGateway,
    WorkflowLogService,
    WorkflowProgressCacheService,
    ReconcileMarketingService,
    ReconcileSalesService,
    ReconcileSalesAttributionService,
    ...(shouldRunApiBackgroundServices()
      ? [
          WorkflowQueueProcessor,
          WorkflowExecutionReconcilerService,
          ManualMetaUploadProcessor,
        ]
      : []),
    ...(shouldRunPancakeWorkers() ? [PancakeWebhookReconcileProcessor, ProductCogsRefreshProcessor] : []),
  ],
  exports: [WorkflowService, WorkflowExecutionGateway],
})
export class WorkflowModule {}
