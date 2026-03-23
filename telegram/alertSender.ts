// telegram/alertSender.ts
// Manages the Telegram bot instance. Sends alert messages and handles
// basic commands: /start, /status, /signal.

import TelegramBot from 'node-telegram-bot-api'
import { config }  from '@/lib/config'
import { 
  formatAlert, 
  formatDetailAnalysis, 
  formatWelcome, 
  formatSignalHistory, 
  formatRekap, 
  formatBantuan 
} from '@/telegram/formatter'
import { prisma }  from '@/lib/db'
import { logger }  from '@/utils/logger'
import type { Signal } from '@/services/signalEngine'
import { generateChart } from '@/services/legacy/chartBuilder'
import { getCoinMappingStats } from '@/utils/coinMapping' 
import fs from 'fs/promises'
import dayjs from 'dayjs'
import utc   from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'

dayjs.extend(utc)
dayjs.extend(timezone)

// @ts-ignore - JS modules
import { addActiveSignal, startMonitor } from '@/services/legacy/tracker'
// @ts-ignore - JS modules
import { initScheduler as startRecapScheduler } from '@/services/legacy/recap'

// ─── Bot singleton ────────────────────────────────────────────────────────

let botInstance: TelegramBot | null = null

export function getBot(): TelegramBot {
  if (!botInstance) {
    const shouldPoll = process.env.NODE_ENV !== 'production'
    botInstance = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: shouldPoll })
    registerCommands(botInstance)
    
    startMonitor(botInstance)
    startRecapScheduler(botInstance)
    
    logger.info({ context: 'BOOT' }, `Telegram bot started. Polling active: ${shouldPoll}`)
  }
  return botInstance
}

// ─── Send alert ───────────────────────────────────────────────────────────

export async function sendAlert(signal: Signal, chartBuffer?: Buffer): Promise<boolean> {
  const bot  = getBot()
  try {
    const text = formatAlert(signal)
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

    const dbSignal = await prisma.signal.create({
      data: {
        symbol:      signal.symbol,
        direction:   signal.direction,
        confidence:  signal.confidence,
        technical:   signal.technical,
        fundamental: signal.fundamental,
        openInterest: signal.openInterest,
        reasons:     JSON.stringify(signal.reasons),
        entryLow:    signal.riskPlan.entryLow,
        entryHigh:   signal.riskPlan.entryHigh,
        tp1:         signal.riskPlan.tp1,
        tp2:         signal.riskPlan.tp2,
        tp3:         signal.riskPlan.tp3,
        sl:          signal.riskPlan.stopLoss,
        rrRatio:     signal.riskPlan.rrRatio,
        oiValue:     signal.oiValue,
        oiChange:    signal.oiChange,
      }
    })

    let subs = await prisma.subscriber.findMany({ where: { isActive: true } })
    if (subs.length === 0) {
      subs = [{ chatId: config.TELEGRAM_CHAT_ID }] as any
    }

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
          await prisma.signalDelivery.create({
            data: {
              signalId: dbSignal.id,
              chatId: sub.chatId,
              messageId: sentMsgId
            }
          })

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
            signalId: dbSignal.id,
            confidence: signal.confidence,
            rrRatio: signal.riskPlan.rrRatio,
            currentCaption: text,
            sentAt: new Date().toISOString()
          })
        }
      } catch (err: any) {
        if (err.message.includes('Forbidden') || err.message.includes('blocked')) {
          await prisma.subscriber.update({ where: { chatId: sub.chatId }, data: { isActive: false } }).catch(() => {})
        }
      }
      await new Promise(r => setTimeout(r, 50))
    }
    return true
  } catch (err: any) {
    logger.error({ context: 'TELEGRAM', err: err.message }, '❌ Failed to send Telegram message')
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
      await prisma.subscriber.upsert({
        where: { chatId },
        update: { isActive: true, username },
        create: { chatId, username, isActive: true }
      })
      await bot.sendMessage(msg.chat.id, formatWelcome(), { parse_mode: 'HTML' })
      logger.info({ context: 'TELEGRAM', chatId }, '[telegram] welcome message sent')
    } catch (error: any) {
      logger.error({ context: 'TELEGRAM', err: error.message }, '❌ Failed to send /start response')
    }
  })

  // /signal
  bot.onText(/\/signal/, async (msg) => {
    try {
      const signals = await prisma.signal.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      if (!signals.length) {
        await bot.sendMessage(msg.chat.id, 'Belum ada sinyal tersimpan.')
        logger.info({ context: 'TELEGRAM', chatId: msg.chat.id }, '[telegram-command] /signal empty data')
        return
      }
      await bot.sendMessage(msg.chat.id, formatSignalHistory(signals), { parse_mode: 'HTML' })
      logger.info({ context: 'TELEGRAM', chatId: msg.chat.id, count: signals.length }, `[telegram-command] /signal loaded ${signals.length} rows`)
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /signal failed')
    }
  })

  // /rekap
  bot.onText(/\/rekap/, async (msg) => {
    try {
      const todayStart = dayjs().tz('Asia/Jakarta').startOf('day').toDate()
      const dailySignals = await prisma.signal.findMany({
        where: { createdAt: { gte: todayStart } }
      })
      const stats = {
        total:   dailySignals.length,
        active:  dailySignals.filter(s => !s.closed).length,
        tp:      dailySignals.filter(s => s.closed && s.closeReason === 'TP3').length,
        sl:      dailySignals.filter(s => s.closed && s.closeReason === 'SL').length,
        expired: dailySignals.filter(s => s.closed && s.closeReason === 'EXPIRED').length,
        accuracy: 0
      }
      const closedCount = stats.tp + stats.sl + stats.expired
      if (closedCount > 0) {
        stats.accuracy = (stats.tp / closedCount) * 100
      }
      await bot.sendMessage(msg.chat.id, formatRekap(stats), { parse_mode: 'HTML' })
      logger.info({ context: 'TELEGRAM', chatId: msg.chat.id, stats }, '[telegram-command] /rekap accuracy calculated')
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /rekap failed')
    }
  })

  // /bantuan
  bot.onText(/\/bantuan/, (msg) => {
    bot.sendMessage(msg.chat.id, formatBantuan(), { parse_mode: 'HTML' })
      .then(() => logger.info({ context: 'TELEGRAM', chatId: msg.chat.id }, '[telegram-command] /bantuan sent'))
      .catch((err: any) => logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /bantuan failed'))
  })

  // /status
  bot.onText(/\/status/, async (msg) => {
    try {
      const { getTicker } = await import('@/services/marketData')
      const btc = await getTicker('BTCUSDT')
      const activeSignals = await prisma.signal.count({ where: { status: 'ACTIVE' } })
      const btcChange = btc?.priceChangePercent ?? 0
      const text = [
        '<b>ORBIS | System Status</b>',
        '',
        `<b>BTC:</b> $${btc?.lastPrice?.toLocaleString() ?? 0} (${btcChange >= 0 ? '+' : ''}${btcChange.toFixed(2)}%)`,
        `<b>Active Signals:</b> ${activeSignals}`,
        '',
        '<i>Node: Railway | Latency: Optimized</i>'
      ].join('\n')
      bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' })
    } catch (err: any) {
      logger.error({ context: 'TELEGRAM', err: err.message }, '❌ /status failed')
    }
  })

  // Callback query handler
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) return
    const chatId = String(query.message.chat.id)
    if (query.data === 'detail_analisis') {
      try {
        const messageId = query.message.message_id
        const sigDelivery = await prisma.signalDelivery.findFirst({
          where: { messageId, chatId },
          include: { signal: true }
        })
        if (!sigDelivery || !sigDelivery.signal) {
          await bot.answerCallbackQuery(query.id, { text: '⚠️ Detail tidak ditemukan', show_alert: true })
          return
        }

        const detailText = formatDetailAnalysis(sigDelivery.signal as any)

        await bot.sendMessage(chatId, detailText, { parse_mode: 'HTML' })
        await bot.answerCallbackQuery(query.id)
      } catch (err: any) {
        logger.error({ context: 'TELEGRAM', err: err.message, stack: err.stack }, '❌ Detail callback failed')
        bot.answerCallbackQuery(query.id, { 
          text: '❌ Gagal memuat detail. Silakan coba lagi.', 
          show_alert: true 
        }).catch(() => {})
      }
    }
  })

  bot.on('polling_error', (err: any) => logger.error({ context: 'TELEGRAM', err: err.message }, '❌ Polling error'))
}
