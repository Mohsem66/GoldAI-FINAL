// =====================================================================
// GoldAI — 24/7 Automatic Signal + Auto Execution Worker
// -----------------------------------------------------------------------
// Runs as a plain Node process (`node backend/worker/signal-worker.js`).
// Has NO dependency on a browser. Talks to MT5 bridge for market data and
// to Backend (:5000) for control state + authenticated execution.
//
// Uses the EXACT SAME analysis engines as the frontend / Real MT5 Backtest
// (loaded via engine-loader.js from js/engines/*.js).
//
// Active timeframe comes from Server trading-state (not hardcoded M5/M15).
// Auto orders go ONLY through Backend POST /api/mt5/send-signal so that
// SYSTEM / MODE / AUTO_TRADING / Risk / Claim / Ledger all apply.
// =====================================================================
const path = require("path");
const axios = require("axios");
const logger = require("./logger");
const store = require("./store");
const mt5 = require("./mt5-client");
const { loadEngines } = require("./engine-loader");
const trail = require("./trail-manager"); // ADDED 2026-10-08 trailing stop

// Load backend/.env if present (GOLD_AI_API_TOKEN, BACKEND_URL) — never log token values
try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch (_) { /* dotenv optional */ }

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 10000; // default 10s; adaptive delay never exceeds 15s
const MAX_POLL_MS = 15000; // hard cap: closed candle → signal within 15s window
const POST_CLOSE_GRACE_MS = 2000; // wait after expected bar close for bridge to publish closed bar
const ENTRY_COUNT = Number(process.env.WORKER_CANDLE_COUNT) || 400;
const M1_COUNT = Number(process.env.WORKER_M1_COUNT) || 1500;
const HTF_COUNT = Number(process.env.WORKER_HTF_COUNT) || 300; // enough for EMA200 on the HTF
const BACKEND_URL = (process.env.BACKEND_URL || "http://127.0.0.1:5000/api").replace(/\/$/, "");
const API_TOKEN = (process.env.GOLD_AI_API_TOKEN || "").trim();
const SUPPORTED_TF = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

let engines = null;
let stopped = false;
let cycleTimer = null;
let cycleBusy = false;

function loadEnginesOnce() {
  if (!engines) {
    engines = loadEngines();
    // Restore the same-direction signal lock saved before the last restart.
    try {
      const snap = store.getCluster();
      if (snap && engines.GoldAI_TradePermission && engines.GoldAI_TradePermission.restoreCluster) {
        engines.GoldAI_TradePermission.restoreCluster(snap);
        logger.worker(`restored signal lock: dir=${snap.lastDir || "-"} tf=${snap.lastTf || "-"}`);
      }
    } catch (e) {
      logger.error(`could not restore signal lock: ${e.message}`);
    }
  }
  return engines;
}

function saveClusterSnapshot() {
  try {
    const perm = engines && engines.GoldAI_TradePermission;
    if (perm && perm.snapshotCluster) store.setCluster(perm.snapshotCluster());
  } catch (e) {
    logger.error(`could not save signal lock: ${e.message}`);
  }
}

/**
 * HTF bars for the bias layer: REAL MT5 bars of the HTF timeframe (same rule
 * as the backtest — see GoldAI_Backtest.htfTimeframeFor), only bars fully
 * closed at `knownTime`. Falls back to resampling the entry bars (closed
 * buckets only) if the bridge cannot deliver them.
 */
async function loadHtfBars(B, tf, mode, entryBars, barSeconds, knownTime, symbol) {
  const htfTF = B.htfTimeframeFor(tf, mode);
  const htfSec = B.TF_SECONDS[htfTF];
  try {
    const res = await mt5.candles(htfTF, HTF_COUNT, symbol);
    if (res && res.status === "ok" && res.candles && res.candles.length > 5) {
      const bars = B.toBars(res.candles).sort((a, b) => a.time - b.time);
      return { bars: B.closedHtfBars(bars, htfSec, knownTime), source: "MT5_REAL_" + htfTF };
    }
  } catch (e) {
    logger.mt5(`[${tf}] ${htfTF} fetch failed: ${e.message}`);
  }
  const resampled = B.resample(entryBars, barSeconds, htfSec);
  return { bars: B.closedHtfBars(resampled, htfSec, knownTime), source: "RESAMPLED_FALLBACK" };
}

function nowISO() { return new Date().toISOString(); }

/**
 * ADDED 2026-10-07 (display only): small copy of the indicator values the
 * engine already computed for this candle, so the dashboard tiles and the
 * indicator details page can show them. Never used for any decision.
 */
function indicatorSnapshot(L) {
  if (!L) return {};
  const n = (v, d) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(d)));
  const out = {};
  try {
    if (L.ema) out.ema = { trend: L.ema.trend, alignment: L.ema.alignment, ema20: n(L.ema.ema20, 2), ema50: n(L.ema.ema50, 2), ema200: n(L.ema.ema200, 2) };
    if (L.rsi) out.rsi = { rsi: n(L.rsi.rsi, 2), zone: L.rsi.zone };
    if (L.atr) out.atr = { atr: n(L.atr.atr, 3), volatility: L.atr.volatility };
    if (L.structure) out.structure = { trend: L.structure.trend, structure: L.structure.structure, bosDir: L.structure.bosDir, chochDir: L.structure.chochDir };
    if (L.macd) out.macd = { hist: n(L.macd.hist, 3) };
    if (L.adx) out.adx = { adx: n(L.adx.adx, 1) };
    if (L.volume) out.volume = { ratio: n(L.volume.ratio, 2) };
    if (L.divergence) out.divergence = { type: L.divergence.type };
    if (L.liquidity) out.liquidity = { sweep: L.liquidity.sweep };
    if (L.candles) out.candles = { pattern: L.candles.pattern };
  } catch (_) {}
  return out;
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  // Prefer Authorization: Bearer (required). X-GoldAI-Token also accepted by Backend.
  if (API_TOKEN) {
    h["Authorization"] = "Bearer " + API_TOKEN;
    h["X-GoldAI-Token"] = API_TOKEN;
  }
  return h;
}

async function fetchControlState() {
  const res = await axios.get(`${BACKEND_URL}/mt5/control-state`, {
    headers: authHeaders(),
    timeout: 5000
  });
  return res.data;
}

function modeForTf(tf) {
  const u = String(tf || "").toUpperCase();
  return (u === "H1" || u === "H4" || u === "D1") ? "swing" : "scalp";
}

/**
 * Schedule next worker cycle so a newly closed bar is evaluated within MAX_POLL_MS.
 * Not a blind fixed interval: targets (nextClose + grace), capped at 15s.
 */
function delayUntilNextCycle(tf, lastClosedUnix) {
  const B = loadEnginesOnce().GoldAI_Backtest;
  const barSec = (B && B.TF_SECONDS && B.TF_SECONDS[tf]) ? B.TF_SECONDS[tf] : 300;
  const now = Date.now();
  if (lastClosedUnix && barSec) {
    const nextCloseMs = (Number(lastClosedUnix) + Number(barSec)) * 1000;
    const target = nextCloseMs + POST_CLOSE_GRACE_MS;
    let delay = target - now;
    if (delay < 1000) delay = 1000; // already past close — check soon
    if (delay > MAX_POLL_MS) delay = MAX_POLL_MS;
    return delay;
  }
  return Math.min(POLL_MS, MAX_POLL_MS);
}



function buildClientOrderId(symbol, tf, candleTime) {
  // Deterministic for a given candle — no wall-clock or random entropy.
  // Keep length safe for MT5 comment field (~31–63 typical); uniqueness = symbol|tf|time.
  const sym = String(symbol || 'XAU').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const tfu = String(tf || 'M5').toUpperCase().slice(0, 4);
  const ct = String(candleTime);
  return (`GA${sym}${tfu}${ct}`).slice(0, 31);
}

/**
 * Ask Backend to execute (never call Bridge order_send directly).
 */
async function requestExecution(payload) {
  const res = await axios.post(`${BACKEND_URL}/mt5/send-signal`, payload, {
    headers: authHeaders(),
    timeout: 20000,
    validateStatus: () => true
  });
  return { statusCode: res.status, data: res.data };
}

// ---- one signal evaluation for one timeframe --------------------------

async function evaluateTimeframe(tf, control) {
  const symbol = mt5.DEFAULT_SYMBOL;
  const B = engines.GoldAI_Backtest;
  const cfg = engines.GoldAI_Config;
  const mode = modeForTf(tf);
  cfg.ACTIVE_TIMEFRAME = String(tf).toLowerCase();

  const entryRes = await mt5.candles(tf, ENTRY_COUNT, symbol);
  if (!entryRes || entryRes.status !== "ok" || !entryRes.candles || entryRes.candles.length < 220) {
    logger.mt5(`[${tf}] not enough real candles yet (${entryRes && entryRes.candles ? entryRes.candles.length : 0}) — skipping this cycle`);
    return null; // do NOT mark candle processed
  }
  const entryBars = B.toBars(entryRes.candles);
  const barSeconds = B.TF_SECONDS[tf];
  if (!barSeconds) {
    logger.error(`[${tf}] TF_SECONDS missing — skip`);
    return null;
  }
  const lastClosed = entryBars[entryBars.length - 1];
  const candleKey = `${symbol}|${tf}|${lastClosed.time}`;

  const state = store.getState();
  if (state.lastCandle[tf] === candleKey) {
    return { skipped: true, reason: "already evaluated this candle", candleKey };
  }

  const entrySeries = B.seriesOf(entryBars);
  // CHANGED: real HTF bars (was: ~33 bars resampled from 400 M5 bars, so the
  // HTF EMA50/200 were never available and an unfinished hour was included).
  const htf = await loadHtfBars(B, tf, mode, entryBars, barSeconds, lastClosed.time + barSeconds, symbol);
  if (htf.source !== "MT5_REAL_" + B.htfTimeframeFor(tf, mode)) {
    logger.mt5(`[${tf}] HTF using ${htf.source} (${htf.bars.length} bars)`);
  }
  const htfSeries = B.seriesOf(htf.bars);

  let microBarsFull = entryBars;
  if (mode === "scalp") {
    try {
      const m1Res = await mt5.candles("M1", M1_COUNT, symbol);
      if (m1Res && m1Res.status === "ok" && m1Res.candles && m1Res.candles.length) {
        microBarsFull = B.toBars(m1Res.candles);
      }
    } catch (e) {
      logger.mt5(`M1 fetch failed (microstructure fall back): ${e.message}`);
    }
  }
  const microSeries = B.seriesOf(microBarsFull);
  const price = lastClosed.close;

  engines.GoldAI_Data.dataMode = "live";
  engines.GoldAI_Data.livePriceOk = true;
  engines.GoldAI_Data.lastPrice = price;
  cfg.LIVE_PRICE = price;

  let final, atr, structure;
  try {
    const built = B.buildSignal(
      { closes: entrySeries.closes, highs: entrySeries.highs, lows: entrySeries.lows, volumes: entrySeries.volumes, candles: entrySeries.candles },
      { closes: htfSeries.closes, highs: htfSeries.highs, lows: htfSeries.lows },
      { closes: microSeries.closes },
      cfg, price
    );
    final = built.final;
    atr = built.atr;
    structure = built.structure;
    if (final && built.layers && !final.layers) final.layers = built.layers;
    saveClusterSnapshot();
  } catch (e) {
    logger.error(`[${tf}] buildSignal failed (candle NOT marked processed): ${e.message}`);
    return { error: e.message, candleKey, processed: false };
  }

  if (!final) {
    logger.error(`[${tf}] empty signal result — candle NOT marked processed`);
    return { error: "empty_final", processed: false };
  }

  let plan = null;
  let planCapital = cfg.DEFAULT_CAPITAL || 10000;
  let planSpecs = cfg.SYMBOL_SPECS || {};
  if (final.signal && !String(final.signal).includes("WAIT") && atr) {
    try {
      // Prefer live account equity from bridge when available
      try {
        const acc = await axios.get(`${mt5.BRIDGE_URL}/account-info`, { timeout: 4000 });
        if (acc.data && Number(acc.data.equity) > 0) planCapital = Number(acc.data.equity);
      } catch (_) {}
      try {
        const si = await mt5.symbolInfo(symbol);
        if (si && si.status === "ok") planSpecs = si;
      } catch (_) {}
      // Display plan (signal-candle close): shown on dashboard / used for MANUAL.
      plan = engines.GoldAI_Trade.createTradePlan(
        final.signal, price, atr, planCapital,
        cfg.DEFAULT_RISK_PERCENT || 1, cfg, planSpecs, structure
      );
    } catch (e) {
      logger.error(`[${tf}] trade plan failed: ${e.message}`);
    }
  }

  const _diag = (final && final.diagnostics) ? final.diagnostics : {};
  const entry = {
    id: `${symbol}|${tf}|${lastClosed.time}`,
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
    lot: plan ? plan.lot : null,
    source: "MT5",
    dataSource: "MT5",
    htfSource: htf.source,
    htfBars: htf.bars.length,
    workerStatus: "RUNNING",
    executionEligible: false,
    executionStatus: "NOT_EXECUTED",
    executionBlocked: final.executionBlocked === true,
    // Display/hydration fields only (do not affect execution gates)
    directionalEdge: final.directionalEdge != null ? final.directionalEdge : _diag.directionalEdge,
    primaryReject: final.primaryReject || _diag.primaryRejectFinal || _diag.primaryReject || null,
    entryQuality: final.entryQuality || null,
    diagnostics: {
      directionalEdge: final.directionalEdge != null ? final.directionalEdge : _diag.directionalEdge,
      confidenceSeed: _diag.confidenceSeed,
      confidenceAfterQuality: _diag.confidenceAfterQuality != null ? _diag.confidenceAfterQuality : final.confidence,
      primaryReject: final.primaryReject || _diag.primaryRejectFinal || _diag.primaryReject || null,
      primaryRejectFinal: final.primaryReject || _diag.primaryRejectFinal || null,
      qualityReasons: (final.qualityReasons || _diag.qualityReasons || []).slice ? (final.qualityReasons || _diag.qualityReasons || []).slice() : (final.qualityReasons || _diag.qualityReasons || []),
      layers: {
        regime: (final.layers && (final.layers.regime || (final.layers.marketRegime && final.layers.marketRegime.regime)))
          || (_diag.layers && _diag.layers.regime) || null,
        htf: (final.layers && final.layers.htf) || (_diag.layers && _diag.layers.htf) || null
      }
    },
    layers: Object.assign({
      regime: (final.layers && final.layers.regime) || (_diag.layers && _diag.layers.regime) || null,
      marketRegime: final.layers && final.layers.marketRegime,
      htf: (final.layers && final.layers.htf) || (_diag.layers && _diag.layers.htf) || null
    }, indicatorSnapshot(final.layers)),
  };

  // Mark candle processed only after successful evaluation (signal object exists).
  // CHANGED: the signal is written to the journal AFTER the execution step below,
  // so signals.json records the real execution result (was always NOT_EXECUTED).
  store.setLastCandle(tf, candleKey);
  const _d = (final && final.diagnostics) ? final.diagnostics : {};
  const _edge = final && final.directionalEdge != null ? final.directionalEdge : _d.directionalEdge;
  const _rej = final && (final.primaryReject || _d.primaryRejectFinal || _d.primaryReject) || "-";
  logger.signal(`[${tf}] ${entry.signal} conf=${entry.confidence} edge=${_edge != null ? _edge : "-"} reject=${_rej} price=${entry.price} candle=${entry.candleTimeISO}`);
  // Observation-only diagnostics (does not affect decision / eligibility)
  if (final && final.diagnostics) {
    try {
      const d = final.diagnostics;
      const _qr = (d.qualityReasons && d.qualityReasons.length) ? d.qualityReasons.join(",") : "-";
      logger.info(`[${tf}] diag edge=${d.directionalEdge} seedConf=${d.confidenceSeed} qualityConf=${d.confidenceAfterQuality} reject=${d.primaryRejectFinal || d.primaryReject || "-"} qualityReasons=${_qr} regime=${(d.layers && d.layers.regime) || "-"} htf=${d.layers && d.layers.htf ? (d.layers.htf.trend + "/" + d.layers.htf.strength) : "-"}`);
    } catch (_) {}
  }

  // ---- Auto execution via Backend (not Bridge direct) -----------------
  const sysOn = control && control.system && control.system.enabled === true;
  const trading = control && control.trading ? control.trading : {};
  const modeAuto = trading.tradeMode === "auto";
  const autoOn = trading.autoTradingEnabled === true;
  const actionable = entry.signal && !String(entry.signal).includes("WAIT")
    && final.executionBlocked !== true
    && (final.tradePermission ? final.tradePermission.dedupOk !== false : true)
    && entry.primaryReject !== "SIGNAL_DEDUP"
    && entry.primaryReject !== "SIGNAL_CLUSTER";
  const minConf = Number(trading.autoMinConfidence != null ? trading.autoMinConfidence : 80);
  const confOk = Number(entry.confidence || 0) >= minConf;

  // CHANGED: auto orders use a plan rebuilt from the LIVE price the order will
  // fill at (ask for BUY, bid for SELL), a single TP (TP2/TP3 are manual-only),
  // and are skipped if reward:risk to TP1 is below cfg.AUTO_MIN_RR.
  let autoPlan = null;
  let autoSkip = null;
  const wantsAuto = sysOn && modeAuto && autoOn && actionable && confOk && plan && plan.stopLoss && plan.tp1 && plan.lot;
  if (wantsAuto) {
    const isSell = String(entry.signal).toUpperCase().includes("SELL");
    try {
      const q = await mt5.currentPrice(symbol);
      const fill = q && q.status === "ok" ? Number(isSell ? q.bid : q.ask) : NaN;
      if (!(fill > 0)) {
        autoSkip = "NO_LIVE_PRICE";
      } else {
        autoPlan = engines.GoldAI_Trade.createAutoExecutionPlan(
          final.signal, fill, atr, planCapital,
          cfg.DEFAULT_RISK_PERCENT || 1, cfg, planSpecs, structure,
          Number(q.ask) - Number(q.bid)           // spread: SELL TP/SL shifted so chart touch = fill
        );
        entry.autoPlan = {
          fillPrice: fill, stopLoss: autoPlan.stopLoss, tp1: autoPlan.tp1,
          lot: autoPlan.lot, rr: autoPlan.rr, minRR: autoPlan.minRR, rrOk: autoPlan.rrOk,
          spreadAdjusted: autoPlan.spreadAdjusted
        };
        if (!autoPlan.rrOk || !autoPlan.lot) autoSkip = "RR_BELOW_MIN";
      }
    } catch (e) {
      autoSkip = "NO_LIVE_PRICE";
      logger.error(`[${tf}] live price for auto plan failed: ${e.message}`);
    }
  }

  if (wantsAuto && !autoSkip && autoPlan) {
    entry.executionEligible = true;
    const clientOrderId = buildClientOrderId(symbol, tf, lastClosed.time);
    // ADDED 2026-10-08: with the trailing stop ON the order gets a far TP, so the
    // trailing stop (not a fixed target) closes winners. Entry gate (min RR to the
    // normal TP) is unchanged.
    let sendTp = autoPlan.tp1;
    if (cfg.TRAIL_ENABLED === true && engines.GoldAI_Trade.farTakeProfit) {
      const far = engines.GoldAI_Trade.farTakeProfit(!String(entry.signal).toUpperCase().includes("SELL"), Number(autoPlan.entry), Number(autoPlan.stopLoss), cfg);
      if (Number.isFinite(far) && far > 0) { sendTp = Number(far.toFixed(2)); entry.autoPlan.tpSent = sendTp; }
    }
    const payload = {
      signal: String(entry.signal).toUpperCase().includes("SELL") ? "SELL" : "BUY",
      symbol,
      entry: autoPlan.entry,
      sl: autoPlan.stopLoss,
      tp1: sendTp,
      tp2: null,
      tp3: null,
      volume: autoPlan.lot,
      mode: "auto",
      clientOrderId,
      deviation: Number(cfg.EXECUTION_DEVIATION_POINTS || 20),
      candleCloseTime: lastClosed.time,
      timeframe: tf,
      confidence: entry.confidence
    };
    try {
      logger.worker(`[${tf}] requesting execution ${payload.signal} lot=${payload.volume} entry=${payload.entry} sl=${payload.sl} tp=${payload.tp1} rr=${autoPlan.rr} cid=${clientOrderId}`);
      const result = await requestExecution(payload);
      entry.executionHttp = result.statusCode;
      entry.executionResponse = result.data;
      if (result.statusCode === 401) {
        entry.executionStatus = "AUTH_FAILED";
        logger.error(`[${tf}] execution auth failed — set GOLD_AI_API_TOKEN on worker and backend`);
      } else if (result.data && (result.data.executionState === "EXECUTED" || result.data.status === "FILLED")) {
        entry.executionStatus = "EXECUTED";
      } else if (result.data && result.data.executionState) {
        entry.executionStatus = result.data.executionState;
      } else {
        entry.executionStatus = "REJECTED_OR_UNKNOWN";
      }
      logger.worker(`[${tf}] execution result: ${entry.executionStatus} ${JSON.stringify(result.data && result.data.status)}`);
    } catch (e) {
      entry.executionStatus = "REQUEST_ERROR";
      entry.executionError = e.message;
      logger.error(`[${tf}] execution request error: ${e.message}`);
    }
  } else if (wantsAuto && autoSkip) {
    entry.executionStatus = "SKIPPED_" + autoSkip;
    logger.worker(`[${tf}] auto order skipped: ${autoSkip}${autoPlan ? ` (rr=${autoPlan.rr} < min ${autoPlan.minRR})` : ""}`);
  } else {
    const why = !sysOn ? "SYSTEM_OFF"
      : !modeAuto ? "MODE_NOT_AUTO"
      : !autoOn ? "AUTO_TRADING_OFF"
      : !actionable ? "WAIT_OR_INVALID"
      : !confOk ? "CONFIDENCE_LOW"
      : !plan ? "NO_PLAN"
      : "NOT_ELIGIBLE";
    entry.executionStatus = "SKIPPED_" + why;
  }

  store.appendSignal(entry);
  return entry;
}

async function runCycle() {
  if (cycleBusy) {
    logger.worker("previous cycle still running — skip overlap");
    return;
  }
  cycleBusy = true;
  try {
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
      store.setStatus({ state: "MT5_DISCONNECTED", mt5Connected: false, message: (health && health.message) || "MT5 not connected" });
      logger.mt5(`MT5 reports not connected`);
      return;
    }

    let control;
    try {
      control = await fetchControlState();
    } catch (e) {
      store.setStatus({ state: "BACKEND_UNREACHABLE", mt5Connected: true, message: `control-state: ${e.message}` });
      logger.error(`Backend control-state unreachable: ${e.message} — signal-only this cycle, no execution`);
      control = { system: { enabled: false }, trading: { tradeMode: "manual", autoTradingEnabled: false, activeTimeframe: "M5" } };
    }

    const tfRaw = (control.trading && control.trading.activeTimeframe) || "M5";
    const tf = String(tfRaw).toUpperCase();
    if (!SUPPORTED_TF.includes(tf)) {
      logger.error(`unsupported activeTimeframe from server: ${tf}`);
      store.setStatus({ state: "UNSUPPORTED_TF", message: tf });
      return;
    }

    loadEnginesOnce();
    const result = await evaluateTimeframe(tf, control);

    // ADDED 2026-10-08: trailing stop for open GoldAI auto trades (does nothing unless TRAIL_ENABLED)
    try { await trail.run(engines); } catch (e) { logger.error(`[TRAIL] cycle error: ${e.message}`); }

    store.setStatus({
      state: "RUNNING",
      mt5Connected: true,
      activeTimeframe: tf,
      systemEnabled: !!(control.system && control.system.enabled),
      tradeMode: control.trading && control.trading.tradeMode,
      autoTradingEnabled: !!(control.trading && control.trading.autoTradingEnabled),
      account: { login: health.login || null, server: health.server || null, symbol: health.symbol || mt5.DEFAULT_SYMBOL },
      lastSuccessfulRun: nowISO(),
      lastEval: result && result.signal ? result.signal : (result && result.skipped ? "skipped" : null),
      message: "ok",
    });
    // Provide last closed bar time for adaptive next-wake scheduling
    const lastClosedUnix = (result && (result.candleTimestamp != null
      ? result.candleTimestamp
      : (result.candleKey ? Number(String(result.candleKey).split("|").pop()) : null)));
    return { tf, lastClosedUnix };
  } finally {
    cycleBusy = false;
  }
}

async function loopForever() {
  if (stopped) return;
  let schedule = null;
  try {
    schedule = await runCycle();
  } catch (e) {
    logger.error(`unexpected cycle error (worker keeps running): ${e.stack || e.message}`);
    store.setStatus({ state: "ERROR", message: e.message });
  } finally {
    if (!stopped) {
      const tf = schedule && schedule.tf;
      const lastClosedUnix = schedule && schedule.lastClosedUnix;
      const delay = delayUntilNextCycle(tf || "M5", lastClosedUnix);
      cycleTimer = setTimeout(loopForever, delay);
    }
  }
}

function start() {
  stopped = false;
  logger.worker(`GoldAI Signal+Execution Worker starting — bridge=${mt5.BRIDGE_URL} backend=${BACKEND_URL} symbol=${mt5.DEFAULT_SYMBOL} pollDefault=${POLL_MS}ms max=${MAX_POLL_MS}ms adaptive`);
  if (!API_TOKEN) {
    logger.error("GOLD_AI_API_TOKEN is empty — auto execution will receive 401 until token is set on both worker and backend");
  }
  store.setStatus({ state: "RUNNING", startedAt: nowISO(), message: "starting" });
  loopForever();
}

function stop() {
  stopped = true;
  if (cycleTimer) clearTimeout(cycleTimer);
  store.setStatus({ state: "STOPPED", message: "stopped" });
  logger.worker("Signal Worker stopped");
}

process.on("uncaughtException", (err) => {
  logger.error(`uncaughtException (worker keeps running): ${err.stack || err.message}`);
  store.setStatus({ state: "ERROR", message: String(err.message || err) });
});
process.on("unhandledRejection", (err) => {
  logger.error(`unhandledRejection (worker keeps running): ${err && (err.stack || err.message || err)}`);
});
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

if (require.main === module) {
  start();
}

module.exports = { start, stop, runCycle, evaluateTimeframe };
