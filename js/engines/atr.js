// =====================================
// GoldAI — ATR Risk Engine
// =====================================

function calcATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Number(atr.toFixed(5)); // Keep full precision for Forex decimals
}

function analyzeATR(highs, lows, closes, cfg) {
  const atr = calcATR(highs, lows, closes, cfg.ATR_PERIOD || 14);
  let volatility = "UNKNOWN";
  if (atr == null) {
    return { atr: null, volatility, buyScore: 0, sellScore: 0, reason: "ATR N/A" };
  }

  const sym = (window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();
  if (sym.includes("XAU") || sym.includes("GOLD")) {
    if (atr >= 8) volatility = "HIGH";
    else if (atr >= 3) volatility = "MEDIUM";
    else volatility = "LOW";
  } else {
    if (atr >= 0.0030) volatility = "HIGH";
    else if (atr >= 0.0008) volatility = "MEDIUM";
    else volatility = "LOW";
  }

  return {
    atr,
    volatility,
    buyScore: 0,
    sellScore: 0,
    reason: `ATR ${atr} (${volatility})`
  };
}

function buildRiskLevels(entry, signal, atr, cfg) {
  if (!atr || !signal || signal.includes("WAIT")) {
    return { stopLoss: "-", tp1: "-", tp2: "-", tp3: "-", riskReward: "-" };
  }
  const slM = cfg.ATR_SL_MULT || 1.5;
  const t1 = cfg.ATR_TP1_MULT || 2;
  const t2 = cfg.ATR_TP2_MULT || 3.5;
  const t3 = cfg.ATR_TP3_MULT || 5;

  let stop, tp1, tp2, tp3;
  if (signal.includes("BUY")) {
    stop = entry - atr * slM;
    tp1 = entry + atr * t1;
    tp2 = entry + atr * t2;
    tp3 = entry + atr * t3;
  } else {
    stop = entry + atr * slM;
    tp1 = entry - atr * t1;
    tp2 = entry - atr * t2;
    tp3 = entry - atr * t3;
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp2 - entry);
  const rr = risk > 0 ? (reward / risk).toFixed(2) : "-";

  return {
    stopLoss: Number(stop),
    tp1: Number(tp1),
    tp2: Number(tp2),
    tp3: Number(tp3),
    riskReward: "1:" + rr
  };
}

window.GoldAI_ATR = { calcATR, analyzeATR, buildRiskLevels };
