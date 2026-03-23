# 📡 CryptoSense Bot

Bot Telegram analisis crypto otomatis yang menggabungkan analisis teknikal, fundamental, dan sentiment untuk menghasilkan sinyal trading berkualitas tinggi.

---

## Arsitektur

```
Market Data (Binance + CoinGecko)
        ↓
  Data Normalizer & Redis Cache
        ↓
  ┌─────────────┬──────────────┬────────────┐
  │  Technical  │ Fundamental  │ Sentiment  │
  │  Engine     │ Engine       │ Engine     │
  │  (40 pts)   │ (40 pts)     │ (20 pts)   │
  └──────┬──────┴──────┬───────┴──────┬─────┘
         └─────────────┼──────────────┘
                       ↓
              Signal Scoring Engine
              (confidence 0–100)
                       ↓
              Filter Pipeline
              · Min confidence ≥ 65
              · Multi-pilar gate (2/3 harus aktif)
              · Cooldown 4 jam per coin
              · BTC circuit-breaker
              · R:R validation (min 1:2)
                       ↓
         ┌─────────────┴─────────────┐
         │    Risk Manager           │
         │  · Entry zone (ATR-based) │
         │  · TP1 / TP2 / TP3 (Fib) │
         │  · Stop Loss              │
         └─────────────┬─────────────┘
                       ↓
         Telegram Alert + Dashboard DB
```

---

## Struktur Project

```
cryptosense/
├── app/
│   ├── api/
│   │   ├── scanner/route.ts      ← trigger/status scanner
│   │   ├── signals/route.ts      ← signal history
│   │   ├── watchlist/route.ts    ← live prices
│   │   └── performance/route.ts  ← win rate stats
│   ├── dashboard/page.tsx        ← monitoring UI
│   ├── layout.tsx
│   └── page.tsx
├── analysis/
│   ├── technical.ts              ← RSI, MACD, EMA, volume, S/R
│   ├── fundamental.ts            ← news, whale activity
│   └── sentiment.ts              ← F&G, dominance, funding rate
├── services/
│   ├── marketData.ts             ← Binance + CoinGecko adapters
│   ├── riskManager.ts            ← ATR entry, Fib TP, SL calc
│   ├── signalEngine.ts           ← combiner + filter pipeline
│   ├── signalTracker.ts          ← TP/SL hit detector
│   └── scanner.ts                ← orchestrator + cron scheduler
├── telegram/
│   ├── formatter.ts              ← Telegram MarkdownV2 templates
│   └── alertSender.ts            ← bot instance + command handlers
├── utils/
│   ├── cache.ts                  ← Redis wrapper + cooldown helpers
│   ├── logger.ts                 ← pino structured logger
│   └── performance.ts            ← win rate calculator
├── lib/
│   ├── config.ts                 ← all env vars + constants
│   └── db.ts                     ← Prisma client singleton
├── prisma/
│   └── schema.prisma             ← Signal, MarketSnapshot, FearGreed
├── styles/globals.css
├── .env.example
├── next.config.js
├── tsconfig.json
└── package.json
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone <repo>
cd cryptosense
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
# Edit .env dan isi:
# - TELEGRAM_BOT_TOKEN (dari @BotFather)
# - TELEGRAM_CHAT_ID (channel atau group ID)
# - CRYPTOPANIC_API_KEY (opsional, tapi direkomendasikan)
```

### 3. Setup Database

```bash
npm run db:push
```

### 4. Jalankan Scanner (standalone)

```bash
npm run scanner
```

### 5. Jalankan Dashboard (Next.js)

```bash
npm run dev
# Buka http://localhost:3000/dashboard
```

---

## Konfigurasi Penting (`.env`)

| Variable | Default | Keterangan |
|---|---|---|
| `MIN_CONFIDENCE` | 65 | Minimum score untuk kirim alert |
| `COOLDOWN_HOURS` | 4 | Jeda antar alert per coin |
| `SCAN_INTERVAL_MINUTES` | 5 | Frekuensi scan teknikal |
| `MAX_SL_PCT` | 8 | Maksimum SL % dari entry |
| `MIN_RR_RATIO` | 2 | Minimum Risk:Reward ratio |

---

## Telegram Commands

| Command | Fungsi |
|---|---|
| `/start` | Salam pembuka + daftar perintah |
| `/status` | Market overview saat ini (BTC, F&G) |
| `/signals` | 5 signal terakhir |
| `/help` | Panduan membaca alert |

---

## Status Implementasi

### ✅ Sudah Konkret (production-ready logic)
- Technical engine: RSI, MACD, EMA stack, volume spike, S/R detection
- Multi-timeframe confirmation (4H gate + 1H timing)
- Signal scoring: 40/40/20 weighted system
- Filter pipeline: 4 filter berlapis termasuk BTC circuit-breaker
- Risk manager: ATR-based entry zone, Fibonacci TP1/2/3, dynamic SL
- Telegram formatter: MarkdownV2, inline keyboard, command handlers
- Signal persistence: Prisma + SQLite → mudah migrate ke PostgreSQL
- Cooldown system: Redis-backed dengan in-memory fallback
- Signal tracker: TP/SL hit detection untuk performa tracking
- Dashboard: signal history table dengan auto-refresh

### ⚠️ Partial / Placeholder
- **Fundamental engine**: News scoring via CryptoPanic ✅, Whale tracker butuh setup listener terpisah
- **Sentiment engine**: F&G ✅, Funding rate ✅, Social mention (LunarCrush) = placeholder
- **Volume anomaly**: Coverage by technical engine, on-chain version butuh Glassnode paid API

### 🔜 Next Steps untuk Production
1. Deploy ke Railway/Render (gratis tier untuk mulai)
2. Setup Redis managed (Railway Redis atau Upstash free tier)
3. Ganti SQLite ke PostgreSQL untuk production
4. Tambah backtesting script menggunakan historical data
5. Implementasi LunarCrush social volume
6. Tambah webhook-based whale tracker (Whale Alert Telegram channel → forward ke bot)

---

## Tools yang Digunakan (semua free tier)

| Service | Untuk | Free Limit |
|---|---|---|
| Binance Public API | OHLCV, ticker | Tidak butuh API key |
| CoinGecko | Metadata, dominance | 30 req/menit |
| CryptoPanic | News + sentiment | Free tier tersedia |
| alternative.me | Fear & Greed | Gratis sepenuhnya |
| Binance Futures | Funding rate | Tidak butuh API key |
| Railway | Hosting | 500 jam/bulan gratis |

---

## Disclaimer

Bot ini adalah alat bantu analisis, **bukan** financial advisor. Selalu lakukan riset mandiri (DYOR) dan gunakan position sizing yang sesuai dengan risk tolerance Anda.
