// services/signalEngine.ts
// The brain. Takes outputs from all three analysis engines, combines them,
// applies every filter from the blueprint, and returns a signal or null.

import { config, SCORE_WEIGHTS, BTC_DROP_THRESHOLD_PCT, BTC_WEAK_THRESHOLD_PCT } from '@/lib/config'
import { isOnCooldown, setCooldown }                      from '@/utils/cache'
import { getBTCHourlyChange }                              from '@/services/marketData'
import { buildRiskPlan, type RiskPlan }                    from '@/services/riskManager'
import type { TechnicalScore }                             from '@/analysis/technical'
import type { FundamentalScore }                           from '@/analysis/fundamental'
import type { SentimentScore }                             from '@/analysis/sentiment'
import { logger }                                          from '@/utils/logger'
import { prisma }                                          from '@/lib/db'

// ─── Types ────────────────────────────────────────────────────────────────

export type SignalDirection = 'LONG' | 'SHORT'

export interface Signal {
  symbol:         string
  direction:      SignalDirection
  confidence:     number           // 0–100 (final weighted score)
  techScore:      number
  fundScore:      number
  sentScore:      number
  currentPrice:   number
  riskPlan:       RiskPlan
  reasons:        string[]
  fearGreedVal:   number           // NEW:
  fearGreedLabel: string
  generatedAt:    Date
}

export interface SignalResult {
  signal:         Signal | null
  rejectionReason:string | null
}

// ─── Filter pipeline ──────────────────────────────────────────────────────

interface FilterContext {
  symbol:    string
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
  confidence:number
  tech?:     import('@/analysis/technical').TechnicalScore
}

async function passesAllFilters(ctx: FilterContext): Promise<{ pass: boolean; reason: string }> {
  const { symbol, direction, confidence, tech } = ctx

  // ── Filter 1: Direction must be resolved ─────────────────────
  if (direction === 'NEUTRAL') {
    return { pass: false, reason: 'Technical direction unresolved (NEUTRAL)' }
  }

  // ── Filter 2: Minimum confidence threshold ─────────────────
  if (confidence < config.MIN_CONFIDENCE) {
    logger.warn({ context: 'SIGNAL', symbol, confidence, threshold: config.MIN_CONFIDENCE }, '⚠️ Signal below threshold — not sent')
    return { pass: false, reason: `Confidence ${confidence} below threshold ${config.MIN_CONFIDENCE}` }
  }

  // ── Filter 3: Cooldown check ────────────────────────────
  if (await isOnCooldown(symbol)) {
    return { pass: false, reason: `${symbol} on cooldown (${config.COOLDOWN_HOURS}h)` }
  }

  // ── Filter 4: BTC circuit-breaker (LONG signals only) ──────
  if (direction === 'LONG') {
    const btcChange = await getBTCHourlyChange()
    // Hard circuit-breaker: BTC drops > 2.5%/1h → all LONGs blocked
    if (btcChange < -BTC_DROP_THRESHOLD_PCT) {
      return {
        pass: false,
        reason: `BTC circuit-breaker: -${Math.abs(btcChange).toFixed(1)}% in 1h — all LONG alerts suppressed`,
      }
    }
    // Soft circuit-breaker: BTC drops > 1.5%/1h → need higher confidence
    if (btcChange < -BTC_WEAK_THRESHOLD_PCT && confidence < 70) {
      return {
        pass: false,
        reason: `BTC weakening (-${Math.abs(btcChange).toFixed(1)}%/1h) — need confidence ≥70 to enter LONG (got ${confidence})`,
      }
    }
  }

  // ── Filter 5: Market Regime — EMA spread sideways detector ──
  // Tolak sinyal jika market sideways/choppy (EMA 9 dan 50 terlalu dekat)
  if (tech) {
    const tf4h = tech.details.find(d => d.timeframe === '4h')
    if (tf4h && tf4h.ema50 > 0) {
      const emaSpreadPct = Math.abs(tf4h.ema9 - tf4h.ema50) / tf4h.ema50 * 100
      if (emaSpreadPct < 1.5) {
        return {
          pass: false,
          reason: `Market too choppy: EMA9/EMA50 spread ${emaSpreadPct.toFixed(2)}% < 1.5% (no trend structure)`,
        }
      }
    }
  }

  return { pass: true, reason: '' }
}

// ─── Score combiner ───────────────────────────────────────────────────────

/**
 * Combines the three engine scores using the 40/40/20 weight system.
 * Each engine already normalizes its score to its own max weight,
 * so we just sum them. Total possible = 40 + 40 + 20 = 100.
 *
 * Additional rule from blueprint: at least 2 of 3 engines must contribute
 * a non-trivial score (>= 30% of their max) for the signal to qualify.
 */
function combineScores(
  techScore: number,
  fundScore: number,
  sentScore: number,
): { confidence: number; pilarsPassing: number } {
  const maxPossibleScore = 100 // NEW: CryptoPanic removed; total score always 100

  const rawTotal = techScore + fundScore + sentScore;
  const confidence = Math.min(Math.round((rawTotal / maxPossibleScore) * 100), 100);

  const pilarsPassing = [
    techScore >= SCORE_WEIGHTS.technical   * 0.30,
    fundScore >= SCORE_WEIGHTS.fundamental * 0.30,
    sentScore >= SCORE_WEIGHTS.sentiment   * 0.30,
  ].filter(Boolean).length;

  return { confidence, pilarsPassing };
}

// ─── Main signal builder ──────────────────────────────────────────────────

export async function buildSignal(
  symbol:    string,
  tech:      TechnicalScore,
  fund:      FundamentalScore,
  sent:      SentimentScore,
): Promise<SignalResult> {
  const direction = tech.direction

  const { confidence, pilarsPassing } = combineScores(
    tech.score,
    fund.score,
    sent.score,
  )

  // ── Multi-pilar gate: at least 2/3 engines must agree ──── AUDIT FIX
  if (pilarsPassing < 2) {
    return {
      signal: null,
      rejectionReason: `Only ${pilarsPassing}/3 analysis pillars qualifying (need at least 2 for confluence)`,
    }
  }

  // ── Run all filters ────────────────────────────────────────
  const { pass, reason } = await passesAllFilters({ symbol, direction, confidence, tech })
  if (!pass) {
    logger.debug({ symbol, reason }, 'Signal rejected by filter')
    return { signal: null, rejectionReason: reason }
  }

  // At this point direction is either LONG or SHORT (neutrals rejected above)
  const resolvedDirection = direction as SignalDirection

  // ── Build risk plan ────────────────────────────────────────
  const tf4h = tech.details.find(d => d.timeframe === '4h')
  if (!tf4h) {
    return { signal: null, rejectionReason: 'Missing 4H technical data for risk plan' }
  }

  const riskPlan = await buildRiskPlan(symbol, resolvedDirection, tf4h)

  if (!riskPlan.isValid) {
    return {
      signal: null,
      rejectionReason: `Risk plan invalid: R:R=${riskPlan.rrRatio} SL=${riskPlan.slPct}%`,
    }
  }

  // ── Assemble final signal ──────────────────────────────────
  const allReasons = [
    ...tech.reasons,
    ...fund.reasons,
    ...sent.reasons,
  ].filter(Boolean).slice(0, 7)  // cap at 7 reasons for readable Telegram message

  const signal: Signal = {
    symbol,
    direction:      resolvedDirection,
    confidence,
    techScore:      tech.score,
    fundScore:      fund.score,
    sentScore:      sent.score,
    currentPrice:   tf4h.currentPrice,
    riskPlan,
    reasons:        allReasons,
    fearGreedVal:   sent.fearGreedVal, // NEW:
    fearGreedLabel: sent.fearGreedLabel,
    generatedAt:    new Date(),
  }

  // ── Set cooldown ───────────────────────────────────────────
  await setCooldown(symbol, config.COOLDOWN_HOURS)

  logger.info({ context: 'SIGNAL', symbol, direction: resolvedDirection, confidence }, '🎯 Signal generated')
  return { signal, rejectionReason: null }
}
