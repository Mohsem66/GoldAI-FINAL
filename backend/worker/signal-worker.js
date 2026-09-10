// =====================================================================
// GoldAI — 24/7 Automatic Signal Worker
// -----------------------------------------------------------------------
// Runs as a plain Node process (`node backend/worker/signal-worker.js`).
// Has NO dependency on a browser, Firefox, index.html, or the Express
// backend being up — it talks to the MT5 bridge directly and writes
// signals straight to backend/data/signals.json. Closing the frontend or
// even the whole backend server does not stop this process.
//
// Uses the EXACT SAME analysis engines as the frontend / Real MT5 Backtest
// (loaded via engine-loader.js from js/engines/*.js) — there is no second,
// hand-written analysis implementation here. See buildSignalForTimeframe().
//
// Monitors M5 (scalp) and M15 (swing) independently. Evaluates a timeframe
// only once its candle has actually CLOSED (bridge already excludes the
// still-forming bar) — dedup key = symbol|timeframe|candleCloseTime,
// persisted to disk so a restart never re-fires (or skips) a candle.
//
// Never calls anything execution-related. AUTO_TRADING_ENABLED stays false
// and is not read anywhere in this file.
// =====================================================================
const path = require("path");
const logger = require("./logger");
const store = require("./store");
const mt5 = require("./mt5-client");
const { loadEngines } = require("./engine-loader");

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 20000;
const ENTRY_COUNT = Number(process.env.WORKER_CANDLE_COUNT) || 400; // enough for EMA200 + buffer
const M1_COUNT = Number(process.env.WORKER_M1_COUNT) || 1500;

const TIMEFRAMES = [
  { tf: "M5", mode: "scalp" },
  { tf: "M15", mode: "swing" },
];

let engines = null; // set by loadEnginesOnce()
let stopped = false;
let cycleTimer = null;

function loadEnginesOnce() {
  if (!engines) engines = loadEngines();
  return engines;
}

function nowISO() { return new Date().toISOString(); }

// ---- one signal evaluation for one timeframe --------------------------

async function evaluateTimeframe(tfCfg, m1Bars) {
  const { tf, mode } = tfCfg;
  const symbol = mt5.DEFAULT_SYMBOL;
  const B = engines.GoldAI_Backtest;
  const cfg = engines.GoldAI_Config;

  const entryRes = await mt5.candles(tf, ENTRY_COUNT, symbol);
  if (!entryRes || entryRes.status !== "ok" || !entryRes.candles || entryRes.candles.length < 220) {
    logger.mt5(`[${tf}] not enough real candles yet (${entryRes && entryRes.candles ? entryRes.candles.length : 0}) — skipping this cycle`);
    return null;
  }
  const entryBars = B.toBars(entryRes.candles);
  const barSeconds = B.TF_SECONDS[tf];
  const lastClosed = entryBars[entryBars.length - 1];
  const candleKey = `${symbol}|${tf}|${lastClosed.time}`;

  const state = store.getState();
  if (state.lastCandle[tf] === candleKey) {
    return { skipped: true, reason: "already evaluated this candle", candleKey };
  }

  const entrySeries = B.seriesOf(entryBars);
  const htfBucketSeconds = mode === "swing" ? B.TF_SECONDS.H4 : B.TF_SECONDS.H1;
  const htfBarsFull = B.resample(entryBars, barSeconds, htfBucketSeconds);
  const htfSeries = B.seriesOf(htfBarsFull);

  let microBarsFull;
  if (mode === "swing") {
    microBarsFull = entryBars; // mirrors js/engines/backtest.js's own M15/swing branch exactly
  } else {
    microBarsFull = (m1Bars && m1Bars.length) ? m1Bars : entryBars;
  }
  const microSeries = B.seriesOf(microBarsFull);

  const price = lastClosed.close;

  // This IS the live moment — all fetched data is, by definition, already
  // known "now", so no additional look-ahead slicing is needed the way the
  // backtest walk-forward loop needs it.
  engines.GoldAI_Data.dataMode = "live";
  engines.GoldAI_Data.livePriceOk = true;

  const { final, atr } = B.buildSignal(
    { closes: entrySeries.closes, highs: entrySeries.highs, lows: entrySeries.lows, volumes: entrySeries.volumes, candles: entrySeries.candles },
    { closes: htfSeries.closes, highs: htfSeries.highs, lows: htfSeries.lows },
    { closes: microSeries.closes },
    cfg, price
  );

  let plan = null;
  if (final.signal && !final.signal.includes("WAIT") && atr) {
    try {
      plan = engines.GoldAI_Trade.createTradePlan(final.signal, price, atr, cfg.DEFAULT_CAPITAL || 10000, cfg.DEFAULT_RISK_PERCENT || 1, cfg, cfg.SYMBOL_SPECS || {});
    } catch (e) {
      logger.error(`[${tf}] trade plan failed: ${e.message}`);
    }
  }

  const entry = {
    id: `${Date.now()}_${tf}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowISO(),
    symbol, timeframe: tf, mode,
    candleTimestamp: lastClosed.time,
    candleTimeISO: new Date(lastClosed.time * 1000).toISOString(),
    signal: final.signal,
    price,
    score: final.confidence,
    confidence: final.confidence,
    reason: final.reason || (final.warnings || []).join("; "),
    warnings: final.warnings || [],
    stopLoss: plan ? plan.stopLoss : null,
    tp1: plan ? plan.tp1 : null,
    tp2: plan ? plan.tp2 : null,
    tp3: plan ? plan.tp3 : null,
    source: "MT5",
    dataSource: "MT5",
    workerStatus: "RUNNING",
    executionEligible: false, // Auto Trading is not wired in this build
    executionStatus: "NOT_EXECUTED",
  };

  store.setLastCandle(tf, candleKey);
  store.appendSignal(entry);
  logger.signal(`[${tf}] ${entry.signal} conf=${entry.confidence} price=${entry.price} candle=${entry.candleTimeISO}`);
  return entry;
}

// ---- one full poll cycle: health check, then both timeframes ----------

async function runCycle() {
  let health;
  try {
    health = await mt5.health();
  } catch (e) {
    store.setStatus({ state: "MT5_DISCONNECTED", mt5Connected: false, message: `bridge unreachable: ${e.message}` });
    logger.mt5(`bridge unreachable: ${e.message} — will retry`);
    return;
  }

  const connected = !!(health && health.connected);
  if (!connected) {
    store.setStatus({ state: "MT5_DISCONNECTED", mt5Connected: false, message: health && health.message || "MT5 not connected" });
    logger.mt5(`MT5 reports not connected: ${JSON.stringify(health)}`);
    return; // never generate a signal without a real, live MT5 connection
  }

  loadEnginesOnce();

  let m1Bars = [];
  try {
    const m1Res = await mt5.candles("M1", M1_COUNT);
    if (m1Res && m1Res.status === "ok" && m1Res.candles) {
      m1Bars = engines.GoldAI_Backtest.toBars(m1Res.candles);
    }
  } catch (e) {
    logger.mt5(`M1 fetch failed (microstructure will fall back): ${e.message}`);
  }

  const results = {};
  for (const tfCfg of TIMEFRAMES) {
    try {
      results[tfCfg.tf] = await evaluateTimeframe(tfCfg, m1Bars);
    } catch (e) {
      logger.error(`[${tfCfg.tf}] evaluation failed: ${e.stack || e.message}`);
      results[tfCfg.tf] = { error: e.message };
    }
  }

  store.setStatus({
    state: "RUNNING",
    mt5Connected: true,
    account: { login: health.login || null, server: health.server || null, symbol: health.symbol || mt5.DEFAULT_SYMBOL },
    server: health.server || null,
    lastSuccessfulRun: nowISO(),
    message: "ok",
  });
}

async function loopForever() {
  if (stopped) return;
  try {
    await runCycle();
  } catch (e) {
    logger.error(`unexpected cycle error (worker keeps running): ${e.stack || e.message}`);
    store.setStatus({ state: "ERROR", message: e.message });
  } finally {
    if (!stopped) cycleTimer = setTimeout(loopForever, POLL_MS);
  }
}

function start() {
  stopped = false;
  logger.worker(`GoldAI Signal Worker starting — bridge=${mt5.BRIDGE_URL} symbol=${mt5.DEFAULT_SYMBOL} poll=${POLL_MS}ms`);
  logger.worker(`Signals will be written to: ${store.JOURNAL_FILE}`);
  store.setStatus({ state: "RUNNING", startedAt: nowISO(), message: "starting" });
  loopForever();
}

function stop() {
  stopped = true;
  if (cycleTimer) clearTimeout(cycleTimer);
  store.setStatus({ state: "STOPPED", message: "stopped" });
  logger.worker("Signal Worker stopped");
}

// A single bad tick, a bridge timeout, or an unexpected exception must NEVER
// kill this process — that would defeat the entire point of "24/7".
process.on("uncaughtException", (err) => {
  logger.error(`uncaughtException (worker keeps running): ${err.stack || err.message}`);
  store.setStatus({ state: "ERROR", message: String(err.message || err) });
});
process.on("unhandledRejection", (reason) => {
  logger.error(`unhandledRejection (worker keeps running): ${reason && reason.stack ? reason.stack : reason}`);
  store.setStatus({ state: "ERROR", message: String(reason) });
});
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

if (require.main === module) {
  start();
}

module.exports = { start, stop, runCycle };
