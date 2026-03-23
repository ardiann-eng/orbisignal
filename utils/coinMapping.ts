// utils/coinMapping.ts
// Dynamic CoinGecko coin mapping — auto-fetches all coins from /coins/list
// and builds a "BTC/USDT" → "bitcoin" mapping, cached to coinmap.json for 24h.
// Call initCoinMapping() at startup before first usage.

import fs from 'fs/promises'
import path from 'path'
import axios from 'axios'
import { logger } from '@/utils/logger'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── Config ───────────────────────────────────────────────────────────────

const CACHE_FILE = path.resolve(process.cwd(), 'coinmap.json')
const CACHE_TTL  = 24 * 60 * 60 * 1000 // 24 hours

export interface CoinFundamentalData {
  id: string
  market_cap_rank: number | null
  total_volume: number
  market_cap: number
  price_change_percentage_7d_in_currency: number | null
  ath_change_percentage: number | null
}

interface CoinMapCache {
  builtAt:    number
  totalCoins: number
  mapping:    Record<string, CoinFundamentalData>
}

// ─── In-memory mapping (populated by initCoinMapping) ─────────────────────

let COIN_MAPPING: Record<string, CoinFundamentalData> = {}

async function validateMapping(mapping: Record<string, CoinFundamentalData>): Promise<Record<string, CoinFundamentalData>> {
  const mustHave: Record<string, string> = {
    'BTC/USDT': 'bitcoin',
    'ETH/USDT': 'ethereum',
    'SOL/USDT': 'solana',
    'BNB/USDT': 'binancecoin',
    'XRP/USDT': 'ripple',
    'DOGE/USDT': 'dogecoin',
    'ADA/USDT': 'cardano',
    'AVAX/USDT': 'avalanche-2',
    'LINK/USDT': 'chainlink',
    'DOT/USDT': 'polkadot',
  }

  let allOk = true
  for (const [symbol, expectedId] of Object.entries(mustHave)) {
    const actual = mapping[symbol]
    if (!actual || actual.id !== expectedId) {
      logger.error({
        context: 'COINGECKO',
        symbol,
        expected: expectedId,
        actual:   actual?.id || 'missing',
      }, '❌ Mapping validation FAILED — wrong coin ID')
      // Override dengan fallback dasar jika mismatch (data metric mungkin tidak akurat tapi ID benar)
      if (actual) {
        mapping[symbol].id = expectedId
      } else {
        mapping[symbol] = {
          id: expectedId,
          market_cap_rank: 999,
          total_volume: 0,
          market_cap: 0,
          price_change_percentage_7d_in_currency: 0,
          ath_change_percentage: 0,
        }
      }
      allOk = false
    }
  }

  if (allOk) {
    logger.info({ context: 'COINGECKO' }, '✅ Mapping validation passed')
  } else {
    logger.warn({ context: 'COINGECKO' }, '⚠️ Some mappings were auto-corrected')
  }

  return mapping
}

async function buildCoinMapping(): Promise<Record<string, CoinFundamentalData>> {
  logger.info({ context: 'COINGECKO' }, '🗺 Building coin mapping from CoinGecko...')

  let mapping: Record<string, CoinFundamentalData> = {}

  // Fetch top 1000 coins by market cap (10 pages x 100 per page)
  for (let page = 1; page <= 10; page++) {
    // FIX: Added &price_change_percentage=7d for fundamental metrics
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=${page}&sparkline=false&price_change_percentage=7d`

    let success = false
    // FIX: Retry each page up to 3 times on 429
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data: coins } = await axios.get(url, { timeout: 15000 })

        for (const coin of coins) {
          const key = `${String(coin.symbol).toUpperCase()}/USDT`
          if (!mapping[key]) {
            mapping[key] = {
              id: String(coin.id),
              market_cap_rank: coin.market_cap_rank ?? 999,
              total_volume: coin.total_volume ?? 0,
              market_cap: coin.market_cap ?? 0,
              price_change_percentage_7d_in_currency: coin.price_change_percentage_7d_in_currency ?? 0,
              ath_change_percentage: coin.ath_change_percentage ?? 0,
            }
          }
        }

        success = true
        logger.debug({ context: 'COINGECKO', page, mapped: Object.keys(mapping).length }, `📄 Mapping page ${page}/5 done`)
        break // success, exit retry loop

      } catch (err: any) {
        const is429 = err?.response?.status === 429
        if (is429 && attempt < 3) {
          const wait = attempt * 10000 // 10s, 20s
          logger.warn({ context: 'COINGECKO', page, attempt }, `⚠️ Rate limited on page ${page}, waiting ${wait / 1000}s...`)
          await sleep(wait)
        } else {
          logger.error({ context: 'COINGECKO', page, err: err.message }, `❌ Page ${page} failed after ${attempt} attempts`)
          break // give up on this page
        }
      }
    }

    // FIX: 5s delay between pages (free tier = 30 req/min)
    await sleep(5000)

    if (!success && Object.keys(mapping).length > 0) {
      // We have partial data — stop fetching more pages but keep what we have
      logger.warn({ context: 'COINGECKO', mapped: Object.keys(mapping).length },
        `⚠️ Stopping early — saving partial mapping (${Object.keys(mapping).length} coins)`)
      break
    }
  }

  // Validate and save even if partial
  if (Object.keys(mapping).length > 0) {
    mapping = await validateMapping(mapping)

    const cacheData: CoinMapCache = {
      builtAt:    Date.now(),
      totalCoins: Object.keys(mapping).length,
      mapping,
    }

    await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData, null, 2), 'utf8')

    logger.info({
      context: 'COINGECKO',
      mapped:  Object.keys(mapping).length,
    }, '✅ Coin mapping built — by market cap')
  } else {
    logger.error({ context: 'COINGECKO' }, '❌ Coin mapping completely empty — no data fetched')
  }

  return mapping
}

// ─── Load from cache (or rebuild if expired / missing) ────────────────────

async function getCoinMapping(): Promise<Record<string, CoinFundamentalData>> {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8')
    const cache = JSON.parse(raw) as CoinMapCache
    const age   = Date.now() - cache.builtAt

    if (age < CACHE_TTL) {
      logger.info({
        context:  'COINGECKO',
        ageHours: (age / 3_600_000).toFixed(1),
        mapped:   Object.keys(cache.mapping).length,
      }, '✅ Coin mapping loaded from cache')
      
      // Force rebuild if BTC is not bitcoin (invalid baseline cache) or if mapping structure is old (string vs object)
      const btcNode = cache.mapping['BTC/USDT']
      if (!btcNode || typeof btcNode === 'string' || btcNode.id !== 'bitcoin') {
        logger.warn({ context: 'COINGECKO' }, '⚠️ Cache invalid (wrong BTC mapping or old schema), rebuilding...')
        return await buildCoinMapping()
      }

      return cache.mapping
    }

    logger.info({ context: 'COINGECKO' }, '♻️ Coin mapping cache expired, rebuilding...')
    return await buildCoinMapping()
  } catch {
    logger.info({ context: 'COINGECKO' }, '🆕 No cache found, building coin mapping...')
    return await buildCoinMapping()
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Call once at startup before any CoinGecko sentiment calls.
 */
export async function initCoinMapping(): Promise<void> {
  COIN_MAPPING = await getCoinMapping()
}

/**
 * Same interface as the old hardcoded getCoinGeckoId().
 * Returns null for unmapped symbols (no warning spam).
 */
export function getCoinGeckoId(symbol: string): string | null {
  return COIN_MAPPING[symbol]?.id ?? null
}

/**
 * Returns the full cached coin metrics for the fundamental engine.
 */
export function getCoinFundamentalData(symbol: string): CoinFundamentalData | null {
  return COIN_MAPPING[symbol] ?? null
}

/**
 * Returns stats for /coinstats Telegram command.
 */
export async function getCoinMappingStats(): Promise<{
  total:    number
  ageHours: string
}> {
  try {
    const raw   = await fs.readFile(CACHE_FILE, 'utf8')
    const cache = JSON.parse(raw) as CoinMapCache
    return {
      total:    Object.keys(cache.mapping).length,
      ageHours: ((Date.now() - cache.builtAt) / 3_600_000).toFixed(1),
    }
  } catch {
    return { total: Object.keys(COIN_MAPPING).length, ageHours: '?' }
  }
}
