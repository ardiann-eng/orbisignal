// services/chartGenerator.ts
// NEW: Pure Node.js chart rendering with visual annotations (entry zone, TP/SL, direction, and pattern label).

import { ChartJSNodeCanvas } from 'chartjs-node-canvas'
import type { ChartConfiguration } from 'chart.js'
import { Chart } from 'chart.js'
// chartjs-plugin-annotation has a JS default export; typing can be incomplete in TS.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import annotationPlugin from 'chartjs-plugin-annotation'

Chart.register(annotationPlugin as any)

const canvas = new ChartJSNodeCanvas({
  width: 1280,
  height: 720,
  backgroundColour: '#131722',
})

// CCXT OHLCV: [timestamp, open, high, low, close, volume]
export type OHLCV = number[]

export async function generateSignalChart(params: {
  symbol: string
  direction: 'LONG' | 'SHORT'
  candles: number[][]
  entryLow: number
  entryHigh: number
  tp1: number
  tp2: number
  tp3: number
  sl: number
  pattern: string
  confidence: number
}): Promise<Buffer> {
  const {
    symbol,
    direction,
    candles,
    entryLow,
    entryHigh,
    tp1,
    tp2,
    tp3,
    sl,
    pattern,
    confidence,
  } = params

  const display = candles.slice(-60)
  const len = display.length
  const labels = display.map((_, i) => i.toString())

  const closes = display.map(c => c[4])
  const highs = display.map(c => c[2])
  const lows = display.map(c => c[3])

  const dirColor = direction === 'LONG' ? '#26a69a' : '#ef5350'

  const yMax = highs.length ? Math.max(...highs) : 0

  const patternText =
    pattern && pattern !== 'No Pattern'
      ? pattern
      : ''

  const config: ChartConfiguration = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: symbol,
          data: closes,
          borderColor: dirColor,
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
          tension: 0.1,
        },

        // Entry zone high
        {
          label: `Entry High ${entryHigh}`,
          data: Array(len).fill(entryHigh),
          borderColor: '#FFD700',
          borderWidth: 1.5,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false,
        },

        // Entry zone low (shaded to previous dataset high)
        {
          label: `Entry Low ${entryLow}`,
          data: Array(len).fill(entryLow),
          borderColor: '#FFD700',
          borderWidth: 1.5,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: '-1',
          backgroundColor: 'rgba(255, 215, 0, 0.08)',
        },

        {
          label: `TP1 ${tp1}`,
          data: Array(len).fill(tp1),
          borderColor: '#26a69a',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: `TP2 ${tp2}`,
          data: Array(len).fill(tp2),
          borderColor: '#00897b',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },
        {
          label: `TP3 ${tp3}`,
          data: Array(len).fill(tp3),
          borderColor: '#004d40',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },

        {
          label: `SL ${sl}`,
          data: Array(len).fill(sl),
          borderColor: '#ef5350',
          borderWidth: 2,
          borderDash: [8, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: {
        legend: { display: false },

        annotation: {
          annotations: {
            entryLabel: {
              type: 'label',
              xValue: len - 1,
              yValue: (entryLow + entryHigh) / 2,
              content: 'ENTRY ZONE',
              color: '#FFD700',
              font: { size: 10, weight: 'bold' },
              textAlign: 'right',
            },

            tp1Label: {
              type: 'label',
              xValue: len - 1,
              yValue: tp1,
              content: `TP1 — ${tp1}`,
              color: '#26a69a',
              font: { size: 10 },
              textAlign: 'right',
            },

            tp2Label: {
              type: 'label',
              xValue: len - 1,
              yValue: tp2,
              content: `TP2 — ${tp2}`,
              color: '#00897b',
              font: { size: 10 },
              textAlign: 'right',
            },

            tp3Label: {
              type: 'label',
              xValue: len - 1,
              yValue: tp3,
              content: `TP3 — ${tp3}`,
              color: '#004d40',
              font: { size: 10 },
              textAlign: 'right',
            },

            slLabel: {
              type: 'label',
              xValue: len - 1,
              yValue: sl,
              content: `SL — ${sl}`,
              color: '#ef5350',
              font: { size: 10, weight: 'bold' },
              textAlign: 'right',
            },

            directionLabel: {
              type: 'label',
              xValue: 2,
              yValue: yMax * 0.99,
              content: [
                direction === 'LONG' ? '▲ LONG' : '▼ SHORT',
                symbol,
                `Conf: ${confidence}/100`,
                patternText,
              ]
                .filter(Boolean)
                .join('\n'),
              color: dirColor,
              font: { size: 13, weight: 'bold' },
              textAlign: 'left',
            },
          },
        },
      },
      scales: {
        x: {
          display: false,
          grid: { color: 'rgba(255,255,255,0.05)' },
        },
        y: {
          position: 'right',
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#787b86',
            font: { size: 10 },
          },
        },
      },
    },
    plugins: [
      {
        id: 'watermark',
        beforeDraw(chart: any) {
          const ctx = chart.ctx
          ctx.save()
          ctx.globalAlpha = 0.15
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 24px Arial'
          ctx.textAlign = 'center'
          ctx.fillText('ORBIS', chart.width / 2, chart.height / 2)
          ctx.restore()
        },
      } as any,
    ],
  }

  return canvas.renderToBuffer(config)
}

