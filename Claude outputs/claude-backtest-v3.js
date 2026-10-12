/**
 * Claude - read-only backtest of the CURRENT engine on real MT5 M5 candles.
 * Does NOT change any project file. Writes only a new result file in this folder.
 * Usage (from C:\GoldAI-FINAL\backend):
 *   node "..\Claude outputs\claude-backtest-current.js" 60 M5
 * (first = how many days back, default 60; second = M5, M15, H1 or H4, default M5)
 */
const fs = require("fs");
const path = require("path");
const BACKEND = path.join(__dirname, "..", "backend");
const axios = require(path.join(BACKEND, "node_modules", "axios"));
const { loadEngines } = require(path.join(BACKEND, "worker", "engine-loader"));

const DAYS = Math.max(7, Math.min(Number(process.argv[2]) || 60, 365));
const TF_IN = String(process.argv[3] || "M5").toUpperCase();
const TF = ["M5", "M15", "H1", "H4"].includes(TF_IN) ? TF_IN : "M5";
const BRIDGE = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSD.";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const OUT = path.join(__dirname, `backtest-${TF}-${DAYS}d-current-${stamp}.json`);

async function fetchCandles(timeframe, count, start, end) {
  const params = { symbol: SYMBOL, timeframe, count: Math.max(10, Math.min(Number(count) || 4000, 5000)) };
  if (start != null && end != null) { params.start = start; params.end = end; }
  const t0 = Date.now();
  const res = await axios.get(BRIDGE + "/candles", { params, timeout: 90000 });
  const n = res.data && res.data.candles ? res.data.candles.length : 0;
  console.log(`[${new Date().toISOString()}] fetched ${timeframe} ${n} bars in ${Date.now() - t0} ms`);
  return res.data;
}

async function main() {
  const engines = loadEngines();
  const cfg = engines.GoldAI_Config;
  cfg.SYMBOL = SYMBOL;
  cfg.ACTIVE_TIMEFRAME = TF.toLowerCase();
  engines.GoldAI_Data.dataMode = "live";
  engines.GoldAI_Data.livePriceOk = true;
  engines.GoldAI_Data.fetchMT5History = (tf, count, start, end) => fetchCandles(tf, count, start, end);
  engines.GoldAI_Data.fetchMT5RangeChunked = async (tf, startEpoch, endEpoch, tfSeconds, maxBarsPerChunk) => {
    const perChunk = Math.max(200, Math.min(Number(maxBarsPerChunk) || 4000, 5000));
    const chunkSeconds = perChunk * (Number(tfSeconds) || 300);
    const all = []; let cur = Math.floor(startEpoch); const endI = Math.floor(endEpoch); let guard = 0;
    while (cur < endI && guard < 2000) {
      guard++;
      const chunkEnd = Math.min(endI, cur + chunkSeconds);
      const res = await fetchCandles(tf, perChunk, cur, chunkEnd);
      if (res && res.status === "ok" && res.candles && res.candles.length) all.push(...res.candles);
      cur = chunkEnd;
    }
    const byTime = new Map(); for (const c of all) byTime.set(c.time, c);
    const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    return { status: merged.length ? "ok" : "unavailable", symbol: SYMBOL, timeframe: tf, candles: merged };
  };
  engines.GoldAI_Data.fetchMT5SymbolSpecs = async () =>
    (await axios.get(BRIDGE + "/symbol-info", { params: { symbol: SYMBOL }, timeout: 8000 })).data;

  const capital = 500; // the real starting capital the user plans
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 24 * 3600 * 1000);
  const _log = console.log; let _last = 0;
  console.log(`Started at ${new Date().toISOString()}`);
  const _hb = setInterval(() => _log(`[${new Date().toISOString()}] still working...`), 5 * 60 * 1000);
  console.log(`Running ${DAYS} days on ${SYMBOL} ${TF} ... (this can take several minutes)`);

  const report = await engines.GoldAI_Backtest.runRealMT5Backtest({
    entryTF: TF, mode: "scalp", rangePreset: "custom",
    customStart: start.toISOString(), customEnd: end.toISOString(),
    capital, riskPercent: Number(cfg.DEFAULT_RISK_PERCENT) || 1,
    minConfidence: Number(cfg.MIN_CONFIDENCE) || 68,
    slippagePoints: 2, commissionPerLot: 7, tpTarget: "tp1",
    liveWindow: true // same history window as the live worker (and much faster)
  });
  report.configSnapshot = {
    MIN_CONFIDENCE: cfg.MIN_CONFIDENCE, AUTO_MIN_CONFIDENCE: cfg.AUTO_MIN_CONFIDENCE,
    RISK_V2: cfg.RISK_V2, TRAIL_ENABLED: cfg.TRAIL_ENABLED, TRAIL_START_R: cfg.TRAIL_START_R,
    TRAIL_ATR_MULT: cfg.TRAIL_ATR_MULT
  };
  const slim = { ...report, journal: (report.journal || []).filter((r) => r.executed) };
  fs.writeFileSync(OUT, JSON.stringify(slim, null, 2));
  console.log(JSON.stringify({
    file: OUT, testStart: report.testStart, testEnd: report.testEnd, candles: report.testCandles,
    buySignals: report.buySignals, sellSignals: report.sellSignals,
    executableSignals: report.executableSignals, trades: slim.journal.length,
    winRate: report.winRate, profitFactor: report.profitFactor, netPL: report.netPL,
    maxDrawdownPct: report.maxDrawdownPct, errors: report.errors
  }, null, 2));
  clearInterval(_hb);
  console.log("DONE " + new Date().toISOString());
}
main().catch((e) => { console.error("BACKTEST_FAIL", e && e.stack ? e.stack : e); process.exit(1); });
