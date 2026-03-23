const ccxt = require('ccxt');
const { loadActiveSignals, saveActiveSignals, appendToHistory } = require('./storage');
// AUDIT FIX: Use Prisma to track global signal state
const { prisma } = require('../../lib/db');

const okx = new ccxt.okx({ enableRateLimit: true });
const bybit = new ccxt.bitget({ enableRateLimit: true });
const { logger } = require('../../utils/logger');

let botInstance = null;
let monitorStarted = false;
let priceFetcher = null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getCurrentPrice(symbol) {
  logger.debug({ context: 'TRACKER', symbol }, '📡 Checking current price...');
  try {
    const ticker = await okx.fetchTicker(symbol);
    return ticker.last;
  } catch (err) {
    logger.warn({ context: 'TRACKER', symbol, err: err.message }, '⚠️ OKX failed, fallback Bitget');
    try {
      const ticker = await bybit.fetchTicker(symbol);
      return ticker.last;
    } catch (err2) {
      logger.error({ context: 'TRACKER', symbol, err: err2.message }, '❌ Both exchanges failed for symbol');
      throw err2;
    }
  }
}

function setPriceFetcher(fn) {
  priceFetcher = fn;
}

function getNowJakarta() {
  return new Date();
}

function formatWibTime(date) {
  return date.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Jakarta',
  }) + ' WIB';
}

function formatPrice(num) {
  return Number(num).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 5, // AUDIT FIX: More precision for low-priced coins
  });
}

function calcPnlPct(direction, entry, closePrice) {
  if (!entry || !closePrice) return 0;
  if (direction === 'LONG') {
    return ((closePrice - entry) / entry) * 100;
  }
  if (direction === 'SHORT') {
    return ((entry - closePrice) / entry) * 100;
  }
  return 0;
}

// ─── AUDIT FIX: New Update Messages ──────────────────────────────────────

async function sendTpUpdateMessage(sig, tpLevel, price, pct) {
  const dirEmoji = sig.direction === 'LONG' ? '🟢' : '🔴';

  // Load LATEST state from DB to show all hits correctly
  const dbSignal = await prisma.signal.findUnique({ where: { id: sig.signalId } });
  if (!dbSignal) return;

  const tpLines = [];
  if (dbSignal.tp1Hit) tpLines.push(`✅ TP1 HIT — $${formatPrice(dbSignal.tp1)} (+${dbSignal.tp1Pct.toFixed(2)}%)`);
  if (dbSignal.tp2Hit) tpLines.push(`⚡ TP2 HIT — $${formatPrice(dbSignal.tp2)} (+${dbSignal.tp2Pct.toFixed(2)}%)`);
  if (dbSignal.tp3Hit) tpLines.push(`🔥 <b>TP3 HIT — $${formatPrice(dbSignal.tp3)} (+${dbSignal.tp3Pct.toFixed(2)}%)</b>`);

  const isAllTpHit = dbSignal.tp3Hit;

  const text = `
📊 <b>SIGNAL UPDATE</b>
━━━━━━━━━━━━━━━━━━
${dirEmoji} ${sig.direction} — <b>$${sig.symbol.replace('/USDT','')}/USDT</b>

${tpLines.join('\n')}
⏱ ${formatWibTime(new Date())}
${isAllTpHit ? '\n📌 Signal selesai — semua TP tercapai! 🎯' : ''}
━━━━━━━━━━━━━━━━━━
  `.trim();

  await botInstance.sendMessage(sig.chatId, text, { parse_mode: 'HTML' });
}

async function sendSlUpdateMessage(sig, price, pct) {
  const dirEmoji = sig.direction === 'LONG' ? '🟢' : '🔴';

  const text = `
📊 <b>SIGNAL UPDATE</b>
━━━━━━━━━━━━━━━━━━
${dirEmoji} ${sig.direction} — <b>$${sig.symbol.replace('/USDT','')}/USDT</b>

❌ <b>STOP LOSS HIT</b> — $${formatPrice(price)}
📉 Loss: <b>${pct.toFixed(2)}%</b>
⏱ ${formatWibTime(new Date())}
📌 Signal closed.
━━━━━━━━━━━━━━━━━━
  `.trim();

  await botInstance.sendMessage(sig.chatId, text, { parse_mode: 'HTML' });
}

async function sendExpiredMessage(sig) {
  const dirEmoji = sig.direction === 'LONG' ? '🟢' : '🔴';

  const text = `
⏰ <b>SIGNAL EXPIRED</b>
━━━━━━━━━━━━━━━━━━
${dirEmoji} ${sig.direction} — <b>$${sig.symbol.replace('/USDT','')}/USDT</b>

Signal tidak mencapai TP maupun SL
dalam 48 jam. Auto-closed.
⏱ ${formatWibTime(new Date(sig.sentAt))} → ${formatWibTime(new Date())} (+48h)
━━━━━━━━━━━━━━━━━━
  `.trim();

  await botInstance.sendMessage(sig.chatId, text, { parse_mode: 'HTML' });
}

// ─── Core Logic ─────────────────────────────────────────────────────────

async function addActiveSignal(data) {
  try {
    const signals = await loadActiveSignals();
    const now = new Date();
    const key = String(data.messageId);
    signals[key] = {
      symbol: data.symbol,
      direction: data.direction,
      entry: data.entry,
      tp1: data.tp1,
      tp2: data.tp2,
      tp3: data.tp3,
      sl: data.sl,
      chatId: data.chatId,
      messageId: data.messageId,
      signalId: data.signalId,
      sentAt: data.sentAt || now.toISOString(),
    };
    await saveActiveSignals(signals);
  } catch (err) {
    logger.error({ context: 'TRACKER', err: err.message }, '❌ addActiveSignal error');
  }
}

async function monitorActiveSignals() {
  try {
    const signals = await loadActiveSignals();
    const now = new Date();
    
    for (const [key, sig] of Object.entries(signals)) {
      try {
        const sentAt = new Date(sig.sentAt);
        const ageMs = now - sentAt;
        const maxAgeMs = 48 * 60 * 60 * 1000;

        // 1. Check EXPIRED
        if (ageMs > maxAgeMs) {
          await sendExpiredMessage(sig);
          await prisma.signal.update({
            where: { id: sig.signalId },
            data: { closed: true, closeReason: 'EXPIRED', closedAt: new Date(), status: 'CLOSED' }
          }).catch(() => {});
          delete signals[key];
          continue;
        }

        // 2. Fetch fresh price
        const fetcher = priceFetcher || getCurrentPrice;
        const price = await fetcher(sig.symbol);

        // 3. Check hits against LATEST DB state (multi-user safe)
        const dbSignal = await prisma.signal.findUnique({ where: { id: sig.signalId } });
        if (!dbSignal || dbSignal.closed) {
          delete signals[key]; // already handled globally
          continue;
        }

        const isLong = sig.direction === 'LONG';
        const hitSL = isLong ? price <= sig.sl : price >= sig.sl;

        if (hitSL) {
          const pct = calcPnlPct(sig.direction, sig.entry, price);
          await sendSlUpdateMessage(sig, price, pct);
          await prisma.signal.update({
            where: { id: sig.signalId },
            data: { slHit: true, slPct: pct, closed: true, closeReason: 'SL', closedAt: new Date(), status: 'CLOSED' }
          });
          delete signals[key];
          continue;
        }

        // TP Check sequence
        const hitTP3 = isLong ? price >= sig.tp3 : price <= sig.tp3;
        const hitTP2 = isLong ? price >= sig.tp2 : price <= sig.tp2;
        const hitTP1 = isLong ? price >= sig.tp1 : price <= sig.tp1;

        if (hitTP3 && !dbSignal.tp3Hit) {
          const pct = calcPnlPct(sig.direction, sig.entry, sig.tp3);
          // Mark all previous TP as hit for safety
          await prisma.signal.update({
            where: { id: sig.signalId },
            data: { 
              tp1Hit: true, tp1Pct: dbSignal.tp1Pct || calcPnlPct(sig.direction, sig.entry, sig.tp1),
              tp2Hit: true, tp2Pct: dbSignal.tp2Pct || calcPnlPct(sig.direction, sig.entry, sig.tp2),
              tp3Hit: true, tp3Pct: pct, 
              closed: true, closeReason: 'TP3', closedAt: new Date(), status: 'COMPLETED' 
            }
          });
          await sendTpUpdateMessage(sig, sig.tp3, price, pct);
          delete signals[key];
        } 
        else if (hitTP2 && !dbSignal.tp2Hit) {
          const pct = calcPnlPct(sig.direction, sig.entry, sig.tp2);
          await prisma.signal.update({
            where: { id: sig.signalId },
            data: { 
              tp1Hit: true, tp1Pct: dbSignal.tp1Pct || calcPnlPct(sig.direction, sig.entry, sig.tp1),
              tp2Hit: true, tp2Pct: pct, 
              status: 'TP2_HIT' 
            }
          });
          await sendTpUpdateMessage(sig, sig.tp2, price, pct);
        }
        else if (hitTP1 && !dbSignal.tp1Hit) {
          const pct = calcPnlPct(sig.direction, sig.entry, sig.tp1);
          await prisma.signal.update({
            where: { id: sig.signalId },
            data: { tp1Hit: true, tp1Pct: pct, status: 'TP1_HIT' }
          });
          await sendTpUpdateMessage(sig, sig.tp1, price, pct);
        }

      } catch (err) {
        logger.error({ context: 'TRACKER', symbol: sig.symbol, err: err.message }, '❌ Signal check error');
      }
    }
    await saveActiveSignals(signals);
  } catch (err) {
    logger.error({ context: 'TRACKER', err: err.message }, '❌ monitorActiveSignals error');
  }
}

function startMonitor(bot) {
  if (monitorStarted) return;
  botInstance = bot;
  monitorStarted = true;
  setInterval(monitorActiveSignals, 60_000); // 1 min interval for stability
}

module.exports = {
  addActiveSignal,
  startMonitor,
  setPriceFetcher,
  _monitorActiveSignals: monitorActiveSignals,
};

