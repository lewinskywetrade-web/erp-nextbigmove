-- Store warehouse-wide WMS configuration (such as the consolidated daily inventory email schedule & recipients).
CREATE TABLE IF NOT EXISTS "wms_system_settings" (
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wms_system_settings_pkey" PRIMARY KEY ("key")
);
