import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { randomUUID } from 'crypto';
import { Queue } from 'bull';
import { PANCAKE_WEBHOOK_RECONCILE_QUEUE } from '../pancake-webhook.constants';
import {
  cogsRefreshJobOptions,
  normalizeCogsRefreshScope,
  PRODUCT_COGS_REFRESH_JOB,
  ProductCogsRefreshScope,
} from '../product-cogs-refresh.constants';

@Injectable()
export class ProductCogsRefreshPublisherService {
  constructor(
    @InjectQueue(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
    private readonly queue: Queue,
  ) {}

  /** Await inside the source transaction, after writes while its parent locks remain held. */
  async enqueue(input: ProductCogsRefreshScope): Promise<void> {
    const scope = normalizeCogsRefreshScope(input);
    const refreshId = randomUUID();
    // Every accepted edit gets a new identity; an active older job must never
    // absorb a newer change. Redis failure propagates and rolls back the edit.
    await this.queue.add(PRODUCT_COGS_REFRESH_JOB, {
      ...scope,
      refreshId,
      affectedDates: [],
    }, cogsRefreshJobOptions(`product-cogs-refresh-${refreshId}-first`, 1_000));
  }
}
