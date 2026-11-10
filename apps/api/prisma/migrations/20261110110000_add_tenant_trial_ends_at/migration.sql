-- Store the trial end date captured by the WMS "Create tenant" trial duration.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);
