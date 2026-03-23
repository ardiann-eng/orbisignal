// analysis/fundamental.ts
// Handles whale activity and basic fundamentals. CryptoPanic removed. // NEW:

import { cache } from '@/utils/cache'
import { logger } from '@/utils/logger'
import { getCoinFundamentalData, type CoinFundamentalData } from '@/utils/coinMapping' // FIX: Use real CoinGecko metrics

// ─── Types ────────────────────────────────────────────────────────────────

// type NewsKind = 'positive' | 'negative' | 'neutral' // REMOVED:
// interface NewsItem { // REMOVED:
//   title:     string // REMOVED:
//   sentiment: NewsKind // REMOVED:
//   votes:     number   // REMOVED:
//   publishedAt: string // REMOVED:
// } // REMOVED:

export interface FundamentalScore {
  score:   number     // 0–30
  reasons: string[]
}

// ─── News Sentiment (CryptoPanic) ───────────────────────────────────────── // REMOVED:
// All CryptoPanic integration removed. Use CoinGecko + Fear&Greed in sentiment engine. // REMOVED:

// ─── Whale Activity ────────────────────────────────────────────────────────
// Whale Alert is consumed via their Telegram channel bot in production.
// Here we use their public REST API (requires paid plan for full access).
// In MVP: we proxy whale data through a simple manual cache populated
// by a separate Telegram listener or webhook.

interface WhaleEvent {
  symbol:    string
  amountUSD: number
  type:      'transfer' | 'exchange_inflow' | 'exchange_outflow'
  timestamp: number
}

/**
 * In MVP this reads from a Redis key populated by a separate whale-listener
 * process (or manually injected during testing).
 * Key: whale:{SYMBOL} → WhaleEvent[]
 */
async function getWhaleEvents(symbol: string): Promise<WhaleEvent[]> {
  const baseSymbol = symbol.split('/')[0]
  return (await cache.get<WhaleEvent[]>(`whale:${baseSymbol}`)) ?? []
}

function scoreWhaleActivity(
  events: WhaleEvent[],
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
): { points: number; reasons: string[] } {
  const reasons: string[] = []
  let points = 0

  const recentEvents = events.filter(e => Date.now() / 1000 - e.timestamp < 6 * 3600)
  const outflows     = recentEvents.filter(e => e.type === 'exchange_outflow')
  const inflows      = recentEvents.filter(e => e.type === 'exchange_inflow')

  const totalOutflowUSD = outflows.reduce((s, e) => s + e.amountUSD, 0)
  const totalInflowUSD  = inflows.reduce((s, e) => s + e.amountUSD, 0)

  // Exchange outflow = whales withdrawing to self-custody = accumulation signal (bullish)
  if (totalOutflowUSD > 5_000_000 && direction !== 'SHORT') {
    points += 12
    reasons.push(`Whale outflow from exchanges: $${(totalOutflowUSD / 1e6).toFixed(1)}M (accumulation)`)
  }

  // Exchange inflow = whales depositing to sell (bearish)
  if (totalInflowUSD > 5_000_000 && direction !== 'LONG') {
    points -= 12
    reasons.push(`Whale exchange inflow: $${(totalInflowUSD / 1e6).toFixed(1)}M (distribution)`)
  }

  return { points, reasons }
}

// ─── Fundamental Metrics (CoinGecko) — Intraday Optimized ─────────────────
// Composition: Liquidity 40% | Volume Consistency 30% | Rank 20% | Trend 10%
// ATH drawdown = minor bonus only (max +2)
// Total max = 30 points

function calculateFundamentalScore(
  cgData: CoinFundamentalData | null,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
): { points: number; reasons: string[] } {
  if (!cgData || direction === 'NEUTRAL') return { points: 0, reasons: [] }
  
  let score = 0
  const reasons: string[] = []

  // ── Komponen 1: LIQUIDITY — vol/mcap ratio (max 12 pts = 40%) ──────
  // Higher ratio = more liquid = better for intraday entries/exits
  const volMcap = cgData.market_cap > 0 ? cgData.total_volume / cgData.market_cap : 0
  if (volMcap >= 0.20)      { score += 12; reasons.push(`Liq: ${(volMcap*100).toFixed(1)}% vol/mcap (+12)`) }
  else if (volMcap >= 0.12) { score += 10; reasons.push(`Liq: ${(volMcap*100).toFixed(1)}% vol/mcap (+10)`) }
  else if (volMcap >= 0.06) { score += 8;  reasons.push(`Liq: ${(volMcap*100).toFixed(1)}% vol/mcap (+8)`) }
  else if (volMcap >= 0.03) { score += 5;  reasons.push(`Liq: ${(volMcap*100).toFixed(1)}% vol/mcap (+5)`) }
  else if (volMcap >= 0.01) { score += 2;  reasons.push(`Liq: ${(volMcap*100).toFixed(1)}% vol/mcap (+2)`) }
  // < 1% = 0 pts (too illiquid for intraday)

  // ── Komponen 2: VOLUME CONSISTENCY (max 9 pts = 30%) ───────────────
  // Proxy: use the relationship between volume and marketcap rank.
  // Coins with high volume relative to their rank are "consistently active".
  // A top-100 coin with $500M+ vol is healthy. A top-500 coin with $500M+ vol is exceptional.
  const rank = cgData.market_cap_rank || 999
  const vol  = cgData.total_volume || 0
  const volPerRank = rank > 0 ? vol / rank : 0

  if (volPerRank >= 5_000_000)      { score += 9; reasons.push(`VolCon: $${(vol/1e6).toFixed(0)}M at rank ${rank} (+9)`) }
  else if (volPerRank >= 2_000_000) { score += 7; reasons.push(`VolCon: $${(vol/1e6).toFixed(0)}M at rank ${rank} (+7)`) }
  else if (volPerRank >= 500_000)   { score += 5; reasons.push(`VolCon: $${(vol/1e6).toFixed(0)}M at rank ${rank} (+5)`) }
  else if (volPerRank >= 100_000)   { score += 3; reasons.push(`VolCon: $${(vol/1e6).toFixed(0)}M at rank ${rank} (+3)`) }
  else if (vol >= 1_000_000)        { score += 1; reasons.push(`VolCon: $${(vol/1e6).toFixed(1)}M minimal (+1)`) }
  // Very low volume = 0 pts

  // ── Komponen 3: RANK (max 6 pts = 20%) ─────────────────────────────
  // Moderate bonus — not dominant. Higher rank = safer asset for intraday.
  if (rank <= 20)       { score += 6; reasons.push(`Rank ${rank} (+6)`) }
  else if (rank <= 50)  { score += 5; reasons.push(`Rank ${rank} (+5)`) }
  else if (rank <= 100) { score += 4; reasons.push(`Rank ${rank} (+4)`) }
  else if (rank <= 200) { score += 2; reasons.push(`Rank ${rank} (+2)`) }
  else if (rank <= 300) { score += 1; reasons.push(`Rank ${rank} (+1)`) }

  // ── Komponen 4: TREND CONTEXT (max 3 pts = 10%) ────────────────────
  // Small confirmation only — intraday doesn't rely heavily on weekly trend
  const change7d = cgData.price_change_percentage_7d_in_currency || 0
  if (direction === 'LONG') {
    if (change7d >= 5)       { score += 3; reasons.push('7d trend confirms LONG (+3)') }
    else if (change7d >= 0)  { score += 1; reasons.push('7d trend neutral-positive (+1)') }
  } else {
    if (change7d <= -5)      { score += 3; reasons.push('7d trend confirms SHORT (+3)') }
    else if (change7d <= 0)  { score += 1; reasons.push('7d trend neutral-negative (+1)') }
  }

  // ── Minor Bonus: ATH Drawdown (max +2 pts) ─────────────────────────
  // Demoted to minor bonus — not a primary factor for intraday
  const athChange = cgData.ath_change_percentage || 0
  if (direction === 'LONG' && athChange <= -70) {
    score += 2; reasons.push('ATH drawdown deep value bonus (+2)')
  } else if (direction === 'SHORT' && athChange >= -15) {
    score += 2; reasons.push('Near ATH short bonus (+2)')
  }

  return { points: Math.min(score, 30), reasons }
}

// const SYMBOL_TO_CP: Record<string, string> = { ... } // REMOVED:

// ─── Main export ──────────────────────────────────────────────────────────

export async function runFundamentalEngine(
  symbol: string,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
): Promise<FundamentalScore> {
  try { // NEW:
    const whaleEvents = await getWhaleEvents(symbol)
    const { points: whalePoints, reasons: whaleReasons } = scoreWhaleActivity(whaleEvents, direction) // NEW:

    // Ambil data CoinGecko fundamental dari mapping yang sudah difetch saat startup
    const cgData = getCoinFundamentalData(symbol)
    
    let cgMetrics: { points: number; reasons: string[] };
    if (!cgData) {
      // AUDIT FIX: Don't penalize mid-cap/unmapped coins with 0. Give neutral 15 points.
      cgMetrics = { points: 15, reasons: ['No fundamental data (mid-cap/unmapped) — using neutral base score'] }
    } else {
      cgMetrics = calculateFundamentalScore(cgData, direction)
    }

    const rawPoints = whalePoints + cgMetrics.points
    const score = Math.min(Math.max(rawPoints, 0), 30) // Max 30 pts
    
    return { score, reasons: [...whaleReasons, ...cgMetrics.reasons].slice(0, 5) }
  } catch (err) {
    logger.error({ err, symbol }, 'runFundamentalEngine failed')
    return { score: 10, reasons: ['Fundamental engine error — using neutral fallback'] }
  }
}
