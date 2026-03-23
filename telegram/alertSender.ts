// telegram/alertSender.ts
// Manages the Telegram bot instance. Sends alert messages and handles
// basic commands: /start, /status, /signals.

import TelegramBot from 'node-telegram-bot-api'
import { config }  from '@/lib/config'
import { formatAlert, formatDetailAnalysis } from '@/telegram/formatter' // FIX:
import { prisma }  from '@/lib/db'
import { logger }  from '@/utils/logger'
import type { Signal } from '@/services/signalEngine'
import { generateChart } from '@/services/legacy/chartBuilder'
import { getCoinMappingStats } from '@/utils/coinMapping' // FIX: for /coinstats command
import fs from 'fs/promises'

// @ts-ignore - JS modules
import { addActiveSignal, startMonitor } from '@/services/legacy/tracker'
// @ts-ignore - JS modules
import { initScheduler as startRecapScheduler } from '@/services/legacy/recap'

// ─── Bot singleton ────────────────────────────────────────────────────────

// ─── Bot singleton ────────────────────────────────────────────────────────

let botInstance: TelegramBot | null = null

export function getBot(): TelegramBot {
  if (!botInstance) {
    // Disable polling in production completely to prevent webhook conflicts
    const shouldPoll = process.env.NODE_ENV !== 'production'
    
    // Debug token
    console.log("Using Token:", config.TELEGRAM_BOT_TOKEN?.slice(0, 5) + "...")
    
    botInstance = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: shouldPoll })
    registerCommands(botInstance)
    
    // FIX: Start tracker and recap cron jobs
    startMonitor(botInstance)
    startRecapScheduler(botInstance)
    
    logger.info({ context: 'BOOT' }, `Telegram bot started. Polling active: ${shouldPoll}`)
  }
  return botInstance
}

// ─── Send alert ───────────────────────────────────────────────────────────

// UPDATE: `chartBuffer` optional so scanner can render the annotated chart locally.
export async function sendAlert(signal: Signal, chartBuffer?: Buffer): Promise<boolean> {
  const bot  = getBot()
  try {
    const text = formatAlert(signal)

    // Attempt to generate the chart image (scanner may provide a pre-rendered buffer).
    const resolvedChartBuffer = chartBuffer ?? await generateChart(signal)
    const options: TelegramBot.SendMessageOptions = {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '📊 TradingView',
            url:  `https://www.tradingview.com/chart/?symbol=${signal.symbol.replace('/', '')}`,
          },
          {
            text:          '📋 Detail Analisis',
            callback_data: `detail_analisis`,
          },
        ]],
      },
    }

    // FIX: Create main signal record FIRST
    const dbSignal = await prisma.signal.create({
      data: {
        symbol:      signal.symbol,
        direction:   signal.direction,
        confidence:  signal.confidence,
        technical:   signal.techScore,
        fundamental: signal.fundScore,
        sentiment:   signal.sentScore,
        reasons:     JSON.stringify(signal.reasons),
        entryLow:    signal.riskPlan.entryLow,
        entryHigh:   signal.riskPlan.entryHigh,
        tp1:         signal.riskPlan.tp1,
        tp2:         signal.riskPlan.tp2,
        tp3:         signal.riskPlan.tp3,
        sl:          signal.riskPlan.stopLoss,
        rrRatio:     signal.riskPlan.rrRatio,
        fearGreed:   signal.fearGreedVal,
        marketMood:  signal.fearGreedLabel,
      }
    })

    // FIX: Fetch all active subscribers
    let subs = await prisma.subscriber.findMany({ where: { isActive: true } })
    if (subs.length === 0) {
      // Fallback if nobody pressed /start yet
      subs = [{ chatId: config.TELEGRAM_CHAT_ID }] as any
    }

    logger.info({ context: 'TELEGRAM', count: subs.length, symbol: signal.symbol }, '📤 Broadcasting signal messages...')

    // FIX: Loop through subscribers to mass broadcast
    for (const sub of subs) {
      try {
        let sentMsgId: number | undefined

        if (resolvedChartBuffer) {
          const sentMsg = await bot.sendPhoto(sub.chatId, resolvedChartBuffer, {
            caption: text,
            ...options
          }, { filename: 'chart.png', contentType: 'image/png' })
          sentMsgId = sentMsg.message_id
        } else {
          const sentMsg = await bot.sendMessage(sub.chatId, text, options)
          sentMsgId = sentMsg.message_id
        }

        if (sentMsgId) {
          // Save delivery record
          await prisma.signalDelivery.create({
            data: {
              signalId: dbSignal.id,
              chatId: sub.chatId,
              messageId: sentMsgId
            }
          })

          // FIX: Add each specific message back to live tracker so it can be edited!
          await addActiveSignal({
            symbol: signal.symbol,
            direction: signal.direction,
            entry: (signal.riskPlan.entryLow + signal.riskPlan.entryHigh) / 2,
            tp1: signal.riskPlan.tp1,
            tp2: signal.riskPlan.tp2,
            tp3: signal.riskPlan.tp3,
            sl: signal.riskPlan.stopLoss,
            chatId: sub.chatId,
            messageId: sentMsgId,
            signalId: dbSignal.id, // AUDIT FIX: Track primary key for DB updates
            confidence: signal.confidence,
            rrRatio: signal.riskPlan.rrRatio,
            currentCaption: text
          })
        }
      } catch (err: any) {
        if (err.message.includes('Forbidden') || err.message.includes('blocked')) {
          await prisma.subscriber.update({ where: { chatId: sub.chatId }, data: { isActive: false } }).catch(() => {})
        }
        logger.error({ context: 'TELEGRAM', err: err.message, chatId: sub.chatId }, '❌ Failed to send Telegram message to sub')
      }

      // Respect Telegram 30 msg/s broadcast limit
      await new Promise(r => setTimeout(r, 50))
    }

    return true
  } catch (err: any) {
    logger.error({ context: 'TELEGRAM', err: err.message, chatId: config.TELEGRAM_CHAT_ID }, '❌ Failed to send Telegram message')
    return false
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────

function registerCommands(bot: TelegramBot) {
  // /start
  bot.onText(/\/start/, async (msg) => {
    try {
      const chatId = String(msg.chat.id)
      const username = msg.from?.username || msg.chat.username

      // FIX: Auto-enroll user into Signal broadcaster
      await prisma.subscriber.upsert({
        where: { chatId },
        update: { isActive: true, username },
        create: { chatId, username, isActive: true }
      })

      await bot.sendMessage(
        msg.chat.id,
`◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈
         O R B I S
  MARKET INTELLIGENCE SYSTEM
◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈

Pasar bergerak setiap detik.
Orbis sudah tahu lebih dulu.

🔭 Scanner    : LIVE
🧠 Signal AI  : ACTIVE
🛡️ Risk Guard : ARMED
👥 Broadcast  : SUBSCRIBED ✅

/signal  — Sinyal terbaru
/rekap   — Akurasi hari ini
/bantuan — Panduan

◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈
Presisi bukan kebetulan. Ini Orbis.
⚠️ Bukan financial advice. DYOR.`,
      )
    } catch (error: any) {
      logger.error({ context: 'TELEGRAM', err: error.message }, '❌ Failed to send /start response')
    }
  })

  // /status
  bot.onText(/\/status/, async (msg) => {
    try {
      // Lazy import to avoid circular deps
      const { getTicker } = await import('@/services/marketData')
      const btc           = await getTicker('BTCUSDT')
      const { cache }     = await import('@/utils/cache')
      const fg            = await cache.get<{ value: number; value_classification: string }>('feargreed:latest')

      const activeSignals = await prisma.signal.count({ where: { status: 'ACTIVE' } })
      const btcChange = btc?.priceChangePercent ?? 0

      const text = [
        '<b>ORBIS | System Status</b>',
        '',
        `<b>BTC:</b> $${btc?.lastPrice?.toLocaleString() ?? 0} (${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}%)`,
        `<b>Market Mood:</b> ${fg?.value ?? 50} (${fg?.value_classification ?? 'Neutral'})`,
        `<b>Active Signals:</b> ${activeSignals}`,
        `<b>Coins Monitored:</b> 100`,
        '',
        '<i>Current Node: Railway US-West | Data Source: MEXC API | Latency: Optimized</i>'
      ].join('\n')

      bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }).catch((err: any) => {
        logger.error({ context: 'TELEGRAM', err: err.message, chatId: msg.chat.id }, '❌ Failed to send /status response')
      })
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /status failed')
      bot.sendMessage(msg.chat.id, '⚠️ System Error: Unable to retrieve status.').catch((e: any) => logger.error({ context: 'TELEGRAM', err: e.message }, '❌ Failed to send Telegram message'))
    }
  })

  // /signals
  bot.onText(/\/signals/, async (msg) => {
    try {
      const signals = await prisma.signal.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
      })

      if (!signals.length) {
        bot.sendMessage(msg.chat.id, '📭 No active signals in the database.').catch(e => console.error(e))
        return
      }

      const lines = signals.map((s: any, i: number) => {
        const dir   = s.direction === 'LONG' ? '🟢' : '🔴'
        const date  = new Date(s.createdAt).toLocaleDateString('en-US')
        return `${i + 1}. ${dir} <b>${s.symbol}</b> — ${s.confidence}/100 — ${date} — <i>${s.status}</i>`
      })

      const text = `<b>ORBIS | Last 5 Signals:</b>\n\n${lines.join('\n')}`
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' }).catch((e: any) => logger.error({ context: 'TELEGRAM', err: e.message }, '❌ Failed to send Telegram message'))
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /signals failed')
    }
  })

  // /bantuan
  bot.onText(/\/bantuan/, (msg) => {
    const text = `◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈
         O R B I S
       PANDUAN LENGKAP
◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈

Selamat datang di Orbis.
Berikut yang bisa kamu lakukan:

📡 <b>SINYAL TRADING</b>
/signal — Minta sinyal terbaru
Orbis akan menganalisis pasar dan
mengirim sinyal dengan entry zone,
TP, SL, dan confidence score.

📊 <b>PERFORMA BOT</b>
/rekap — Akurasi sinyal hari ini
Lihat berapa sinyal yang hit TP,
hit SL, dan win rate keseluruhan.

◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈

💡 <b>CARA MEMBACA SINYAL</b>

🟢 LONG  = prediksi harga naik
🔴 SHORT = prediksi harga turun

🎯 Entry Zone  = area ideal masuk posisi
✅ TP1/2/3     = target take profit
🛡️ Stop Loss   = batas kerugian maksimal
⚖️ R:R Ratio   = rasio risk vs reward
🧠 Confidence  = tingkat keyakinan AI
                 (semakin tinggi = semakin kuat)

◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈

⚡ <b>TIPS MENGGUNAKAN ORBIS</b>
- Selalu perhatikan confidence score
- Gunakan stop loss tanpa pengecualian
- Jangan masuk posisi di luar entry zone
- Kelola ukuran posisi dengan bijak

◈ ━━━━━━━━━━━━━━━━━━━━━━━━ ◈
Presisi bukan kebetulan. Ini Orbis.
⚠️ Bukan financial advice. DYOR.`

    bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📡 Signal', callback_data: 'bantuan:signal' },
            { text: '📊 Rekap Hari Ini', callback_data: 'bantuan:rekap' },
          ],
          [
            { text: '⚠️ DYOR — Bukan Financial Advice', callback_data: 'bantuan:dyor' },
          ],
        ],
      },
    }).catch((err: any) => {
      logger.error({ context: 'TELEGRAM', err: err.message, chatId: msg.chat.id }, '❌ Failed to send /bantuan response')
    })
  })

  // /coinstats
  bot.onText(/\/coinstats/, async (msg) => {
    try {
      const stats = await getCoinMappingStats()
      await bot.sendMessage(
        msg.chat.id,
        `🗺️ <b>Coin Mapping Stats</b>\n` +
        `Total mapped : ${stats.total} coins\n` +
        `Cache age    : ${stats.ageHours} jam\n` +
        `Refresh      : tiap 24 jam otomatis`,
        { parse_mode: 'HTML' },
      )
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /coinstats failed')
    }
  })

  // Callback query handler (inline button presses)
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return
    const chatId = query.message.chat.id

    if (query.data === 'detail_analisis' || query.data.startsWith('detail_')) {
      try {
        const messageId = query.message.message_id

        // Prevent NaN Prisma crashes from extremely old buttons
        if (!messageId) return

        // FIX: Baca dari database SignalDelivery terlebih dahulu, baru load Signal utamanya
        const sigDelivery = await prisma.signalDelivery.findFirst({
          where: { messageId },
          include: { signal: true }
        })

        if (!sigDelivery || !sigDelivery.signal) {
          await bot.answerCallbackQuery(query.id, {
            text: '⚠️ Detail tidak ditemukan',
            show_alert: true
          })
          return
        }

        const sigRecord = sigDelivery.signal
        const reasons = JSON.parse(sigRecord.reasons) as string[]

        // FIX: Format pesan detail HTML persis seperti instruksi
        const detailText = `
📋 <b>DETAIL ANALISIS</b>
${sigRecord.symbol} ${sigRecord.direction}

<b>📊 Alasan Sinyal:</b>
${reasons.map(r => `• ${r}`).join('\n')}

<b>📈 Score Breakdown:</b>
Teknikal    : ${sigRecord.technical}/40
Fundamental : ${sigRecord.fundamental}/40
Sentiment   : ${sigRecord.sentiment}/20
Total       : ${sigRecord.confidence}/100

<b>😱 Market Mood:</b>
${sigRecord.marketMood} (Fear & Greed: ${sigRecord.fearGreed})
        `.trim()

        // FIX: Kirim sebagai pesan baru dan acknowledge
        await bot.sendMessage(chatId, detailText, {
          parse_mode: 'HTML'
        })

        await bot.answerCallbackQuery(query.id) // dismiss loading ring

      } catch (err: any) {
        logger.error({ context: 'TELEGRAM', err: err.message }, '❌ detail callback failed')
        bot.answerCallbackQuery(query.id, { text: '❌ Terjadi error, coba lagi', show_alert: true }).catch(() => {})
      }
    }
  })

  bot.on('polling_error', (err: any) => logger.error({ context: 'TELEGRAM', err: err.message }, '❌ Telegram polling error'))
}
