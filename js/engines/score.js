// =====================================
// GoldAI — Score Aggregator (balanced quality)
// Simulated macro weight = 0 (safety)
// =====================================

function runScoreEngine(layers) {
  let buy = 0, sell = 0, conf = 0;
  const reasons = [];
  const confirms = [];
  const warnings = [];

  const add = (layer, weight = 1) => {
    if (!layer) return;
    buy += (layer.buyScore || 0) * weight;
    sell += (layer.sellScore || 0) * weight;
    conf += layer.confidence || 0;
    if (layer.reason) reasons.push(layer.reason);
    if (layer.confirms) confirms.push(...layer.confirms);
    if (layer.warnings) warnings.push(...layer.warnings);
  };

  // Core technical weights (structure/liquidity lead)
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

  // Simulated macro — WEIGHT ZERO until real live feeds are connected.
  // Still collect warnings so UI remains transparent.
  if (layers.fundamental) {
    // add(layers.fundamental, 0);  // intentionally zero
    if (layers.fundamental.simulated !== false) {
      warnings.push("Fundamental is simulated (not live) — weight=0");
    }
    if (layers.fundamental.warnings) warnings.push(...layers.fundamental.warnings);
  }
  if (layers.correlation) {
    // add(layers.correlation, 0);  // intentionally zero
    if (layers.correlation.simulated !== false) {
      warnings.push("Correlation is simulated (not live) — weight=0");
    }
    if (layers.correlation.warnings) warnings.push(...layers.correlation.warnings);
  }

  // AI Brain is meta-bias only — light nudge, no double-count of tech
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

  if (layers.htf) {
    if (layers.htf.trend === "BULLISH") {
      buy += 3.5;
      confirms.push("HTF bullish bias");
    }
    if (layers.htf.trend === "BEARISH") {
      sell += 3.5;
      confirms.push("HTF bearish bias");
    }
    if (layers.htf.strength === "WEAK") {
      conf -= 6;
      warnings.push("HTF weak momentum");
    }
  }

  if (layers.m1) {
    if (layers.m1.microstructure === "BULLISH") buy += 1.2;
    if (layers.m1.microstructure === "BEARISH") sell += 1.2;
  }

  if (layers.adx && layers.adx.regime === "RANGE") {
    conf -= 12;
    warnings.push("ADX range → lower confidence");
  }

  const buyScore = Number(buy.toFixed(1));
  const sellScore = Number(sell.toFixed(1));
  const diff = Math.abs(buyScore - sellScore);

  if (diff < 1.0) warnings.push("Conflicting / weak edge");

  // Balanced entry threshold
  let signal = "WAIT 🟡";
  if (buyScore > sellScore + 2.0) signal = "BUY 🟢";
  else if (sellScore > buyScore + 2.0) signal = "SELL 🔴";

  // Confidence: technical edge first; AI only soft blend
  conf = Math.abs(buyScore - sellScore) * 5.5 + (conf / 12);
  const aiBrainConf = layers.aiBrain ? (layers.aiBrain.aiConfidence || 0) : 0;
  if (aiBrainConf > 0) {
    conf = conf * 0.72 + aiBrainConf * 0.28;
  }

  if (confirms.length >= 3) conf += 5;
  if (confirms.length >= 5) conf += 4;
  if (diff >= 4) conf += 4;

  if (conf > 100) conf = 100;
  if (conf < 0) conf = 0;
  conf = Math.round(conf);

  let quality = "LOW";
  if (conf >= 82) quality = "EXCELLENT";
  else if (conf >= 72) quality = "HIGH";
  else if (conf >= 62) quality = "MEDIUM";

  const uniq = [...new Set(reasons.filter(Boolean))];
  const uniqConfirms = [...new Set(confirms.filter(Boolean))];
  const uniqWarnings = [...new Set(warnings.filter(Boolean))];

  return {
    signal,
    buyScore,
    sellScore,
    confidence: conf,
    entryQuality: quality,
    reason: uniq.slice(0, 6).join(" · "),
    confirms: uniqConfirms,
    warnings: uniqWarnings,
    alignment: diff >= 3 ? "STRONG" : diff >= 1.5 ? "MODERATE" : "WEAK"
  };
}

window.GoldAI_Score = { runScoreEngine };
