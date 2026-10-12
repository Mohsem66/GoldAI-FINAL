/**
 * GoldAI — WHY do signals lose in the afternoon/night? (diagnostics, read-only)
 *
 * Runs the normal backtest (same engine and settings as the live worker) over the
 * last N days with every signal's indicator values attached, plus plain market
 * statistics per hour (range, spread, how "trendy" vs "choppy" the price is).
 * Never sends orders and never changes settings. Writes only its own files:
 *   backend/data/diagnose-<TF>.json   (summary)
 *   backend/data/diagnose-<TF>.csv    (one row per signal, traded and not traded)
 *
 *   cd C:\GoldAI-FINAL\backend
 *   node worker\diagnose-sessions.js            (M5, 60 days)
 *   set BT_TF=M15&& node worker\diagnose-sessions.js
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { loadEngines } = require("./engine-loader");

const BRIDGE = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const BACKEND = (process.env.BACKEND_URL || "http://127.0.0.1:5000/api").replace(/\/$/, "");
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSD.";
const TF = String(process.env.BT_TF || "M5").toUpperCase();
const DAYS = Number(process.env.BT_DAYS) || 60;
const DATA = path.join(__dirname, "..", "data");

const cache = new Map();
async function fetchCandles(timeframe, count, start, end) {
  const params = { symbol: SYMBOL, timeframe, count: Math.max(10, Math.min(Number(count) || 4000, 5000)) };
  if (start != null && end != null) { params.start = start; params.end = end; }
  const key = JSON.stringify(params);
  if (!cache.has(key)) cache.set(key, (await axios.get(BRIDGE + "/candles", { params, timeout: 90000 })).data);
  return cache.get(key);
}
async function rangeChunked(tf, startEpoch, endEpoch, tfSeconds, maxBarsPerChunk) {
  const perChunk = Math.max(200, Math.min(Number(maxBarsPerChunk) || 4000, 5000));
  const chunkSeconds = perChunk * (Number(tfSeconds) || 300);
  const all = []; let cur = Math.floor(startEpoch); const endI = Math.floor(endEpoch); let guard = 0;
  while (cur < endI && guard < 800) {
    guard++;
    const chunkEnd = Math.min(endI, cur + chunkSeconds);
    const res = await fetchCandles(tf, perChunk, cur, chunkEnd);
    if (res && res.status === "ok" && res.candles && res.candles.length) all.push(...res.candles);
    cur = chunkEnd;
  }
  const byTime = new Map(); for (const c of all) byTime.set(c.time, c);
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  return { status: merged.length ? "ok" : "unavailable", symbol: SYMBOL, timeframe: tf, candles: merged };
}

function engines() {
  const e = loadEngines();
  Object.assign(e.GoldAI_Config, { SYMBOL, ACTIVE_TIMEFRAME: TF.toLowerCase() });
  e.GoldAI_Data.dataMode = "live";
  e.GoldAI_Data.livePriceOk = true;
  e.GoldAI_Data.fetchMT5History = (tf, count, start, end) => fetchCandles(tf, count, start, end);
  e.GoldAI_Data.fetchMT5RangeChunked = rangeChunked;
  let specs = null;
  e.GoldAI_Data.fetchMT5SymbolSpecs = async () => {
    if (!specs) specs = (await axios.get(BRIDGE + "/symbol-info", { params: { symbol: SYMBOL }, timeout: 8000 })).data;
    return specs;
  };
  return e;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(3)));

/** Plain market behaviour per UTC hour — no engine involved. */
function marketByHour(bars) {
  const H = Array.from({ length: 24 }, () => ({ range: [], spread: [], eff: [], cont: [], absMove: [] }));
  for (let i = 12; i < bars.length - 12; i++) {
    const h = new Date(bars[i].time * 1000).getUTCHours();
    const b = bars[i];
    H[h].range.push(b.high - b.low);
    if (Number.isFinite(Number(b.spread))) H[h].spread.push(Number(b.spread));
    let p = 0; for (let q = i - 11; q <= i; q++) p += Math.abs(bars[q].close - bars[q - 1].close);
    const prev = bars[i].close - bars[i - 12].close, next = bars[i + 12].close - bars[i].close;
    if (p > 0) H[h].eff.push(Math.abs(prev) / p);
    // does the move of the last 12 bars CONTINUE over the next 12 bars? (+1 continue, -1 reverse)
    if (prev !== 0 && next !== 0) H[h].cont.push(Math.sign(prev) === Math.sign(next) ? 1 : 0);
    H[h].absMove.push(Math.abs(next));
  }
  return H.map((x, h) => ({
    hourUTC: h, bars: x.range.length, avgRange: r2(avg(x.range)), avgSpreadPts: r2(avg(x.spread)),
    efficiency12: r2(avg(x.eff)), continuationPct: x.cont.length ? Number((100 * avg(x.cont)).toFixed(1)) : null,
    avgNext12Move: r2(avg(x.absMove))
  }));
}

async function main() {
  let minConf = 68;
  try {
    const ts = (await axios.get(BACKEND + "/mt5/trading-state", { timeout: 5000 })).data;
    if (Number(ts && ts.autoMinConfidence) > 0) minConf = Number(ts.autoMinConfidence);
  } catch (_) {}
  let capital = 10000;
  try {
    const acc = (await axios.get(BRIDGE + "/account-info", { timeout: 8000 })).data || {};
    capital = Number(acc.equity) > 0 ? Number(acc.equity) : (Number(acc.balance) > 0 ? Number(acc.balance) : 10000);
  } catch (_) {}
  const end = new Date(), start = new Date(end.getTime() - DAYS * 86400000);
  console.error(`diagnose ${TF}, ${DAYS} days, min confidence ${minConf} ...`);
  const e = engines();
  const t0 = Date.now();
  const r = await e.GoldAI_Backtest.runRealMT5Backtest({
    entryTF: TF, mode: ["H1", "H4", "D1"].includes(TF) ? "swing" : "scalp",
    rangePreset: "custom", customStart: start.toISOString(), customEnd: end.toISOString(),
    capital, riskPercent: Number(e.GoldAI_Config.DEFAULT_RISK_PERCENT) || 1, minConfidence: minConf,
    slippagePoints: 2, commissionPerLot: 7, tpTarget: "tp1",
    liveWindow: true, shadow: true, features: true
  });
  console.error(`backtest done in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (r.errors && r.errors.length) { console.error("ERRORS:", r.errors.join(" | ")); process.exit(1); }

  // rows: every traded or paper (not traded) signal with its features
  const rows = [];
  for (const j of r.journal) {
    const t = j.executed ? j : j.shadow;
    if (!t || t.exitReason === "UNRESOLVED") continue;
    const dir = j.executed ? (String(j.signal).includes("BUY") ? "BUY" : "SELL") : j.shadow.dir;
    rows.push(Object.assign({
      time: j.timeISO, hourUTC: new Date(j.time * 1000).getUTCHours(), group: j.executed ? "traded" : "not_traded",
      reason: j.executed ? "" : j.shadow.reason, dir, conf: j.confidence,
      R: t.rMultiple, result: t.exitReason, bars: t.duration,
      slDist: Number(Math.abs(t.entry - t.stopLoss).toFixed(3)), tpDist: Number(Math.abs(t.takeProfit - t.entry).toFixed(3))
    }, j.f || {}));
  }
  const cols = Object.keys(rows[0] || { time: 1 });
  const q = (v) => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  fs.writeFileSync(path.join(DATA, `diagnose-${TF}.csv`), [cols.join(",")].concat(rows.map((x) => cols.map((c) => q(x[c])).join(","))).join("\n"));

  const bars = (await rangeChunked(TF, Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000), e.GoldAI_Backtest.TF_SECONDS[TF], 4000)).candles;
  const out = {
    createdAt: new Date().toISOString(), tf: TF, days: DAYS, minConfidence: minConf, capital,
    start: start.toISOString(), end: end.toISOString(), signals: rows.length,
    traded: r.groups && r.groups.traded, notTraded: r.groups && r.groups.notTraded,
    market: marketByHour(bars.map((b) => ({ time: Number(b.time), open: +b.open, high: +b.high, low: +b.low, close: +b.close, spread: b.spread })))
  };
  fs.writeFileSync(path.join(DATA, `diagnose-${TF}.json`), JSON.stringify(out, null, 2));

  // short console summary: per hour, signals result vs market behaviour
  console.log(`\nhour(UTC) | signals | avg R  | trend-continuation % | efficiency | spread`);
  for (let h = 0; h < 24; h++) {
    const rs = rows.filter((x) => x.hourUTC === h).map((x) => x.R).filter((x) => x != null);
    const m = out.market[h];
    console.log(`${String(h).padStart(2)}        | ${String(rs.length).padStart(7)} | ${String(r2(avg(rs))).padStart(6)} | ${String(m.continuationPct).padStart(6)} | ${String(m.efficiency12).padStart(6)} | ${m.avgSpreadPts}`);
  }
  console.log(`\nsaved: ${path.join(DATA, `diagnose-${TF}.csv`)} and .json`);
}

main().catch((e) => { console.error("FAILED:", e && e.stack || e); process.exit(1); });
