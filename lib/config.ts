// lib/config.ts
// Single source of truth for all configuration values.
// All env vars are read here — never access process.env directly elsewhere.

import { z } from 'zod'

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN:          z.string().min(10),
  TELEGRAM_CHAT_ID:            z.string(),
  BINANCE_BASE_URL:            z.string().url().default('https://api.mexc.com'),
  COINGECKO_BASE_URL:          z.string().url().default('https://api.coingecko.com/api/v3'),
  // CRYPTOPANIC_API_KEY:      z.string().default(''), // REMOVED:
  LUNARCRUSH_API_KEY:          z.string().default(''),
  REDIS_URL:                   z.string().default('redis://localhost:6379'),
  DATABASE_URL:                z.string().default('file:./cryptosense.db'),
  MIN_CONFIDENCE:              z.coerce.number().min(0).max(100).default(62), // AUDIT FIX: 62 requires solid multi-pillar score
  COOLDOWN_HOURS:              z.coerce.number().default(4),
  SCAN_INTERVAL_MINUTES:       z.coerce.number().default(5),
  FUNDAMENTAL_INTERVAL_MINUTES:z.coerce.number().default(15),
  MAX_SL_PCT:                  z.coerce.number().default(8),
  MIN_RR_RATIO:                z.coerce.number().default(2),
})

function loadConfig() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error('❌ Invalid environment variables:', parsed.error.flatten())
    process.exit(1)
  }
  return parsed.data
}

export const config = loadConfig()

// ─── Watchlist ─────────────────────────────────────────────────────────────
// Tier A: large-cap barometers (used for market context check)
export const TIER_A_SYMBOLS = ['BTC/USDT', 'ETH/USDT'] as const

// Tier B: mid-cap momentum targets (where alerts actually fire)
export const TIER_B_SYMBOLS = [
  'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT',
  'DOT/USDT', 'LINK/USDT', 'MATIC/USDT', 'LTC/USDT', 'UNI/USDT',
  'ATOM/USDT', 'AAVE/USDT', 'NEAR/USDT', 'FTM/USDT', 'INJ/USDT',
  'SUI/USDT', 'SEI/USDT', 'TIA/USDT', 'ARB/USDT', 'OP/USDT',
] as const

export type Symbol = typeof TIER_B_SYMBOLS[number] | typeof TIER_A_SYMBOLS[number]

// ─── Scoring Weights (must sum to 100) ────────────────────────────────────
export const SCORE_WEIGHTS = {
  technical:   40,
  fundamental: 40,
  sentiment:   20,
} as const

// ─── Timeframes used for multi-timeframe confirmation ─────────────────────
// '4h' is the trend direction gate; '1h' is the entry timing gate
export const TIMEFRAMES = ['4h', '1h'] as const

// ─── Technical thresholds ─────────────────────────────────────────────────
export const TECHNICAL_THRESHOLDS = {
  rsi: { oversold: 30, overbought: 70 }, // AUDIT FIX: kembali ke standar RSI klasik — RSI 40 bukan oversold
  volumeSpike: 1.5,          // AUDIT FIX: butuh 50% di atas avg volume, bukan 20% (noise)
  volumeAvgPeriod: 20,       // candles for avg volume calc
  emaStack: [9, 21, 50],     // EMA periods to check for alignment
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
}

// ─── BTC circuit-breaker ──────────────────────────────────────────────────
// If BTC drops more than this % in 1h, all LONG alerts are suppressed
export const BTC_DROP_THRESHOLD_PCT = 2.5 // AUDIT FIX: dari 5% → 2.5% agar lebih protektif
// Partial circuit breaker: BTC drop > this → require higher confidence
export const BTC_WEAK_THRESHOLD_PCT = 1.5  // AUDIT FIX: jika BTC -1.5%/1h, butuh confidence >= 70
