import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class AnalyticsRequestCoordinatorService {
  private readonly logger = new Logger(AnalyticsRequestCoordinatorService.name);
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly activeByTenant = new Map<string, number>();
  private readonly waitersByTenant = new Map<string, Array<() => void>>();
  private readonly maxConcurrentPerTenant = Math.max(
    1,
    Number(process.env.ANALYTICS_MAX_CONCURRENT_PER_TENANT || 4),
  );

  async run<T>(
    tenantId: string,
    requestKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const existing = this.inFlight.get(requestKey) as Promise<T> | undefined;
    if (existing) {
      this.logger.debug(`Coalescing analytics request ${requestKey}`);
      return existing;
    }

    const execution = (async () => {
      await this.acquire(tenantId);
      try {
        return await operation();
      } finally {
        this.release(tenantId);
      }
    })();

    this.inFlight.set(requestKey, execution);
    try {
      return await execution;
    } finally {
      if (this.inFlight.get(requestKey) === execution) {
        this.inFlight.delete(requestKey);
      }
    }
  }

  private async acquire(tenantId: string): Promise<void> {
    const active = this.activeByTenant.get(tenantId) || 0;
    if (active < this.maxConcurrentPerTenant) {
      this.activeByTenant.set(tenantId, active + 1);
      return;
    }

    await new Promise<void>((resolve) => {
      const waiters = this.waitersByTenant.get(tenantId) || [];
      waiters.push(resolve);
      this.waitersByTenant.set(tenantId, waiters);
    });
  }

  private release(tenantId: string): void {
    const waiters = this.waitersByTenant.get(tenantId);
    const next = waiters?.shift();
    if (next) {
      if (waiters?.length === 0) {
        this.waitersByTenant.delete(tenantId);
      }
      next();
      return;
    }

    const active = this.activeByTenant.get(tenantId) || 1;
    if (active <= 1) {
      this.activeByTenant.delete(tenantId);
    } else {
      this.activeByTenant.set(tenantId, active - 1);
    }
  }
}
