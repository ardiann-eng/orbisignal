export const cache = {
  async get<T>(key: string): Promise<T | null> { return null },
  async set(key: string, value: unknown, ttlSeconds = 300) { },
  async del(key: string) { },
  async exists(key: string): Promise<boolean> { return false },
}

export async function setCooldown(symbol: string, hours: number) {
  await cache.set(`cooldown:${symbol}`, 1, hours * 3600)
}

export async function isOnCooldown(symbol: string): Promise<boolean> {
  return cache.exists(`cooldown:${symbol}`)
}
