// app/api/performance/route.ts
import { NextResponse }         from 'next/server'
import { getPerformanceReport } from '@/utils/performance'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const days = parseInt(searchParams.get('days') ?? '30')
  const report = await getPerformanceReport(days)
  return NextResponse.json(report)
}
