// ADDED 2026-10-08 — trailing stop for GoldAI auto trades (all timeframes).
//
// Runs once per worker cycle, only when GoldAI_Config.TRAIL_ENABLED is true.
// For every OPEN position that GoldAI itself opened automatically
// (magic 20250817 + comment "GA<symbol><TF><candleTime>"):
//   - replays the closed candles of that trade's own timeframe since it opened,
//     with the same rule the backtest uses (GoldAI_Trade.trailStep):
//     after +TRAIL_START_R x risk, stop -> break-even, then best price - 2 x ATR;
//   - if that stop is tighter than the stop in MT5, asks the bridge to move it.
// The stop only ever moves toward profit (checked here AND in the bridge).
// It never opens or closes a position. Manual trades are not touched.
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const store = require("./store");
const mt5 = require("./mt5-client");

const STATE_FILE = path.join(store.WORKER_DATA_DIR, "trail-state.json");
const MAGIC = 20250817;
// Longest names first so "M15..." is never read as "M1" + digits.
const COMMENT_RE = /^GA.*?(M15|M30|M1|M5|H1|H4|D1)(\d{10})$/;
const TF_SEC = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

let specsCache = {}; // symbol -> { point, digits, at }

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeState(obj) {
  try {
    if (!fs.existsSync(store.WORKER_DATA_DIR)) fs.mkdirSync(store.WORKER_DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    try { fs.renameSync(tmp, STATE_FILE); }
    catch (_) { fs.copyFileSync(tmp, STATE_FILE); try { fs.unlinkSync(tmp); } catch (__) {} }
  } catch (e) {
    logger.error(`[TRAIL] could not save trail-state.json: ${e.message}`);
  }
}

async function specsFor(symbol) {
  const c = specsCache[symbol];
  if (c && Date.now() - c.at < 3600 * 1000) return c;
  const r = await mt5.symbolInfo(symbol);
  if (!r || r.status !== "ok" || !(Number(r.point) > 0)) throw new Error("symbol-info unavailable");
  specsCache[symbol] = { point: Number(r.point), digits: Number(r.digits) || 2, at: Date.now() };
  return specsCache[symbol];
}

/** Pure part (tested on its own): new stop for one position, or null. */
function computeStop(T, cfg, pos, initialSL, bars, point) {
  const tf = pos.tf, sec = TF_SEC[tf];
  const isBuy = pos.type === "BUY";
  const entry = Number(pos.price_open);
  const openTime = Number(pos.time);
  if (!(sec > 0) || !(entry > 0) || !(initialSL > 0) || !Number.isFinite(openTime)) return null;
  const atr = T.atrWilder(bars, 14);
  const st = T.trailInit(isBuy, entry, initialSL);
  let used = 0, lastAtr = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.time + sec <= openTime) continue;        // bar closed before the trade opened
    const sellOff = isBuy ? 0 : Math.max(0, Number(b.spread) || 0) * point;
    // FIX kept 2026-10-11 (from 2026-10-09): if the trade opened well after this bar started,
    // the bar's high/low may be from BEFORE the entry -> use only its close for that bar.
    const bb = (openTime - b.time > 60) ? { high: b.close, low: b.close, close: b.close } : b;
    if (!Number.isFinite(atr[i])) continue;
    T.trailStep(st, bb, atr[i], sellOff, cfg);
    used++; lastAtr = atr[i];
  }
  if (!used || !st.active) return { active: false, bars: used };
  return { active: true, stop: st.stop, best: st.best, atr: lastAtr, bars: used };
}

async function run(engines) {
  const cfg = engines && engines.GoldAI_Config;
  const T = engines && engines.GoldAI_Trade;
  if (!cfg || cfg.TRAIL_ENABLED !== true || !T || !T.trailStep) return;

  const res = await mt5.positions();
  if (!res || res.status !== "ok" || !Array.isArray(res.positions)) return;

  const state = readState();
  let changed = false;
  const open = new Set();
  const mine = [];
  for (const p of res.positions) {
    if (Number(p.magic) !== MAGIC) continue;
    const m = COMMENT_RE.exec(String(p.comment || ""));
    if (!m) continue;                                 // manual / unknown trades: not touched
    open.add(String(p.ticket));
    mine.push(Object.assign({}, p, { tf: m[1] }));
  }
  // forget tickets that are no longer open
  for (const k of Object.keys(state)) if (!open.has(k)) { delete state[k]; changed = true; }

  const barCache = {};
  let quote = null;
  for (const p of mine) {
    const key = String(p.ticket);
    const curSL = Number(p.sl) || 0;
    if (!(curSL > 0)) continue;                       // no stop in MT5 -> leave it alone
    if (!state[key]) {
      state[key] = { initialSL: curSL, entry: Number(p.price_open), type: p.type, tf: p.tf, openTime: p.time, firstSeen: new Date().toISOString() };
      changed = true;
      logger.worker(`[TRAIL] watching ${p.type} #${p.ticket} ${p.tf} entry=${p.price_open} sl=${curSL}`);
    }
    const initialSL = Number(state[key].initialSL);
    try {
      const sp = await specsFor(p.symbol);
      const sec = TF_SEC[p.tf];
      const need = Math.min(5000, Math.ceil((Date.now() / 1000 - Number(p.time)) / sec) + 400);
      const ck = p.symbol + "|" + p.tf;
      if (!barCache[ck]) {
        const r = await mt5.candles(p.tf, Math.max(400, need), p.symbol);
        barCache[ck] = r && r.status === "ok" && Array.isArray(r.candles) ? r.candles : [];
      }
      const out = computeStop(T, cfg, p, initialSL, barCache[ck], sp.point);
      if (!out || !out.active) continue;
      const isBuy = p.type === "BUY";
      let target = out.stop;
      const minStep = Math.max(0.1 * (out.atr || 0), sp.point * 5);
      if (isBuy ? target < curSL + minStep : target > curSL - minStep) continue;   // not meaningfully tighter
      if (!quote) quote = await mt5.currentPrice(p.symbol);
      if (!quote || quote.status !== "ok") continue;
      const bid = Number(quote.bid), ask = Number(quote.ask);
      const buffer = Math.max(0.1 * (out.atr || 0), (ask - bid), sp.point * 10);
      // price already went past the trailing level -> put the stop just behind the price
      if (isBuy && target > bid - buffer) target = bid - buffer;
      if (!isBuy && target < ask + buffer) target = ask + buffer;
      const f = Math.pow(10, sp.digits);
      target = Math.round(target * f) / f;               // buffer above is >= 10 points, so rounding cannot cross the price
      if (isBuy ? target <= curSL : target >= curSL) continue;
      const r = await mt5.modifySL(p.ticket, target);
      if (r && r.status === "OK") {
        state[key].lastSl = target; state[key].lastMove = new Date().toISOString(); changed = true;
        logger.worker(`[TRAIL] ${p.type} #${p.ticket} ${p.tf} stop ${curSL} -> ${target} (best=${Number(out.best).toFixed(2)} atr=${Number(out.atr).toFixed(2)})`);
      } else {
        logger.worker(`[TRAIL] ${p.type} #${p.ticket} move to ${target} refused: ${r && (r.message || r.status)}`);
      }
    } catch (e) {
      logger.error(`[TRAIL] #${p.ticket}: ${e.message}`);
    }
  }
  if (changed) writeState(state);
}

module.exports = { run, computeStop, COMMENT_RE, STATE_FILE };
