// utils/chartBuilder.ts
// FIX: python → QuickChart.io (no native deps, works on Railway)
// Renders a Chart.js config via QuickChart's free hosted API.

import axios from 'axios'
import { logger } from '@/utils/logger'
import type { Signal } from '@/services/signalEngine'
import { getCandles } from '@/services/marketData'
import { formatPrice } from '@/telegram/formatter'

const QUICKCHART_URL = 'https://quickchart.io/chart'

export async function generateChart(signal: Signal): Promise<Buffer | null> {
  try {
    const candles = await getCandles(signal.symbol, '1h', 60)
    if (!candles || candles.length === 0) {
      logger.warn({ symbol: signal.symbol }, 'No candle data for chart')
      return null
    }

    // Build labels and OHLC data for a line chart (QuickChart doesn't support candlestick natively)
    const labels = candles.map(c => {
      const d = new Date(c.openTime)
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`
    })
    const closes = candles.map(c => c.close)
    const highs  = candles.map(c => c.high)
    const lows   = candles.map(c => c.low)

    const { entryLow, entryHigh, tp1, tp2, tp3, stopLoss } = signal.riskPlan
    const entryMid = (entryLow + entryHigh) / 2

    // Build horizontal annotation lines for TP/SL/Entry
    const makeAnnotation = (value: number, color: string, label: string) => ({
      type: 'line',
      mode: 'horizontal',
      scaleID: 'y',
      value,
      borderColor: color,
      borderWidth: 2,
      borderDash: [5, 5],
      label: {
        enabled: true,
        content: `${label}: ${formatPrice(value)}`,
        backgroundColor: color,
        font: { size: 10 },
        position: 'end',
      },
    })

    const chartConfig = {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Close',
            data: closes,
            borderColor: signal.direction === 'LONG' ? '#00ff88' : '#ff3366',
            borderWidth: 2,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'High',
            data: highs,
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
          {
            label: 'Low',
            data: lows,
            borderColor: 'rgba(255,255,255,0.15)',
            borderWidth: 1,
            pointRadius: 0,
            fill: '-1', // fill between high and low
            backgroundColor: 'rgba(255,255,255,0.03)',
          },
        ],
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: `ORBIS ${signal.direction} — ${signal.symbol} (Score: ${signal.confidence}/100)`,
            color: '#ffffff',
            font: { size: 18 },
          },
          legend: { display: false },
          annotation: {
            annotations: [
              makeAnnotation(entryMid, '#eab308', 'Entry'),
              makeAnnotation(tp1, '#22c55e', 'TP1'),
              makeAnnotation(tp2, '#22c55e', 'TP2'),
              makeAnnotation(tp3, '#16a34a', 'TP3'),
              makeAnnotation(stopLoss, '#ef4444', 'SL'),
            ],
          },
        },
        scales: {
          x: {
            ticks: { color: '#888', maxTicksLimit: 10, font: { size: 9 } },
            grid: { color: '#333' },
          },
          y: {
            position: 'right',
            ticks: { color: '#888', font: { size: 10 } },
            grid: { color: '#333' },
          },
        },
      },
    }

    // POST to QuickChart API
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: JSON.stringify(chartConfig),
        width: 1280,
        height: 720,
        backgroundColor: '#1a1a2e',
        format: 'png',
      },
      {
        responseType: 'arraybuffer',
        timeout: 15000,
      },
    )

    return Buffer.from(response.data)
  } catch (error: any) {
    logger.error({ context: 'CHART', err: error.message }, '❌ Chart generation failed (QuickChart)')
    return null
  }
}
