/**
 * Server-side Risk Guard (authoritative for Auto Trading).
 * Daily loss uses real MT5 P/L from Bridge GET /daily-pnl — fail-closed if unavailable.
 * Browser RiskGuard remains UX-only.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '..', 'data');
const RISK_STATE_FILE = path.join(DATA_DIR, 'risk-state.json');
const PYTHON_SERVER = (process.env.MT5_BRIDGE_URL || 'http://localhost:5001').replace(/\/$/, '');

const DEFAULTS = {
  MAX_TRADES_PER_DAY: Number(process.env.MAX_TRADES_PER_DAY) || 0,
  DAILY_LOSS_LIMIT_PCT: Number(process.env.DAILY_LOSS_LIMIT_PCT) || 3,
  AUTO_MIN_CONFIDENCE: Number(process.env.AUTO_MIN_CONFIDENCE) || 80,
  DEFAULT_RISK_PERCENT: Number(process.env.DEFAULT_RISK_PERCENT) || 1
};

function todayKey() {
  const d = new Date();
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

function readJSONSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJSONAtomic(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + '.tmp' + process.pid + '_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadRiskState() {
  const s = readJSONSafe(RISK_STATE_FILE, null);
  const key = todayKey();
  if (!s || s.date !== key) {
    return { date: key, trades: 0 };
  }
  return s;
}

function saveRiskState(state) {
  writeJSONAtomic(RISK_STATE_FILE, state);
}

/**
 * Fetch authoritative daily P/L from MT5 Bridge.
 */
async function fetchDailyPnLFromMT5() {
  try {
    const res = await axios.get(PYTHON_SERVER + '/daily-pnl', { timeout: 8000 });
    const data = res.data;
    if (!data || data.status !== 'ok') {
      return {
        ok: false,
        reason: 'MT5 daily P/L unavailable: ' + ((data && data.message) || 'status not ok')
      };
    }
    if (!Number.isFinite(Number(data.totalPnL))) {
      return { ok: false, reason: 'MT5 daily P/L missing totalPnL' };
    }
    return {
      ok: true,
      totalPnL: Number(data.totalPnL),
      closedPnL: Number(data.closedPnL),
      floatingPnL: Number(data.floatingPnL),
      equity: data.equity != null ? Number(data.equity) : null,
      balance: data.balance != null ? Number(data.balance) : null
    };
  } catch (e) {
    return { ok: false, reason: 'MT5 daily P/L fetch failed: ' + (e.message || String(e)) };
  }
}

/**
 * Check whether a new order is allowed (before claim/bridge).
 * Daily loss from real MT5 totalPnL vs equity/balance. Fail-closed if P/L unavailable.
 */
async function checkCanTrade(opts) {
  const state = loadRiskState();
  const maxTrades = (opts && opts.maxTrades != null) ? Number(opts.maxTrades) : DEFAULTS.MAX_TRADES_PER_DAY;
  const dailyLossPct = (opts && opts.dailyLossPct != null) ? Number(opts.dailyLossPct) : DEFAULTS.DAILY_LOSS_LIMIT_PCT;

  if (Number.isFinite(maxTrades) && maxTrades > 0 && state.trades >= maxTrades) {
    return { allowed: false, reason: 'MAX_TRADES_PER_DAY (' + maxTrades + ')', state };
  }

  const pnl = await fetchDailyPnLFromMT5();
  if (!pnl.ok) {
    return {
      allowed: false,
      reason: 'DAILY_LOSS_UNAVAILABLE (fail-closed): ' + pnl.reason,
      state
    };
  }

  const capital = (Number.isFinite(pnl.equity) && pnl.equity > 0)
    ? pnl.equity
    : (Number.isFinite(pnl.balance) && pnl.balance > 0 ? pnl.balance : null);

  if (capital == null || capital <= 0) {
    return {
      allowed: false,
      reason: 'DAILY_LOSS_UNAVAILABLE (fail-closed): no valid equity/balance from MT5',
      state
    };
  }

  const lossPct = pnl.totalPnL < 0 ? (Math.abs(pnl.totalPnL) / capital) * 100 : 0;
  if (lossPct >= Math.abs(dailyLossPct)) {
    return {
      allowed: false,
      reason: 'DAILY_LOSS_LIMIT (' + dailyLossPct + '%): current loss ' + lossPct.toFixed(2) + '% of capital (totalPnL=' + pnl.totalPnL + ')',
      state,
      pnl
    };
  }

  return { allowed: true, state, pnl, lossPct };
}

function recordTradeExecuted() {
  const state = loadRiskState();
  state.trades = (state.trades || 0) + 1;
  saveRiskState(state);
  return state;
}

function checkConfidence(confidence, minConf) {
  const min = minConf != null ? Number(minConf) : DEFAULTS.AUTO_MIN_CONFIDENCE;
  const c = Number(confidence);
  if (!Number.isFinite(c)) return { ok: false, reason: 'confidence missing/invalid' };
  if (c < min) return { ok: false, reason: 'confidence ' + c + ' < AUTO_MIN_CONFIDENCE ' + min };
  return { ok: true };
}

function validateSignalSide(signal) {
  const s = String(signal || '').toUpperCase();
  if (s.includes('WAIT')) return { ok: false, reason: 'WAIT is not executable' };
  if (s.includes('BUY') && !s.includes('SELL')) return { ok: true, side: 'BUY' };
  if (s.includes('SELL')) return { ok: true, side: 'SELL' };
  return { ok: false, reason: 'signal must be BUY or SELL' };
}

function validateSlTp(side, entry, sl, tp) {
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);
  if (![e, s, t].every(Number.isFinite) || e <= 0 || s <= 0 || t <= 0) {
    return { ok: false, reason: 'invalid entry/sl/tp numbers' };
  }
  if (side === 'BUY') {
    if (!(s < e && t > e)) return { ok: false, reason: 'BUY requires SL < entry < TP' };
  } else {
    if (!(s > e && t < e)) return { ok: false, reason: 'SELL requires TP < entry < SL' };
  }
  return { ok: true };
}

function validateVolume(volume, symbolInfo) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v <= 0) return { ok: false, reason: 'invalid volume' };
  if (!symbolInfo || symbolInfo.status === 'unavailable') {
    return { ok: true, volume: v };
  }
  const vmin = Number(symbolInfo.volume_min || 0.01);
  const vmax = Number(symbolInfo.volume_max || 50);
  const step = Number(symbolInfo.volume_step || 0.01);
  let out = Math.max(vmin, Math.min(v, vmax));
  if (step > 0) out = Math.round(out / step) * step;
  out = Number(out.toFixed(8));
  if (out < vmin) return { ok: false, reason: 'volume below min' };
  return { ok: true, volume: out };
}

module.exports = {
  DEFAULTS,
  loadRiskState,
  fetchDailyPnLFromMT5,
  checkCanTrade,
  recordTradeExecuted,
  checkConfidence,
  validateSignalSide,
  validateSlTp,
  validateVolume
};
