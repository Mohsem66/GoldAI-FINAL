// =====================================
// GoldAI — Market Structure
// HH/HL · LH/LL · BOS · CHoCH · Swings
// =====================================

// Per-series memory to avoid cross-timeframe pollution (M1 memory affecting M5 etc.)
const MS = {
  lookback: 5,
  memoryMap: {}   // key → { trend }
};

function getMemoryKey(highs, lows, closes) {
  // Simple stable key based on series identity (length + last values)
  const lastH = highs && highs.length ? highs[highs.length - 1] : 0;
  const lastL = lows && lows.length ? lows[lows.length - 1] : 0;
  const lastC = closes && closes.length ? closes[closes.length - 1] : 0;
  return (highs ? highs.length : 0) + "_" + lastH + "_" + lastL + "_" + lastC;
}

function isSwingHigh(prices, i, lb) {
  if (i < lb || i >= prices.length - lb) return false;
  const v = prices[i];
  for (let j = i - lb; j <= i + lb; j++) {
    if (j !== i && prices[j] >= v) return false;
  }
  return true;
}

function isSwingLow(prices, i, lb) {
  if (i < lb || i >= prices.length - lb) return false;
  const v = prices[i];
  for (let j = i - lb; j <= i + lb; j++) {
    if (j !== i && prices[j] <= v) return false;
  }
  return true;
}

function findSwings(highs, lows, lb) {
  const sh = [], sl = [];
  for (let i = lb; i < highs.length - lb; i++) {
    if (isSwingHigh(highs, i, lb)) sh.push({ i, price: highs[i] });
    if (isSwingLow(lows, i, lb)) sl.push({ i, price: lows[i] });
  }
  return { highs: sh, lows: sl };
}

function analyzeMarketStructure(highs, lows, closes, cfg) {
  const lb = cfg.SWING_LOOKBACK || 5;
  const swings = findSwings(highs, lows, lb);
  const price = closes[closes.length - 1];

  const result = {
    trend: "UNKNOWN",
    structure: "NONE",
    regime: "RANGE",
    bos: false,
    choch: false,
    bosDir: "NONE",
    chochDir: "NONE",
    swingHigh: null,
    swingLow: null,
    breakStrength: 0,
    buyScore: 0,
    sellScore: 0,
    confidence: 0,
    reason: []
  };

  if (swings.highs.length < 2 || swings.lows.length < 2) {
    result.reason = ["Not enough swings"];
    return format(result);
  }

  const lh = swings.highs[swings.highs.length - 1];
  const ph = swings.highs[swings.highs.length - 2];
  const ll = swings.lows[swings.lows.length - 1];
  const pl = swings.lows[swings.lows.length - 2];

  result.swingHigh = lh.price;
  result.swingLow = ll.price;

  const HH = lh.price > ph.price;
  const LH = lh.price < ph.price;
  const HL = ll.price > pl.price;
  const LL = ll.price < pl.price;

  // Structure pattern
  if (HH && HL) {
    result.trend = "BULLISH";
    result.structure = "HH-HL";
    result.regime = "TREND";
    result.buyScore += 5;
    result.reason.push("HH + HL → Uptrend");
  } else if (LH && LL) {
    result.trend = "BEARISH";
    result.structure = "LH-LL";
    result.regime = "TREND";
    result.sellScore += 5;
    result.reason.push("LH + LL → Downtrend");
  } else if (HH && LL) {
    result.trend = "VOLATILE";
    result.structure = "HH-LL";
    result.regime = "RANGE";
    result.buyScore += 1;
    result.sellScore += 1;
    result.reason.push("Mixed HH-LL");
  } else if (LH && HL) {
    result.trend = "RANGE";
    result.structure = "LH-HL";
    result.regime = "RANGE";
    result.reason.push("Range (LH-HL)");
  }

  // BOS — break of last swing
  const minBreak = (cfg.MIN_BREAK_STRENGTH || 0.15) / 100 * price;
  if (price > lh.price + minBreak) {
    result.bos = true;
    result.bosDir = "BULLISH";
    result.breakStrength = Number((((price - lh.price) / price) * 100).toFixed(3));
    result.buyScore += 5;
    result.confidence += 15;
    result.reason.push(`Bullish BOS (str ${result.breakStrength}%)`);
  } else if (price < ll.price - minBreak) {
    result.bos = true;
    result.bosDir = "BEARISH";
    result.breakStrength = Number((((ll.price - price) / price) * 100).toFixed(3));
    result.sellScore += 5;
    result.confidence += 15;
    result.reason.push(`Bearish BOS (str ${result.breakStrength}%)`);
  }

  // CHoCH — character change vs per-series memory (prevents M1 memory leaking into M5/H1)
  const memKey = getMemoryKey(highs, lows, closes);
  if (!MS.memoryMap[memKey]) MS.memoryMap[memKey] = { trend: "UNKNOWN" };
  const prevTrend = MS.memoryMap[memKey].trend;

  if (prevTrend === "BULLISH" && result.trend === "BEARISH") {
    result.choch = true;
    result.chochDir = "BEARISH";
    result.sellScore += 6;
    result.confidence += 18;
    result.reason.push("Bearish CHoCH");
  } else if (prevTrend === "BEARISH" && result.trend === "BULLISH") {
    result.choch = true;
    result.chochDir = "BULLISH";
    result.buyScore += 6;
    result.confidence += 18;
    result.reason.push("Bullish CHoCH");
  }
  if (result.trend === "BULLISH" || result.trend === "BEARISH") {
    MS.memoryMap[memKey].trend = result.trend;
  }

  // Confidence from score gap
  result.confidence += Math.abs(result.buyScore - result.sellScore) * 6;
  if (result.confidence > 100) result.confidence = 100;

  return format(result);
}

function format(r) {
  return {
    ...r,
    reason: Array.isArray(r.reason) ? r.reason.join(" · ") : r.reason
  };
}

window.GoldAI_MarketStructure = { analyzeMarketStructure, findSwings };
