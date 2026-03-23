// app/api/signals/route.ts
import { NextResponse } from 'next/server'
import { prisma }       from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit  = Math.min(parseInt(searchParams.get('limit') ?? '20'), 100)
  const status = searchParams.get('status') ?? undefined

  const signals = await prisma.signal.findMany({
    where:   status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take:    limit,
    select: {
      id: true, symbol: true, direction: true, confidence: true,
      entryLow: true, entryHigh: true, tp1: true, tp2: true, tp3: true,
      sl: true, rrRatio: true,
      technical: true, fundamental: true, openInterest: true,
      reasons: true, status: true, createdAt: true,
    },
  })

  return NextResponse.json({
    total: signals.length,
    signals: signals.map(s => ({
      ...s,
      reasons: JSON.parse(s.reasons as string),
    })),
  })
}
