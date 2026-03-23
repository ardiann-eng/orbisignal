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

    // Build OHLC data for candlestick chart
    const candlestickData = candles.map(c => ({
      x: c.openTime,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close
    }))

    const { entryLow, entryHigh, tp1, tp2, tp3, stopLoss } = signal.riskPlan
    const entryMid = (entryLow + entryHigh) / 2

    // Build horizontal annotation lines for TP/SL/Entry
    const makeAnnotation = (value: number, color: string, label: string, isEntry = false) => ({
      type: 'line',
      mode: 'horizontal',
      scaleID: 'y',
      value,
      borderColor: color,
      borderWidth: isEntry ? 3 : 2,
      borderDash: isEntry ? [] : [4, 4],
      label: {
        enabled: true,
        content: `${label}: ${formatPrice(value)}`,
        backgroundColor: 'rgba(0,0,0,0.8)',
        color: color,
        font: { size: 11, weight: 'bold' },
        position: 'end',
        xAdjust: -10,
      },
    })

    const chartConfig = {
      type: 'candlestick',
      data: {
        datasets: [{
          label: signal.symbol,
          data: candlestickData,
          color: {
            up: '#26a69a',    // TV Bullish Green
            down: '#ef5350',  // TV Bearish Red
            unchanged: '#999',
          },
          borderColor: {
            up: '#26a69a',
            down: '#ef5350',
          },
          wickColor: {
            up: '#26a69a',
            down: '#ef5350',
          }
        }]
      },
      options: {
        responsive: false,
        devicePixelRatio: 2, // High DPI for clarity
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            text: `ORBIS Inteligência — ${signal.symbol} (${signal.direction})`,
            color: '#d1d4dc',
            font: { size: 20, weight: 'bold' }
          },
          annotation: {
            annotations: {
              entry: makeAnnotation(entryMid, '#f0b90b', 'ENTRY', true),
              tp1:   makeAnnotation(tp1, '#00ff88', 'TP1'),
              tp2:   makeAnnotation(tp2, '#00ff88', 'TP2'),
              tp3:   makeAnnotation(tp3, '#00ff88', 'TP3'),
              sl:    makeAnnotation(stopLoss, '#ff3366', 'SL'),
            }
          }
        },
        scales: {
          x: {
            type: 'time',
            time: { unit: 'hour', displayFormats: { hour: 'HH:mm' } },
            grid: { color: '#1f222d', drawBorder: false },
            ticks: { color: '#787b86', font: { size: 10 } }
          },
          y: {
            position: 'right',
            grid: { color: '#1f222d', drawBorder: false },
            ticks: { color: '#d1d4dc', font: { size: 11 } }
          }
        }
      }
    }

    // POST to QuickChart API with version 3 (enables financial plugins)
    const response = await axios.post(
      QUICKCHART_URL,
      {
        chart: JSON.stringify(chartConfig),
        width: 1000,
        height: 600,
        backgroundColor: '#131722', // TV Dark Background
        format: 'png',
        version: '3'
      },
      {
        responseType: 'arraybuffer',
        timeout: 20000,
      },
    )

    return Buffer.from(response.data)
  } catch (error: any) {
    logger.error({ context: 'CHART', err: error.message }, '❌ Chart generation failed (QuickChart)')
    return null
  }
}
