// services/signalEngine.ts
// The brain. Takes outputs from all three analysis engines, combines them,
// applies every filter from the blueprint, and returns a signal or null.

import { config, SCORE_WEIGHTS, MAX_RAW_SCORE, BTC_DROP_THRESHOLD_PCT, BTC_WEAK_THRESHOLD_PCT } from '@/lib/config'
import { isOnCooldown, setCooldown }                      from '@/utils/cache'
import { getBTCHourlyChange }                              from '@/services/marketData'
import { buildRiskPlan, type RiskPlan }                    from '@/services/riskManager'
import type { TechnicalScore, MarketStructureResult }     from '@/analysis/technical'
import type { FundamentalScore }                           from '@/analysis/fundamental'
import type { OpenInterestScore }                          from '@/analysis/openInterest'
import type { PatternResult }                              from '@/services/patternRecognition'
import { getPatternBonus }                                 from '@/services/patternRecognition'
import { calcATR }                                      from '@/services/riskManager'
import { calculateEntryQuality, type EntryQualityResult } from '@/analysis/entryQuality'
import { logger }                                          from '@/utils/logger'
import { prisma }                                          from '@/lib/db'
import { getCandles }                                      from '@/services/marketData'

// ─── Types ────────────────────────────────────────────────────────────────

export type SignalDirection = 'LONG' | 'SHORT'

export interface Signal {
  symbol:         string
  direction:      SignalDirection
  confidence:     number           // 0–100 (final weighted score)
  technical:      number
  fundamental:    number
  openInterest:   number
  currentPrice:   number
  riskPlan:       RiskPlan
  reasons:        string[]
  oiValue:        number
  oiChange:       number
  patternName:    string
  patternConfidence: number
  patternReason:  string
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

  // ── Filter 6: Volume confirmation ────────────────────────────
  if (tech) {
    const tf1h = tech.details.find(d => d.timeframe === '1h')
    if (tf1h && tf1h.volumeRatio < 0.5) {
      return { pass: false, reason: `Volume too low: ratio ${tf1h.volumeRatio.toFixed(2)} < 0.5` }
    }
  }

  return { pass: true, reason: '' }
}

// ─── Score combiner ───────────────────────────────────────────────────────────

/**
 * Market structure modifier: scores the structural context.
 * Returns a score from -3 to +10 (capped to SCORE_WEIGHTS.structure).
 */
function scoreMarketStructure(
  ms: MarketStructureResult,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
): { structureScore: number; structureReasons: string[] } {
  if (direction === 'NEUTRAL') return { structureScore: 0, structureReasons: [] }

  let score = 0
  const reasons: string[] = []

  if (direction === 'LONG') {
    if (ms.bos === 'BULLISH')    { score += 4; reasons.push('BOS Bullish (+4)') }
    if (ms.higherLow)            { score += 3; reasons.push('Higher Low (+3)') }
    if (ms.breakout)             { score += 3; reasons.push('Resistance Breakout (+3)') }
    if (ms.supportReject)        { score += 2; reasons.push('Support Rejection (+2)') }
    // Penalty for contradicting structure
    if (ms.bos === 'BEARISH')    { score -= 3; reasons.push('BOS Bearish contradicts LONG (−3)') }
    if (ms.lowerHigh)            { score -= 2; reasons.push('Lower High contradicts LONG (−2)') }
    if (ms.breakdown)            { score -= 3; reasons.push('Breakdown contradicts LONG (−3)') }
  } else { // SHORT
    if (ms.bos === 'BEARISH')    { score += 4; reasons.push('BOS Bearish (+4)') }
    if (ms.lowerHigh)            { score += 3; reasons.push('Lower High (+3)') }
    if (ms.breakdown)            { score += 3; reasons.push('Support Breakdown (+3)') }
    if (ms.resistReject)         { score += 2; reasons.push('Resistance Rejection (+2)') }
    // Penalty for contradicting structure
    if (ms.bos === 'BULLISH')    { score -= 3; reasons.push('BOS Bullish contradicts SHORT (−3)') }
    if (ms.higherLow)            { score -= 2; reasons.push('Higher Low contradicts SHORT (−2)') }
    if (ms.breakout)             { score -= 3; reasons.push('Breakout contradicts SHORT (−3)') }
  }

  const clamped = Math.max(0, Math.min(score, SCORE_WEIGHTS.structure))
  return { structureScore: clamped, structureReasons: reasons }
}

/**
 * Combines all 5 scoring pillars into a single confidence percentage.
 * Tech(40) + Structure(10) + Pattern(10) + Fund(30) + OI(20) = 110 max raw
 * Confidence = rawTotal / 110 * 100
 */
function combineScores(
  techScore:      number,
  structureScore: number,
  patternScore:   number,
  fundScore:      number,
  oiScore:        number,
): { confidence: number; pilarsPassing: number } {
  const rawTotal = techScore + structureScore + patternScore + fundScore + oiScore
  const confidence = Math.min(Math.round((rawTotal / MAX_RAW_SCORE) * 100), 100)

  const pilarsPassing = [
    techScore      >= SCORE_WEIGHTS.technical    * 0.15,
    structureScore >= 1,  // Any positive structure signal counts
    fundScore      >= SCORE_WEIGHTS.fundamental  * 0.15,
    oiScore        >= SCORE_WEIGHTS.openInterest * 0.15,
  ].filter(Boolean).length

  return { confidence, pilarsPassing }
}

/**
 * Adaptive confidence threshold:
 * - Strong tech (≥35): lower bar (42) since technical conviction is high
 * - Normal tech (20–34): standard bar (45)
 * - Weak tech (<20): higher bar (47) to prevent noise
 */
function getAdaptiveThreshold(techScore: number): number {
  if (techScore >= 35) return 42
  if (techScore >= 20) return 45
  return 47
}

// ─── Main signal builder ──────────────────────────────────────────────────

export async function buildSignal(
  symbol:    string,
  tech:      TechnicalScore,
  fund:      FundamentalScore,
  oi:        OpenInterestScore,
  pattern:   PatternResult | null = null,
): Promise<SignalResult> {
  const direction = tech.direction

  // ── 1. Market Structure scoring ──────────────────────────────
  const tf4h = tech.details.find(d => d.timeframe === '4h')
  const ms = tf4h?.marketStructure
  const { structureScore, structureReasons } = ms
    ? scoreMarketStructure(ms, direction)
    : { structureScore: 0, structureReasons: ['No structure data'] }

  // ── 2. Pattern scoring ───────────────────────────────────────
  let patternScore = 0
  let patternLabel = 'None'
  let patternTier  = 'N/A'
  let patternName  = 'None'
  let patternConf  = 0
  let patternReason = 'No pattern detected'

  if (pattern && direction !== 'NEUTRAL') {
    const bonus = getPatternBonus(pattern, direction as 'LONG' | 'SHORT')
    patternScore = Math.max(0, Math.min(bonus, SCORE_WEIGHTS.pattern))
    patternName  = pattern.pattern
    patternLabel = `${pattern.pattern} (${pattern.bias})`
    patternConf  = pattern.confidence || 0
    patternReason = pattern.logic || 'Pattern logic confirmed by AI engine'
    patternTier  = bonus >= 8 ? 'HIGH' : bonus > 0 ? 'LOW' : 'OPPOSING'
    
    logger.info({
      context: 'PATTERN_ENGINE',
      symbol,
      pattern: patternName,
      confidence: patternConf,
      reason: patternReason
    }, `🔍 [${symbol}] Pattern Detected: ${patternName}`)
  }

  // ── 3. Entry Quality Filter (EMA9 Distance) ───────────────
  if (!tf4h) return { signal: null, rejectionReason: 'Missing 4H technical data' }

  const candles4h = await getCandles(symbol, '4h', 60)
  const atr = calcATR(candles4h)
  const entryQualityResult = calculateEntryQuality(
    tf4h.currentPrice,
    tf4h.ema9,
    atr,
    symbol
  )

  // ── 4. Combine all 5 pillars + Entry Quality Bonus ──────────
  const { confidence: initialConfidence, pilarsPassing } = combineScores(
    tech.score, structureScore, patternScore, fund.score, oi.score
  )

  // Apply entry quality modifier
  const confidence = Math.min(Math.max(0, initialConfidence + entryQualityResult.score), 100)

  // ── 4. Adaptive confidence threshold ─────────────────────────
  const threshold = getAdaptiveThreshold(tech.score)

  // ── 5. Detailed analysis log ─────────────────────────────────
  const tf1h = tech.details.find(d => d.timeframe === '1h')
  logger.info({
    context: 'ANALYSIS',
    symbol,
    direction,
    technical: {
      score: tech.score,
      rsi4h: tf4h?.rsi.toFixed(0) ?? '-',
      rsi1h: tf1h?.rsi.toFixed(0) ?? '-',
      macdHist4h: tf4h?.macdHist.toFixed(4) ?? '-',
      emaStack: tf4h ? `${tf4h.ema9.toFixed(2)}/${tf4h.ema21.toFixed(2)}/${tf4h.ema50.toFixed(2)}` : '-',
      volumeRatio: tf1h?.volumeRatio.toFixed(1) ?? '-',
    },
    structure: {
      score: structureScore,
      bos: ms?.bos ?? 'N/A',
      higherLow: ms?.higherLow ?? false,
      lowerHigh: ms?.lowerHigh ?? false,
      breakout: ms?.breakout ?? false,
      breakdown: ms?.breakdown ?? false,
      supportReject: ms?.supportReject ?? false,
      resistReject: ms?.resistReject ?? false,
    },
    pattern: {
      score: patternScore,
      detected: patternLabel,
      tier: patternTier,
    },
    fundamental: {
      score: fund.score,
      reasons: fund.reasons.slice(0, 4),
    },
    openInterest: {
      score: oi.score,
      oiChange: oi.oiChange.toFixed(2) + '%',
      fundingRate: (oi.fundingRate * 100).toFixed(4) + '%',
      reasons: oi.reasons,
    },
    entryQuality: {
      status: entryQualityResult.status,
      ratio:  entryQualityResult.ratio.toFixed(2),
      score:  entryQualityResult.score,
    },
    final: {
      rawTotal: tech.score + structureScore + patternScore + fund.score + oi.score,
      confidence,
      threshold,
      pillars: pilarsPassing,
    },
  }, `📊 [${symbol}] Analysis Complete`)

  // ── 6. Multi-pillar gate ─────────────────────────────────────
  const minPillars = tech.score >= 35 ? 1 : 2
  if (pilarsPassing < minPillars) {
    const reason = `Only ${pilarsPassing}/4 pillars qualifying (need ${minPillars})`
    logger.info({ context: 'REJECT', symbol, reason }, `❌ [${symbol}] ${reason}`)
    return { signal: null, rejectionReason: reason }
  }

  // ── 7. Adaptive confidence check ─────────────────────────────
  const confThreshold = Math.min(threshold, config.MIN_CONFIDENCE)
  if (confidence < confThreshold) {
    const reason = `Confidence ${confidence} below adaptive threshold ${confThreshold}`
    logger.info({ context: 'REJECT', symbol, confidence, threshold: confThreshold }, `❌ [${symbol}] ${reason}`)
    return { signal: null, rejectionReason: reason }
  }

  // ── 8. Safety filters ────────────────────────────────────────
  const { pass, reason } = await passesAllFilters({ symbol, direction, confidence, tech })
  if (!pass) {
    logger.info({ context: 'REJECT', symbol, reason }, `❌ [${symbol}] ${reason}`)
    return { signal: null, rejectionReason: reason }
  }

  // ── 9. Build risk plan ───────────────────────────────────────
  const resolvedDirection = direction as SignalDirection
  if (!tf4h) {
    return { signal: null, rejectionReason: 'Missing 4H technical data for risk plan' }
  }

  const riskPlan = await buildRiskPlan(symbol, resolvedDirection, tf4h)
  if (!riskPlan.isValid) {
    const rr = `R:R=${riskPlan.rrRatio} SL=${riskPlan.slPct}%`
    logger.info({ context: 'REJECT', symbol, rr }, `❌ [${symbol}] Risk plan invalid: ${rr}`)
    return { signal: null, rejectionReason: `Risk plan invalid: ${rr}` }
  }

  // ── 10. Assemble final signal ────────────────────────────────
  const allReasons = [
    `Entry Quality: ${entryQualityResult.status} (${entryQualityResult.ratio.toFixed(2)}x ATR)`,
    ...tech.reasons,
    ...structureReasons,
    ...fund.reasons,
    ...oi.reasons,
  ].filter(Boolean).slice(0, 8)

  const signal: Signal = {
    symbol,
    direction:      resolvedDirection,
    confidence,
    technical:      tech.score,
    fundamental:    fund.score,
    openInterest:   oi.score,
    currentPrice:   tf4h.currentPrice,
    riskPlan,
    reasons:        allReasons,
    oiValue:        oi.oiValue,
    oiChange:       oi.oiChange,
    patternName,
    patternConfidence: patternConf,
    patternReason,
    generatedAt:    new Date(),
  }

  // ── Set cooldown ─────────────────────────────────────────────
  await setCooldown(symbol, config.COOLDOWN_HOURS)

  logger.info({ context: 'SIGNAL', symbol, direction: resolvedDirection, confidence }, '🎯 Signal generated')
  return { signal, rejectionReason: null }
}
