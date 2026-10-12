// =====================================
// GoldAI — Score Aggregator (quality-first)
// Confidence is a technical strength score, NOT a win-probability.
// Correlated layers must not inflate confidence via simple summation.
// =====================================

function runScoreEngine(layers) {
  let buy = 0, sell = 0;
  const reasons = [];
  const confirms = [];
  const warnings = [];

  // Directional edge only — do NOT accumulate layer.confidence here
  // (EMA/structure/ADX/MACD/RSI are highly correlated on the same trend).
  const add = (layer, weight = 1) => {
    if (!layer) return;
    buy += (layer.buyScore || 0) * weight;
    sell += (layer.sellScore || 0) * weight;
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
      warnings.push("HTF weak momentum");
    } else if (layers.htf.strength === "STRONG") {
      confirms.push("HTF strong momentum");
    }
  }

  if (layers.m1) {
    if (layers.m1.microstructure === "BULLISH") buy += 1.2;
    if (layers.m1.microstructure === "BEARISH") sell += 1.2;
  }

  if (layers.adx && layers.adx.regime === "RANGE") {
    warnings.push("ADX range → lower confidence");
  }

  const buyScore = Number(buy.toFixed(1));
  const sellScore = Number(sell.toFixed(1));
  const diff = Math.abs(buyScore - sellScore);

  if (diff < 1.0) warnings.push("Conflicting / weak edge");

  // Balanced entry threshold (unchanged)
  let signal = "WAIT 🟡";
  if (buyScore > sellScore + 2.0) signal = "BUY 🟢";
  else if (sellScore > buyScore + 2.0) signal = "SELL 🔴";

  // ---- Confidence: edge-first, anti-inflation ----
  // Previous formula summed correlated layer.confidence and used *5.5 on edge,
  // producing mass 90–100 scores that are not real probabilities.
  // New model: primary driver is directional edge; modifiers are capped.
  let conf = Math.min(52, diff * 3.4); // edge 10 → ~34, edge 15 → ~51

  // Quality bonuses (small, capped)
  if (confirms.length >= 3) conf += 3;
  if (confirms.length >= 5) conf += 2;
  if (diff >= 6) conf += 4;
  if (diff >= 10) conf += 3;

  // HTF / regime modifiers (real quality gates — conflict-filter may still hard-block)
  if (layers.htf && layers.htf.strength === "STRONG") conf += 8;
  else if (layers.htf && layers.htf.strength === "MODERATE") conf += 3;
  else if (layers.htf && layers.htf.strength === "WEAK") conf -= 12;

  if (layers.adx && layers.adx.regime === "RANGE") conf -= 14;
  else if (layers.adx && layers.adx.regime === "STRONG_TREND") conf += 5;
  else if (layers.adx && layers.adx.regime === "TREND") conf += 2;

  if (layers.structure && layers.structure.regime === "RANGE") conf -= 8;

  // Weak BOS must not dominate confidence
  if (layers.structure && layers.structure.bos) {
    const bs = Number(layers.structure.breakStrength) || 0;
    if (bs < 0.25) conf -= 6;
    else if (bs >= 0.40) conf += 3;
  }

  // Soft AI blend (reduced influence vs previous 0.28)
  const aiBrainConf = layers.aiBrain ? (layers.aiBrain.aiConfidence || 0) : 0;
  if (aiBrainConf > 0) {
    conf = conf * 0.88 + Math.min(aiBrainConf, 75) * 0.12;
  }

  // Soft ceiling: 100 only reachable with exceptional edge + strong HTF + non-range
  let hardCap = 92;
  if (
    diff >= 12 &&
    layers.htf && layers.htf.strength === "STRONG" &&
    !(layers.adx && layers.adx.regime === "RANGE") &&
    !(layers.structure && layers.structure.regime === "RANGE")
  ) {
    hardCap = 100;
  }

  if (conf > hardCap) conf = hardCap;
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
