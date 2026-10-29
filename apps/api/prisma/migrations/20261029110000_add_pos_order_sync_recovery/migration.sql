CREATE TABLE "pos_order_source_versions" (
  "tenantId" UUID NOT NULL,
  "shopId" TEXT NOT NULL,
  "posOrderId" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_order_source_versions_pkey" PRIMARY KEY ("tenantId", "shopId", "posOrderId")
);

CREATE TABLE "pos_order_sync_recoveries" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "storeId" UUID,
  "shopId" TEXT NOT NULL,
  "posOrderId" TEXT NOT NULL,
  "failedLogId" UUID NOT NULL,
  "failedReceivedAt" TIMESTAMP(3) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "queueJobId" UUID,
  "queuedAt" TIMESTAMP(3),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "lastSourceVersion" TEXT,
  "lastSourceStatus" INTEGER,
  "recoveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_order_sync_recoveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pos_order_sync_recoveries_tenantId_shopId_posOrderId_key"
  ON "pos_order_sync_recoveries"("tenantId", "shopId", "posOrderId");
CREATE INDEX "pos_order_sync_recoveries_state_nextAttemptAt_idx"
  ON "pos_order_sync_recoveries"("state", "nextAttemptAt");
CREATE INDEX "pos_order_sync_recoveries_state_leaseUntil_idx"
  ON "pos_order_sync_recoveries"("state", "leaseUntil");
CREATE INDEX "pos_order_recovery_scope_failed_at_idx"
  ON "pos_order_sync_recoveries"("shopId", "posOrderId", "failedReceivedAt");
