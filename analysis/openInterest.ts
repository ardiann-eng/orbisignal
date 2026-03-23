// analysis/openInterest.ts
// Open Interest engine (Replaces Sentiment analysis).
// Logic: Correlations between Price change and OI change.
// Weight in final score: 20 points max.

import { cache } from '@/utils/cache'
import { logger } from '@/utils/logger'
import { getOpenInterest, getFundingRate } from '@/services/marketData'

export interface OpenInterestScore {
  score:    number   // 0–20
  oiValue:  number
  oiChange: number   // % change from last scan
  fundingRate: number // current funding rate
  reasons:  string[]
}

export async function runOpenInterestEngine(
  symbol: string,
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
  priceChange1h: number, // passed from technical engine or candles
): Promise<OpenInterestScore> {
  if (direction === 'NEUTRAL') {
    return { score: 0, oiValue: 0, oiChange: 0, fundingRate: 0, reasons: ['Neutral direction'] }
  }

  // 1. Fetch OI and Funding Rate
  const [currentOI, fundingRate] = await Promise.all([
    getOpenInterest(symbol),
    getFundingRate(symbol)
  ])

  const cacheKey = `oi:last:${symbol}`
  const lastOI = await cache.get<number>(cacheKey)
  
  // Store current OI for next scan
  await cache.set(cacheKey, currentOI, 3600)

  if (currentOI === 0) {
    return { 
      score: 10, // Neutral fallback
      oiValue: 0, 
      oiChange: 0, 
      fundingRate,
      reasons: ['Open Interest data unavailable — using neutral fallback'] 
    }
  }

  if (lastOI === null || lastOI === 0) {
    logger.info({ context: 'OI_ANA', symbol, currentOI }, 'ℹ️ Initial OI capture (First Run)')
    return {
      score: 10,
      oiValue: currentOI,
      oiChange: 0,
      fundingRate,
      reasons: [`Initial OI capture: ${currentOI.toLocaleString()} (confirming next cycle)`]
    }
  }

  const oiChangePct = ((currentOI - lastOI) / lastOI) * 100
  let oiScore = 10 
  const reasons: string[] = []

  const isPriceUp = priceChange1h > 0
  const isOIUp = oiChangePct > 0.5 

  // 2. Base OI Logic (Max 12 pts for trend)
  if (direction === 'LONG') {
    if (isPriceUp && isOIUp) {
      oiScore = 12
      reasons.push('🔥 Bullish Confirmation: Price ↑, OI ↑ (Strong Accumulation)')
    } else if (isPriceUp && !isOIUp) {
      oiScore = 8
      reasons.push('⚠️ Weak Bullish: Price ↑, OI ↓ (Short Covering)')
    } else if (!isPriceUp && isOIUp) {
      oiScore = 2
      reasons.push('❌ Bearish Pressure: Price ↓, OI ↑ (Aggressive Shorting)')
    } else {
      oiScore = 5
      reasons.push('💤 Weak Move: Price ↓, OI ↓ (Long Liquidation)')
    }
  } else { // SHORT
    if (!isPriceUp && isOIUp) {
      oiScore = 12
      reasons.push('🔥 Bearish Confirmation: Price ↓, OI ↑ (Strong Selling Pressure)')
    } else if (!isPriceUp && !isOIUp) {
      oiScore = 8
      reasons.push('⚠️ Weak Bearish: Price ↓, OI ↓ (Long Liquidation)')
    } else if (isPriceUp && isOIUp) {
      oiScore = 2
      reasons.push('❌ Bullish Pressure: Price ↑, OI ↑ (Aggressive Longing)')
    } else {
      oiScore = 5
      reasons.push('💤 Weak Move: Price ↑, OI ↓ (Short Covering)')
    }
  }

  // 3. Funding Rate Quality Modifier (Max 8 pts = Total 20)
  // Logic: 
  // LONG: prefer low/negative funding (unstretched), penalize high positive (crowded)
  // SHORT: prefer positive funding (longs paying shorts), penalize negative (shorts crowded)
  let fundingScore = 0
  if (direction === 'LONG') {
    if (fundingRate < 0) {
      fundingScore = 8
      reasons.push(`💎 Negative Funding (${(fundingRate*100).toFixed(4)}%): Shorts paying Longs (+8)`)
    } else if (fundingRate < 0.0001) { // 0.01% standard
      fundingScore = 5
      reasons.push(`✅ Healthy Funding (${(fundingRate*100).toFixed(4)}%): Low retail heat (+5)`)
    } else if (fundingRate > 0.0003) { // 0.03%+ crowded
      fundingScore = -3
      reasons.push(`⚠️ Crowded LONG (${(fundingRate*100).toFixed(2)}%): High funding penalty (-3)`)
    }
  } else { // SHORT
    if (fundingRate > 0.0002) {
      fundingScore = 8
      reasons.push(`💎 Positive Funding (${(fundingRate*100).toFixed(4)}%): Longs paying Shorts (+8)`)
    } else if (fundingRate > 0) {
      fundingScore = 4
      reasons.push(`✅ Normal Funding (${(fundingRate*100).toFixed(4)}%): Bearish bias healthy (+4)`)
    } else if (fundingRate < -0.0002) {
      fundingScore = -3
      reasons.push(`⚠️ Crowded SHORT (${(fundingRate*100).toFixed(2)}%): Negative funding penalty (-3)`)
    }
  }

  const finalScore = Math.min(Math.max(oiScore + fundingScore, 0), 20)

  logger.info({ 
    context: 'OI_ANA', 
    symbol, 
    score: finalScore, 
    oiChangePct: oiChangePct.toFixed(2),
    fundingRate: (fundingRate*100).toFixed(4) + '%'
  }, '📈 OI & Funding analysis complete')

  return {
    score: finalScore,
    oiValue: currentOI,
    oiChange: oiChangePct,
    fundingRate,
    reasons,
  }
}
