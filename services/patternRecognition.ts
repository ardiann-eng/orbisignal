// services/patternRecognition.ts
// NEW: Pattern Recognition Engine (heuristic-based) for OHLCV candle series.
// Output: a list of detected patterns (>= 24 supported patterns).

export type PatternBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface PatternResult {
  pattern: string
  confidence: number // 0-100
  bias: PatternBias
}

// CCXT OHLCV format: [timestamp, open, high, low, close, volume]
export type OHLCV = number[]

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function linearRegressionSlope(data: number[]): number {
  const n = data.length
  if (n < 2) return 0

  const xMean = (n - 1) / 2
  const yMean = data.reduce((a, b) => a + b, 0) / n

  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (data[i] - yMean)
    den += (i - xMean) ** 2
  }
  return den === 0 ? 0 : num / den
}

function checkFibRatio(value: number, target: number, tolerance = 0.03): boolean {
  return Math.abs(value - target) <= tolerance
}

function getCandle(candles: OHLCV[], idxFromEnd: number) {
  const idx = candles.length + idxFromEnd
  if (idx < 0 || idx >= candles.length) return null
  return candles[idx]
}

function candleBody(c: OHLCV) {
  const open = c[1]
  const close = c[4]
  return Math.abs(close - open)
}

function candleRange(c: OHLCV) {
  return c[2] - c[3]
}

function candleShadows(c: OHLCV) {
  const open = c[1]
  const close = c[4]
  const high = c[2]
  const low = c[3]
  const top = Math.max(open, close)
  const bottom = Math.min(open, close)
  return {
    upperShadow: high - top,
    lowerShadow: bottom - low,
  }
}

function candleIsBullish(c: OHLCV) {
  return c[4] > c[1]
}

function candleIsBearish(c: OHLCV) {
  return c[4] < c[1]
}

function priceSlope(closes: number[], window = 5) {
  const slice = closes.slice(-window)
  if (slice.length < 2) return 0
  return linearRegressionSlope(slice)
}

// ─────────────────────────────────────────────────────────────────────────────
// A) TRIANGLE PATTERNS
// ─────────────────────────────────────────────────────────────────────────────

function detectTriangles(candles: OHLCV[]): PatternResult[] {
  const results: PatternResult[] = []
  const highs = candles.map(c => c[2])
  const lows = candles.map(c => c[3])

  const slice = 20
  if (candles.length < slice + 5) return results

  const recentHighs = highs.slice(-slice)
  const recentLows = lows.slice(-slice)

  const highSlope = linearRegressionSlope(recentHighs)
  const lowSlope = linearRegressionSlope(recentLows)

  // Thresholds are heuristic. Use relative slopes by price baseline for stability.
  const baseline = (recentHighs[0] + recentLows[0]) / 2 || 1
  const highSlopeN = highSlope / baseline
  const lowSlopeN = lowSlope / baseline

  // SYMMETRICAL TRIANGLE: high turun, low naik (converging)
  if (highSlopeN < -0.001 && lowSlopeN > 0.001) {
    results.push({ pattern: 'Symmetrical Triangle', confidence: 70, bias: 'NEUTRAL' })
  }

  // ASCENDING TRIANGLE: high flat, low naik
  if (Math.abs(highSlopeN) < 0.0005 && lowSlopeN > 0.001) {
    results.push({ pattern: 'Ascending Triangle', confidence: 75, bias: 'BULLISH' })
  }

  // DESCENDING TRIANGLE: high turun, low flat
  if (highSlopeN < -0.001 && Math.abs(lowSlopeN) < 0.0005) {
    results.push({ pattern: 'Descending Triangle', confidence: 75, bias: 'BEARISH' })
  }

  // BROADENING TRIANGLE: high naik, low turun (diverging)
  if (highSlopeN > 0.001 && lowSlopeN < -0.001) {
    results.push({ pattern: 'Broadening Triangle', confidence: 65, bias: 'NEUTRAL' })
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// B) CHANNELS & WEDGES
// ─────────────────────────────────────────────────────────────────────────────

function detectChannelsAndWedges(candles: OHLCV[]): PatternResult[] {
  const results: PatternResult[] = []
  if (candles.length < 30) return results

  const highs = candles.map(c => c[2])
  const lows = candles.map(c => c[3])
  const closes = candles.map(c => c[4])

  const highSlope = linearRegressionSlope(highs.slice(-20))
  const lowSlope = linearRegressionSlope(lows.slice(-20))
  const closeSlope = linearRegressionSlope(closes.slice(-20))

  const baseline = (highs[highs.length - 20] + lows[lows.length - 20]) / 2 || 1
  const highSlopeN = highSlope / baseline
  const lowSlopeN = lowSlope / baseline
  const closeSlopeN = closeSlope / baseline

  // TREND CHANNEL UP: high naik, low naik, paralel
  if (highSlopeN > 0.001 && lowSlopeN > 0.001 && Math.abs(highSlopeN - lowSlopeN) < 0.0005) {
    results.push({ pattern: 'Ascending Channel', confidence: 72, bias: 'BULLISH' })
  }

  // TREND CHANNEL DOWN
  if (highSlopeN < -0.001 && lowSlopeN < -0.001 && Math.abs(highSlopeN - lowSlopeN) < 0.0005) {
    results.push({ pattern: 'Descending Channel', confidence: 72, bias: 'BEARISH' })
  }

  // RANGING CHANNEL: high flat, low flat
  if (Math.abs(highSlopeN) < 0.0003 && Math.abs(lowSlopeN) < 0.0003) {
    results.push({ pattern: 'Ranging Channel', confidence: 68, bias: 'NEUTRAL' })
  }

  // RISING WEDGE: narrowing up (usually bearish reversal)
  if (highSlopeN > 0 && lowSlopeN > 0 && lowSlopeN > highSlopeN * 1.2) {
    results.push({ pattern: 'Rising Wedge', confidence: 78, bias: 'BEARISH' })
  }

  // FALLING WEDGE: narrowing down (usually bullish reversal)
  if (highSlopeN < 0 && lowSlopeN < 0 && highSlopeN < lowSlopeN * 1.2) {
    results.push({ pattern: 'Falling Wedge', confidence: 78, bias: 'BULLISH' })
  }

  // Pennants: tightening versions derived from slopes + breakout direction.
  const breakoutBias: PatternBias =
    closeSlopeN > 0.0006 ? 'BULLISH' : closeSlopeN < -0.0006 ? 'BEARISH' : 'NEUTRAL'

  if (highSlopeN > 0.0008 && lowSlopeN > 0.0008 && Math.abs(highSlopeN - lowSlopeN) < 0.00035) {
    results.push({ pattern: 'Bull Pennant', confidence: 70, bias: breakoutBias === 'BULLISH' ? 'BULLISH' : 'NEUTRAL' })
  }

  if (highSlopeN < -0.0008 && lowSlopeN < -0.0008 && Math.abs(highSlopeN - lowSlopeN) < 0.00035) {
    results.push({ pattern: 'Bear Pennant', confidence: 70, bias: breakoutBias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL' })
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// C) HARMONIC PATTERNS (Fibonacci-based)
// ─────────────────────────────────────────────────────────────────────────────

type Swing = { index: number; price: number }

function findSwingPoints(candles: OHLCV[], lookback = 5): { swingHighs: Swing[]; swingLows: Swing[] } {
  const swingHighs: Swing[] = []
  const swingLows: Swing[] = []

  for (let i = lookback; i < candles.length - lookback; i++) {
    const high = candles[i][2]
    const low = candles[i][3]

    const window = candles.slice(i - lookback, i + lookback + 1)
    const isSwingHigh = window.every((c, idx) => idx === lookback || c[2] <= high)
    const isSwingLow = window.every((c, idx) => idx === lookback || c[3] >= low)

    if (isSwingHigh) swingHighs.push({ index: i, price: high })
    if (isSwingLow) swingLows.push({ index: i, price: low })
  }

  return { swingHighs, swingLows }
}

function detectHarmonics(candles: OHLCV[]): PatternResult[] {
  const results: PatternResult[] = []
  const { swingHighs, swingLows } = findSwingPoints(candles)
  if (swingHighs.length + swingLows.length < 6) return results

  const allSwings = [...swingHighs, ...swingLows].sort((a, b) => a.index - b.index)
  const last = allSwings.slice(-6)
  if (last.length < 5) return results

  const [X, A, B, C, D] = last.slice(-5)

  const XA = Math.abs(A.price - X.price)
  const AB = Math.abs(B.price - A.price)
  const BC = Math.abs(C.price - B.price)
  const CD = Math.abs(D.price - C.price)
  const XD = Math.abs(D.price - X.price)

  if (XA === 0 || AB === 0 || BC === 0) return results

  const AB_XA = AB / XA
  const BC_AB = BC / AB
  const CD_BC = CD / BC
  const AD_XA = XD / XA

  // Simplified bias from D price vs X.
  const biasFromD: PatternBias = D.price < X.price ? 'BULLISH' : 'BEARISH'

  // GARTLEY: AB=0.618 XA, BC=0.382-0.886 AB, CD=1.272-1.618 BC, AD=0.786 XA
  if (
    checkFibRatio(AB_XA, 0.618) &&
    BC_AB >= 0.382 &&
    BC_AB <= 0.886 &&
    CD_BC >= 1.272 &&
    CD_BC <= 1.618 &&
    checkFibRatio(AD_XA, 0.786)
  ) {
    results.push({ pattern: 'Gartley', confidence: 82, bias: biasFromD })
  }

  // BAT
  if (
    AB_XA >= 0.382 &&
    AB_XA <= 0.500 &&
    BC_AB >= 0.382 &&
    BC_AB <= 0.886 &&
    CD_BC >= 1.618 &&
    CD_BC <= 2.618 &&
    checkFibRatio(AD_XA, 0.886)
  ) {
    results.push({ pattern: 'Bat', confidence: 83, bias: biasFromD })
  }

  // BUTTERFLY
  if (
    checkFibRatio(AB_XA, 0.786) &&
    BC_AB >= 0.382 &&
    BC_AB <= 0.886 &&
    CD_BC >= 1.618 &&
    CD_BC <= 2.618 &&
    AD_XA >= 1.270 &&
    AD_XA <= 1.618
  ) {
    results.push({ pattern: 'Butterfly', confidence: 80, bias: biasFromD })
  }

  // CRAB
  if (
    AB_XA >= 0.382 &&
    AB_XA <= 0.618 &&
    BC_AB >= 0.382 &&
    BC_AB <= 0.886 &&
    CD_BC >= 2.618 &&
    CD_BC <= 3.618 &&
    checkFibRatio(AD_XA, 1.618)
  ) {
    results.push({ pattern: 'Crab', confidence: 85, bias: biasFromD })
  }

  // CYPHER: AB=0.382-0.618 XA, BC=1.272-1.414 AB, CD=0.786 XC
  const XC = Math.abs(C.price - X.price)
  if (XC !== 0) {
    const CD_XC = CD / XC
    if (
      AB_XA >= 0.382 &&
      AB_XA <= 0.618 &&
      BC_AB >= 1.272 &&
      BC_AB <= 1.414 &&
      checkFibRatio(CD_XC, 0.786)
    ) {
      results.push({ pattern: 'Cypher', confidence: 79, bias: biasFromD })
    }
  }

  // SHARK
  const XC2 = Math.abs(C.price - X.price)
  if (XC2 !== 0) {
    const CD_XC = CD / XC2
    if (
      AB_XA >= 1.130 &&
      AB_XA <= 1.618 &&
      BC_AB >= 1.618 &&
      BC_AB <= 2.240 &&
      checkFibRatio(CD_XC, 0.886, 0.05)
    ) {
      results.push({ pattern: 'Shark', confidence: 77, bias: biasFromD })
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// D) CANDLESTICK PATTERNS (extra patterns to reach 24+)
// ─────────────────────────────────────────────────────────────────────────────

function detectCandlestickPatterns(candles: OHLCV[]): PatternResult[] {
  const results: PatternResult[] = []
  if (candles.length < 6) return results

  const c = getCandle(candles, -1)
  const p1 = getCandle(candles, -2)
  const p2 = getCandle(candles, -3)
  const p3 = getCandle(candles, -4)
  if (!c || !p1 || !p2 || !p3) return results

  const closes = candles.map(x => x[4])
  const slope5 = priceSlope(closes, 5) // heuristic trend
  const downtrend = slope5 < -0.0002
  const uptrend = slope5 > 0.0002

  const body = candleBody(c)
  const range = candleRange(c)
  const { upperShadow, lowerShadow } = candleShadows(c)

  const prevBody = candleBody(p1)
  const prevRange = candleRange(p1)
  const bullish = candleIsBullish(c)
  const bearish = candleIsBearish(c)

  const prevBullish = candleIsBullish(p1)
  const prevBearish = candleIsBearish(p1)

  const tinyBody = range > 0 ? body / range : 1
  const prevTinyBody = prevRange > 0 ? prevBody / prevRange : 1

  // 1) Bullish/Bearish Engulfing (2 patterns)
  if (prevBearish && bullish) {
    const prevMin = Math.min(p1[1], p1[4])
    const prevMax = Math.max(p1[1], p1[4])
    const currMin = Math.min(c[1], c[4])
    const currMax = Math.max(c[1], c[4])
    if (currMin <= prevMin && currMax >= prevMax) {
      results.push({ pattern: 'Bullish Engulfing', confidence: 84, bias: 'BULLISH' })
    }
  }
  if (prevBullish && bearish) {
    const prevMin = Math.min(p1[1], p1[4])
    const prevMax = Math.max(p1[1], p1[4])
    const currMin = Math.min(c[1], c[4])
    const currMax = Math.max(c[1], c[4])
    if (currMin <= prevMin && currMax >= prevMax) {
      results.push({ pattern: 'Bearish Engulfing', confidence: 84, bias: 'BEARISH' })
    }
  }

  // 2) Hammer / Hanging Man (2 patterns)
  if (downtrend && bullish && range > 0) {
    if (lowerShadow >= body * 2 && upperShadow <= body * 0.25) {
      results.push({ pattern: 'Hammer', confidence: 80, bias: 'BULLISH' })
    }
  }
  if (uptrend && bearish && range > 0) {
    if (lowerShadow >= body * 2 && upperShadow <= body * 0.25) {
      results.push({ pattern: 'Hanging Man', confidence: 78, bias: 'BEARISH' })
    }
  }

  // 3) Inverted Hammer / Shooting Star (2 patterns)
  if (downtrend && bullish && range > 0) {
    if (upperShadow >= body * 2 && lowerShadow <= body * 0.25) {
      results.push({ pattern: 'Inverted Hammer', confidence: 78, bias: 'BULLISH' })
    }
  }
  if (uptrend && bearish && range > 0) {
    if (upperShadow >= body * 2 && lowerShadow <= body * 0.25) {
      results.push({ pattern: 'Shooting Star', confidence: 80, bias: 'BEARISH' })
    }
  }

  // 4) Harami (2 patterns)
  if (prevBullish && bearish) {
    const prevLow = Math.min(p1[1], p1[4])
    const prevHigh = Math.max(p1[1], p1[4])
    const currLow = Math.min(c[1], c[4])
    const currHigh = Math.max(c[1], c[4])
    if (currLow >= prevLow && currHigh <= prevHigh && prevTinyBody > 0.2 && tinyBody < 0.25) {
      results.push({ pattern: 'Bearish Harami', confidence: 72, bias: 'BEARISH' })
    }
  }
  if (prevBearish && bullish) {
    const prevLow = Math.min(p1[1], p1[4])
    const prevHigh = Math.max(p1[1], p1[4])
    const currLow = Math.min(c[1], c[4])
    const currHigh = Math.max(c[1], c[4])
    if (currLow >= prevLow && currHigh <= prevHigh && prevTinyBody > 0.2 && tinyBody < 0.25) {
      results.push({ pattern: 'Bullish Harami', confidence: 72, bias: 'BULLISH' })
    }
  }

  // 5) Piercing Line / Dark Cloud Cover (2 patterns)
  const prevOpen = p1[1]
  const prevClose = p1[4]
  const midpoint = (prevOpen + prevClose) / 2
  if (prevBearish && bullish) {
    if (c[1] <= p1[3] * 1.0005 && c[4] > midpoint && c[4] < prevOpen) {
      results.push({ pattern: 'Piercing Line', confidence: 78, bias: 'BULLISH' })
    }
  }
  if (prevBullish && bearish) {
    if (c[1] >= p1[2] * 0.9995 && c[4] < midpoint && c[4] > prevOpen) {
      results.push({ pattern: 'Dark Cloud Cover', confidence: 78, bias: 'BEARISH' })
    }
  }

  // 6) Morning Star / Evening Star (2 patterns)
  const morningStar = (() => {
    const firstBear = candleIsBearish(p3) && candleRange(p3) > 0 && candleBody(p3) / candleRange(p3) > 0.5
    const secondTiny = candleRange(p2) > 0 ? candleBody(p2) / candleRange(p2) < 0.3 : false
    const thirdBull = candleIsBullish(c)
    if (!firstBear || !secondTiny || !thirdBull) return false
    const midFirst = (p3[1] + p3[4]) / 2
    return c[4] > midFirst
  })()
  if (morningStar) results.push({ pattern: 'Morning Star', confidence: 86, bias: 'BULLISH' })

  const eveningStar = (() => {
    const firstBull = candleIsBullish(p3) && candleRange(p3) > 0 && candleBody(p3) / candleRange(p3) > 0.5
    const secondTiny = candleRange(p2) > 0 ? candleBody(p2) / candleRange(p2) < 0.3 : false
    const thirdBear = candleIsBearish(c)
    if (!firstBull || !secondTiny || !thirdBear) return false
    const midFirst = (p3[1] + p3[4]) / 2
    return c[4] < midFirst
  })()
  if (eveningStar) results.push({ pattern: 'Evening Star', confidence: 86, bias: 'BEARISH' })

  // 7) Three White Soldiers / Three Black Crows (2 patterns)
  const p4 = getCandle(candles, -5)
  const p5 = getCandle(candles, -6)
  if (p4 && p5) {
    const bullish4 = [p5, p4, p1, c].every(x => candleIsBullish(x))
    const bearish4 = [p5, p4, p1, c].every(x => candleIsBearish(x))
    if (bullish4) {
      const closes4 = [p5, p4, p1, c].map(x => x[4])
      const progressive = closes4[0] < closes4[1] && closes4[1] < closes4[2] && closes4[2] < closes4[3]
      const bodiesReasonable = [p5, p4, p1, c].every(x => {
        const r = candleRange(x)
        if (r <= 0) return false
        return candleBody(x) / r > 0.35
      })
      if (progressive && bodiesReasonable && downtrend) {
        results.push({ pattern: 'Three White Soldiers', confidence: 82, bias: 'BULLISH' })
      }
    }

    if (bearish4) {
      const closes4 = [p5, p4, p1, c].map(x => x[4])
      const progressive = closes4[0] > closes4[1] && closes4[1] > closes4[2] && closes4[2] > closes4[3]
      const bodiesReasonable = [p5, p4, p1, c].every(x => {
        const r = candleRange(x)
        if (r <= 0) return false
        return candleBody(x) / r > 0.35
      })
      if (progressive && bodiesReasonable && uptrend) {
        results.push({ pattern: 'Three Black Crows', confidence: 82, bias: 'BEARISH' })
      }
    }

    // 8) Three Line Strike (2 patterns)
    if (candleIsBullish(c) && candleIsBearish(p5) && candleIsBearish(p4) && candleIsBearish(p1)) {
      const strongBody = (range || 1) > 0 ? body / (range || 1) > 0.6 : false
      if (strongBody && c[4] > p5[1]) {
        results.push({ pattern: 'Bullish Three Line Strike', confidence: 88, bias: 'BULLISH' })
      }
    }
    if (candleIsBearish(c) && candleIsBullish(p5) && candleIsBullish(p4) && candleIsBullish(p1)) {
      const strongBody = (range || 1) > 0 ? body / (range || 1) > 0.6 : false
      if (strongBody && c[4] < p5[1]) {
        results.push({ pattern: 'Bearish Three Line Strike', confidence: 88, bias: 'BEARISH' })
      }
    }
  }

  // 9) Doji (1 pattern)
  if (range > 0 && tinyBody < 0.08 && (upperShadow / range) > 0.25 && (lowerShadow / range) > 0.25) {
    results.push({ pattern: 'Doji', confidence: 60, bias: 'NEUTRAL' })
  }

  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// E) MAIN PATTERN DETECTOR
// ─────────────────────────────────────────────────────────────────────────────

export function detectPatterns(candles: OHLCV[]): PatternResult[] {
  if (!candles || candles.length < 60) return []

  const all: PatternResult[] = [
    ...detectTriangles(candles),
    ...detectChannelsAndWedges(candles),
    ...detectHarmonics(candles),
    ...detectCandlestickPatterns(candles),
  ]

  if (all.length === 0) return []

  // De-duplicate by (pattern + bias) keeping max confidence.
  const bestByKey = new Map<string, PatternResult>()
  for (const r of all) {
    const key = `${r.pattern}::${r.bias}`
    const prev = bestByKey.get(key)
    if (!prev || r.confidence > prev.confidence) bestByKey.set(key, r)
  }

  return [...bestByKey.values()]
    .map(r => ({ ...r, confidence: clamp(r.confidence, 0, 100) }))
    .filter(r => r.confidence >= 60)
    .sort((a, b) => b.confidence - a.confidence)
}

export function pickBestPattern(patterns: PatternResult[]): PatternResult | null {
  if (!patterns || patterns.length === 0) return null
  return patterns.slice().sort((a, b) => b.confidence - a.confidence)[0]
}

