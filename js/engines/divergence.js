// =====================================
// GoldAI — RSI Divergence (swing-based)
// =====================================

function findSwingIndices(arr, order, lb) {
  const out = [];
  if (!arr || arr.length < lb * 2 + 1) return out;
  for (let i = lb; i < arr.length - lb; i++) {
    let ok = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (order === "high" && arr[j] >= arr[i]) { ok = false; break; }
      if (order === "low" && arr[j] <= arr[i]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function strength(pOld, pNew, rOld, rNew) {
  const pd = Math.abs(pNew - pOld);
  const rd = Math.abs(rNew - rOld);
  if (pd >= 1.2 && rd >= 8) return "STRONG";
  if (pd >= 0.5 && rd >= 4) return "MEDIUM";
  return "WEAK";
}

function analyzeDivergence(prices, rsiValues) {
  const result = {
    type: "NONE",
    strength: "NONE",
    buyScore: 0,
    sellScore: 0,
    confidence: 0,
    reason: "No divergence"
  };

  if (!prices || !rsiValues || prices.length < 20 || rsiValues.length < 20) return result;

  // Require aligned series length to avoid index mismatch (look-ahead / misaligned RSI)
  const len = Math.min(prices.length, rsiValues.length);
  if (len < 20) return result;
  prices = prices.slice(prices.length - len);
  rsiValues = rsiValues.slice(rsiValues.length - len);

  const lb = 3;
  const confMap = { STRONG: 20, MEDIUM: 12, WEAK: 5 };

  const priceHighs = findSwingIndices(prices, "high", lb);
  const priceLows = findSwingIndices(prices, "low", lb);

  // Regular Bullish: last two price lows — lower low, RSI higher low
  if (priceLows.length >= 2) {
    const i2 = priceLows[priceLows.length - 1];
    const i1 = priceLows[priceLows.length - 2];
    if (i2 < rsiValues.length && i1 < rsiValues.length) {
      const p1 = prices[i1], p2 = prices[i2];
      const r1 = rsiValues[i1], r2 = rsiValues[i2];
      if (r1 != null && r2 != null && p2 < p1 && r2 > r1) {
        const s = strength(p1, p2, r1, r2);
        if (s !== "WEAK" || Math.abs(r2 - r1) >= 3) {
          return {
            type: "REGULAR_BULLISH",
            strength: s,
            buyScore: s === "STRONG" ? 5 : s === "MEDIUM" ? 3.5 : 2,
            sellScore: 0,
            confidence: confMap[s],
            reason: "Regular Bullish Div (" + s + ")"
          };
        }
      }
    }
  }

  // Regular Bearish: last two price highs — higher high, RSI lower high
  if (priceHighs.length >= 2) {
    const i2 = priceHighs[priceHighs.length - 1];
    const i1 = priceHighs[priceHighs.length - 2];
    if (i2 < rsiValues.length && i1 < rsiValues.length) {
      const p1 = prices[i1], p2 = prices[i2];
      const r1 = rsiValues[i1], r2 = rsiValues[i2];
      if (r1 != null && r2 != null && p2 > p1 && r2 < r1) {
        const s = strength(p1, p2, r1, r2);
        if (s !== "WEAK" || Math.abs(r1 - r2) >= 3) {
          return {
            type: "REGULAR_BEARISH",
            strength: s,
            buyScore: 0,
            sellScore: s === "STRONG" ? 5 : s === "MEDIUM" ? 3.5 : 2,
            confidence: confMap[s],
            reason: "Regular Bearish Div (" + s + ")"
          };
        }
      }
    }
  }

  // Hidden Bullish: higher low in price, lower low in RSI
  if (priceLows.length >= 2) {
    const i2 = priceLows[priceLows.length - 1];
    const i1 = priceLows[priceLows.length - 2];
    if (i2 < rsiValues.length && i1 < rsiValues.length) {
      const p1 = prices[i1], p2 = prices[i2];
      const r1 = rsiValues[i1], r2 = rsiValues[i2];
      if (r1 != null && r2 != null && p2 > p1 && r2 < r1) {
        const s = strength(p1, p2, r1, r2);
        return {
          type: "HIDDEN_BULLISH",
          strength: s,
          buyScore: s === "STRONG" ? 3 : 2,
          sellScore: 0,
          confidence: Math.max(confMap[s] - 4, 4),
          reason: "Hidden Bullish Div (" + s + ")"
        };
      }
    }
  }

  // Hidden Bearish: lower high in price, higher high in RSI
  if (priceHighs.length >= 2) {
    const i2 = priceHighs[priceHighs.length - 1];
    const i1 = priceHighs[priceHighs.length - 2];
    if (i2 < rsiValues.length && i1 < rsiValues.length) {
      const p1 = prices[i1], p2 = prices[i2];
      const r1 = rsiValues[i1], r2 = rsiValues[i2];
      if (r1 != null && r2 != null && p2 < p1 && r2 > r1) {
        const s = strength(p1, p2, r1, r2);
        return {
          type: "HIDDEN_BEARISH",
          strength: s,
          buyScore: 0,
          sellScore: s === "STRONG" ? 3 : 2,
          confidence: Math.max(confMap[s] - 4, 4),
          reason: "Hidden Bearish Div (" + s + ")"
        };
      }
    }
  }

  return result;
}

window.GoldAI_Divergence = { analyzeDivergence };
