-- CreateTable
CREATE TABLE "Signal" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "technical" INTEGER NOT NULL,
    "fundamental" INTEGER NOT NULL,
    "sentiment" INTEGER NOT NULL,
    "reasons" TEXT NOT NULL,
    "entryLow" REAL NOT NULL,
    "entryHigh" REAL NOT NULL,
    "tp1" REAL NOT NULL,
    "tp2" REAL NOT NULL,
    "tp3" REAL NOT NULL,
    "sl" REAL NOT NULL,
    "rrRatio" REAL NOT NULL,
    "fearGreed" INTEGER NOT NULL,
    "marketMood" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "tp1Hit" BOOLEAN NOT NULL DEFAULT false,
    "tp2Hit" BOOLEAN NOT NULL DEFAULT false,
    "tp3Hit" BOOLEAN NOT NULL DEFAULT false,
    "slHit" BOOLEAN NOT NULL DEFAULT false,
    "tp1Pct" REAL NOT NULL DEFAULT 0,
    "tp2Pct" REAL NOT NULL DEFAULT 0,
    "tp3Pct" REAL NOT NULL DEFAULT 0,
    "slPct" REAL NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closeReason" TEXT,
    "closedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SignalDelivery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "signalId" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    CONSTRAINT "SignalDelivery_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openPrice" REAL NOT NULL,
    "highPrice" REAL NOT NULL,
    "lowPrice" REAL NOT NULL,
    "closePrice" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "rsi" REAL,
    "macd" REAL,
    "macdSignal" REAL,
    "ema9" REAL,
    "ema21" REAL,
    "ema50" REAL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FearGreedSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "value" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_chatId_key" ON "Subscriber"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "SignalDelivery_chatId_messageId_key" ON "SignalDelivery"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "MarketSnapshot_symbol_timeframe_capturedAt_idx" ON "MarketSnapshot"("symbol", "timeframe", "capturedAt");
