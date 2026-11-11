import * as Joi from 'joi';

export default Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3001),
  PROCESS_ROLE: Joi.string().valid('all', 'api', 'worker').default('all'),
  LOG_DEBUG_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Database
  DATABASE_URL: Joi.string().required(),
  DATABASE_CONNECTION_LIMIT: Joi.number().integer().min(1).default(6),
  DATABASE_POOL_TIMEOUT_SECONDS: Joi.number().integer().min(1).default(10),

  // JWT
  JWT_SECRET: Joi.string().min(64).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(64).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('', null),

  // Analytics load protection
  CACHE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  ANALYTICS_MAX_CONCURRENT_PER_TENANT: Joi.number().integer().min(1).default(2),

  // Rate limiting
  THROTTLE_TTL: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(100),

  // Pancake webhook queue processing
  PANCAKE_WEBHOOK_PROCESS_INLINE: Joi.string().valid('true', 'false').default('false'),
  PANCAKE_WEBHOOK_INLINE_FALLBACK: Joi.string().valid('true', 'false').default('true'),
  PANCAKE_WEBHOOK_QUEUE_ATTEMPTS: Joi.number().integer().min(1).default(5),
  PANCAKE_WEBHOOK_QUEUE_BACKOFF_MS: Joi.number().integer().min(100).default(2000),
  PANCAKE_WEBHOOK_QUEUE_TIMEOUT_MS: Joi.number().integer().min(1000).default(120000),
  PANCAKE_WEBHOOK_QUEUE_REMOVE_ON_COMPLETE: Joi.number().integer().min(1).default(1000),
  PANCAKE_WEBHOOK_QUEUE_REMOVE_ON_FAIL: Joi.number().integer().min(1).default(5000),
  PANCAKE_WEBHOOK_PROCESSOR_CONCURRENCY: Joi.number().integer().min(1).default(2),
  PANCAKE_AUTO_CANCEL_PROCESSOR_CONCURRENCY: Joi.number().integer().min(1).default(1),
  PANCAKE_REPORTS_HYDRATE_PROCESSOR_CONCURRENCY: Joi.number().integer().min(1).default(1),
  PANCAKE_WEBHOOK_RECONCILE_DELAY_MS: Joi.number().integer().min(10000).default(300000),
  PANCAKE_WEBHOOK_RECONCILE_MIN_DELAY_MS: Joi.number().integer().min(10000).default(300000),
  PANCAKE_WEBHOOK_ALLOW_AUTOMATIC_FULL_RESET: Joi.string().valid('true', 'false').default('false'),
  PANCAKE_RECONCILE_PROCESSOR_CONCURRENCY: Joi.number().integer().min(1).default(1),
  PANCAKE_RECONCILE_QUEUE_ATTEMPTS: Joi.number().integer().min(1).default(3),
  PANCAKE_RECONCILE_QUEUE_BACKOFF_MS: Joi.number().integer().min(1000).default(4000),
  PANCAKE_RECONCILE_QUEUE_TIMEOUT_MS: Joi.number().integer().min(30000).default(300000),

  // Object storage
  OBJECT_STORAGE_PROVIDER: Joi.string().default('s3-compatible'),
  OBJECT_STORAGE_ENDPOINT: Joi.string().allow('', null),
  OBJECT_STORAGE_REGION: Joi.string().default('us-east-1'),
  OBJECT_STORAGE_BUCKET: Joi.string().allow('', null),
  OBJECT_STORAGE_ACCESS_KEY_ID: Joi.string().allow('', null),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: Joi.string().allow('', null),
  OBJECT_STORAGE_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('false'),
  OBJECT_STORAGE_AUTO_CREATE_BUCKET: Joi.string().valid('true', 'false').default('false'),
  OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS: Joi.number().integer().min(60).default(900),
  OBJECT_STORAGE_PAYMENT_PROOF_MAX_FILE_MB: Joi.number().integer().min(1).default(8),
  OBJECT_STORAGE_UNDELIVERABLE_PROOF_MAX_FILE_MB: Joi.number().integer().min(1).default(30),
  OBJECT_STORAGE_STOX_APK_MAX_FILE_MB: Joi.number().integer().min(1).default(150),

  // Queue tuning
  CONFIRMATION_UPDATE_QUEUE_CONCURRENCY: Joi.number().integer().min(1).default(4),
  WMS_PICKING_HANDOFF_QUEUE_CONCURRENCY: Joi.number().integer().min(1).default(4),
  WMS_PICKING_HANDOFF_QUEUE_ATTEMPTS: Joi.number().integer().min(1).default(4),
  WMS_PICKING_HANDOFF_QUEUE_BACKOFF_MS: Joi.number().integer().min(100).default(3000),
  WMS_PICKING_HANDOFF_QUEUE_TIMEOUT_MS: Joi.number().integer().min(1000).default(45000),
  WMS_PACKING_POST_COMPLETE_QUEUE_CONCURRENCY: Joi.number().integer().min(1).default(2),
  WMS_PACKING_POST_COMPLETE_QUEUE_ATTEMPTS: Joi.number().integer().min(1).default(4),
  WMS_PACKING_POST_COMPLETE_QUEUE_BACKOFF_MS: Joi.number().integer().min(100).default(3000),
  WMS_PACKING_POST_COMPLETE_QUEUE_TIMEOUT_MS: Joi.number().integer().min(1000).default(60000),
  WMS_DEMAND_QUEUE_REFRESH_CHUNK_SIZE: Joi.number().integer().min(1).default(25),
  WMS_DEMAND_QUEUE_REFRESH_TX_TIMEOUT_MS: Joi.number().integer().min(1000).default(90000),
  WMS_DEMAND_QUEUE_REFRESH_TX_MAX_WAIT_MS: Joi.number().integer().min(1000).default(10000),

  // WMS feature rollout
  WMS_BASKET_DEMAND_PICKING_ENABLED: Joi.string().valid('true', 'false').default('true'),
  WMS_STOX_LEGACY_RESERVED_ENABLED: Joi.string().valid('true', 'false').default('false'),

  // Local-first Creative AI / Claudebox integration
  AI_AGENT_ENABLED: Joi.string().valid('true', 'false').default('false'),
  CLAUDEBOX_WS_URL: Joi.when('AI_AGENT_ENABLED', {
    is: 'true',
    then: Joi.string().uri({ scheme: ['ws', 'wss'] }).required(),
    otherwise: Joi.string().uri({ scheme: ['ws', 'wss'] }).allow('', null),
  }),
  CLAUDEBOX_HTTP_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow('', null),
  CLAUDEBOX_API_KEY: Joi.when('AI_AGENT_ENABLED', {
    is: 'true',
    then: Joi.string().min(24).required(),
    otherwise: Joi.string().min(24).allow('', null),
  }),
  AI_AGENT_SIGNING_SECRET: Joi.when('AI_AGENT_ENABLED', {
    is: 'true',
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).allow('', null),
  }),
  CREATIVE_AI_WORKSPACE_ROOT: Joi.string().allow('', null),
  CREATIVE_AI_UPLOAD_TMP_DIR: Joi.string().allow('', null),
  CREATIVE_AI_MAX_VIDEO_MB: Joi.number().positive().default(250),
  CREATIVE_AI_MAX_VIDEO_SECONDS: Joi.number().positive().default(600),
  CREATIVE_AI_HOOK_FRAME_LIMIT: Joi.number().integer().min(1).max(12).default(6),
  CREATIVE_AI_TIMELINE_FRAME_LIMIT: Joi.number().integer().min(1).max(24).default(12),
  CREATIVE_AI_FFMPEG_BIN: Joi.string().default('ffmpeg'),
  CREATIVE_AI_FFPROBE_BIN: Joi.string().default('ffprobe'),
  CREATIVE_AI_WHISPER_BIN: Joi.string().allow('', null),
  CREATIVE_AI_WHISPER_URL: Joi.string().uri({ scheme: ['http', 'https'] }).allow('', null),
  CREATIVE_AI_SCENE_THRESHOLD: Joi.number().min(0.05).max(0.95).default(0.3),
  CREATIVE_AI_MAX_SCENES: Joi.number().integer().min(1).max(60).default(40),
  CREATIVE_AI_MAX_GRID_FRAMES: Joi.number().integer().min(10).max(180).default(90),
  CREATIVE_AI_PUSH_BUDGET_BYTES: Joi.number().integer().min(1000000).default(8000000),
  CLAUDEBOX_MAX_BODY_BYTES: Joi.number().integer().min(1000000).allow('', null),
  CREATIVE_AI_WHISPER_MODEL: Joi.string().default('small'),
  CREATIVE_AI_WHISPER_LANGUAGE: Joi.string().allow('', null),
  CREATIVE_AI_TRANSCRIPTION_TIMEOUT_MS: Joi.number().integer().min(1000).default(1200000),
  CREATIVE_AI_MODEL: Joi.string().default('sonnet'),
  CREATIVE_AI_MAX_TURNS: Joi.number().integer().min(1).max(100).default(8),
  CREATIVE_AI_MAX_BUDGET_USD: Joi.number().positive().max(100).default(1),
  CREATIVE_AI_RUN_TIMEOUT_MS: Joi.number().integer().min(30000).default(3900000),
  CREATIVE_AI_SHARED_WORKSPACE: Joi.string().valid('true', 'false').default('false'),
  CREATIVE_AI_QUEUE_CONCURRENCY: Joi.number().integer().min(1).default(1),
  CREATIVE_AI_QUEUE_ATTEMPTS: Joi.number().integer().min(1).default(2),
  CREATIVE_AI_QUEUE_BACKOFF_MS: Joi.number().integer().min(100).default(3000),
  CREATIVE_AI_RETAIN_SOURCE_VIDEO: Joi.string().valid('true', 'false').default('false'),
  CREATIVE_AI_WORKSPACE_RETENTION_DAYS: Joi.number().integer().min(1).default(14),
  CREATIVE_AI_STALE_RUN_GRACE_MS: Joi.number().integer().min(10000).default(120000),
  OPS_DIGEST_TOKEN: Joi.string().min(32).allow('', null),
  OPS_DIGEST_EMAIL_TO: Joi.string().allow('', null),
});
