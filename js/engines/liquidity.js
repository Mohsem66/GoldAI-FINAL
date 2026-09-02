// =====================================
// GoldAI — Liquidity / Smart Money (basic)
// Equal highs/lows · sweep · imbalance hint
// =====================================

function analyzeLiquidity(highs, lows, closes) {
  const result = {
    equalHighs: false,
    equalLows: false,
    sweep: "NONE",
    buyScore: 0,
    sellScore: 0,
    confidence: 0,
    reason: "No liquidity event"
  };
  if (!highs || highs.length < 20) return result;

  const price = closes[closes.length - 1];
  const tol = price * 0.0008;
  const reasons = [];

  // Equal highs (liquidity pool above)
  const recentH = highs.slice(-15);
  let eqH = 0;
  for (let i = 0; i < recentH.length; i++) {
    for (let j = i + 1; j < recentH.length; j++) {
      if (Math.abs(recentH[i] - recentH[j]) <= tol) eqH++;
    }
  }
  if (eqH >= 2) {
    result.equalHighs = true;
    reasons.push("Equal highs (sell-side liquidity)");
  }

  // Equal lows
  const recentL = lows.slice(-15);
  let eqL = 0;
  for (let i = 0; i < recentL.length; i++) {
    for (let j = i + 1; j < recentL.length; j++) {
      if (Math.abs(recentL[i] - recentL[j]) <= tol) eqL++;
    }
  }
  if (eqL >= 2) {
    result.equalLows = true;
    reasons.push("Equal lows (buy-side liquidity)");
  }

  // Sweep: wick beyond recent extreme then close back
  const maxH = Math.max(...highs.slice(-10, -1));
  const minL = Math.min(...lows.slice(-10, -1));
  const lastH = highs[highs.length - 1];
  const lastL = lows[lows.length - 1];
  const lastC = closes[closes.length - 1];
  const lastO = closes.length > 1 ? closes[closes.length - 2] : lastC;

  // Bullish sweep of lows (stop hunt then reclaim)
  if (lastL < minL - tol && lastC > minL) {
    result.sweep = "BULLISH_SWEEP";
    result.buyScore += 4;
    result.confidence += 12;
    reasons.push("Bullish liquidity sweep");
  }
  // Bearish sweep of highs
  if (lastH > maxH + tol && lastC < maxH) {
    result.sweep = "BEARISH_SWEEP";
    result.sellScore += 4;
    result.confidence += 12;
    reasons.push("Bearish liquidity sweep");
  }

  result.reason = reasons.join(" · ") || "No liquidity event";
  return result;
}

window.GoldAI_Liquidity = { analyzeLiquidity };
