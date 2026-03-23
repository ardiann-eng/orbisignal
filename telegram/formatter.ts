// telegram/formatter.ts
// Converts a Signal object to the exact Telegram message format from the blueprint.
// Uses HTML parse mode (more readable and simpler than MarkdownV2).

import dayjs from 'dayjs'
import type { Signal } from '@/services/signalEngine'

// ─── Dynamic price precision ──────────────────────────────────────────────
// FIX: formatPrice replaces all hardcoded toFixed(2) calls

export function formatPrice(price: number): string {
  if (price >= 1000)        return price.toFixed(2)
  if (price >= 1)           return price.toFixed(4)
  if (price >= 0.01)        return price.toFixed(5)
  if (price >= 0.001)       return price.toFixed(6)
  if (price >= 0.0001)      return price.toFixed(7)
  if (price >= 0.00001)     return price.toFixed(8)
  return price.toExponential(4)
}

// ─── Market mood ─────────────────────────────────────────────────────────

function getMarketMoodEmoji(label: string): string {
  const map: Record<string, string> = {
    'Extreme Fear': '😱 Extreme Fear',
    'Fear':         '😨 Fear',
    'Neutral':      '😐 Neutral',
    'Greed':        '🤑 Greed',
    'Extreme Greed':'🚀 Extreme Greed',
  }
  return map[label] || '😐 Neutral'
}

// ─── Main formatter (compact version) ────────────────────────────────────
// FIX: Switched to HTML parse mode — cleaner, no MarkdownV2 escaping hell.
// Reasons and score breakdown moved to inline button "📋 Detail Analisis".

export function formatAlert(signal: Signal): string {
  const { symbol, direction, confidence, riskPlan, currentPrice, fearGreedLabel, fearGreedVal } = signal
  const { entryLow, entryHigh, tp1, tp2, tp3, stopLoss, rrRatio } = riskPlan
  const p = formatPrice

  const dir   = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  const mood  = getMarketMoodEmoji(fearGreedLabel)
  const coin  = symbol.replace('/USDT', '')
  const time  = dayjs(signal.generatedAt).format('HH:mm') + ' WIB'

  return [
    `${dir} — <b>$${coin}/USDT</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💰 ${p(currentPrice)}  |  🧠 <b>${confidence}/100</b>`,
    `${mood} (${fearGreedVal})`,
    ``,
    `🎯 <b>Entry</b>  : ${p(entryLow)} – ${p(entryHigh)}`,
    `✅ <b>TP</b>     : ${p(tp1)} / ${p(tp2)} / ${p(tp3)}`,
    `🛡 <b>SL</b>     : ${p(stopLoss)}`,
    `⚖️ <b>R:R</b>    : 1:${rrRatio}`,
    ``,
    `📊 T:${signal.techScore} | F:${signal.fundScore} | S:${signal.sentScore}`,
    `⏰ ${time}`,
    `━━━━━━━━━━━━━━━━━━`,
    `⚠️ Bukan financial advice. DYOR.`,
  ].join('\n')
}

// ─── Detail callback formatter ────────────────────────────────────────────
// FIX: Used when user clicks "📋 Detail Analisis" inline button

export function formatDetailAnalysis(signal: Signal): string {
  const reasonLines = signal.reasons.map(r => `• ${r}`).join('\n')

  return [
    `<b>📋 Alasan Sinyal — ${signal.symbol}</b>`,
    reasonLines || '• (tidak ada detail)',
    ``,
    `<b>📊 Score Breakdown</b>`,
    `Teknikal    : ${signal.techScore}/40`,
    `Fundamental : ${signal.fundScore}/40`,
    `Sentiment   : ${signal.sentScore}/20`,
  ].join('\n')
}

// ─── Market summary formatter (for /status command) ───────────────────────

export function formatMarketSummary(params: {
  fearGreed:     number
  fearGreedLabel: string
  btcPrice:      number
  btcChange24h:  number
  activeSignals: number
  scannedCoins:  number
}): string {
  const { fearGreed, fearGreedLabel, btcPrice, btcChange24h, activeSignals, scannedCoins } = params
  const btcSign   = btcChange24h >= 0 ? '+' : ''
  const moodEmoji = fearGreed < 30 ? '😨' : fearGreed < 50 ? '😟' : fearGreed < 70 ? '😐' : '🤑'

  return [
    `📡 <b>CryptoSense Bot — Status</b>`,
    ``,
    `₿ BTC: $${formatPrice(btcPrice)} (${btcSign}${btcChange24h.toFixed(2)}%)`,
    `${moodEmoji} Fear &amp; Greed: ${fearGreed} (${fearGreedLabel})`,
    `🔍 Coins Dipantau: ${scannedCoins}`,
    `🟢 Active Signals: ${activeSignals}`,
  ].join('\n')
}
