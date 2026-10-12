// =====================================
// GoldAI — Market Structure
// HH/HL · LH/LL · BOS · CHoCH · Swings
// =====================================

// Per-series memory to avoid cross-timeframe pollution (M1 memory affecting M5 etc.)
const MS = {
  lookback: 5,
  memoryMap: {}   // key → { trend }
};

function getMemoryKey(highs, lows, closes, cfg) {
  // Stable per symbol+TF so prevTrend survives candle-to-candle (CHoCH memory).
  // Do NOT key on last OHLC — that created a new empty memory every bar.
  const sym = (cfg && (cfg.SYMBOL || cfg.symbol)) || "XAU";
  const tf = (cfg && (cfg.ACTIVE_TIMEFRAME || cfg.TF || cfg.timeframe)) || "DEFAULT";
  return String(sym).toUpperCase() + "|" + String(tf).toUpperCase();
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
  result.swingHighs = swings.highs.slice(-8).map(s => s.price);
  result.swingLows = swings.lows.slice(-8).map(s => s.price);
  // ADDED 2026-10-07: faster swings (confirmed after 3 bars instead of 5) used
  // ONLY for stop / target placement, so levels are not stale. Trend logic
  // above still uses the normal swings.
  const fast = findSwings(highs, lows, 3);
  result.swingHighsFast = fast.highs.slice(-12).map(s => s.price);
  result.swingLowsFast = fast.lows.slice(-12).map(s => s.price);

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
    // Two-swing LH-HL is often a pullback inside a larger trend, not a confirmed range market.
    // Keep structure tag LH-HL for diagnostics; do NOT set structure.regime=RANGE (hard-gate input).
    result.trend = "RANGE";
    result.structure = "LH-HL";
    result.regime = "NEUTRAL";
    result.reason.push("LH-HL pullback/ambiguous (not confirmed range regime)");
  }

  // BOS — break of last swing (score scaled by break strength — weak BOS must not inflate)
  const minBreakPct = (cfg.MIN_BREAK_STRENGTH != null ? cfg.MIN_BREAK_STRENGTH : 0.20);
  const minBreak = minBreakPct / 100 * price;
  if (price > lh.price + minBreak) {
    result.bos = true;
    result.bosDir = "BULLISH";
    result.breakStrength = Number((((price - lh.price) / price) * 100).toFixed(3));
    // Scale: 0.20% → ~2 pts, 0.40%+ → full 5 pts (was always +5 / +15 conf)
    const bosPts = Math.min(5, Math.max(1.5, result.breakStrength * 12));
    result.bosPts = bosPts;
    result.buyScore += bosPts;
    result.confidence += Math.min(10, Math.max(3, result.breakStrength * 25));
    result.reason.push(`Bullish BOS (str ${result.breakStrength}%)`);
  } else if (price < ll.price - minBreak) {
    result.bos = true;
    result.bosDir = "BEARISH";
    result.breakStrength = Number((((ll.price - price) / price) * 100).toFixed(3));
    const bosPts = Math.min(5, Math.max(1.5, result.breakStrength * 12));
    result.bosPts = bosPts;
    result.sellScore += bosPts;
    result.confidence += Math.min(10, Math.max(3, result.breakStrength * 25));
    result.reason.push(`Bearish BOS (str ${result.breakStrength}%)`);
  }

  // Classification only: a validated BOS (same minBreak thresholds) means the
  // active structure is directional. Mixed swing tags (e.g. HH-LL) must not keep
  // regime=RANGE / trend=VOLATILE when price has already broken the swing.
  // Does NOT change MIN_BREAK_STRENGTH, scores already applied above, or gates.
  if (result.bos && result.bosDir === "BULLISH") {
    result.trend = "BULLISH";
    if (result.regime === "RANGE" || result.regime === "NEUTRAL" || result.regime === "UNKNOWN") {
      result.regime = "TREND";
    }
    result.reason.push("BOS upgrades structure trend/regime to BULLISH/TREND");
  } else if (result.bos && result.bosDir === "BEARISH") {
    result.trend = "BEARISH";
    if (result.regime === "RANGE" || result.regime === "NEUTRAL" || result.regime === "UNKNOWN") {
      result.regime = "TREND";
    }
    result.reason.push("BOS upgrades structure trend/regime to BEARISH/TREND");
  }

  // CHoCH — character change vs per-series memory (prevents M1 memory leaking into M5/H1)
  const memKey = getMemoryKey(highs, lows, closes, cfg);
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
