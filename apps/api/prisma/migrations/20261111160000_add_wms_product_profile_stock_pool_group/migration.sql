-- Group linked WMS product profiles (across sister stores or old/new variants) into a shared physical stock pool.
ALTER TABLE "wms_product_profiles" ADD COLUMN IF NOT EXISTS "stockPoolGroupId" UUID;

CREATE INDEX IF NOT EXISTS "wms_product_profiles_tenantId_stockPoolGroupId_idx"
ON "wms_product_profiles"("tenantId", "stockPoolGroupId");
