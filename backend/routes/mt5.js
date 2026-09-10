const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const MT5_CONFIG = {
  server: process.env.MT5_SERVER || 'ICMarkets-Demo',
  login: process.env.MT5_LOGIN,
  password: process.env.MT5_PASSWORD
};

const PYTHON_SERVER = (process.env.MT5_BRIDGE_URL || 'http://localhost:5001').replace(/\/$/, '');

// =====================================================================
// Auto Trading Safety Layer (additive — does not touch analysis, risk,
// SL/TP/trailing/break-even, or any /candles /current-price /health path)
// -----------------------------------------------------------------------
// Three independent gates, all enforced HERE (server-side), not just in
// the browser, so a second tab / a bypassed client / a stray retry can
// never reach mt5.order_send() on its own say-so:
//
//   Gate 1 — SYSTEM ON/OFF + sinceEpoch: no candle that closed before the
//            recorded ON moment may ever execute.
//   Gate 2 — one execution per (symbol|timeframe|candleCloseTime): an
//            atomic, filesystem-level claim (fs 'wx' exclusive-create)
//            taken BEFORE any network call to the bridge, so a second,
//            concurrent, or cross-tab request is rejected synchronously,
//            before axios.post ever fires — never a race.
//   Gate 3 (bridge-side, see mt5_connector.py) — trade_mode / market
//            status checked before order_send(), fail-closed on unknown.
//
// State machine per claimed candle:
//   CLAIMED  -> EXECUTED   (bridge returned a confirmed FILLED result)
//            -> FAILED     (bridge returned a confirmed, definitive
//                            rejection — no order was created)
//            -> UNKNOWN    (timeout / connection reset / 5xx / malformed
//                            response / anything not unambiguously one of
//                            the two outcomes above)
//   UNKNOWN is STICKY: never auto-retried, never auto-cleaned. Only the
//   explicit reconciliation endpoint below may move it to EXECUTED/FAILED,
//   and only by actually asking MT5, never by sending a new order.
// =====================================================================

const DATA_DIR = path.join(__dirname, '..', 'data');
const SYSTEM_STATE_FILE = path.join(DATA_DIR, 'system-state.json');
const EXEC_LEDGER_FILE = path.join(DATA_DIR, 'execution-ledger.json');
const CLAIMS_DIR = path.join(DATA_DIR, 'claims'); // one lockfile per claimed candle

const CANDLE_STALENESS_TOLERANCE_SEC = 5; // clock-skew tolerance for Gate 1 (never widened to hide a truly stale candle)

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CLAIMS_DIR)) fs.mkdirSync(CLAIMS_DIR, { recursive: true });
}

function readJSONSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback; // corrupted/partial file -> fail closed via the caller's fallback
  }
}

function writeJSONAtomic(file, data) {
  ensureDataDirs();
  const tmp = file + '.tmp' + process.pid + '_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic on the same filesystem, incl. Windows NTFS
}

// ---- Gate 1: SYSTEM ON/OFF state -------------------------------------

function getSystemState() {
  // Fail-closed: any read problem, missing file, or malformed content means
  // the system is treated as OFF. There is no code path where a read
  // failure results in "treat as ON".
  const s = readJSONSafe(SYSTEM_STATE_FILE, null);
  if (!s || typeof s.enabled !== 'boolean' || typeof s.sinceEpoch !== 'number') {
    return { enabled: false, sinceEpoch: null };
  }
  return s;
}

function setSystemState(enabled) {
  const state = { enabled: Boolean(enabled), sinceEpoch: Math.floor(Date.now() / 1000) };
  writeJSONAtomic(SYSTEM_STATE_FILE, state);
  return state;
}

router.get('/system-state', (req, res) => {
  res.json(getSystemState());
});

router.post('/system-state', (req, res) => {
  const enabled = req.body && req.body.enabled === true;
  const state = setSystemState(enabled);
  res.json(state);
});

// ---- Gate 2: atomic per-candle claim ----------------------------------

function claimKeyToFilename(symbol, timeframe, candleCloseTime) {
  // Sanitize to a safe filename — the key itself stays exact for ledger use.
  const safe = `${symbol}__${timeframe}__${candleCloseTime}`.replace(/[^a-zA-Z0-9_.\-]/g, '_');
  return path.join(CLAIMS_DIR, safe + '.lock');
}

// Returns true if this call WON the claim (i.e., no prior claim existed).
// This is a single fs syscall (exclusive create) — the check-and-create is
// atomic at the OS level, so two near-simultaneous callers can never both
// win. Whichever call loses gets EEXIST and returns false, synchronously,
// before any network request to the bridge is ever made.
function tryClaimCandle(symbol, timeframe, candleCloseTime, meta) {
  ensureDataDirs();
  const file = claimKeyToFilename(symbol, timeframe, candleCloseTime);
  try {
    fs.writeFileSync(file, JSON.stringify({ ...meta, claimedAt: Date.now() }), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e; // real I/O error — never silently treat as "claim granted"
  }
}

function claimKeyString(symbol, timeframe, candleCloseTime) {
  return `${symbol}|${timeframe}|${candleCloseTime}`;
}

// ---- execution ledger (CLAIMED/EXECUTED/FAILED/UNKNOWN, per clientOrderId) --

function readLedger() { return readJSONSafe(EXEC_LEDGER_FILE, {}); }
function writeLedgerEntry(clientOrderId, entry) {
  const ledger = readLedger();
  ledger[clientOrderId] = { ...ledger[clientOrderId], ...entry, updatedAt: new Date().toISOString() };
  writeJSONAtomic(EXEC_LEDGER_FILE, ledger);
  return ledger[clientOrderId];
}

// Classifies a bridge response into EXECUTED / FAILED / UNKNOWN.
// Anything not unambiguously matching one of the two definite shapes below
// falls into UNKNOWN by default — this is the fail-closed rule for
// response classification itself, independent of the trade_mode fail-closed
// rule enforced in the bridge.
function classifyBridgeResult(bridgeOnline, httpOk, data) {
  if (!bridgeOnline) return { state: 'UNKNOWN', reason: 'bridge unreachable / network error' };
  if (!httpOk) return { state: 'UNKNOWN', reason: 'bridge returned non-2xx (possible mid-call failure)' };
  if (!data || typeof data !== 'object') return { state: 'UNKNOWN', reason: 'malformed/non-JSON bridge response' };

  if (data.status === 'FILLED' && (typeof data.order === 'number' || typeof data.order === 'string')) {
    return { state: 'EXECUTED', reason: 'bridge confirmed FILLED with order ticket' };
  }
  const DEFINITE_NO_TRADE_STATUSES = ['ERROR', 'MARKET_CLOSED', 'MARKET_NOT_TRADEABLE'];
  if (DEFINITE_NO_TRADE_STATUSES.includes(data.status)) {
    return { state: 'FAILED', reason: `bridge confirmed no trade created (status=${data.status})` };
  }
  // Any other/unexpected status shape (including DISCONNECTED, which means
  // we don't actually know if a prior attempt on the MT5 side landed) is
  // ambiguous, not a confirmed failure.
  return { state: 'UNKNOWN', reason: `unrecognized/ambiguous bridge status: ${data.status}` };
}

// ---- reconciliation (read-only — never sends an order) -----------------

router.get('/reconcile/:clientOrderId', async (req, res) => {
  const clientOrderId = req.params.clientOrderId;
  const ledger = readLedger();
  const entry = ledger[clientOrderId];
  if (!entry) return res.status(404).json({ status: 'NOT_FOUND', message: 'no ledger entry for this clientOrderId' });
  if (entry.state !== 'UNKNOWN') {
    return res.json({ status: 'ALREADY_RESOLVED', ledgerState: entry.state, entry });
  }
  try {
    // Read-only lookup against MT5's own history/positions, matched by the
    // clientOrderId that the bridge now stamps into the order's comment
    // field (see mt5_connector.py). This endpoint never calls order_send.
    const lookup = await axios.get(`${PYTHON_SERVER}/reconcile-order`, {
      params: { clientOrderId }, timeout: 10000
    });
    const found = lookup.data && lookup.data.found;
    if (found === true) {
      const resolved = writeLedgerEntry(clientOrderId, {
        state: 'EXECUTED', reason: 'reconciled: matching MT5 deal found', reconciledAt: new Date().toISOString(),
        mt5Details: lookup.data.details || null
      });
      return res.json({ status: 'RESOLVED_EXECUTED', entry: resolved });
    }
    if (found === false) {
      const resolved = writeLedgerEntry(clientOrderId, {
        state: 'FAILED', reason: 'reconciled: no matching MT5 deal found', reconciledAt: new Date().toISOString()
      });
      return res.json({ status: 'RESOLVED_FAILED', entry: resolved });
    }
    // Bridge itself couldn't determine it confidently — stays UNKNOWN.
    return res.json({ status: 'STILL_UNKNOWN', message: 'MT5 lookup was inconclusive', entry });
  } catch (e) {
    // A failed reconciliation attempt must never change the ledger state —
    // UNKNOWN stays UNKNOWN until a lookup actually succeeds.
    return res.status(502).json({ status: 'RECONCILE_UNAVAILABLE', message: e.message, entry });
  }
});

router.post('/send-signal', async (req, res) => {
  try {
    const {
      signal, entry, sl, tp1, tp2, tp3, volume,
      symbol, mode, clientOrderId, deviation, candleCloseTime
    } = req.body;

    const resolvedMode = mode === 'auto' ? 'auto' : 'manual';

    // --- Gate 1: SYSTEM ON/OFF -----------------------------------------
    const sys = getSystemState();
    if (!sys.enabled) {
      return res.json({ status: 'SYSTEM_OFF', executionState: 'SYSTEM_OFF', message: 'SYSTEM is OFF — no new trade may open (position management is unaffected and continues elsewhere).' });
    }

    // --- candle staleness (auto only) -----------------------------------
    // Manual trades are a human directly approving a specific action right
    // now, so they are not subject to the "was this candle already old
    // when the system turned on" check — but they ARE still subject to
    // SYSTEM OFF above, matching the original SYSTEM ON/OFF spec (no new
    // entries while OFF, for either manual or auto).
    if (resolvedMode === 'auto') {
      if (typeof candleCloseTime !== 'number' || !Number.isFinite(candleCloseTime) || candleCloseTime <= 0) {
        return res.json({ status: 'INVALID_CANDLE_TIMESTAMP', executionState: 'INVALID_CANDLE_TIMESTAMP', message: 'candleCloseTime missing/invalid — auto execution refused (fail-closed).' });
      }
      if (sys.sinceEpoch != null && candleCloseTime < (sys.sinceEpoch - CANDLE_STALENESS_TOLERANCE_SEC)) {
        return res.json({ status: 'STALE_CANDLE_REJECTED', executionState: 'STALE_CANDLE_REJECTED', message: `candle closed before SYSTEM was turned ON (candleCloseTime=${candleCloseTime}, sinceEpoch=${sys.sinceEpoch})` });
      }
    }

    // --- Gate 2: atomic per-candle claim (auto only — manual trades are
    //     one-off human actions, not a recurring per-candle poll, so the
    //     candle-claim concept doesn't apply to them) --------------------
    let claimKey = null;
    if (resolvedMode === 'auto' && symbol && candleCloseTime) {
      // Timeframe isn't in the payload today; use ACTIVE-timeframe-agnostic
      // keying is NOT safe (would collide across timeframes), so require it.
      const timeframe = req.body.timeframe || req.body.activeTimeframe;
      if (!timeframe) {
        return res.json({ status: 'INVALID_REQUEST', executionState: 'INVALID_REQUEST', message: 'timeframe missing — required for the per-candle execution claim (fail-closed).' });
      }
      claimKey = claimKeyString(symbol, timeframe, candleCloseTime);
      const won = tryClaimCandle(symbol, timeframe, candleCloseTime, { clientOrderId, requestedAt: new Date().toISOString() });
      if (!won) {
        return res.json({ status: 'REJECTED_DUPLICATE', executionState: 'REJECTED_DUPLICATE', message: `this candle (${claimKey}) was already claimed by another request — never reached the bridge.` });
      }
      if (clientOrderId) writeLedgerEntry(clientOrderId, { state: 'CLAIMED', claimKey, mode: resolvedMode });
    }

    // --- forward to bridge (the only network call in this path) --------
    let bridgeOnline = true;
    let httpOk = true;
    const response = await axios.post(`${PYTHON_SERVER}/execute-trade`, {
      signal, entry, stopLoss: sl, tp1, tp2, tp3, volume, symbol,
      mode: resolvedMode, clientOrderId, deviation,
      server: MT5_CONFIG.server, login: MT5_CONFIG.login
    }, { timeout: 15000 }).catch((err) => {
      bridgeOnline = false;
      if (err.response) { httpOk = false; return err.response; } // bridge answered but with non-2xx
      return { data: { status: 'DISCONNECTED', message: 'MT5 Python bridge offline', error: err.message } };
    });

    const classification = classifyBridgeResult(bridgeOnline, httpOk, response.data);

    if (clientOrderId) {
      writeLedgerEntry(clientOrderId, {
        state: classification.state,
        reason: classification.reason,
        claimKey,
        mode: resolvedMode,
        bridgeStatus: response.data && response.data.status
      });
    }
    // UNKNOWN is sticky by construction: the claim lockfile is never
    // deleted here for any outcome, so no subsequent request for the same
    // candle can ever win a new claim and retry — this holds regardless of
    // whether the outcome was EXECUTED, FAILED, or UNKNOWN.

    const status = response.data.status || (bridgeOnline ? 'PENDING' : 'DISCONNECTED');
    res.json({
      message: bridgeOnline ? 'Signal forwarded to MT5 bridge' : 'MT5 bridge not available — trade NOT executed',
      status,
      executionState: classification.state,
      ledgerState: classification.state,
      details: response.data
    });
  } catch (error) {
    // An unexpected exception here must also be treated as ambiguous, not
    // as a definite failure — if a clientOrderId and claim already exist,
    // leave them exactly as CLAIMED/whatever they last were; do not release.
    res.status(500).json({ error: error.message, executionState: 'UNKNOWN', status: 'UNKNOWN' });
  }
});

router.get('/current-price', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const response = await axios.get(`${PYTHON_SERVER}/current-price`, { params: { symbol }, timeout: 3000 }).catch(() => ({
      data: { price: 0, status: 'unavailable' }
    }));
    res.json({ price: response.data.price, status: response.data.status || 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const MT5_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

router.get('/candles', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const timeframe = String(req.query.timeframe || 'M5').toUpperCase();
    if (!MT5_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ status: 'error', message: `unsupported timeframe ${timeframe}`, candles: [] });
    }
    let count = parseInt(req.query.count, 10);
    if (!Number.isFinite(count)) count = 120;
    count = Math.max(10, Math.min(count, 5000));

    const response = await axios.get(`${PYTHON_SERVER}/candles`, {
      params: { symbol, timeframe, count },
      timeout: 20000 // large backtest pulls (up to 5000 bars) need more than the old 8s
    }).catch(() => ({
      data: { status: 'unavailable', message: 'MT5 Python bridge unreachable', candles: [] }
    }));

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message, candles: [] });
  }
});

router.get('/account-info/:uid', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_SERVER}/account-info`, { timeout: 3000 }).catch(() => ({
      data: { balance: 0, equity: 0, freeMargin: 0, status: 'unavailable' }
    }));
    res.json({ ...response.data, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/symbol-info', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const response = await axios.get(`${PYTHON_SERVER}/symbol-info`, { params: { symbol }, timeout: 3000 });
    res.json(response.data);
  } catch (e) {
    res.json({
      status: 'unavailable',
      message: 'MT5 bridge offline — using approximate lot sizing',
      executionState: 'DISCONNECTED'
    });
  }
});

router.get('/health', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_SERVER}/health`, { timeout: 2000 });
    res.json({ status: 'online', bridge: 'connected', executionState: 'READY', details: response.data });
  } catch (e) {
    res.json({
      status: 'degraded',
      bridge: 'DISCONNECTED',
      executionState: 'DISCONNECTED',
      message: 'Python MT5 bridge not reachable on port 5001'
    });
  }
});

module.exports = router;
