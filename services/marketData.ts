// services/marketData.ts
// Responsible for fetching and normalizing raw market data via CCXT wrapper
// Primary: OKX, Fallback: Bitget // NEW:

import ccxt from 'ccxt'
import axios from 'axios'
import { config, TIMEFRAMES, type Symbol } from '@/lib/config'
import { cache } from '@/utils/cache'
import { logger } from '@/utils/logger'

// ─── Types ────────────────────────────────────────────────────────────────

export interface Candle {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closeTime: number
}

export interface Ticker {
  symbol: string
  priceChangePercent: number
  lastPrice: number
  volume: number     // 24h base volume
  quoteVolume: number
}

export interface CoinMeta {
  symbol: string
  marketCapRank: number
  marketCap: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── CCXT DataFetcher Class ───────────────────────────────────────────────

class DataFetcher {
  // NOTE: type annotation dihapus agar tidak tergantung namespace ccxt di TS
  // Menggunakan OKX sebagai primary dan Bitget sebagai fallback // NEW:
  private primary // NEW:
  private fallback // NEW:

  constructor() {
    this.primary  = new ccxt.okx({ enableRateLimit: true })     // NEW:
    this.fallback = new ccxt.bitget({ enableRateLimit: true })  // NEW:
  }

  /**
   * Universal fetch with 3x retry exponential backoff and automatic fallback.
   */
  private async fetchWithRetryAndFallback<T>(
    operationName: string,
    operation: (exchange: any) => Promise<T>,
    symbol: string
  ): Promise<T> {
    let lastError: Error | unknown = null

    // Try primary exchange (OKX) // NEW:
    // FIX: removed per-symbol debug log here — too noisy in 100-symbol scan loop
    for (let i = 0; i < 3; i++) {
      try {
        return await operation(this.primary) // NEW:
      } catch (err: any) {
        lastError = err
        logger.warn({ context: 'EXCHANGE', symbol, attempt: i + 1, err: err.message }, `⚠️ Primary ${operationName} failed`) // NEW:
        await sleep(Math.pow(2, i) * 1000) // Exponential backoff
      }
    }

    logger.warn({ context: 'EXCHANGE', symbol }, `⚠️ Primary failed — switching to Fallback for ${operationName}`) // NEW:

    // Try fallback exchange (Bitget) // NEW:
    for (let i = 0; i < 3; i++) {
      try {
        return await operation(this.fallback) // NEW:
      } catch (err: any) {
        lastError = err
        logger.warn({ context: 'EXCHANGE', symbol, attempt: i + 1, err: err.message }, `⚠️ Fallback ${operationName} failed`) // NEW:
        await sleep(Math.pow(2, i) * 1000)
      }
    }

    logger.error({ context: 'EXCHANGE', symbol, err: (lastError as Error)?.message || 'Unknown error' }, `❌ Both exchanges failed for ${operationName}`)
    throw lastError
  }

  public async get_ohlcv(symbol: string, timeframe: string, limit: number): Promise<[number, number, number, number, number, number][]> {
    return this.fetchWithRetryAndFallback(
      'get_ohlcv',
      async (exchange) => {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit)
        return ohlcv as [number, number, number, number, number, number][]
      },
      symbol
    )
  }

  public async get_ticker(symbol: string): Promise<any> {
    return this.fetchWithRetryAndFallback(
       'get_ticker',
       async (exchange) => await exchange.fetchTicker(symbol),
       symbol
    )
  }

  public async get_orderbook(symbol: string, depth: number = 20): Promise<any> {
    return this.fetchWithRetryAndFallback(
      'get_orderbook',
      async (exchange) => await exchange.fetchOrderBook(symbol, depth),
      symbol
    )
  }

  public async get_funding_rate(symbol: string): Promise<number> {
    // Only fetch perp funding rate; skip spot pairs cleanly
    if (!symbol.includes(':')) {
      return 0
    }

    return this.fetchWithRetryAndFallback(
      'get_funding_rate',
      async (exchange) => {
        try {
          const funding = await exchange.fetchFundingRate(symbol)
          return funding.fundingRate || 0
        } catch (err: any) {
          // Jika market tidak ada di exchange (symbol tidak didukung perp), treat sebagai 0
          const msg = String(err?.message || '')
          if (msg.includes('does not have market symbol')) {
            return 0
          }
          throw err
        }
      },
      symbol
    )
  }

  public async get_open_interest(symbol: string): Promise<number> {
    const swapSymbol = symbol.includes(':') ? symbol : `${symbol}:USDT`

    return this.fetchWithRetryAndFallback(
      'get_open_interest',
      async (exchange) => {
        try {
          const oi = await exchange.fetchOpenInterest(swapSymbol)
          const val = (oi as any).openInterestAmount || (oi as any).openInterest || (oi as any).value || 0
          logger.debug({ context: 'EXCHANGE', symbol, swapSymbol, val }, '🔍 fetchOpenInterest result')
          return val
        } catch (err: any) {
          const msg = String(err?.message || '')
          if (msg.includes('does not have market symbol') || msg.includes('not supported')) {
            return 0
          }
          throw err
        }
      },
      symbol
    )
  }

  public async get_markets(exchangeId: 'primary' | 'fallback' = 'primary') {
    return exchangeId === 'primary'
      ? await this.primary.loadMarkets()
      : await this.fallback.loadMarkets()
  }
}

const fetcher = new DataFetcher()

// ─── Exported Implementations ─────────────────────────────────────────────

export async function getOpenInterest(symbol: string): Promise<number> {
  const cacheKey = `oi:${symbol}`
  const cached = await cache.get<number>(cacheKey)
  if (cached !== null && cached !== undefined) return cached

  try {
    const val = await fetcher.get_open_interest(symbol)
    logger.info({ context: 'EXCHANGE', symbol, oi: val }, '📊 OI Fetch result')
    await cache.set(cacheKey, val, 300) // 5 min TTL
    return val
  } catch (err: any) {
    logger.error({ context: 'EXCHANGE', symbol, err: err.message }, '❌ getOpenInterest failed')
    return 0
  }
}

export async function getFundingRate(symbol: string): Promise<number> {
  const swapSymbol = symbol.includes(':') ? symbol : `${symbol}:USDT`
  const cacheKey = `fr:${swapSymbol}`
  const cached = await cache.get<number>(cacheKey)
  if (cached !== null && cached !== undefined) return cached

  try {
    const val = await fetcher.get_funding_rate(swapSymbol)
    logger.debug({ context: 'EXCHANGE', symbol, fundingRate: val }, '💰 Funding Rate fetched')
    await cache.set(cacheKey, val, 300) // 5 min TTL
    return val
  } catch (err: any) {
    logger.warn({ context: 'EXCHANGE', symbol, err: err.message }, '⚠️ getFundingRate failed — returning 0')
    return 0
  }
}

export async function getCandles(
  symbol: string,
  interval: typeof TIMEFRAMES[number],
  limit = 100,
): Promise<Candle[]> {
  const safeLimit = Math.floor(Math.min(limit, 1000))
  const cacheKey = `candles:${symbol}:${interval}:${safeLimit}`
  const ttl = interval === '1h' ? 60 : 240

  const cached = await cache.get<Candle[]>(cacheKey)
  if (cached) return cached

  try {
    const data = await fetcher.get_ohlcv(symbol, interval, safeLimit)
    const candles: Candle[] = data.map((k) => ({
      openTime: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: k[5],
      // CCXT standard OHLCV doesn't provide exact close time, estimate it
      closeTime: k[0] + (interval === '1h' ? 3600000 : 14400000) - 1, 
    }))

    await cache.set(cacheKey, candles, ttl)
    return candles
  } catch (err: any) {
    logger.error({ context: 'EXCHANGE', symbol, interval, err: err.message }, '❌ getCandles failed')
    return []
  }
}

export async function getTicker(symbol: string): Promise<Ticker | null> {
  const cacheKey = `ticker:${symbol}`
  const cached = await cache.get<Ticker>(cacheKey)
  if (cached) return cached

  try {
    const data = await fetcher.get_ticker(symbol)
    if (!data.last) return null

    const ticker: Ticker = {
      symbol,
      priceChangePercent: data.percentage || 0,
      lastPrice: data.last,
      volume: data.baseVolume || 0,
      quoteVolume: data.quoteVolume || 0,
    }

    await cache.set(cacheKey, ticker, 30)
    return ticker
  } catch (err: any) {
    logger.error({ context: 'EXCHANGE', symbol, err: err.message }, '❌ getTicker failed')
    return null
  }
}

export async function getBTCHourlyChange(): Promise<number> {
  const btc1h = await getCandles('BTC/USDT', '1h', 2)
  if (btc1h.length < 2) return 0
  const prev = btc1h[btc1h.length - 2].close
  const curr = btc1h[btc1h.length - 1].close
  return ((curr - prev) / prev) * 100
}

// ─── CoinGecko metadata ───────────────────────────────────────────────────

const SYMBOL_TO_GECKO_ID: Record<string, string> = {
  'SOL/USDT': 'solana', 'BNB/USDT': 'binancecoin', 'XRP/USDT': 'ripple',
  'ADA/USDT': 'cardano', 'AVAX/USDT': 'avalanche-2', 'DOT/USDT': 'polkadot',
  'LINK/USDT': 'chainlink', 'MATIC/USDT': 'matic-network', 'LTC/USDT': 'litecoin',
  'UNI/USDT': 'uniswap', 'ATOM/USDT': 'cosmos', 'AAVE/USDT': 'aave',
  'NEAR/USDT': 'near', 'FTM/USDT': 'fantom', 'INJ/USDT': 'injective-protocol',
  'SUI/USDT': 'sui', 'SEI/USDT': 'sei-network', 'TIA/USDT': 'celestia',
  'ARB/USDT': 'arbitrum', 'OP/USDT': 'optimism',
  'BTC/USDT': 'bitcoin', 'ETH/USDT': 'ethereum',
}

export async function getCoinMeta(symbol: string): Promise<CoinMeta | null> {
  const geckoId = SYMBOL_TO_GECKO_ID[symbol]
  if (!geckoId) return null

  const cacheKey = `meta:${symbol}`
  const cached = await cache.get<CoinMeta>(cacheKey)
  if (cached) return cached

  // FIX: Robust retry logic for CoinGecko (similar to CCXT)
  for (let i = 0; i < 3; i++) {
    try {
      const { data } = await axios.get(
        `${config.COINGECKO_BASE_URL}/coins/${geckoId}`,
        { 
          params: { localization: false, tickers: false, community_data: false }, 
          timeout: i === 0 ? 8000 : 15000 // give more time on retries
        },
      )

      const meta: CoinMeta = {
        symbol,
        marketCapRank: data.market_cap_rank,
        marketCap: data.market_data.market_cap.usd,
      }

      await cache.set(cacheKey, meta, 3600)
      return meta
    } catch (err: any) {
      if (i === 2) {
        logger.error({ context: 'GECKO', symbol, err: err.message }, '❌ getCoinMeta failed after 3 attempts')
        return null
      }
      const waitTime = Math.pow(2, i) * 1000
      logger.warn({ context: 'GECKO', symbol, attempt: i + 1, waitTime }, `⚠️ CoinGecko call failed, retrying...`)
      await sleep(waitTime)
    }
  }
  return null
}

export async function getAllTickers(symbols: readonly string[]): Promise<Ticker[]> {
  const results = await Promise.allSettled(symbols.map(s => getTicker(s)))
  return results
    .filter((r): r is PromiseFulfilledResult<Ticker> => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value as Ticker)
}

// ─── Dynamic Symbols ──────────────────────────────────────────────────────

export async function getExchangeSymbols(limit = 100): Promise<string[]> {
  const cacheKey = 'exchange:symbols'
  
  // FIX: Aggressive Cache hit check
  const cached = await cache.get<string[]>(cacheKey)
  if (cached && Array.isArray(cached) && cached.length > 0) {
    logger.info({ context: 'CACHE', type: 'EXCHANGE_SYMBOLS', count: cached.length }, '📦 Symbols loaded from cache')
    return cached.slice(0, limit)
  }

  logger.info({ context: 'EXCHANGE' }, '⚙️ Rebuilding symbol list (cache miss/expired)...')
  const fallbackSymbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT"]

  try {
    const markets = await fetcher.get_markets('primary')

    // Ambil semua pair spot USDT yang aktif
    const usdtSpotSymbols = Object.values(markets)
      .filter(m => m?.active && m?.quote === 'USDT' && m?.spot)
      .map(m => m!.symbol as string) // e.g., 'BTC/USDT'

    if (!usdtSpotSymbols || usdtSpotSymbols.length === 0) {
      logger.warn({ context: 'EXCHANGE', msg: 'No symbols matched criteria, using fallback list' })
      return fallbackSymbols
    }

    // Ambil ticker untuk semua pair dan sort berdasarkan quoteVolume (24h)
    // Gunakan concurrency limit sederhana jika perlu, tapi Promise.allSettled + local ticker cache cukup aman.
    const tickerResults = await Promise.allSettled(
      usdtSpotSymbols.map(s => getTicker(s))
    )

    const sortedByVolume = tickerResults
      .filter((r): r is PromiseFulfilledResult<Ticker | null> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value as Ticker)
      .sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0))

    const topSymbols = sortedByVolume.map(t => t.symbol)

    if (!topSymbols || topSymbols.length === 0) {
      logger.warn('Ticker fetch produced no symbols, using fallback list')
      return fallbackSymbols
    }

    // Simpan seluruh hasil (bukan cuma limit) agar cache lebih reusable
    await cache.set(cacheKey, topSymbols, 86400) // Cache for 1 day
    logger.info({ context: 'CACHE', count: topSymbols.length }, '✅ Symbol list cached successfully')
    
    return topSymbols.slice(0, limit)
  } catch (err: any) {
    logger.error({ context: 'EXCHANGE', err: err.message }, '❌ getExchangeSymbols failed')
    return fallbackSymbols
  }
}
