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
  score:   number     // 0–40
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

// ─── Fundamental Metrics (CoinGecko) ──────────────────────────────────────

// FIX: Fundamental score uses real CoinGecko metrics cached via coinMapping
function calculateFundamentalScore(
  cgData: CoinFundamentalData | null,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
): { points: number; reasons: string[] } {
  if (!cgData || direction === 'NEUTRAL') return { points: 0, reasons: [] }
  
  let score = 0
  const reasons: string[] = []

  // Komponen 1: Market cap rank (0–10 poin)
  const rank = cgData.market_cap_rank || 999
  if (rank <= 10)       { score += 10; reasons.push('Rank <= 10 (+10)') }
  else if (rank <= 50)  { score += 7;  reasons.push('Rank <= 50 (+7)') }
  else if (rank <= 100) { score += 5;  reasons.push('Rank <= 100 (+5)') }
  else if (rank <= 200) { score += 3;  reasons.push('Rank <= 200 (+3)') }
  // AUDIT FIX: rank > 200 → 0 pts (tidak ada skor bonus palsu)

  // Komponen 2: Volume/MarketCap ratio (0–10 poin)
  const volMcap = cgData.market_cap > 0 ? cgData.total_volume / cgData.market_cap : 0
  if (volMcap >= 0.15)      { score += 10; reasons.push('Liq/Vol >= 15% (+10)') }
  else if (volMcap >= 0.08) { score += 7;  reasons.push('Liq/Vol >= 8% (+7)') }
  else if (volMcap >= 0.04) { score += 5;  reasons.push('Liq/Vol >= 4% (+5)') }
  else if (volMcap >= 0.02) { score += 3;  reasons.push('Liq/Vol >= 2% (+3)') }
  // AUDIT FIX: vol/mcap sangat rendah → 0 pts

  // Komponen 3: Price change 7 hari konfirmasi tren (0–10 poin)
  const change7d = cgData.price_change_percentage_7d_in_currency || 0
  if (direction === 'LONG') {
    if (change7d >= 10)      { score += 10; reasons.push('7d Uptrend >= 10% (+10)') }
    else if (change7d >= 5)  { score += 7;  reasons.push('7d Uptrend >= 5% (+7)') }
    else if (change7d >= 0)  { score += 4;  reasons.push('Positive 7d Trend (+4)') }
    // AUDIT FIX: 7d negatif untuk LONG → 0 pts
  } else { // SHORT
    if (change7d <= -10)     { score += 10; reasons.push('7d Downtrend <= -10% (+10)') }
    else if (change7d <= -5) { score += 7;  reasons.push('7d Downtrend <= -5% (+7)') }
    else if (change7d <= 0)  { score += 4;  reasons.push('Negative 7d Trend (+4)') }
    // AUDIT FIX: 7d positif untuk SHORT → 0 pts
  }

  // Komponen 4: ATH drawdown (0–10 poin)
  const athChange = cgData.ath_change_percentage || 0
  if (direction === 'LONG') {
    if (athChange <= -80)      { score += 10; reasons.push('Deep Value / Dump <= -80% (+10)') }
    else if (athChange <= -60) { score += 7;  reasons.push('Pullback <= -60% (+7)') }
    else if (athChange <= -40) { score += 5;  reasons.push('Pullback <= -40% (+5)') }
    else if (athChange <= -20) { score += 3;  reasons.push('Pullback <= -20% (+3)') }
    // AUDIT FIX: near ATH saat LONG → 0 pts (tidak ada skor gratis)
  } else { // SHORT
    if (athChange >= -10)      { score += 10; reasons.push('Close to ATH, Short Ripe (+10)') }
    else if (athChange >= -20) { score += 7;  reasons.push('Near ATH Peak (+7)') }
    else if (athChange >= -30) { score += 5;  reasons.push('Distance from ATH <= -30% (+5)') }
    // AUDIT FIX: jauh dari ATH saat SHORT → 0 pts
  }

  return { points: Math.min(score, 40), reasons }
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
    const cgMetrics = calculateFundamentalScore(cgData, direction)

    const rawPoints = whalePoints + cgMetrics.points // Kombinasi Whale (bonus) + CG metrics
    const score = Math.min(Math.max(rawPoints, 0), 40) // NEW: Maksimal 40 poin
    
    // Gabung semua alasan, cap ke 5 alasan agar rapi
    return { score, reasons: [...whaleReasons, ...cgMetrics.reasons].slice(0, 5) } // NEW:
  } catch (err) { // NEW:
    logger.error({ err, symbol }, 'runFundamentalEngine failed') // NEW:
    return { score: 0, reasons: [] } // NEW:
  } // NEW:
}
