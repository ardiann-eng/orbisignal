// NEW: JSON-based storage for active signals and history
const fs = require('fs/promises'); // NEW:
const path = require('path'); // NEW:

const ACTIVE_FILE = path.join(process.cwd(), 'active_signals.json'); // NEW:
const HISTORY_FILE = path.join(process.cwd(), 'signal_history.json'); // NEW:

async function loadActiveSignals() { // NEW:
  try { // NEW:
    const data = await fs.readFile(ACTIVE_FILE, 'utf8'); // NEW:
    return JSON.parse(data); // NEW:
  } catch { // NEW:
    return {}; // NEW:
  } // NEW:
} // NEW:

async function saveActiveSignals(signals) { // NEW:
  try { // NEW:
    await fs.writeFile( // NEW:
      ACTIVE_FILE, // NEW:
      JSON.stringify(signals, null, 2), // NEW:
      'utf8', // NEW:
    ); // NEW:
  } catch (err) { // NEW:
    console.error('saveActiveSignals error:', err); // NEW:
  } // NEW:
} // NEW:

async function appendToHistory(signalData) { // NEW:
  let history = []; // NEW:
  try { // NEW:
    const data = await fs.readFile(HISTORY_FILE, 'utf8'); // NEW:
    history = JSON.parse(data); // NEW:
  } catch { // NEW:
    history = []; // NEW:
  } // NEW:
  const dateStr = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' }); // NEW:
  history.push({ // NEW:
    date: dateStr, // NEW:
    ...signalData, // NEW:
  }); // NEW:
  try { // NEW:
    await fs.writeFile( // NEW:
      HISTORY_FILE, // NEW:
      JSON.stringify(history, null, 2), // NEW:
      'utf8', // NEW:
    ); // NEW:
  } catch (err) { // NEW:
    console.error('appendToHistory error:', err); // NEW:
  } // NEW:
} // NEW:

async function getHistoryByDate(dateStr) { // NEW:
  try { // NEW:
    const data = await fs.readFile(HISTORY_FILE, 'utf8'); // NEW:
    const history = JSON.parse(data); // NEW:
    return history.filter(s => s.date === dateStr); // NEW:
  } catch { // NEW:
    return []; // NEW:
  } // NEW:
} // NEW:

module.exports = { // NEW:
  loadActiveSignals, // NEW:
  saveActiveSignals, // NEW:
  appendToHistory, // NEW:
  getHistoryByDate, // NEW:
}; // NEW:

