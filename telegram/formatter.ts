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
  const { symbol, direction, confidence, riskPlan, currentPrice, oiValue, oiChange, technical, fundamental, openInterest } = signal
  const { entryLow, entryHigh, tp1, tp2, tp3, stopLoss, rrRatio } = riskPlan
  const p = formatPrice

  const dir   = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT'
  const coin  = symbol.replace('/USDT', '')
  const time  = dayjs(signal.generatedAt).format('HH:mm') + ' WIB'
  
  const oiSign = oiChange >= 0 ? '+' : ''
  const oiLabel = `📈 OI: ${oiSign}${oiChange.toFixed(2)}%`

  return [
    `${dir} — <b>$${coin}/USDT</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `💰 ${p(currentPrice)}  |  🧠 <b>${confidence}/100</b>`,
    `${oiLabel}`,
    ``,
    `🎯 <b>Entry</b>  : ${p(entryLow)} – ${p(entryHigh)}`,
    `✅ <b>TP</b>     : ${p(tp1)} / ${p(tp2)} / ${p(tp3)}`,
    `🛡 <b>SL</b>     : ${p(stopLoss)}`,
    `⚖️ <b>R:R</b>    : 1:${rrRatio}`,
    ``,
    signal.patternName !== 'None' ? `🤖 <b>AI Pattern</b>: ${signal.patternName}\n📝 <b>Reason</b>: ${signal.patternReason}\n` : '',
    `📊 T:${technical} | F:${fundamental} | OI:${openInterest}`,
    `⏰ ${time}`,
    `━━━━━━━━━━━━━━━━━━`,
    `⚠️ Bukan financial advice. DYOR.`,
  ].join('\n')
}

// ─── Detail callback formatter ────────────────────────────────────────────
// FIX: Used when user clicks "📋 Detail Analisis" inline button

export function formatDetailAnalysis(signal: Signal): string {
  // Extract entry quality if it's the first reason (our convention)
  const firstReason = signal.reasons[0] || ''
  const hasQuality = firstReason.startsWith('Entry Quality:')
  const displayReasons = hasQuality ? signal.reasons.slice(1) : signal.reasons
  const qualityInfo = hasQuality ? firstReason : 'Entry Quality: N/A'

  const reasonLines = displayReasons.map(r => `• ${r}`).join('\n')

  return [
    `<b>📋 Alasan Sinyal — ${signal.symbol}</b>`,
    reasonLines || '• (tidak ada detail)',
    ``,
    `<b>📊 ${qualityInfo}</b>`,
    ``,
    `<b>📊 Score Breakdown</b>`,
    `Teknikal    : ${signal.technical}/40`,
    `Fundamental : ${signal.fundamental}/40`,
    `Open Interest: ${signal.openInterest}/20`,
    `Total       : ${signal.confidence}/100`,
  ].join('\n')
}

// ─── Market summary formatter (for /status command) ───────────────────────

export function formatMarketSummary(params: {
  btcPrice:      number
  btcChange24h:  number
  activeSignals: number
  scannedCoins:  number
  oiStatus?:     string
}): string {
  const { btcPrice, btcChange24h, activeSignals, scannedCoins, oiStatus } = params
  const btcSign   = btcChange24h >= 0 ? '+' : ''

  return [
    `📡 <b>CryptoSense Bot — Status</b>`,
    ``,
    `₿ BTC: $${formatPrice(btcPrice)} (${btcSign}${btcChange24h.toFixed(2)}%)`,
    `🔭 OI Analysis: ${oiStatus || 'Active'}`,
    `🔍 Coins Dipantau: ${scannedCoins}`,
    `🟢 Active Signals: ${activeSignals}`,
  ].join('\n')
}

// ─── Professional Welcome Formatter ────────────────────────────────────

export function formatWelcome(): string {
  return [
    `<b>ORBIS // Market Intelligence</b>`,
    ``,
    `Scanner aktif dan market sedang dipantau.`,
    ``,
    `<b>Status</b>`,
    `<code>Scanner     Online</code>`,
    `<code>Signal      Active</code>`,
    `<code>Risk Guard  Ready</code>`,
    ``,
    `/signal   Sinyal terbaru`,
    `/rekap    Akurasi hari ini`,
    `/bantuan  Panduan`,
    ``,
    `<i>Not financial advice. Manage your risk.</i>`,
  ].join('\n')
}

// ─── Signal History Formatter ──────────────────────────────────────────

export function formatSignalHistory(signals: any[]): string {
  const lines = signals.map((s, i) => {
    const dir = s.direction === 'LONG' ? '🟢' : '🔴'
    const time = dayjs(s.createdAt).format('DD/MM HH:mm')
    const entry = (s.entryLow + s.entryHigh) / 2
    
    return [
      `<b>${i + 1}. ${dir} ${s.symbol}</b>`,
      `<code>${s.confidence}% | Entry: ${formatPrice(entry)} | ${time}</code>`,
      `Stat: <i>${s.status}</i>`,
      ``
    ].join('\n')
  })

  return `<b>ORBIS // Last ${signals.length} Signals</b>\n\n${lines.join('\n')}`
}

// ─── Performance Rekap Formatter ──────────────────────────────────────

export function formatRekap(stats: {
  total: number
  tp: number
  sl: number
  expired: number
  active: number
  accuracy: number
}): string {
  return [
    `📊 <b>Rekap Hari Ini</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `<code>Total Signal: ${stats.total}</code>`,
    `<code>TP Hit      : ${stats.tp}</code>`,
    `<code>SL Hit      : ${stats.sl}</code>`,
    `<code>Expired     : ${stats.expired}</code>`,
    `<code>Active      : ${stats.active}</code>`,
    `━━━━━━━━━━━━━━━━━━`,
    `<b>Accuracy: ${stats.accuracy.toFixed(1)}%</b>`,
  ].join('\n')
}

// ─── Clean Bantuan Formatter ──────────────────────────────────────────

export function formatBantuan(): string {
  return [
    `<b>ORBIS // Panduan Penggunaan</b>`,
    ``,
    `<b>Command Utama:</b>`,
    `/signal   — Rekap sinyal terbaru`,
    `Menampilkan 5-10 sinyal terakhir beserta status TP/SL.`,
    ``,
    `/rekap    — Akurasi performa hari ini`,
    `Statistik winrate berdasarkan sinyal yang sudah closed hari ini.`,
    ``,
    `/bantuan  — Panduan lengkap ini`,
    ``,
    `<b>Keterangan Status:</b>`,
    `• ACTIVE: Sinyal sedang berjalan`,
    `• COMPLETED: Target TP3 tercapai`,
    `• CLOSED: Terhenti di Stop Loss atau Expired (48h)`,
    ``,
    `<i>Presisi bukan kebetulan. Ini Orbis.</i>`,
  ].join('\n')
}
