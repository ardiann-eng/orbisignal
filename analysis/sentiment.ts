// analysis/sentiment.ts
// Sentiment engine (CoinGecko per-coin + Fear & Greed global). // NEW:
// Weight in final score: 20 points max.

import axios from 'axios'
import { cache } from '@/utils/cache'
import { logger } from '@/utils/logger'
import { getCoinGeckoId } from '@/utils/coinMapping' // FIX: dynamic mapping replaces hardcoded COINGECKO_IDS

// ─── Types ────────────────────────────────────────────────────────────────

export interface SentimentScore {
  score:        number   // 0–20
  fearGreedVal: number
  fearGreedLabel: string
  reasons:      string[]
}

// FIX: COINGECKO_IDS and getCoinGeckoId moved to utils/coinMapping.ts (dynamic auto-mapping)

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms)) // NEW:

export type FearGreed = { value: number; label: string } // NEW:

export async function getFearAndGreed(): Promise<FearGreed> { // NEW:
  const cacheKey = 'feargreed:latest' // NEW:
  const cached = await cache.get<FearGreed>(cacheKey) // NEW:
  if (cached) return cached // NEW:
  
  logger.debug({ context: 'FEARGREED' }, '📡 Fetching Fear & Greed index...')
  try { // NEW:
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 5000 }) // NEW:
    const value = parseInt(data.data[0].value) // NEW:
    const label = data.data[0].value_classification // NEW:
    const result = { value, label } // NEW:
    await cache.set(cacheKey, result, 300) // NEW: 5 min TTL
    logger.info({ context: 'FEARGREED', value, label }, '✅ Fear & Greed loaded')
    return result // NEW:
  } catch (err: any) { // NEW:
    logger.warn({ context: 'FEARGREED', err: err.message }, '⚠️ Fear & Greed failed — using neutral fallback (50)')
    return { value: 50, label: 'Neutral' } // NEW:
  } // NEW:
} // NEW:

type CoinGeckoSentiment = { // NEW:
  sentimentUp: number // NEW:
  sentimentDown: number // NEW:
  priceChange1h: number // NEW:
  priceChange24h: number // NEW:
  sentimentScore: number // NEW:
} // NEW:

// FIX: Helper that retries on 429 with exponential backoff
async function axiosGetWithRetry(url: string, maxRetry = 3): Promise<any> {
  for (let i = 0; i < maxRetry; i++) {
    try {
      const res = await axios.get(url, { timeout: 10000 })
      return res
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 429) {
        const wait = (i + 1) * 5000 // 5s, 10s, 15s
        logger.warn({ context: 'COINGECKO' }, `⚠️ Rate limited, waiting ${wait / 1000}s before retry ${i + 1}/${maxRetry}`) // FIX:
        await sleep(wait)
        continue
      }
      if (i === maxRetry - 1) throw err
    }
  }
}

async function getCoinGeckoSentiment(symbol: string): Promise<CoinGeckoSentiment | null> { // NEW:
  const coinId = getCoinGeckoId(symbol) // NEW:
  if (!coinId) {
    // FIX: remove noisy warn for unmapped coins — they are expected in a 100-symbol scan
    return null
  }

  const cacheKey = `coingecko:sent:${symbol}` // NEW:
  const cached = await cache.get<CoinGeckoSentiment>(cacheKey) // NEW:
  if (cached) return cached // NEW:

  // FIX: only debug-log on actual network calls (cache miss)
  logger.debug({ context: 'COINGECKO', coinId }, '📡 Fetching sentiment data...')
  try { // NEW:
    const url =
      `https://api.coingecko.com/api/v3/coins/${coinId}` +
      `?localization=false&tickers=false&market_data=true` +
      `&community_data=true&developer_data=false` // NEW:

    const { data } = await axiosGetWithRetry(url) // FIX: use retry wrapper

    const sentimentUp = data.sentiment_votes_up_percentage ?? 50 // NEW:
    const sentimentDown = data.sentiment_votes_down_percentage ?? 50 // NEW:
    const priceChange1h = data.market_data?.price_change_percentage_1h_in_currency?.usd ?? 0 // NEW:
    const priceChange24h = data.market_data?.price_change_percentage_24h ?? 0 // NEW:

    const result: CoinGeckoSentiment = { // NEW:
      sentimentUp, // NEW:
      sentimentDown, // NEW:
      priceChange1h, // NEW:
      priceChange24h, // NEW:
      sentimentScore: Math.round(sentimentUp), // NEW:
    } // NEW:

    await cache.set(cacheKey, result, 600) // FIX: raise TTL to 10 min to reduce call rate
    // FIX: delay is NOW handled externally in scanner loop — no sleep here
    return result // NEW:
  } catch (err: any) { // NEW:
    // FIX: only log actual failures, not expected unmapped coins
    logger.error({ context: 'COINGECKO', err: err.message, coinId }, '❌ CoinGecko request failed')
    return null // NEW:
  } // NEW:
} // NEW:

function calculateSentimentScore( // NEW:
  coinGeckoData: CoinGeckoSentiment | null,
  fearGreed: FearGreed,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
): number { // NEW:
  if (direction === 'NEUTRAL') return 0 // NEW:

  let score = 0 // NEW:

  // Komponen 1: Fear & Greed (0–8 poin) — always available // NEW:
  const fg = fearGreed.value // NEW:
  if (direction === 'LONG') { // NEW:
    if (fg >= 75) score += 8 // NEW:
    else if (fg >= 55) score += 6 // NEW:
    else if (fg >= 45) score += 4 // NEW:
    else if (fg >= 25) score += 2 // NEW:
    else score += 1 // NEW:
  } else { // SHORT // NEW:
    if (fg <= 25) score += 8 // NEW:
    else if (fg <= 45) score += 6 // NEW:
    else if (fg <= 55) score += 4 // NEW:
    else if (fg <= 75) score += 2 // NEW:
    else score += 1 // NEW:
  } // NEW:

  // FIX Opsi B: if CoinGecko data missing, use F&G-only fallback minimum
  if (!coinGeckoData) {
    // Fear & Greed score already added above. Normalize to 0-10 pts max for fallback
    return Math.min(score, 10)
  }

  // Komponen 2: Community sentiment votes (0–7 poin) // NEW:
  const sentUp = coinGeckoData.sentimentUp // NEW:
  if (direction === 'LONG') { // NEW:
    if (sentUp >= 75) score += 7 // NEW:
    else if (sentUp >= 60) score += 5 // NEW:
    else if (sentUp >= 50) score += 3 // NEW:
    else score += 1 // NEW:
  } else { // SHORT // NEW:
    if (sentUp <= 25) score += 7 // NEW:
    else if (sentUp <= 40) score += 5 // NEW:
    else if (sentUp <= 50) score += 3 // NEW:
    else score += 1 // NEW:
  } // NEW:

  // Komponen 3: Price momentum 24h konfirmasi arah (0–5 poin) // NEW:
  const change24h = coinGeckoData.priceChange24h // NEW:
  if (direction === 'LONG' && change24h > 3) score += 5 // NEW:
  else if (direction === 'LONG' && change24h > 0) score += 3 // NEW:
  else if (direction === 'SHORT' && change24h < -3) score += 5 // NEW:
  else if (direction === 'SHORT' && change24h < 0) score += 3 // NEW:
  else score += 1 // NEW:

  return Math.min(score, 20) // NEW:
} // NEW:

// ─── Main export ──────────────────────────────────────────────────────────

export async function runSentimentEngine(
  symbol: string,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
  fearGreedOverride?: FearGreed, // NEW:
): Promise<SentimentScore> {
  const fearGreed = fearGreedOverride ?? await getFearAndGreed() // NEW:

  const cgData = await getCoinGeckoSentiment(symbol) // FIX: no longer forced into neutral object — let fallback handle it

  // FIX Opsi B: explicit warn if CoinGecko data is missing
  if (!cgData) {
    logger.warn({ context: 'SENTIMENT', symbol }, '⚠️ Using Fear&Greed only fallback for sentiment') // FIX:
  }

  const score = calculateSentimentScore(cgData, fearGreed, direction) // NEW:

  // FIX Opsi C: Log score breakdown so we can debug low scores
  logger.debug({
    context: 'SCORE',
    symbol,
    sentiment: score,
    cgAvailable: !!cgData,
    fearGreed: fearGreed.value,
    direction,
  }, '📊 Sentiment score breakdown') // FIX:

  const reasons: string[] = [] // NEW:
  reasons.push(`Fear & Greed: ${fearGreed.label} (${fearGreed.value})`) // NEW:
  if (cgData) {
    reasons.push(`CG sentiment up: ${Math.round(cgData.sentimentUp)}%`) // NEW:
    reasons.push(`CG 24h change: ${cgData.priceChange24h.toFixed(2)}%`) // NEW:
  } else {
    reasons.push('CoinGecko data unavailable — using F&G fallback') // FIX:
  }

  return { // NEW:
    score, // NEW:
    fearGreedVal: fearGreed.value, // NEW:
    fearGreedLabel: fearGreed.label, // NEW:
    reasons, // NEW:
  } // NEW:
}
