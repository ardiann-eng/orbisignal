import { Redis } from '@upstash/redis'
import { config } from '@/lib/config'
import { logger } from './logger'

// Initialize Upstash Redis client
const redis = new Redis({
  url: config.UPSTASH_REDIS_REST_URL,
  token: config.UPSTASH_REDIS_REST_TOKEN,
})

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    try {
      return await redis.get<T>(key)
    } catch (err: any) {
      logger.error({ context: 'CACHE', key, err: err.message }, '❌ Redis GET error')
      return null
    }
  },

  async set(key: string, value: unknown, ttlSeconds = 300) {
    try {
      await redis.set(key, value, { ex: ttlSeconds })
    } catch (err: any) {
      logger.error({ context: 'CACHE', key, err: err.message }, '❌ Redis SET error')
    }
  },

  async del(key: string) {
    try {
      await redis.del(key)
    } catch (err: any) {
      logger.error({ context: 'CACHE', key, err: err.message }, '❌ Redis DEL error')
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      const count = await redis.exists(key)
      return count > 0
    } catch (err: any) {
      logger.error({ context: 'CACHE', key, err: err.message }, '❌ Redis EXISTS error')
      return false
    }
  },
}

export async function setCooldown(symbol: string, hours: number) {
  await cache.set(`cooldown:${symbol}`, 1, Math.round(hours * 3600))
}

export async function isOnCooldown(symbol: string): Promise<boolean> {
  return await cache.exists(`cooldown:${symbol}`)
}
