// app/api/watchlist/route.ts
// Returns current prices and 24h changes for all monitored coins.
// Used by dashboard to show a live market overview panel.

import { NextResponse }    from 'next/server'
import { getAllTickers, getExchangeSymbols }   from '@/services/marketData' // NEW:
import { cache }           from '@/utils/cache'

export async function GET() {
  const cacheKey = 'api:watchlist'
  const cached   = await cache.get(cacheKey)
  if (cached) return NextResponse.json(cached)

  const symbols = await getExchangeSymbols(100) // NEW:
  const tickers = await getAllTickers(symbols)

  const result = {
    updatedAt: new Date().toISOString(),
    coins: tickers.map(t => ({
      symbol:     t.symbol,
      price:      t.lastPrice,
      change24h:  t.priceChangePercent,
      volume24h:  t.quoteVolume,
    })),
  }

  await cache.set(cacheKey, result, 30) // 30s TTL
  return NextResponse.json(result)
}
