// analysis/technical.ts
// Pure mathematical implementations. No external TA library dependency.
// Each function is independently testable.

import { getCandles, type Candle } from '@/services/marketData'
import { TECHNICAL_THRESHOLDS, TIMEFRAMES } from '@/lib/config'

// ─── Types ────────────────────────────────────────────────────────────────

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
  volumeRatio:  number         // current volume / 20-period avg
  nearSupport:  boolean
  nearResistance: boolean
  supportLevel: number
  resistanceLevel: number
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
    volumeRatio,
    nearSupport:    support > 0 && Math.abs(lastClose - support) / lastClose < 0.03,
    nearResistance: resistance > 0 && Math.abs(lastClose - resistance) / lastClose < 0.03,
    supportLevel:   support,
    resistanceLevel:resistance,
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

  // ── Volume spike scoring (max 5 points) ─────────────────────
  const { volumeSpike } = TECHNICAL_THRESHOLDS
  if (tf1h.volumeRatio > volumeSpike * 1.5) {
    const pts = 5
    bullPoints += pts; bearPoints += pts // volume amplifies either direction
    reasons.push(`Volume spike ${tf1h.volumeRatio.toFixed(1)}× average`)
  } else if (tf1h.volumeRatio > volumeSpike) {
    bullPoints += 3; bearPoints += 3
    reasons.push(`Elevated volume ${tf1h.volumeRatio.toFixed(1)}× average`)
  }

  // ── Support/Resistance scoring (max 5 points) ────────────────
  if (tf4h.nearSupport) {
    bullPoints += 5
    reasons.push(`Price near key support ($${tf4h.supportLevel.toFixed(2)})`)
  }
  if (tf4h.nearResistance) {
    bearPoints += 5
    reasons.push(`Price near key resistance ($${tf4h.resistanceLevel.toFixed(2)})`)
  }

  // ── Resolve direction and normalize score ────────────────────
  const maxRaw = 40
  let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL'
  let rawScore = 0

  if (bullPoints > bearPoints && bullPoints > 8) {
    direction = 'LONG'
    rawScore  = bullPoints
  } else if (bearPoints > bullPoints && bearPoints > 8) {
    direction = 'SHORT'
    rawScore  = bearPoints
  }

  // Normalize to max 40 (the weight ceiling from config)
  const score = Math.min(Math.round((rawScore / maxRaw) * 40), 40)

  return { score, details: [tf4h, tf1h], reasons, direction }
}
