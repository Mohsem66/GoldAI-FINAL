// =====================================
// GoldAI — Score Aggregator (directional edge)
// Confidence here is a TECHNICAL COMPOSITE seed from edge — NOT win probability.
// HTF / Regime / Structure-Quality ownership lives in Signal Quality (conflict-filter).
// Anti-inflation caps retained. No numeric threshold retunes.
// =====================================

/**
 * ENGINE V2 (2026-10-07) — used when GoldAI_Config.ENGINE_V2 === true.
 *
 * Problem fixed: EMA, MACD, ADX(DI), structure trend, RSI momentum, M1 and HTF
 * all measure the SAME thing (is there a trend now?). V1 added them up, so
 * ~97% of the score was "trend", confidence hit its cap on 45% of candles and
 * stopped telling good from bad.
 *
 * V2:
 *  - TREND = ONE vote in [-1..+1] (weighted average of the trend indicators),
 *    worth at most TREND_POINTS (10) points.
 *  - SETUP events add on top, each counted once: divergence, liquidity sweep,
 *    candle pattern, support/resistance, volume spike, BOS, CHoCH.
 *  - RSI zones no longer give contrarian points (OB -> sell / OS -> buy);
 *    RSI only votes momentum inside the trend vote. Extremes are handled as a
 *    penalty in Signal Quality.
 *  - HTF is NOT added here (it is used once, as the HTF gate in Signal Quality).
 *  - Confidence = 50 + 45 * tanh(edge / 12): smooth, never saturates at 100.
 *    edge 5 ~ 68, edge 10 ~ 81, edge 15 ~ 88, edge 20 ~ 92.
 */
function _sgn(v) { return v > 0 ? 1 : v < 0 ? -1 : 0; }
function runScoreEngineV2(layers) {
  const reasons = [], confirms = [], warnings = [];
  const votes = [];
  const vote = (name, dir, w, why) => { votes.push({ name, dir, w }); if (why && dir) reasons.push(why); };

  const ema = layers.ema || {};
  vote("ema", ema.trend === "BULLISH" ? 1 : ema.trend === "BEARISH" ? -1 : 0, 1.0, ema.reason);
  const st = layers.structure || {};
  vote("structure", st.trend === "BULLISH" ? 1 : st.trend === "BEARISH" ? -1 : 0, 1.0, st.reason);
  const macd = layers.macd || {};
  vote("macd", _sgn(Number(macd.hist) || 0), 0.5, macd.reason);
  const adx = layers.adx || {};
  const di = (Number(adx.plusDI) || 0) - (Number(adx.minusDI) || 0);
  vote("adx", Math.abs(di) > 2 ? _sgn(di) : 0, (Number(adx.adx) || 0) >= 25 ? 1.0 : 0.5, adx.reason);
  const rsi = layers.rsi || {};
  const r = Number(rsi.rsi);
  vote("rsi", Number.isFinite(r) ? (r >= 55 ? 1 : r <= 45 ? -1 : 0) : 0, 0.5, rsi.reason);
  if (layers.m1 && layers.m1.independent === true) {
    vote("m1", layers.m1.microstructure === "BULLISH" ? 1 : layers.m1.microstructure === "BEARISH" ? -1 : 0, 0.5);
  }
  const wSum = votes.reduce((a, v) => a + v.w, 0) || 1;
  const trendNet = votes.reduce((a, v) => a + v.dir * v.w, 0) / wSum;          // -1..+1
  const TREND_POINTS = 10;
  let buy = Math.max(0, trendNet) * TREND_POINTS;
  let sell = Math.max(0, -trendNet) * TREND_POINTS;

  // setup events (each counted once)
  const ev = (name, b, s, w, why) => {
    b = (Number(b) || 0) * w; s = (Number(s) || 0) * w;
    if (b || s) { buy += b; sell += s; if (why) confirms.push(why); }
  };
  const div = layers.divergence || {};
  ev("divergence", div.buyScore, div.sellScore, 1.0, div.type && div.type !== "NONE" ? div.reason : null);
  const liq = layers.liquidity || {};
  ev("liquidity", liq.buyScore, liq.sellScore, 1.0, liq.sweep && liq.sweep !== "NONE" ? liq.reason : null);
  const cdl = layers.candles || {};
  ev("candles", cdl.buyScore, cdl.sellScore, 0.7, cdl.pattern && cdl.pattern !== "NONE" ? cdl.reason : null);
  const sr = layers.sr || {};
  ev("sr", sr.buyScore, sr.sellScore, 0.75, (sr.buyScore || sr.sellScore) ? sr.reason : null);
  const vol = layers.volume || {};
  ev("volume", vol.buyScore, vol.sellScore, 0.5, (vol.buyScore || vol.sellScore) ? vol.reason : null);
  if (st.bos && st.bosPts) ev("bos", st.bosDir === "BULLISH" ? st.bosPts : 0, st.bosDir === "BEARISH" ? st.bosPts : 0, 1.0, "BOS " + st.bosDir);
  if (st.choch) ev("choch", st.chochDir === "BULLISH" ? 6 : 0, st.chochDir === "BEARISH" ? 6 : 0, 0.8, "CHoCH " + st.chochDir);

  if (layers.htf && (layers.htf.trend === "BULLISH" || layers.htf.trend === "BEARISH")) {
    confirms.push("HTF " + layers.htf.trend.toLowerCase() + " (gate only, not scored)");
  }

  const buyScore = Number(buy.toFixed(1));
  const sellScore = Number(sell.toFixed(1));
  const diff = Math.abs(buyScore - sellScore);
  if (diff < 1.0) warnings.push("Conflicting / weak edge");

  let signal = "WAIT 🟡";
  if (buyScore > sellScore + 2.0) signal = "BUY 🟢";
  else if (sellScore > buyScore + 2.0) signal = "SELL 🔴";

  let conf = 50 + 45 * Math.tanh(diff / 12);
  conf = Math.round(Math.max(0, Math.min(100, conf)));

  let quality = "LOW";
  if (conf >= 82) quality = "EXCELLENT";
  else if (conf >= 72) quality = "HIGH";
  else if (conf >= 62) quality = "MEDIUM";

  return {
    signal, buyScore, sellScore,
    directionalEdge: diff,
    confidence: conf,
    entryQuality: quality,
    trendNet: Number(trendNet.toFixed(3)),
    trendVotes: votes.map((v) => v.name + ":" + v.dir),
    engineVersion: 2,
    reason: [...new Set(reasons.filter(Boolean))].slice(0, 6).join(" · "),
    confirms: [...new Set(confirms.filter(Boolean))],
    warnings: [...new Set(warnings.filter(Boolean))],
    alignment: diff >= 3 ? "STRONG" : diff >= 1.5 ? "MODERATE" : "WEAK"
  };
}

function runScoreEngine(layers) {
  if (window.GoldAI_Config && window.GoldAI_Config.ENGINE_V2 === true) return runScoreEngineV2(layers);
  let buy = 0, sell = 0;
  const reasons = [];
  const confirms = [];
  const warnings = [];

  const add = (layer, weight = 1) => {
    if (!layer) return;
    buy += (layer.buyScore || 0) * weight;
    sell += (layer.sellScore || 0) * weight;
    if (layer.reason) reasons.push(layer.reason);
    if (layer.confirms) confirms.push(...layer.confirms);
    if (layer.warnings) warnings.push(...layer.warnings);
  };

  add(layers.structure, 1.5);
  add(layers.ema, 1.3);
  add(layers.rsi, 1.1);
  add(layers.divergence, 1.25);
  add(layers.macd, 1.0);
  add(layers.adx, 1.25);
  add(layers.volume, 1.1);
  add(layers.sr, 0.95);
  add(layers.candles, 0.85);
  add(layers.liquidity, 1.4);

  if (layers.fundamental) {
    if (layers.fundamental.simulated !== false) {
      warnings.push("Fundamental is simulated (not live) — weight=0");
    }
    if (layers.fundamental.warnings) warnings.push(...layers.fundamental.warnings);
  }
  if (layers.correlation) {
    if (layers.correlation.simulated !== false) {
      warnings.push("Correlation is simulated (not live) — weight=0");
    }
    if (layers.correlation.warnings) warnings.push(...layers.correlation.warnings);
  }

  if (layers.aiBrain) {
    if (layers.aiBrain.aiSignal && layers.aiBrain.aiSignal.includes("BUY")) {
      buy += 1.5;
      confirms.push("AI meta: bullish bias");
    } else if (layers.aiBrain.aiSignal && layers.aiBrain.aiSignal.includes("SELL")) {
      sell += 1.5;
      confirms.push("AI meta: bearish bias");
    } else if (layers.aiBrain.aiSignal) {
      warnings.push("AI meta: wait / no clear bias");
    }
    if (layers.aiBrain.reasoning) reasons.push(layers.aiBrain.reasoning);
  }

  // HTF directional bias only (no conf penalty — Signal Quality owns HTF once)
  if (layers.htf) {
    if (layers.htf.trend === "BULLISH") {
      buy += 3.5;
      confirms.push("HTF bullish bias");
    }
    if (layers.htf.trend === "BEARISH") {
      sell += 3.5;
      confirms.push("HTF bearish bias");
    }
  }

  // Microstructure only when marked independent (entry TF != micro series)
  if (layers.m1 && layers.m1.independent === true) {
    if (layers.m1.microstructure === "BULLISH") buy += 1.2;
    if (layers.m1.microstructure === "BEARISH") sell += 1.2;
  }

  const buyScore = Number(buy.toFixed(1));
  const sellScore = Number(sell.toFixed(1));
  const diff = Math.abs(buyScore - sellScore);

  if (diff < 1.0) warnings.push("Conflicting / weak edge");

  let signal = "WAIT 🟡";
  if (buyScore > sellScore + 2.0) signal = "BUY 🟢";
  else if (sellScore > buyScore + 2.0) signal = "SELL 🔴";

  // Calibrated technical seed so a CLEAR directional edge can reach STRICT
  // floor (68) after normal quality penalties. Old formula was:
  //   min(52, diff*3.4) + small bonuses → structural max ~64, typically 40–55.
  // Production evidence (3854 journal rows): seed>=68 never occurred, so
  // LOW_CONFIDENCE vetoed even 20–25 edge BUY/SELL setups.
  // Mapping: edge 2 → ~55, edge 8 → ~70, edge 12 → ~79, edge 18 → ~92.
  let conf = 50 + Math.min(Math.max(diff, 0), 18) * 2.35;
  if (confirms.length >= 3) conf += 3;
  if (confirms.length >= 5) conf += 2;
  if (diff >= 6) conf += 2;
  if (diff >= 10) conf += 2;

  const aiBrainConf = layers.aiBrain ? (layers.aiBrain.aiConfidence || 0) : 0;
  if (aiBrainConf > 0) {
    conf = conf * 0.88 + Math.min(aiBrainConf, 75) * 0.12;
  }

  let hardCap = 92;
  if (diff >= 12) hardCap = 100;
  if (conf > hardCap) conf = hardCap;
  if (conf < 0) conf = 0;
  conf = Math.round(conf);

  let quality = "LOW";
  if (conf >= 82) quality = "EXCELLENT";
  else if (conf >= 72) quality = "HIGH";
  else if (conf >= 62) quality = "MEDIUM";

  return {
    signal,
    buyScore,
    sellScore,
    directionalEdge: diff,
    confidence: conf,
    entryQuality: quality,
    reason: [...new Set(reasons.filter(Boolean))].slice(0, 6).join(" · "),
    confirms: [...new Set(confirms.filter(Boolean))],
    warnings: [...new Set(warnings.filter(Boolean))],
    alignment: diff >= 3 ? "STRONG" : diff >= 1.5 ? "MODERATE" : "WEAK"
  };
}

window.GoldAI_Score = { runScoreEngine, runScoreEngineV2 };
