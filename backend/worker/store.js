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
const CLUSTER_FILE = path.join(WORKER_DATA_DIR, "cluster.json");    // same-direction signal lock (survives restarts)
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

// Short blocking pause (used only between retries below).
function pauseMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

function writeJSONAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  // ADDED 2026-10-07: on Windows the rename fails with EPERM/EBUSY/EACCES while
  // another process (backend, antivirus, a file copy) has the target open for a
  // moment. Retry a few times with short pauses instead of losing the write.
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.renameSync(tmp, file); // atomic on the same filesystem, including Windows NTFS
      return;
    } catch (e) {
      lastErr = e;
      if (!e || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) break;
      pauseMs(100 * (attempt + 1));
    }
  }
  // Last resort: copy over the target (not atomic, but keeps the data), then remove the temp file.
  try {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw lastErr;
  }
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

// ---- same-direction signal lock (trade-permission cluster state) --------
// Persisted so a worker restart can no longer open a second trade in the
// same move (this happened on 2026-10-05 after two restarts).
function getCluster() {
  return readJSON(CLUSTER_FILE, null);
}
function setCluster(snapshot) {
  if (!snapshot) return;
  writeJSONAtomic(CLUSTER_FILE, snapshot);
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
  WORKER_DATA_DIR, BACKEND_DATA_DIR, STATE_FILE, STATUS_FILE, JOURNAL_FILE, CLUSTER_FILE,
  getState, setLastCandle,
  getCluster, setCluster,
  getStatus, setStatus,
  appendSignal, getJournal, clearJournal,
};
