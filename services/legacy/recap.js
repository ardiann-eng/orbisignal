const cron = require('node-cron');
const { prisma } = require('../../lib/db');
const { logger } = require('../../utils/logger');

let recapBotInstance = null;

/**
 * Audit-safe statistical calculation using Prisma data.
 * Definition:
 * - Total: All signals created in the period (excluding system errors).
 * - Win: Hit at least TP1.
 * - Loss: Hit SL before any TP.
 * - Expired: No TP or SL hit within 48h.
 */
function calculateProfessionalRecap(signals) {
  const total = signals.length;
  if (total === 0) return null;

  // 1. Classification
  const winSignals = signals.filter(s => s.tp1Hit);
  const lossSignals = signals.filter(s => s.slHit && !s.tp1Hit);
  const expiredSignals = signals.filter(s => s.closeReason === 'EXPIRED');
  
  // 2. Win Rate (Professional: Win / (Win + Loss))
  const winCount = winSignals.length;
  const lossCount = lossSignals.length;
  const validCount = winCount + lossCount;
  const winRate = validCount > 0 ? (winCount / validCount * 100) : 0;

  // 3. TP Breakdown (Cumulative Logic: >=)
  const tp1Total = signals.filter(s => s.tp1Hit).length;
  const tp2Total = signals.filter(s => s.tp2Hit).length;
  const tp3Total = signals.filter(s => s.tp3Hit).length;

  // 4. Performance Metrics
  const avgConf = signals.reduce((a, b) => a + b.confidence, 0) / total;
  const avgPnl = signals.reduce((a, s) => {
    // Determine max PNL reached or final PNL
    let pnl = 0;
    if (s.tp3Hit) pnl = s.tp3Pct;
    else if (s.tp2Hit) pnl = s.tp2Pct;
    else if (s.tp1Hit) pnl = s.tp1Pct;
    else if (s.slHit) pnl = s.slPct;
    return a + pnl;
  }, 0) / (total || 1);

  // 5. Directional Bias
  const longCount = signals.filter(s => s.direction === 'LONG').length;
  const shortCount = signals.filter(s => s.direction === 'SHORT').length;

  // 6. Best/Worst
  const sortedByPnl = [...signals].sort((a, b) => {
    const pnlA = a.tp3Hit ? a.tp3Pct : (a.tp2Hit ? a.tp2Pct : (a.tp1Hit ? a.tp1Pct : a.slPct));
    const pnlB = b.tp3Hit ? b.tp3Pct : (b.tp2Hit ? b.tp2Pct : (b.tp1Hit ? b.tp1Pct : b.slPct));
    return pnlB - pnlA;
  });

  return {
    total,
    winCount,
    lossCount,
    expiredCount: expiredSignals.length,
    winRate,
    tp1Total,
    tp2Total,
    tp3Total,
    avgConf,
    longCount,
    shortCount,
    best: sortedByPnl[0],
    worst: sortedByPnl[sortedByPnl.length - 1]
  };
}

function makeBar(pct, length = 10) {
  const filled = Math.round((pct || 0) / 100 * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

function formatDailyRecap(stats, dateStr) {
  if (!stats) return `<b>DAILY RECAP — ${dateStr}</b>\nNo signals recorded today.`;

  const bar = makeBar(stats.winRate);
  const best = stats.best;
  const worst = stats.worst;

  return `
━━━━━━━━━━━━━━━━━━━━━
📅 <b>DAILY PERFORMANCE — ${dateStr}</b>
<i>Orbis Professional Analytics</i>
━━━━━━━━━━━━━━━━━━━━━

📊 <b>SIGNAL STATISTICS</b>
Total Generated : ${stats.total}
✅ Win (Hit TP) : ${stats.winCount}
❌ Loss (Hit SL): ${stats.lossCount}
⏰ Expired      : ${stats.expiredCount}

🎯 <b>WIN RATE (Adj.)</b>
${stats.winRate.toFixed(1)}%
${bar}
<pre>Ratio: ${stats.winCount}W - ${stats.lossCount}L</pre>

📈 <b>CONFLUENCE LEVELS</b>
Hit TP1 (Initial) : ${stats.tp1Total}x
Hit TP2 (Strong)  : ${stats.tp2Total}x
Hit TP3 (Full)    : ${stats.tp3Total}x

↔️ <b>MARKET BIAS</b>
LONG  : ${stats.longCount} signals
SHORT : ${stats.shortCount} signals
Avg Confidence: ${stats.avgConf.toFixed(0)}/100

🏆 <b>TOP PERFORMERS</b>
Best  : ${best.symbol} (${best.direction})
Worst : ${worst.symbol} (${worst.direction})

━━━━━━━━━━━━━━━━━━━━━
📌 <i>Win Rate dihitung dari Sinyal Valid (Win+Loss).
Sinyal Expired tidak dihitung dalam akurasi.</i>
━━━━━━━━━━━━━━━━━━━━━
`.trim();
}

async function getSignalsFromPrisma(startDate, endDate) {
  return await prisma.signal.findMany({
    where: {
      createdAt: {
        gte: startDate,
        lte: endDate
      }
    }
  });
}

async function sendDailyRecap(chatIdOverride) {
  if (!recapBotInstance) return;
  try {
    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const endOfDay = new Date(now.setHours(23, 59, 59, 999));
    
    const signals = await getSignalsFromPrisma(startOfDay, endOfDay);
    const dateStr = startOfDay.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });

    const stats = calculateProfessionalRecap(signals);
    const text = formatDailyRecap(stats, dateStr);

    const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;

    await recapBotInstance.sendMessage(chatId, text, { parse_mode: 'HTML' });
    logger.info({ context: 'RECAP', date: dateStr, total: signals.length }, '📊 Daily recap sent via Prisma');
  } catch (err) {
    logger.error({ context: 'RECAP', err: err.message }, '❌ sendDailyRecap error');
  }
}

async function sendWeeklyRecap(chatIdOverride) {
  if (!recapBotInstance) return;
  try {
    const now = new Date();
    const startOfWeek = new Date(now.setDate(now.getDate() - 7));
    startOfWeek.setHours(0,0,0,0);
    const endOfWeek = new Date();
    endOfWeek.setHours(23,59,59,999);

    const signals = await getSignalsFromPrisma(startOfWeek, endOfWeek);
    const dateStr = `${startOfWeek.toLocaleDateString('id-ID')} - ${endOfWeek.toLocaleDateString('id-ID')}`;

    const stats = calculateProfessionalRecap(signals);
    const text = formatDailyRecap(stats, dateStr).replace('DAILY PERFORMANCE', 'WEEKLY PERFORMANCE');

    const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID;
    await recapBotInstance.sendMessage(chatId, text, { parse_mode: 'HTML' });
    logger.info({ context: 'RECAP', total: signals.length }, '📊 Weekly recap sent via Prisma');
  } catch (err) {
    logger.error({ context: 'RECAP', err: err.message }, '❌ sendWeeklyRecap error');
  }
}

function initScheduler(bot) {
  recapBotInstance = bot;
  // Daily recap: 23:59 WIB
  cron.schedule('59 23 * * *', async () => {
    await sendDailyRecap();
  }, { timezone: 'Asia/Jakarta' });

  // Weekly recap: Sunday 23:59 WIB
  cron.schedule('59 23 * * 0', async () => {
    await sendWeeklyRecap();
  }, { timezone: 'Asia/Jakarta' });
}

module.exports = {
  calculateProfessionalRecap,
  initScheduler,
  sendDailyRecap,
  sendWeeklyRecap,
};
 // NEW:

