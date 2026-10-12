// =====================================================================
// ADDED 2026-10-09 — short trades: direction from H4, entry/exit on M5.
// Rules LOCKED (same as the tested version, do not change during the test):
//   1. An H4 auto signal that passes every normal check does NOT open a trade
//      at once. It starts an 8-hour "waiting" window (96 M5 candles).
//   2. Entry: SELL -> wait for an M5 close ABOVE EMA20(M5) (pullback), then the
//      first M5 close back BELOW EMA20 -> sell at once. BUY is the mirror.
//      No trigger inside 8 hours -> no trade.
//   3. Stop: highest high (SELL) / lowest low (BUY) since the H4 signal
//      + 0.1 x ATR(M5); at least 1 x ATR(M5) from the entry price.
//   4. Take-profit far away (10 x risk). The trailing stop (break-even, then
//      2 x ATR(M15) behind the best price, moved on every M5 close) closes winners.
//   5. Every trade is closed after 8 hours at most.
// Orders go through the backend like every auto order (all its checks apply).
// Comment on the MT5 order: "GL<symbol>M5<H4 candle time>".
// =====================================================================
"use strict";
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const logger = require("./logger");
const store = require("./store");
const mt5 = require("./mt5-client");

const STATE_FILE = path.join(store.WORKER_DATA_DIR, "ltf-state.json");
const MAGIC = 20250817;
const WINDOW_BARS = 96;          // 8 hours of M5 candles
const MAX_HOLD_SEC = 8 * 3600;   // 8 hours
const LTF_RE = /^GL.*?M5(\d{10})$/;

function readState() {
  try { const r = fs.readFileSync(STATE_FILE, "utf8"); return r.trim() ? JSON.parse(r) : { setups: [] }; }
  catch (_) { return { setups: [] }; }
}
function writeState(s) {
  try {
    if (!fs.existsSync(store.WORKER_DATA_DIR)) fs.mkdirSync(store.WORKER_DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    try { fs.renameSync(tmp, STATE_FILE); } catch (_) { fs.copyFileSync(tmp, STATE_FILE); try { fs.unlinkSync(tmp); } catch (__) {} }
  } catch (e) { logger.error(`[LTF] could not save ltf-state.json: ${e.message}`); }
}

function ema(vals, span) {
  const a = 2 / (span + 1), out = new Array(vals.length); let e = vals[0];
  for (let i = 0; i < vals.length; i++) { e = i === 0 ? vals[0] : e + a * (vals[i] - e); out[i] = e; }
  return out;
}

/**
 * Pure: look for the entry trigger inside the window.
 * bars = closed M5 candles (oldest first), e20/atr5 = arrays for those bars,
 * start = index of the first M5 bar of the window, dir = 1 BUY / -1 SELL.
 * Returns { state: "WAIT" | "TRIGGER" | "EXPIRED", j, ext }.
 */
function findTrigger(bars, e20, atr5, start, dir) {
  let pulled = false;
  const end = Math.min(bars.length, start + WINDOW_BARS);
  for (let j = start; j < end; j++) {
    const c = bars[j].close;
    if (!pulled) { pulled = dir < 0 ? c > e20[j] : c < e20[j]; continue; }
    if ((dir < 0 && c < e20[j]) || (dir > 0 && c > e20[j])) {
      let ext = dir < 0 ? -Infinity : Infinity;
      for (let q = start; q <= j; q++) ext = dir < 0 ? Math.max(ext, bars[q].high) : Math.min(ext, bars[q].low);
      ext = dir < 0 ? ext + 0.1 * atr5[j] : ext - 0.1 * atr5[j];
      return { state: "TRIGGER", j, ext };
    }
  }
  return { state: bars.length - start >= WINDOW_BARS ? "EXPIRED" : "WAIT" };
}

/** Pure: stop from the trigger, using the real entry price. null = no valid trade. */
function stopFor(dir, entryPrice, ext, atr5) {
  let stop = Math.abs(ext - entryPrice) >= atr5 ? ext : entryPrice - dir * atr5;
  if ((dir > 0 && stop >= entryPrice) || (dir < 0 && stop <= entryPrice)) return null;
  return stop;
}

/** Called by the worker when an H4 auto signal passed every check. */
function addSetup(s) {
  const st = readState();
  if (st.setups.some(x => x.id === s.id)) return;
  st.setups.push(Object.assign({ status: "WAITING", createdAt: new Date().toISOString() }, s));
  writeState(st);
  logger.worker(`[LTF] ${s.dir > 0 ? "BUY" : "SELL"} from H4 — waiting up to 8h for an M5 pullback entry (id ${s.id})`);
}

async function run(engines, control, requestExecution) {
  const cfg = engines && engines.GoldAI_Config;
  const T = engines && engines.GoldAI_Trade;
  if (!cfg || !T) return;
  const st = readState();
  let changed = false;
  const symbol = mt5.DEFAULT_SYMBOL;

  const r5 = await mt5.candles("M5", 300, symbol);
  const bars = r5 && r5.status === "ok" && Array.isArray(r5.candles) ? r5.candles : [];
  if (bars.length < 120) return;
  const last = bars[bars.length - 1];
  const brokerNow = last.time + 300;           // close time of the newest closed M5 candle (broker clock)

  // ---- 8-hour limit for open short trades (runs even if the switch is off) ----
  try {
    const pr = await mt5.positions();
    if (pr && pr.status === "ok" && Array.isArray(pr.positions)) {
      for (const p of pr.positions) {
        if (Number(p.magic) !== MAGIC || !LTF_RE.test(String(p.comment || ""))) continue;
        if (Number(p.time) > 0 && brokerNow - Number(p.time) >= MAX_HOLD_SEC) {
          const c = await mt5.closePosition(p.ticket);
          logger.worker(`[LTF] 8h limit: closing ${p.type} #${p.ticket} -> ${c && (c.status + " " + (c.message || ""))}`);
        }
      }
    }
  } catch (e) { logger.error(`[LTF] time-limit check failed: ${e.message}`); }

  const waiting = st.setups.filter(s => s.status === "WAITING");
  if (waiting.length) {
    const e20 = ema(bars.map(b => b.close), 20);
    const atr5 = T.atrWilder(bars, 14);
    for (const s of waiting) {
      const start = bars.findIndex(b => b.time >= s.startTime);
      if (start < 0) {                                     // window not started yet (or data gap)
        if (brokerNow - s.startTime > MAX_HOLD_SEC + 3600) { s.status = "EXPIRED"; changed = true; }
        continue;
      }
      if (start === 0 && bars[0].time > s.startTime + 300) { s.status = "EXPIRED"; s.note = "window older than data"; changed = true; continue; }
      const t = findTrigger(bars, e20, atr5, start, s.dir);
      if (t.state === "EXPIRED") { s.status = "EXPIRED"; changed = true; logger.worker(`[LTF] ${s.id}: no M5 entry within 8h — no trade`); continue; }
      if (t.state !== "TRIGGER") continue;
      if (t.j !== bars.length - 1) {                       // trigger was on an older candle (worker was down)
        s.status = "MISSED"; s.note = "entry candle already passed"; changed = true;
        logger.worker(`[LTF] ${s.id}: entry moment already passed — skipped`); continue;
      }
      // ---- trigger on the newest closed candle: send the order now ----
      s.status = "SENDING"; changed = true;
      try {
        const sysOn = control && control.system && control.system.enabled === true;
        const tr = (control && control.trading) || {};
        if (!(sysOn && tr.tradeMode === "auto" && tr.autoTradingEnabled === true)) { s.status = "SKIPPED_AUTO_OFF"; continue; }
        const q = await mt5.currentPrice(symbol);
        const price = q && q.status === "ok" ? Number(s.dir > 0 ? q.ask : q.bid) : NaN;
        if (!(price > 0)) { s.status = "SKIPPED_NO_PRICE"; continue; }
        const stop = stopFor(s.dir, price, t.ext, atr5[t.j]);
        if (stop == null) { s.status = "SKIPPED_BAD_STOP"; continue; }
        const risk = Math.abs(price - stop);
        let equity = Number(cfg.DEFAULT_CAPITAL) || 10000, specs = {};
        try { const a = await axios.get(`${mt5.BRIDGE_URL}/account-info`, { timeout: 4000 }); if (Number(a.data && a.data.equity) > 0) equity = Number(a.data.equity); } catch (_) {}
        try { const si = await mt5.symbolInfo(symbol); if (si && si.status === "ok") specs = si; } catch (_) {}
        const riskMoney = equity * (Number(cfg.DEFAULT_RISK_PERCENT) || 1) / 100;
        const lot = T.computeRiskLot(riskMoney, risk, specs, cfg.SYMBOL || symbol).lot;
        const digits = Number(specs.digits) || 2, f = Math.pow(10, digits);
        const rnd = v => Math.round(v * f) / f;
        const tp = T.farTakeProfit(s.dir > 0, price, stop, cfg);
        const sym = String(symbol).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
        const payload = {
          signal: s.dir > 0 ? "BUY" : "SELL", symbol, entry: price, sl: rnd(stop), tp1: rnd(tp), tp2: null, tp3: null,
          volume: lot, mode: "auto", clientOrderId: `GL${sym}M5${s.candleCloseTime}`.slice(0, 31),
          deviation: Number(cfg.EXECUTION_DEVIATION_POINTS || 20), candleCloseTime: s.startTime, // FIXED 2026-10-10: real CLOSE time of the H4 candle (was its open time -> wrongly 'stale')
          timeframe: s.tf, confidence: s.confidence
        };
        logger.worker(`[LTF] ${s.id}: M5 entry ${payload.signal} lot=${lot} entry=${price} sl=${payload.sl} tp=${payload.tp1} risk=$${risk.toFixed(2)}`);
        const res = await requestExecution(payload);
        const ok = res && res.data && (res.data.executionState === "EXECUTED" || res.data.status === "FILLED");
        s.status = ok ? "EXECUTED" : "REJECTED"; s.result = res && res.data && (res.data.executionState || res.data.status);
        s.order = { entry: price, sl: payload.sl, tp: payload.tp1, lot };
        logger.worker(`[LTF] ${s.id}: execution result ${s.result}`);
      } catch (e) {
        s.status = "ERROR"; s.note = e.message; logger.error(`[LTF] ${s.id}: ${e.message}`);
      }
    }
  }
  // keep the file small: forget finished setups older than 3 days
  const keepAfter = brokerNow - 3 * 86400;
  const before = st.setups.length;
  st.setups = st.setups.filter(s => s.status === "WAITING" || s.startTime >= keepAfter);
  if (changed || st.setups.length !== before) writeState(st);
}

module.exports = { run, addSetup, findTrigger, stopFor, ema, STATE_FILE, WINDOW_BARS, LTF_RE };
