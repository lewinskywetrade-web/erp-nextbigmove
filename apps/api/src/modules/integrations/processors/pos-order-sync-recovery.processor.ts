import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { POS_ORDER_RECOVERY_JOB, POS_ORDER_RECOVERY_QUEUE, PosOrderRecoveryJobData } from '../pancake-webhook.constants';
import { PosOrderSyncRecoveryService } from '../services/pos-order-sync-recovery.service';

@Processor(POS_ORDER_RECOVERY_QUEUE)
export class PosOrderSyncRecoveryProcessor {
  constructor(private readonly recovery: PosOrderSyncRecoveryService) {}

  @Process({ name: POS_ORDER_RECOVERY_JOB, concurrency: 1 })
  async refresh(job: Job<PosOrderRecoveryJobData>) {
    return this.recovery.process(job.data.recoveryId, String(job.id));
  }
}
