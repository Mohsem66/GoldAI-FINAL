// =====================================
// GoldAI — Support / Resistance
// =====================================

function clusterLevels(levels, tolerance) {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  let group = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - group[group.length - 1] <= tolerance) {
      group.push(sorted[i]);
    } else {
      clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [sorted[i]];
    }
  }
  clusters.push(group.reduce((a, b) => a + b, 0) / group.length);
  return clusters.map(v => Number(v.toFixed(2)));
}

function analyzeSR(highs, lows, price, cfg) {
  const result = {
    supports: [],
    resistances: [],
    nearestSupport: null,
    nearestResistance: null,
    position: "MID",
    buyScore: 0,
    sellScore: 0,
    reason: "S/R N/A"
  };
  if (!highs || highs.length < 30) return result;

  const tol = price * 0.0015; // ~0.15%
  const recentH = highs.slice(-60);
  const recentL = lows.slice(-60);

  // Pivot-ish levels
  const pivH = [], pivL = [];
  for (let i = 2; i < recentH.length - 2; i++) {
    if (recentH[i] > recentH[i - 1] && recentH[i] > recentH[i + 1] &&
        recentH[i] > recentH[i - 2] && recentH[i] > recentH[i + 2]) {
      pivH.push(recentH[i]);
    }
    if (recentL[i] < recentL[i - 1] && recentL[i] < recentL[i + 1] &&
        recentL[i] < recentL[i - 2] && recentL[i] < recentL[i + 2]) {
      pivL.push(recentL[i]);
    }
  }

  const resistances = clusterLevels(pivH, tol).filter(r => r > price).slice(0, 3);
  const supports = clusterLevels(pivL, tol).filter(s => s < price).slice(-3).reverse();

  result.supports = supports;
  result.resistances = resistances;
  result.nearestSupport = supports[0] || null;
  result.nearestResistance = resistances[0] || null;

  const reasons = [];
  if (result.nearestSupport != null) {
    const dist = ((price - result.nearestSupport) / price) * 100;
    if (dist < 0.25) {
      result.buyScore += 2;
      result.position = "NEAR_SUPPORT";
      reasons.push("Near support");
    }
  }
  if (result.nearestResistance != null) {
    const dist = ((result.nearestResistance - price) / price) * 100;
    if (dist < 0.25) {
      result.sellScore += 2;
      result.position = "NEAR_RESISTANCE";
      reasons.push("Near resistance");
    }
  }

  result.reason = reasons.join(" · ") || "S/R mid-range";
  return result;
}

window.GoldAI_SR = { analyzeSR };
