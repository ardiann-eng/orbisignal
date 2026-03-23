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
import { getFearAndGreed, runSentimentEngine }    from '@/analysis/sentiment' // NEW:
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

async function scanCoin(symbol: string, fearGreed: { value: number; label: string }): Promise<ScanResult> { // NEW:
  const start = Date.now()
  // FIX: removed per-symbol debug log — too noisy in 100-symbol scan. Only log errors and generated signals.

  try {
    // ── Run all 3 engines in parallel ───────────────────────────────
    const techResult = await runTechnicalEngine(symbol)
    const [fundResult, sentResult] = await Promise.all([
      runFundamentalEngine(symbol, techResult.direction),
      runSentimentEngine(symbol, techResult.direction, fearGreed), // NEW:
    ])

    // ── Feed into signal engine ───────────────────────────────
    const { signal, rejectionReason } = await buildSignal(
      symbol, techResult, fundResult, sentResult,
    )

    const score = Math.round(techResult.score + fundResult.score + sentResult.score)
    // FIX Opsi C: Only log score at debug level — not for every coin at info
    logger.debug({
      context: 'SCORE',
      symbol,
      technical: techResult.score,
      fundamental: fundResult.score,
      sentiment: sentResult.score,
      total: score,
    }, '📊 Score breakdown')

    if (!signal) {
      // Only warn for symbols that actually made it past the direction filter
      if (techResult.direction !== 'NEUTRAL') {
        logger.debug({ context: 'SCAN', symbol, score, reason: rejectionReason }, '⏭ Symbol filtered out')
      }
      return {
        symbol, signalSent: false,
        confidence:  Math.round(techResult.score + fundResult.score + sentResult.score),
        rejection:   rejectionReason,
        durationMs:  Date.now() - start,
      }
    }

    // NEW: Pattern detection + annotated chart
    // Only run after the signal passes all filters (economy + avoid noisy charts).
    const candles4h = await getCandles(symbol, '4h', 120)
    const ohlcv: number[][] = candles4h.map(c => [
      c.openTime,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
    ])

    const patternResults = detectPatterns(ohlcv)
    const bestPattern = pickBestPattern(patternResults)

    const patternLabel = bestPattern
      ? `${bestPattern.pattern} (${bestPattern.bias})`
      : 'No Pattern'

    if (bestPattern) {
      // Keep reasons short for Telegram readability.
      signal.reasons = [...signal.reasons, `${bestPattern.pattern} pattern terdeteksi (${bestPattern.bias})`].slice(0, 7)
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

    // ── Send to Telegram ──────────────────────────────────────
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

async function runFullScan(): Promise<void> {
  if (isScanning) {
    logger.warn({ context: 'SCAN' }, '⚠️ Scan already in progress, skipping overlapping run')
    return
  }

  isScanning = true
  const results: ScanResult[] = []

  try {
    const symbolsToScan = await getExchangeSymbols(100)
    if (!symbolsToScan.length) {
      logger.error({ context: 'SCAN', err: 'No symbols found to scan' }, '❌ No symbols found to scan')
      return
    }

    const fearGreed = await getFearAndGreed() // NEW:
    logger.info({ context: 'SCAN', symbols: symbolsToScan.length }, '🔍 Scan cycle started')
    const scanStart = Date.now()

    const processedSymbols = new Set<string>()

    for (const symbol of symbolsToScan) {
      if (processedSymbols.has(symbol)) {
        logger.warn({ context: 'SCAN', symbol }, '⚠️ Duplicate symbol detected — skipping')
        continue
      }
      processedSymbols.add(symbol)
      const result = await scanCoin(symbol, fearGreed) // NEW:
      results.push(result)
      
      // Strict delay of 2.5s between each coin scan (CoinGecko free tier = max 24 req/min)
      await sleep(2500)
    }

    const signalsSent = results.filter(r => r.signalSent).length
    const totalMs     = Date.now() - scanStart
    const durationSec = Math.round(totalMs / 1000)

    logger.info(
      { context: 'SCAN', totalCoins: symbolsToScan.length, signalsSent, durationSec },
      `✅ Scan complete — ${signalsSent} signal(s) sent`,
    )

    // AUDIT FIX: Log rejection breakdown so we can monitor which filters are most active
    const rejectionBuckets = results
      .filter(r => !r.signalSent && r.rejection)
      .reduce((acc, r) => {
        const key = r.rejection!.split(':')[0].trim() // group by first part of reason
        acc[key] = (acc[key] || 0) + 1
        return acc
      }, {} as Record<string, number>)

    logger.info({ context: 'SCAN', rejectionBuckets }, '📊 Rejection breakdown this cycle')


    // Store scan summary in cache for dashboard
    await cache.set('scanner:lastRun', {
      timestamp:   new Date().toISOString(),
      scannedCoins:results.length,
      signalsSent,
      results:     results.map(r => ({
        symbol: r.symbol,
        sent:   r.signalSent,
        confidence: r.confidence,
      })),
    }, 600) // 10-min TTL — dashboard reads this
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
