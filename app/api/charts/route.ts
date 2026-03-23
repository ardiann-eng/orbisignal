// app/api/charts/route.ts
import { NextResponse } from 'next/server'
import { getCandles } from '@/services/marketData'
import { TECHNICAL_THRESHOLDS } from '@/lib/config'

/**
 * Basic EMA calculation for the chart data
 */
function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: (number | null)[] = Array(period - 1).fill(null)
  
  let ema = values[0]
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    if (i >= period - 1) result.push(ema)
  }
  return result as number[]
}

/**
 * Basic RSI calculation
 */
function calcRSI(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = Array(period).fill(null)
  if (closes.length < period) return rsi

  let gains = 0; let losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff; else losses -= diff
  }

  let avgGain = gains / period
  let avgLoss = losses / period
  rsi.push(100 - (100 / (1 + (avgGain / (avgLoss || 1)))))

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    rsi.push(100 - (100 / (1 + (avgGain / (avgLoss || 1)))))
  }
  return rsi
}

function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast)
  const emaSlow = calcEMA(closes, slow)
  const macdLine = emaFast.map((f, i) => (f !== null && emaSlow[i] !== null ? f - emaSlow[i]! : null))
  
  // Filter out nulls for signal calculation
  const macdDataForSignal = macdLine.filter(v => v !== null) as number[]
  const signalLineRaw = calcEMA(macdDataForSignal, signal)
  
  // Pad signal line back to match original length
  const signalLine = Array(macdLine.length - signalLineRaw.length).fill(null).concat(signalLineRaw)
  
  const histogram = macdLine.map((m, i) => (m !== null && signalLine[i] !== null ? m - signalLine[i]! : null))
  
  return { macdLine, signalLine, histogram }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get('symbol') || 'BTC/USDT'
  const timeframe = (searchParams.get('timeframe') || '1h') as any

  try {
    const candles = await getCandles(symbol, timeframe, 200)
    const closes = candles.map(c => c.close)

    const ema9 = calcEMA(closes, 9)
    const ema21 = calcEMA(closes, 21)
    const ema50 = calcEMA(closes, 50)
    const rsi = calcRSI(closes, 14)
    const { macdLine, signalLine, histogram } = calcMACD(closes)

    const chartData = candles.map((c, i) => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      ema9: ema9[i],
      ema21: ema21[i],
      ema50: ema50[i],
      rsi: rsi[i],
      macd: macdLine[i],
      macdSignal: signalLine[i],
      macdHist: histogram[i]
    }))

    return NextResponse.json({ success: true, data: chartData })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
}
