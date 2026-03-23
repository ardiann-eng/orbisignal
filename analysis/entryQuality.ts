// analysis/entryQuality.ts
// Assesses if price is too far from EMA benchmarks using ATR as a dynamic ruler.
// Logic: If distance from price to EMA9 > 0.8 * ATR, it's overstretched (Late).

import { logger } from '@/utils/logger'

export type EntryStatus = 'HEALTHY' | 'LATE' | 'OVERSTRETCHED'

export interface EntryQualityResult {
  status: EntryStatus
  ratio: number // distance / ATR
  score: number // bonus or penalty
  reason: string
}

/**
 * Calculate Entry Quality based on distance to EMA.
 * Thresholds:
 * - < 0.3 ATR: HEALTHY (+5 pts)
 * - 0.3 - 0.8 ATR: LATE (0 pts)
 * - > 0.8 ATR: OVERSTRETCHED (-15 pts)
 */
export function calculateEntryQuality(
  price: number,
  ema9: number,
  atr: number,
  symbol: string
): EntryQualityResult {
  if (atr <= 0) {
    return { status: 'HEALTHY', ratio: 0, score: 0, reason: 'ATR unavailable' }
  }

  const distance = Math.abs(price - ema9)
  const ratio = distance / atr

  let status: EntryStatus = 'HEALTHY'
  let score = 0
  let reason = ''

  if (ratio < 0.35) {
    status = 'HEALTHY'
    score = 5
    reason = `Entry near EMA9 (${ratio.toFixed(2)}x ATR)`
  } else if (ratio < 0.8) {
    status = 'LATE'
    score = 0
    reason = `Entry slightly extended (${ratio.toFixed(2)}x ATR)`
  } else {
    status = 'OVERSTRETCHED'
    score = -15
    reason = `Entry overstretched from EMA9 (${ratio.toFixed(2)}x ATR)`
  }

  logger.info(
    { context: 'ENTRY_QUALITY', symbol, ratio: ratio.toFixed(2), status },
    `[entry-quality] decision: ${status}`
  )

  return { status, ratio, score, reason }
}
