// Plain-JSON, dependency-free persistence (no SQLite/native module — keeps
// Windows Server setup to "just run node", nothing to compile). Every write
// is atomic (write to a temp file, then rename) so a crash mid-write can
// never corrupt the file the worker re-reads on restart.
const fs = require("fs");
const path = require("path");

const WORKER_DATA_DIR = path.join(__dirname, "data");           // internal worker state (not requested externally)
const BACKEND_DATA_DIR = path.join(__dirname, "..", "data");    // C:\GoldAI\backend\data — where signals.json must live
const STATE_FILE = path.join(WORKER_DATA_DIR, "state.json");        // last-processed candle per timeframe (dedup)
const STATUS_FILE = path.join(WORKER_DATA_DIR, "status.json");      // worker health / heartbeat
const JOURNAL_FILE = path.join(BACKEND_DATA_DIR, "signals.json");   // backend/data/signals.json — persisted signals
const JOURNAL_CAP = 5000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback; // a corrupted/partial file must never crash the worker
  }
}

function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem, including Windows NTFS
}

// ---- state (dedup key per timeframe) ----------------------------------
function getState() {
  return readJSON(STATE_FILE, { lastCandle: {} }); // lastCandle: { M5: "<symbol>|<tf>|<time>", M15: ... }
}
function setLastCandle(timeframe, key) {
  const s = getState();
  s.lastCandle[timeframe] = key;
  writeJSONAtomic(STATE_FILE, s);
}

// ---- status / heartbeat -------------------------------------------------
function getStatus() {
  return readJSON(STATUS_FILE, {
    state: "STOPPED",
    mt5Connected: false,
    lastHeartbeat: null,
    lastSuccessfulRun: null,
    lastSignal: null,
    startedAt: null,
    message: ""
  });
}
function setStatus(patch) {
  const s = getStatus();
  const next = { ...s, ...patch, lastHeartbeat: new Date().toISOString() };
  writeJSONAtomic(STATUS_FILE, next);
  return next;
}

// ---- signal journal -------------------------------------------------------
function appendSignal(entry) {
  const j = readJSON(JOURNAL_FILE, []);
  j.push(entry);
  const trimmed = j.length > JOURNAL_CAP ? j.slice(j.length - JOURNAL_CAP) : j;
  writeJSONAtomic(JOURNAL_FILE, trimmed);
  setStatus({ lastSignal: entry });
  return trimmed;
}
function getJournal(limit) {
  const j = readJSON(JOURNAL_FILE, []);
  return limit ? j.slice(-limit) : j;
}
function clearJournal() {
  writeJSONAtomic(JOURNAL_FILE, []);
}

module.exports = {
  WORKER_DATA_DIR, BACKEND_DATA_DIR, STATE_FILE, STATUS_FILE, JOURNAL_FILE,
  getState, setLastCandle,
  getStatus, setStatus,
  appendSignal, getJournal, clearJournal,
};
