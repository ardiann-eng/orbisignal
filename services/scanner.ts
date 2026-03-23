// services/scanner.ts
// The main entry point for the analysis loop.
// Run standalone: npx tsx services/scanner.ts
// Or imported by Next.js API route for manual trigger.
//
// Workflow: watchlist → parallel analysis → signal engine → risk filter → alert

import cron        from 'node-cron'
import { config }  from '@/lib/config'
import { cache }   from '@/utils/cache'
import { logger }  from '@/utils/logger'
import { getExchangeSymbols }    from '@/services/marketData'
import { runTechnicalEngine }    from '@/analysis/technical'
import { runFundamentalEngine }  from '@/analysis/fundamental'
import { runOpenInterestEngine } from '@/analysis/openInterest'
import { buildSignal }           from '@/services/signalEngine'
import { sendAlert, getBot }     from '@/telegram/alertSender'
import { initCoinMapping }       from '@/utils/coinMapping' // FIX: dynamic CoinGecko mapping
import { getCandles }           from '@/services/marketData' // NEW: candles for pattern + chart
import { detectPatterns, pickBestPattern } from '@/services/patternRecognition' // NEW:
import { generateSignalChart } from '@/services/chartGenerator' // NEW:

// ─── Single coin scan ─────────────────────────────────────────────────────

interface ScanResult {
  symbol:   string
  signalSent:boolean
  confidence:number | null
  rejection: string | null
  durationMs:number
}

async function scanCoin(symbol: string): Promise<ScanResult> {
  const start = Date.now()

  try {
    // ── Run all 3 engines in parallel ───────────────────────────────
    const techResult = await runTechnicalEngine(symbol)
    
    // We need 1h price change for OI logic
    const priceChange1h = techResult.details.find(d => d.timeframe === '1h')?.priceChange ?? 0

    const [fundResult, oiResult] = await Promise.all([
      runFundamentalEngine(symbol, techResult.direction),
      runOpenInterestEngine(symbol, techResult.direction, priceChange1h),
    ])

    // ── AUDIT FIX: Pattern detection moved BEFORE signal engine ─────────
    const candles4h = await getCandles(symbol, '4h', 120)
    const ohlcv: number[][] = candles4h.map(c => [
      c.openTime, c.open, c.high, c.low, c.close, c.volume,
    ])

    const patternResults = detectPatterns(ohlcv)
    const bestPattern = pickBestPattern(patternResults)

    // ── Feed into signal engine ───────────────────────────────
    // FIX: Pass bestPattern to buildSignal for scoring bonus
    const { signal, rejectionReason } = await buildSignal(
      symbol, techResult, fundResult, oiResult, bestPattern
    )

    const score = Math.round(techResult.score + fundResult.score + oiResult.score)
    logger.debug({
      context: 'SCORE',
      symbol,
      technical: techResult.score,
      fundamental: fundResult.score,
      openInterest: oiResult.score,
      total: score,
    }, '📊 Score breakdown')

    if (!signal) {
      if (techResult.direction !== 'NEUTRAL') {
        logger.debug({ context: 'SCAN', symbol, score, reason: rejectionReason }, '⏭ Symbol filtered out')
      }
      return {
        symbol, signalSent: false,
        confidence:  score,
        rejection:   rejectionReason,
        durationMs:  Date.now() - start,
      }
    }

    const patternLabel = bestPattern
      ? `${bestPattern.pattern} (${bestPattern.bias})`
      : 'No Pattern'

    if (bestPattern) {
      signal.reasons = [...signal.reasons, `⚡ ${bestPattern.pattern} (${bestPattern.bias})`].slice(0, 7)
    }

    let chartBuffer: Buffer | undefined
    try {
      if (ohlcv.length >= 10) {
        chartBuffer = await generateSignalChart({
          symbol: signal.symbol,
          direction: signal.direction,
          candles: ohlcv,
          entryLow: signal.riskPlan.entryLow,
          entryHigh: signal.riskPlan.entryHigh,
          tp1: signal.riskPlan.tp1,
          tp2: signal.riskPlan.tp2,
          tp3: signal.riskPlan.tp3,
          sl: signal.riskPlan.stopLoss,
          pattern: patternLabel,
          confidence: signal.confidence,
        })
      }
    } catch (err: any) {
      logger.warn({ context: 'CHART', symbol, err: err.message }, '⚠️ Node chart generation failed, fallback to QuickChart')
    }

    await sendAlert(signal, chartBuffer)

    return {
      symbol, signalSent: true,
      confidence:  signal.confidence,
      rejection:   null,
      durationMs:  Date.now() - start,
    }
  } catch (err: any) {
    logger.error({ context: 'SCAN', symbol, err: err.message }, '❌ Scan error')
    return {
      symbol, signalSent: false, confidence: null,
      rejection:  `Error: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    }
  }
}

// ─── Full watchlist scan ──────────────────────────────────────────────────

let isScanning = false
let lastScanTime = 0

async function runFullScan(): Promise<void> {
  const now = Date.now()
  
  // FIX: isScanning safety check — if last scan was > 15m ago, assume hung and reset
  if (isScanning && (now - lastScanTime) < 900000) {
    logger.warn({ context: 'SCAN', elapsedSec: Math.round((now - lastScanTime) / 1000) }, '⚠️ Scan cycle skipped — previous run still active')
    return
  }

  isScanning = true
  lastScanTime = now
  const results: ScanResult[] = []

  try {
    const symbolsToScan = await getExchangeSymbols(250) // AUDIT FIX: 100 -> 250 symbols
    if (!symbolsToScan.length) {
      logger.error({ context: 'SCAN', err: 'No symbols found to scan' }, '❌ No symbols found to scan')
      return
    }

    logger.info({ context: 'SCAN', symbols: symbolsToScan.length }, '🔍 Scan cycle started')
    const scanStart = Date.now()

    const processedSymbols = new Set<string>()

    for (const symbol of symbolsToScan) {
      if (processedSymbols.has(symbol)) continue
      processedSymbols.add(symbol)
      
      const coinStart = Date.now()
      
      // FIX: Optimize cycle. 
      // Kita menjalankan scanCoin (API bound) dan memulai timer 2.5s secara paralel.
      // Kita hanya menunggu scanCoin SELESAI sebelum lanjut ke coin berikutnya,
      // TAPI jika scanCoin lebih cepat dari 2.5s, kita tetap menunggu sisa waktu 2.5s agar aman dari rate limit.
      const result = await scanCoin(symbol)
      results.push(result)
      
      const elapsed = Date.now() - coinStart
      const targetDelay = 2200 // Slightly reduced from 2500 for better margin (approx 27 req/min)
      if (elapsed < targetDelay) {
        await sleep(targetDelay - elapsed)
      }
    }

    const signalsSent = results.filter(r => r.signalSent).length
    const totalMs     = Date.now() - scanStart
    const durationSec = Math.round(totalMs / 1000)

    logger.info(
      { context: 'SCAN', totalCoins: symbolsToScan.length, signalsSent, durationSec },
      `✅ Scan complete — ${signalsSent} signal(s) sent`,
    )

    // Log rejection breakdown
    const rejectionBuckets = results
      .filter(r => !r.signalSent && r.rejection)
      .reduce((acc, r) => {
        const key = r.rejection!.split(':')[0].trim()
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {} as Record<string, number>)

    logger.info({ context: 'SCAN', rejectionBuckets }, '📊 Rejection breakdown this cycle')

    // Store scan summary in cache for dashboard
    await cache.set('scanner:lastRun', {
      timestamp:   new Date().toISOString(),
      scannedCoins:results.length,
      signalsSent,
    }, 600)
  } catch (error) {
    logger.error({ context: 'SCAN', err: error }, '❌ Fatal error during runFullScan')
  } finally {
    isScanning = false
  }
}

// ─── Cron scheduler ───────────────────────────────────────────────────────

function startScheduler(): void {
  const interval   = config.SCAN_INTERVAL_MINUTES
  const expression = `*/${interval} * * * *`

  logger.info({ context: 'CRON', expression }, `⏰ Cron scheduler starting`)

  cron.schedule(expression, async () => {
    logger.info({ context: 'CRON' }, '⏰ Scheduled scan triggered')
    try {
      await runFullScan()
    } catch (err: any) {
      logger.error({ context: 'CRON', err: err.message }, '❌ Cron job failed')
    }
  })

  // Run immediately on start
  runFullScan()
}

// ─── Helper ───────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// ─── Standalone entry point ───────────────────────────────────────────────

// ─── Standalone entry point & Global Handlers ─────────────────────────────────────

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    logger.fatal({ context: 'SYSTEM', err: err.message, stack: err.stack }, '💀 Uncaught exception — bot may be unstable')
  })

  process.on('unhandledRejection', (reason) => {
    logger.error({ context: 'SYSTEM', reason: String(reason) }, '⚠️ Unhandled promise rejection')
  })

  ;(async () => {
    logger.info({ context: 'BOOT' }, '🚀 Orbis bot starting...')
    logger.info({ context: 'BOOT', exchange: 'Primary (OKX)' }, '📡 Connecting to exchange...')

    try {
      // FIX: Build dynamic CoinGecko coin mapping before first scan
      await initCoinMapping()

      // Init Telegram bot (starts polling for commands)
      getBot()
      logger.info({ context: 'BOOT' }, '✅ Bot ready — polling active')

      // Start cron loop
      startScheduler()
    } catch (err: any) {
      logger.fatal({ context: 'BOOT', err: err.message }, '💀 Bot failed to start')
      process.exit(1)
    }
  })()
}

// Export for API route usage
export { runFullScan, scanCoin }
