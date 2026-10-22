import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { createHash } from 'crypto';

@Injectable()
export class AnalyticsCacheService {
  private readonly defaultTtlMs: number;
  private readonly logger = new Logger(AnalyticsCacheService.name);
  private readonly redis: Redis;

  constructor() {
    const ttlSeconds = parseInt(process.env.CACHE_TTL_SECONDS || '900', 10);
    this.defaultTtlMs = ttlSeconds * 1000;
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const keyPrefix = process.env.CACHE_PREFIX || 'erp:';
    const password = process.env.REDIS_PASSWORD || undefined;
    this.redis = new Redis({
      host,
      port,
      keyPrefix,
      password,
      lazyConnect: false,
    });
  }

  async get<T>(key: string): Promise<T | null> {
    const val = await this.redis.get(key);
    if (val === null) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttlMs = (ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs);
    await this.redis.set(key, JSON.stringify(value), 'PX', ttlMs);
  }

  async getVersion(tenantId: string): Promise<number> {
    const v = await this.redis.get(this.versionKey(tenantId));
    return v ? parseInt(v, 10) || 0 : 0;
  }

  async bumpVersion(tenantId: string): Promise<void> {
    await this.redis.incr(this.versionKey(tenantId));
  }

  hashObject(obj: any): string {
    return createHash('md5').update(JSON.stringify(obj)).digest('hex').slice(0, 12);
  }

  private versionKey(tenantId: string) {
    return `analytics:${tenantId}:version`;
  }
}
