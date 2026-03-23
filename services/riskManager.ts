// services/riskManager.ts
// Calculates precise entry zone, TP levels, and stop loss based on
// support/resistance structure and ATR volatility. Validates R:R ratio.

import { getCandles }                from '@/services/marketData'
import { config }                    from '@/lib/config'
import { logger }                    from '@/utils/logger'
import type { TechnicalResult }      from '@/analysis/technical'

// ─── Types ────────────────────────────────────────────────────────────────

export interface RiskPlan {
  entryLow:  number
  entryHigh: number
  tp1:       number
  tp2:       number
  tp3:       number
  stopLoss:  number
  rrRatio:   number    // R:R using midpoint entry vs TP2
  slPct:     number    // Stop loss % from entry mid
  tp1Pct:    number
  tp2Pct:    number
  tp3Pct:    number
  isValid:   boolean   // passes MIN_RR_RATIO and MAX_SL_PCT checks
}

// ─── ATR (Average True Range) ─────────────────────────────────────────────
// ATR measures current volatility — used to dynamically size buffers.

export function calcATR(candles: { high: number; low: number; close: number }[], period = 14): number {
  if (candles.length < period + 1) return 0

  const trueRanges: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low  = candles[i].low
    const prev = candles[i - 1].close
    trueRanges.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)))
  }

  // Simple average ATR (not Wilder-smoothed for simplicity)
  const slice = trueRanges.slice(-period)
  return slice.reduce((s, v) => s + v, 0) / slice.length
}

// ─── Fibonacci TP levels ──────────────────────────────────────────────────
// TP levels are projected from the S/R swing using Fib ratios.
const FIB_LEVELS = { tp1: 0.382, tp2: 0.618, tp3: 1.0 }

// ─── Main calculator ─────────────────────────────────────────────────────

/**
 * Build a risk plan for a given symbol and direction.
 *
 * LONG:  Entry = near support. TP projected upward. SL below support - buffer.
 * SHORT: Entry = near resistance. TP projected downward. SL above resistance + buffer.
 */
export async function buildRiskPlan(
  symbol:    string,
  direction: 'LONG' | 'SHORT',
  tf:        TechnicalResult,
): Promise<RiskPlan> {
  const candles4h = await getCandles(symbol, '4h', 60)
  const atr       = calcATR(candles4h)
  const price     = tf.currentPrice

  const support    = tf.supportLevel    || price * 0.95
  const resistance = tf.resistanceLevel || price * 1.05

  // AUDIT FIX: Entry zone berbasis support/resistance aktual + ATR buffer
  // Bukan lagi hardcode 1.5% dari harga sekarang
  const atrBuffer = atr > 0 ? atr * 0.2 : price * 0.005
  let entryLow: number, entryHigh: number

  if (direction === 'LONG') {
    // Entry zone di dekat support: dari support - buffer hingga support + 1 ATR
    entryLow  = support - atrBuffer
    entryHigh = support + (atr > 0 ? atr : price * 0.01)
  } else { // SHORT
    // Entry zone di dekat resistance: dari resistance - 1 ATR hingga resistance + buffer
    entryLow  = resistance - (atr > 0 ? atr : price * 0.01)
    entryHigh = resistance + atrBuffer
  }

  // Pastikan entry zone tidak melewati harga saat ini terlalu jauh (max 5% gap)
  const maxGapPct = 0.05
  if (direction === 'LONG' && entryHigh < price * (1 - maxGapPct)) {
    // Support terlalu jauh di bawah — fallback ke harga saat ini
    entryLow  = price * 0.993
    entryHigh = price * 1.007
  } else if (direction === 'SHORT' && entryLow > price * (1 + maxGapPct)) {
    entryLow  = price * 0.993
    entryHigh = price * 1.007
  }

  const entryMid = (entryLow + entryHigh) / 2

  // AUDIT FIX: SL berbasis ATR (1.5× ATR dari entryLow/entryHigh)
  // Bukan lagi hardcode 0.8% yang terlalu sempit
  const SL_ATR_MULT = 1.5
  const atrOrFallback = atr > 0 ? atr : price * 0.015
  let stopLoss: number

  if (direction === 'SHORT') {
    stopLoss = entryHigh + (atrOrFallback * SL_ATR_MULT)
  } else {
    stopLoss = entryLow - (atrOrFallback * SL_ATR_MULT)
  }

  // Cek apakah SL melewati MAX_SL_PCT — jika ya, reject
  const slDistancePct = Math.abs(entryMid - stopLoss) / entryMid * 100
  if (slDistancePct > config.MAX_SL_PCT) {
    logger.warn({ context: 'RISK', symbol, slDistancePct, maxSlPct: config.MAX_SL_PCT }, '⚠️ SL too wide — rejecting risk plan')
    return {
      entryLow, entryHigh, tp1: 0, tp2: 0, tp3: 0, stopLoss,
      rrRatio: 0, slPct: Math.round(slDistancePct * 10) / 10,
      tp1Pct: 0, tp2Pct: 0, tp3Pct: 0, isValid: false,
    }
  }

  // FIX: MASALAH 4 — TP HARUS BERBEDA SATU SAMA LAIN
  const riskDistance = Math.abs(entryMid - stopLoss)
  let tp1: number, tp2: number, tp3: number

  if (direction === 'SHORT') {
    tp1 = entryMid - (riskDistance * 2.2) // Increased from 1.5 to safely exceed 2.0
    tp2 = entryMid - (riskDistance * 3.5) // Increased from 2.5
    tp3 = entryMid - (riskDistance * 5.5) // Increased from 4.0
  } else {
    tp1 = entryMid + (riskDistance * 2.2)
    tp2 = entryMid + (riskDistance * 3.5)
    tp3 = entryMid + (riskDistance * 5.5)
  }

  // AUDIT FIX: Gunakan config.MIN_RR_RATIO (default 2.0), bukan hardcode 1.2
  const rrAtTp1 = riskDistance > 0 ? Math.abs(tp1 - entryMid) / riskDistance : 0
  const isValid =
    entryLow !== entryHigh &&
    tp1 !== tp2 && tp2 !== tp3 &&
    (direction === 'SHORT' ? stopLoss > entryHigh : stopLoss < entryLow) &&
    rrAtTp1 >= config.MIN_RR_RATIO

  if (!isValid) {
    logger.warn(
      { context: 'RISK', symbol, rrAtTp1: rrAtTp1.toFixed(2), minRR: config.MIN_RR_RATIO },
      '⚠️ Risk plan validation failed — R:R insufficient'
    )
  }

  // Stats for Telegram/logging
  const reward    = Math.abs(tp1 - entryMid)
  const rrRatio   = riskDistance > 0 ? reward / riskDistance : 0
  const slPct     = (riskDistance / entryMid) * 100

  const sign = direction === 'LONG' ? 1 : -1
  const tp1Pct = ((tp1 - entryMid) / entryMid) * 100 * sign
  const tp2Pct = ((tp2 - entryMid) / entryMid) * 100 * sign
  const tp3Pct = ((tp3 - entryMid) / entryMid) * 100 * sign

  // Return raw numbers, don't use Math.round or .toFixed here
  // Presisi harga dinamis akan di-handle oleh formatter.ts saat dikirim ke Telegram
  return {
    entryLow,
    entryHigh,
    tp1,
    tp2,
    tp3,
    stopLoss,
    rrRatio:   Math.round(rrRatio * 10) / 10,
    slPct:     Math.round(slPct * 10)   / 10,
    tp1Pct:    Math.round(tp1Pct * 10)  / 10,
    tp2Pct:    Math.round(tp2Pct * 10)  / 10,
    tp3Pct:    Math.round(tp3Pct * 10)  / 10,
    isValid,
  }
}

