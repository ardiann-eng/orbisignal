// utils/performance.ts
// Reads resolved signals from DB and calculates win rate, avg R:R,
// and per-coin stats. Run manually or expose via API for dashboard.

import { prisma } from '@/lib/db'

export interface PerformanceReport {
  totalSignals:  number
  resolved:      number
  wins:          number    // TP1, TP2, or TP3 hit
  losses:        number    // SL hit
  winRate:       number    // 0–100 %
  avgRR:         number
  bestCoin:      string | null
  worstCoin:     string | null
  byDirection: {
    LONG:  { total: number; wins: number; winRate: number }
    SHORT: { total: number; wins: number; winRate: number }
  }
}

export async function getPerformanceReport(days = 30): Promise<PerformanceReport> {
  const since = new Date(Date.now() - days * 86400_000)

  const signals = await prisma.signal.findMany({
    where: { createdAt: { gte: since } },
    select: {
      symbol: true, direction: true, rrRatio: true,
      status: true, resolvedAt: true,
    },
  })

  const resolved = signals.filter(s => s.status !== 'ACTIVE' && s.status !== 'EXPIRED')
  const wins     = resolved.filter(s => s.status.includes('TP'))
  const losses   = resolved.filter(s => s.status === 'SL_HIT')

  const winRate = resolved.length > 0
    ? Math.round((wins.length / resolved.length) * 100)
    : 0

  const avgRR = resolved.length > 0
    ? Math.round((resolved.reduce((s, r) => s + r.rrRatio, 0) / resolved.length) * 10) / 10
    : 0

  // Per-coin win rate
  const coinStats: Record<string, { wins: number; total: number }> = {}
  for (const s of resolved) {
    if (!coinStats[s.symbol]) coinStats[s.symbol] = { wins: 0, total: 0 }
    coinStats[s.symbol].total++
    if (s.status.includes('TP')) coinStats[s.symbol].wins++
  }

  const coinEntries = Object.entries(coinStats)
  const bestCoin  = coinEntries.sort((a, b) => b[1].wins / b[1].total - a[1].wins / a[1].total)[0]?.[0] ?? null
  const worstCoin = coinEntries.sort((a, b) => a[1].wins / a[1].total - b[1].wins / b[1].total)[0]?.[0] ?? null

  const long  = resolved.filter(s => s.direction === 'LONG')
  const short = resolved.filter(s => s.direction === 'SHORT')
  const longWins  = long.filter(s => s.status.includes('TP'))
  const shortWins = short.filter(s => s.status.includes('TP'))

  return {
    totalSignals: signals.length,
    resolved:     resolved.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate,
    avgRR,
    bestCoin,
    worstCoin,
    byDirection: {
      LONG:  { total: long.length,  wins: longWins.length,  winRate: long.length  > 0 ? Math.round(longWins.length  / long.length  * 100) : 0 },
      SHORT: { total: short.length, wins: shortWins.length, winRate: short.length > 0 ? Math.round(shortWins.length / short.length * 100) : 0 },
    },
  }
}
