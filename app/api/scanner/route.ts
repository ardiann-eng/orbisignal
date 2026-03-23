// app/api/scanner/route.ts
import { NextResponse } from 'next/server'
import { cache }        from '@/utils/cache'
import { runFullScan }  from '@/services/scanner'
import { getBot }       from '@/telegram/alertSender'

// GET — return last scan summary (used by dashboard polling)
export async function GET() {
  const lastRun = await cache.get('scanner:lastRun')
  if (!lastRun) {
    return NextResponse.json({ status: 'no_scan_yet' })
  }
  return NextResponse.json({ status: 'ok', data: lastRun })
}

// POST — manually trigger a scan or handle Telegram webhook
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  
  if (body?.message || body?.callback_query || body?.update_id) {
    console.log("Received Telegram update:", body?.message?.text || "callback data")
    
    // Process synchronously before concluding
    try {
      getBot().processUpdate(body)
    } catch (err) {
      console.error("Bot payload error:", err)
    }

    return NextResponse.json({ ok: true })
  }

  // Wrap scanner execution in setTimeout to immediately return 200 OK without blocking
  setTimeout(() => {
    runFullScan().catch(console.error)
  }, 0)

  return NextResponse.json({ ok: true })
}
