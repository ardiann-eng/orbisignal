// services/signalTracker.ts
// Runs on a separate schedule (every 5 minutes).
// Checks all ACTIVE signals against current price and updates their status
// when TP1/2/3 or SL is hit. This is what makes the dashboard history meaningful.

import { prisma }      from '@/lib/db'
import { getTicker }   from '@/services/marketData'
import { logger }      from '@/utils/logger'

type SignalStatus = 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'EXPIRED'

export async function updateSignalStatuses(): Promise<void> {
  // Only check signals created in the last 72h and still ACTIVE
  const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000)
  const active = await prisma.signal.findMany({
    where: { status: 'ACTIVE', createdAt: { gte: cutoff } },
  })

  if (!active.length) return
  logger.debug({ count: active.length }, 'Tracking open signals...')

  for (const signal of active) {
    const ticker = await getTicker(signal.symbol)
    if (!ticker) continue

    const price     = ticker.lastPrice
    let   newStatus: SignalStatus | null = null

    if (signal.direction === 'LONG') {
      if (price <= signal.sl)  newStatus = 'SL_HIT'
      else if (price >= signal.tp3)  newStatus = 'TP3_HIT'
      else if (price >= signal.tp2)  newStatus = 'TP2_HIT'
      else if (price >= signal.tp1)  newStatus = 'TP1_HIT'
    } else {
      // SHORT: price moves down to hit TP, up to hit SL
      if (price >= signal.sl)  newStatus = 'SL_HIT'
      else if (price <= signal.tp3)  newStatus = 'TP3_HIT'
      else if (price <= signal.tp2)  newStatus = 'TP2_HIT'
      else if (price <= signal.tp1)  newStatus = 'TP1_HIT'
    }

    if (newStatus) {
      await prisma.signal.update({
        where: { id: signal.id },
        data:  { status: newStatus, resolvedAt: new Date() },
      })
      logger.info({ symbol: signal.symbol, newStatus }, 'Signal resolved')
    }
  }

  // Mark signals older than 72h as EXPIRED if still ACTIVE
  await prisma.signal.updateMany({
    where: { status: 'ACTIVE', createdAt: { lt: cutoff } },
    data:  { status: 'EXPIRED', resolvedAt: new Date() },
  })
}
