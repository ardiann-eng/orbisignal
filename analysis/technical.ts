// analysis/technical.ts
// Pure mathematical implementations. No external TA library dependency.
// Each function is independently testable.

import { getCandles, type Candle } from '@/services/marketData'
import { TECHNICAL_THRESHOLDS, TIMEFRAMES } from '@/lib/config'
import { logger } from '@/utils/logger'

// ─── Types ────────────────────────────────────────────────────────────────

export interface MarketStructureResult {
  bos:          'BULLISH' | 'BEARISH' | 'NONE'  // Break of Structure
  higherLow:    boolean                           // last swing low > prev swing low
  lowerHigh:    boolean                           // last swing high < prev swing high
  breakout:     boolean                           // close above last swing high (bullish)
  breakdown:    boolean                           // close below last swing low (bearish)
  supportReject:boolean                           // rejection wick near swing low
  resistReject: boolean                           // rejection wick near swing high
}

export interface TechnicalResult {
  timeframe: string
  rsi:       number
  macd:      number
  macdSignal:number
  macdHist:  number
  ema9:      number
  ema21:     number
  ema50:     number
  currentPrice: number
  priceChange:  number         // 1-hour change for OI confirmation
  volumeRatio:  number         // current volume / 20-period avg
  nearSupport:  boolean
  nearResistance: boolean
  supportLevel: number
  resistanceLevel: number
  marketStructure: MarketStructureResult
}

export interface TechnicalScore {
  score:    number             // 0–40 (weight already applied)
  details:  TechnicalResult[]  // one per timeframe
  reasons:  string[]
  direction: 'LONG' | 'SHORT' | 'NEUTRAL'
}

// ─── Math helpers ─────────────────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  let ema = values[0]
  result.push(ema)
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    result.push(ema)
  }
  return result
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50

  let gains = 0, losses = 0

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  // Wilder smoothing for remaining periods
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function calcMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { macd: number; signal: number; histogram: number } {
  if (closes.length < slow + signal) {
    return { macd: 0, signal: 0, histogram: 0 }
  }
  const emaFast   = calcEMA(closes, fast)
  const emaSlow   = calcEMA(closes, slow)
  const macdLine  = emaFast.map((v, i) => v - emaSlow[i])
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal)
  const lastMacd   = macdLine[macdLine.length - 1]
  const lastSignal = signalLine[signalLine.length - 1]
  return {
    macd:      lastMacd,
    signal:    lastSignal,
    histogram: lastMacd - lastSignal,
  }
}

/**
 * Simple support/resistance: find the highest high and lowest low
 * over the last N candles (excluding the most recent 5 to avoid
 * counting the current move as S/R).
 */
function calcSupportResistance(
  candles: Candle[],
  lookback = 50,
): { support: number; resistance: number } {
  const slice = candles.slice(-lookback - 5, -5)
  if (!slice.length) return { support: 0, resistance: 0 }
  const highs = slice.map(c => c.high)
  const lows  = slice.map(c => c.low)
  return {
    support:    Math.min(...lows),
    resistance: Math.max(...highs),
  }
}

/**
 * Detects market structure signals using simple swing high/low logic.
 * Uses a lookback window of `swingWindow` candles to identify swing points.
 * Pure function — no external calls.
 */
function detectMarketStructure(
  candles: Candle[],
  swingWindow = 5,
): MarketStructureResult {
  const result: MarketStructureResult = {
    bos: 'NONE',
    higherLow: false,
    lowerHigh: false,
    breakout: false,
    breakdown: false,
    supportReject: false,
    resistReject: false,
  }

  if (candles.length < swingWindow * 3 + 5) return result

  // ── Find recent swing highs and lows ──────────────────────────
  // Swing High: candle whose high is higher than swingWindow candles on each side
  // Swing Low:  candle whose low is lower than swingWindow candles on each side
  const swingHighs: number[] = []
  const swingLows:  number[] = []

  // Search the last 60 candles (skip last 2 — they are forming)
  const searchSlice = candles.slice(-60, -2)
  for (let i = swingWindow; i < searchSlice.length - swingWindow; i++) {
    const hi = searchSlice[i].high
    const lo = searchSlice[i].low

    let isSwingHigh = true
    let isSwingLow  = true
    for (let j = i - swingWindow; j <= i + swingWindow; j++) {
      if (j === i) continue
      if (searchSlice[j].high >= hi) isSwingHigh = false
      if (searchSlice[j].low  <= lo) isSwingLow  = false
    }
    if (isSwingHigh) swingHighs.push(hi)
    if (isSwingLow)  swingLows.push(lo)
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return result

  const lastSwingHigh = swingHighs[swingHighs.length - 1]
  const prevSwingHigh = swingHighs[swingHighs.length - 2]
  const lastSwingLow  = swingLows[swingLows.length - 1]
  const prevSwingLow  = swingLows[swingLows.length - 2]

  const lastCandle  = candles[candles.length - 1]
  const lastClose   = lastCandle.close
  const lastLow     = lastCandle.low
  const lastHigh    = lastCandle.high
  const body        = Math.abs(lastCandle.close - lastCandle.open)
  const lowerWick   = Math.min(lastCandle.open, lastCandle.close) - lastLow
  const upperWick   = lastHigh - Math.max(lastCandle.open, lastCandle.close)

  // ── BOS: Break of Structure ───────────────────────────────────
  // Bullish BOS: last close is above previous swing high
  if (lastClose > lastSwingHigh) {
    result.bos = 'BULLISH'
  }
  // Bearish BOS: last close is below previous swing low
  else if (lastClose < lastSwingLow) {
    result.bos = 'BEARISH'
  }

  // ── Higher Low / Lower High ───────────────────────────────────
  result.higherLow = lastSwingLow > prevSwingLow
  result.lowerHigh = lastSwingHigh < prevSwingHigh

  // ── Breakout: close above last swing high ─────────────────────
  result.breakout  = lastClose > lastSwingHigh

  // ── Breakdown: close below last swing low ─────────────────────
  result.breakdown = lastClose < lastSwingLow

  // ── Support Rejection: near swing low + large lower wick ──────
  const nearLow    = Math.abs(lastLow - lastSwingLow) / (lastSwingLow || 1) < 0.015
  result.supportReject = nearLow && body > 0 && lowerWick >= body * 1.5

  // ── Resistance Rejection: near swing high + large upper wick ──
  const nearHigh   = Math.abs(lastHigh - lastSwingHigh) / (lastSwingHigh || 1) < 0.015
  result.resistReject = nearHigh && body > 0 && upperWick >= body * 1.5

  return result
}

function avgVolume(candles: Candle[], period: number): number {
  const slice = candles.slice(-period - 1, -1) // exclude last candle (current)
  if (!slice.length) return 0
  return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length
}

// ─── Single timeframe analysis ────────────────────────────────────────────

async function analyzeTimeframe(
  symbol: string,
  timeframe: typeof TIMEFRAMES[number],
): Promise<TechnicalResult | null> {
  const candles = await getCandles(symbol, timeframe, 120)
  if (candles.length < 60) return null

  const closes   = candles.map(c => c.close)
  const lastClose = closes[closes.length - 1]
  const prevClose = closes[closes.length - 2] // candles are 1h or 4h
  const priceChange = ((lastClose - prevClose) / prevClose) * 100

  const rsi    = calcRSI(closes)
  const { macd, signal: macdSig, histogram } = calcMACD(
    closes,
    TECHNICAL_THRESHOLDS.macdFast,
    TECHNICAL_THRESHOLDS.macdSlow,
    TECHNICAL_THRESHOLDS.macdSignal,
  )

  const [p9, p21, p50] = TECHNICAL_THRESHOLDS.emaStack
  const ema9  = calcEMA(closes, p9)[closes.length - 1]
  const ema21 = calcEMA(closes, p21)[closes.length - 1]
  const ema50 = calcEMA(closes, p50)[closes.length - 1]

  const { support, resistance } = calcSupportResistance(candles)
  const priceRange   = resistance - support
  const proximity    = priceRange * 0.03  // within 3% of S/R level

  const currentVol   = candles[candles.length - 1].volume
  const avgVol       = avgVolume(candles, TECHNICAL_THRESHOLDS.volumeAvgPeriod)
  const volumeRatio  = avgVol > 0 ? currentVol / avgVol : 1

  const marketStructure = detectMarketStructure(candles)

  return {
    timeframe,
    rsi,
    macd,
    macdSignal:     macdSig,
    macdHist:       histogram,
    ema9,
    ema21,
    ema50,
    currentPrice:   lastClose,
    priceChange,
    volumeRatio,
    nearSupport:    support > 0 && Math.abs(lastClose - support) / lastClose < 0.03,
    nearResistance: resistance > 0 && Math.abs(lastClose - resistance) / lastClose < 0.03,
    supportLevel:   support,
    resistanceLevel:resistance,
    marketStructure,
  }
}

// ─── Score engine ─────────────────────────────────────────────────────────

/**
 * Analyze all timeframes and produce a combined 0–40 technical score.
 * Signals must align on BOTH timeframes for maximum score.
 * A signal on only one timeframe yields partial credit.
 */
export async function runTechnicalEngine(symbol: string): Promise<TechnicalScore> {
  const [tf4h, tf1h] = await Promise.all([
    analyzeTimeframe(symbol, '4h'),
    analyzeTimeframe(symbol, '1h'),
  ])

  if (!tf4h || !tf1h) {
    return { score: 0, details: [], reasons: ['Insufficient data'], direction: 'NEUTRAL' }
  }

  const reasons: string[]   = []
  let bullPoints = 0
  let bearPoints = 0

  // ── RSI scoring (max 10 points per direction) ───────────────
  const { oversold, overbought } = TECHNICAL_THRESHOLDS.rsi

  // Both timeframes agree: max credit
  if (tf4h.rsi < oversold && tf1h.rsi < oversold) {
    bullPoints += 10
    reasons.push(`RSI oversold on both timeframes (4H:${tf4h.rsi.toFixed(0)}, 1H:${tf1h.rsi.toFixed(0)})`)
  } else if (tf4h.rsi < oversold) {
    bullPoints += 6
    reasons.push(`RSI oversold on 4H (${tf4h.rsi.toFixed(0)})`)
  } else if (tf1h.rsi < oversold) {
    bullPoints += 3
  }

  if (tf4h.rsi > overbought && tf1h.rsi > overbought) {
    bearPoints += 10
    reasons.push(`RSI overbought on both timeframes (4H:${tf4h.rsi.toFixed(0)}, 1H:${tf1h.rsi.toFixed(0)})`)
  } else if (tf4h.rsi > overbought) {
    bearPoints += 6
    reasons.push(`RSI overbought on 4H (${tf4h.rsi.toFixed(0)})`)
  }

  // ── MACD crossover scoring (max 10 points) ───────────────────
  const macdBull4h = tf4h.macd > tf4h.macdSignal && tf4h.macdHist > 0
  const macdBull1h = tf1h.macd > tf1h.macdSignal && tf1h.macdHist > 0
  const macdBear4h = tf4h.macd < tf4h.macdSignal && tf4h.macdHist < 0
  const macdBear1h = tf1h.macd < tf1h.macdSignal && tf1h.macdHist < 0

  if (macdBull4h && macdBull1h) {
    bullPoints += 10
    reasons.push('MACD bullish on both timeframes')
  } else if (macdBull4h) {
    bullPoints += 6
    reasons.push('MACD bullish on 4H')
  }

  if (macdBear4h && macdBear1h) {
    bearPoints += 10
    reasons.push('MACD bearish on both timeframes')
  } else if (macdBear4h) {
    bearPoints += 6
  }

  // ── EMA Stack scoring (max 10 points) ────────────────────────
  const emaStackBull4h = tf4h.ema9 > tf4h.ema21 && tf4h.ema21 > tf4h.ema50
  const emaStackBear4h = tf4h.ema9 < tf4h.ema21 && tf4h.ema21 < tf4h.ema50
  const currentAboveAll4h = tf4h.currentPrice > tf4h.ema50
  const currentBelowAll4h = tf4h.currentPrice < tf4h.ema50

  if (emaStackBull4h && currentAboveAll4h) {
    bullPoints += 10
    reasons.push('EMA stack bullish alignment (9>21>50)')
  } else if (emaStackBull4h) {
    bullPoints += 5
  }

  if (emaStackBear4h && currentBelowAll4h) {
    bearPoints += 10
    reasons.push('EMA stack bearish alignment (9<21<50)')
  } else if (emaStackBear4h) {
    bearPoints += 5
  }

  // ─── Support/Resistance scoring (max 5 points) ────────────────
  if (tf4h.nearSupport) {
    bullPoints += 5
    reasons.push(`Price near key support ($${tf4h.supportLevel.toFixed(2)})`)
  }
  if (tf4h.nearResistance) {
    bearPoints += 5
    reasons.push(`Price near key resistance ($${tf4h.resistanceLevel.toFixed(2)})`)
  }

  // ─── Volume spike scoring (max 5 points) ─────────────────────
  // Volume spike is directional (Bullish if Price UP, Bearish if Price DOWN)
  const { volumeSpike } = TECHNICAL_THRESHOLDS
  const isUp = tf1h.priceChange > 0

  if (tf1h.volumeRatio > volumeSpike) {
    const pts = tf1h.volumeRatio > volumeSpike * 1.5 ? 5 : 3
    if (isUp) {
      bullPoints += pts
      reasons.push(`Bullish volume spike ${tf1h.volumeRatio.toFixed(1)}× avg`)
    } else {
      bearPoints += pts
      reasons.push(`Bearish volume spike ${tf1h.volumeRatio.toFixed(1)}× avg`)
    }
  }

  // ─── Market Structure scoring (max ±8 points) ─────────────────
  // Uses 4H candle data — already fetched above. No extra API calls.
  const ms = tf4h.marketStructure
  const bullish_ms = ms.bos === 'BULLISH' || ms.higherLow || ms.breakout || ms.supportReject
  const bearish_ms = ms.bos === 'BEARISH' || ms.lowerHigh || ms.breakdown || ms.resistReject

  if (bullish_ms && !bearish_ms) {
    bullPoints += 8
    const signals = [
      ms.bos === 'BULLISH' ? 'BOS Bullish' : '',
      ms.higherLow         ? 'Higher Low'  : '',
      ms.breakout          ? 'Breakout'    : '',
      ms.supportReject     ? 'Support Rejection' : '',
    ].filter(Boolean).join(', ')
    reasons.push(`Market Structure Bullish: ${signals}`)
  } else if (bearish_ms && !bullish_ms) {
    bearPoints += 8
    const signals = [
      ms.bos === 'BEARISH' ? 'BOS Bearish' : '',
      ms.lowerHigh         ? 'Lower High'  : '',
      ms.breakdown         ? 'Breakdown'   : '',
      ms.resistReject      ? 'Resistance Rejection' : '',
    ].filter(Boolean).join(', ')
    reasons.push(`Market Structure Bearish: ${signals}`)
  } else if (bullish_ms && bearish_ms) {
    // Mixed signals — no bonus, but note it internally
    logger.debug({ context: 'TECH_ANA', symbol }, '⚖️ Market Structure mixed signals — no bonus applied')
  }
  // Penalty: if momentum direction is set but market structure counters it
  // We apply this AFTER direction is resolved in next block, so we track for later.
  const msContradictsLong  = bullPoints > bearPoints && bearish_ms && !bullish_ms
  const msContradictsShort = bearPoints > bullPoints && bullish_ms && !bearish_ms
  if (msContradictsLong) {
    bullPoints = Math.max(0, bullPoints - 5)
    reasons.push('⚠️ Market Structure contradicts LONG momentum (−5 pts)')
  } else if (msContradictsShort) {
    bearPoints = Math.max(0, bearPoints - 5)
    reasons.push('⚠️ Market Structure contradicts SHORT momentum (−5 pts)')
  }

  logger.debug({ context: 'TECH_ANA', symbol, bullPoints, bearPoints }, '🔍 Technical points breakdown')

  // ── Resolve direction and normalize score ────────────────────
  const maxRaw = 40
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL'
  let rawScore = 0

  // FIX: Break stalemates — allow a small lead (leadRequired) to resolve direction
  const { minPoints, leadRequired } = TECHNICAL_THRESHOLDS
  
  if (bullPoints > bearPoints + leadRequired && bullPoints > minPoints) {
    direction = 'LONG'
    rawScore  = bullPoints
  } else if (bearPoints > bullPoints + leadRequired && bearPoints > minPoints) {
    direction = 'SHORT'
    rawScore  = bearPoints
  }

  // Normalize to max 40 (the weight ceiling from config)
  const score = Math.min(Math.round((rawScore / maxRaw) * 40), 40)

  return { score, details: [tf4h, tf1h], reasons, direction }
}
