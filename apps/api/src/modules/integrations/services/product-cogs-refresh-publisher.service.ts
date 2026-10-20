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
import { PRODUCT_COGS_REFRESH_FROM, PRODUCT_COGS_REFRESH_POLICY, productCogsManilaDate } from '../product-cogs-refresh-policy';

@Injectable()
export class ProductCogsRefreshPublisherService {
  constructor(
    @InjectQueue(PANCAKE_WEBHOOK_RECONCILE_QUEUE)
    private readonly queue: Queue,
  ) {}

  /** Await inside the source transaction, after writes while its parent locks remain held. */
  async enqueue(input: ProductCogsRefreshScope): Promise<void> {
    const scope = normalizeCogsRefreshScope(input);
    // Keep the edit's authorized revaluation intervals. Extend only zero-cost
    // propagation into older 2026 orders; an undated current default cannot
    // establish that their existing positive historical rates were wrong.
    const until = productCogsManilaDate();
    if (until < PRODUCT_COGS_REFRESH_FROM) return;
    const changes = normalizeCogsRefreshScope({ ...scope, changes: [
      ...scope.changes,
      ...[...new Set(scope.changes.map(change => change.productId))]
        .map(productId => ({ productId, fromDate: PRODUCT_COGS_REFRESH_FROM, toDate: until, zeroOnly: true })),
    ] }).changes;
    const refreshId = randomUUID();
    // Every accepted edit gets a new identity; an active older job must never
    // absorb a newer change. Redis failure propagates and rolls back the edit.
    await this.queue.add(PRODUCT_COGS_REFRESH_JOB, {
      ...scope,
      changes,
      policy: PRODUCT_COGS_REFRESH_POLICY,
      refreshId,
      affectedDates: [],
    }, cogsRefreshJobOptions(`product-cogs-refresh-${refreshId}-first`, 1_000));
  }
}
