// Minimal, dependency-free tagged logger. No npm packages required (important
// for a Windows Server box — nothing to `npm install -g` or compile).
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "worker.log");
const MAX_BYTES = 5 * 1024 * 1024; // rotate at ~5MB
const KEEP_ROTATED = 3;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function rotateIfNeeded() {
  try {
    ensureDir();
    if (!fs.existsSync(LOG_FILE)) return;
    const { size } = fs.statSync(LOG_FILE);
    if (size < MAX_BYTES) return;
    for (let i = KEEP_ROTATED - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch (_) { /* logging must never crash the worker */ }
}

function line(tag, msg) {
  const ts = new Date().toISOString();
  const text = `[${ts}] [${tag}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(text);
  try {
    rotateIfNeeded();
    ensureDir();
    fs.appendFileSync(LOG_FILE, text + "\n");
  } catch (_) { /* never let a logging failure take the worker down */ }
}

module.exports = {
  mt5: (msg) => line("MT5", msg),
  worker: (msg) => line("WORKER", msg),
  signal: (msg) => line("SIGNAL", msg),
  backtest: (msg) => line("BACKTEST", msg),
  error: (msg) => line("ERROR", msg),
  LOG_FILE,
};
