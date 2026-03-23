-- CreateTable
CREATE TABLE "Signal" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "technical" INTEGER NOT NULL,
    "fundamental" INTEGER NOT NULL,
    "sentiment" INTEGER NOT NULL,
    "reasons" TEXT NOT NULL,
    "entryLow" DOUBLE PRECISION NOT NULL,
    "entryHigh" DOUBLE PRECISION NOT NULL,
    "tp1" DOUBLE PRECISION NOT NULL,
    "tp2" DOUBLE PRECISION NOT NULL,
    "tp3" DOUBLE PRECISION NOT NULL,
    "sl" DOUBLE PRECISION NOT NULL,
    "rrRatio" DOUBLE PRECISION NOT NULL,
    "fearGreed" INTEGER NOT NULL,
    "marketMood" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "tp1Hit" BOOLEAN NOT NULL DEFAULT false,
    "tp2Hit" BOOLEAN NOT NULL DEFAULT false,
    "tp3Hit" BOOLEAN NOT NULL DEFAULT false,
    "slHit" BOOLEAN NOT NULL DEFAULT false,
    "tp1Pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tp2Pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tp3Pct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "slPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closeReason" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscriber" (
    "id" SERIAL NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignalDelivery" (
    "id" SERIAL NOT NULL,
    "signalId" INTEGER NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,

    CONSTRAINT "SignalDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "openPrice" DOUBLE PRECISION NOT NULL,
    "highPrice" DOUBLE PRECISION NOT NULL,
    "lowPrice" DOUBLE PRECISION NOT NULL,
    "closePrice" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,
    "rsi" DOUBLE PRECISION,
    "macd" DOUBLE PRECISION,
    "macdSignal" DOUBLE PRECISION,
    "ema9" DOUBLE PRECISION,
    "ema21" DOUBLE PRECISION,
    "ema50" DOUBLE PRECISION,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FearGreedSnapshot" (
    "id" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FearGreedSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscriber_chatId_key" ON "Subscriber"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "SignalDelivery_chatId_messageId_key" ON "SignalDelivery"("chatId", "messageId");

-- CreateIndex
CREATE INDEX "MarketSnapshot_symbol_timeframe_capturedAt_idx" ON "MarketSnapshot"("symbol", "timeframe", "capturedAt");

-- AddForeignKey
ALTER TABLE "SignalDelivery" ADD CONSTRAINT "SignalDelivery_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
