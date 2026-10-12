/**
 * Claude - READ-ONLY export of real MT5 candles to CSV files (for research).
 * Changes no project file and places no order. Writes only into:
 *   C:\GoldAI-FINAL\Claude outputs\candles\
 * Usage (from C:\GoldAI-FINAL\backend):
 *   node "..\Claude outputs\claude-export-candles.js"
 */
const fs = require("fs");
const path = require("path");
const axios = require(path.join(__dirname, "..", "backend", "node_modules", "axios"));
const BRIDGE = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSD.";
const OUT_DIR = path.join(__dirname, "candles");
const PLAN = [ ["M5", 365, 300], ["M15", 730, 900], ["H1", 730, 3600], ["H4", 1095, 14400], ["D1", 1825, 86400] ];

async function fetchRange(tf, start, end, sec) {
  const per = 4000, all = new Map();
  for (let cur = start, guard = 0; cur < end && guard < 3000; guard++) {
    const chunkEnd = Math.min(end, cur + per * sec);
    const res = await axios.get(BRIDGE + "/candles", { params: { symbol: SYMBOL, timeframe: tf, count: per, start: cur, end: chunkEnd }, timeout: 90000 });
    const c = res.data && res.data.candles;
    if (Array.isArray(c)) for (const b of c) all.set(b.time, b);
    cur = chunkEnd;
  }
  return Array.from(all.values()).sort((a, b) => a.time - b.time);
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const specs = (await axios.get(BRIDGE + "/symbol-info", { params: { symbol: SYMBOL }, timeout: 8000 })).data;
  fs.writeFileSync(path.join(OUT_DIR, "symbol-info.json"), JSON.stringify(specs, null, 2));
  const now = Math.floor(Date.now() / 1000);
  for (const [tf, days, sec] of PLAN) {
    const t0 = Date.now();
    const bars = await fetchRange(tf, now - days * 86400, now, sec);
    if (!bars.length) { console.log(`${tf}: NO DATA`); continue; }
    const cols = Object.keys(bars[0]);
    const lines = [cols.join(",")].concat(bars.map((b) => cols.map((k) => b[k]).join(",")));
    fs.writeFileSync(path.join(OUT_DIR, `${SYMBOL.replace(/\W/g, "")}_${tf}.csv`), lines.join("\n"));
    console.log(`${tf}: ${bars.length} bars from ${new Date(bars[0].time * 1000).toISOString()} (${Date.now() - t0} ms)`);
  }
  console.log("EXPORT DONE");
})().catch((e) => { console.error("EXPORT_FAIL", e && e.message ? e.message : e); process.exit(1); });
