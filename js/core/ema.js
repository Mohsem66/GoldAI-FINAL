// =====================================
// GoldAI — EMA Engine (20 / 50 / 200)
// =====================================

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return Number(ema.toFixed(3));
}

function emaSeries(prices, period) {
  if (!prices || prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(period - 1).fill(null);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(ema);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function slope(series, lookback = 5) {
  if (!series || series.length < lookback + 1) return 0;
  const a = series[series.length - 1];
  const b = series[series.length - 1 - lookback];
  if (a == null || b == null) return 0;
  return Number((a - b).toFixed(4));
}

function analyzeEMA(prices, price, cfg) {
  const e20 = calcEMA(prices, cfg.EMA_FAST || 20);
  const e50 = calcEMA(prices, cfg.EMA_MID || 50);
  const e200 = calcEMA(prices, cfg.EMA_SLOW || 200);

  const s20 = emaSeries(prices, cfg.EMA_FAST || 20);
  const s50 = emaSeries(prices, cfg.EMA_MID || 50);

  let buy = 0, sell = 0;
  const reasons = [];
  let alignment = "MIXED";
  let trend = "NEUTRAL";

  if (e20 == null || e50 == null) {
    return {
      ema20: e20, ema50: e50, ema200: e200,
      trend, alignment, buyScore: 0, sellScore: 0,
      distance20: 0, slope20: 0, cross: "NONE",
      reason: "EMA: data insufficient"
    };
  }

  const dist20 = price - e20;
  const dist200 = e200 != null ? price - e200 : 0;
  const sl20 = slope(s20, 5);
  const sl50 = slope(s50, 5);
  const hasEma200 = e200 != null;

  // Alignment — do not claim full stack when EMA200 is missing
  if (e20 > e50 && hasEma200 && e50 > e200) {
    alignment = "BULL_STACK";
    buy += 4;
    reasons.push("EMA stack 20>50>200");
  } else if (e20 < e50 && hasEma200 && e50 < e200) {
    alignment = "BEAR_STACK";
    sell += 4;
    reasons.push("EMA stack 20<50<200");
  } else if (e20 > e50) {
    alignment = "BULLISH";
    buy += 2;
    reasons.push(hasEma200 ? "EMA20 > EMA50" : "EMA20 > EMA50 (EMA200 N/A)");
  } else if (e20 < e50) {
    alignment = "BEARISH";
    sell += 2;
    reasons.push(hasEma200 ? "EMA20 < EMA50" : "EMA20 < EMA50 (EMA200 N/A)");
  }

  // Price vs EMAs
  if (price > e20 && price > e50) { buy += 2; reasons.push("Price above EMA20/50"); }
  if (price < e20 && price < e50) { sell += 2; reasons.push("Price below EMA20/50"); }

  if (hasEma200) {
    if (price > e200) { buy += 2; reasons.push("Price above EMA200"); }
    else { sell += 2; reasons.push("Price below EMA200"); }
  } else {
    reasons.push("EMA200 unavailable (need more candles)");
  }

  // Slope
  if (sl20 > 0 && sl50 > 0) { buy += 1; reasons.push("EMA slopes up"); }
  if (sl20 < 0 && sl50 < 0) { sell += 1; reasons.push("EMA slopes down"); }

  // Cross detection (recent)
  let cross = "NONE";
  if (s20.length > 2 && s50.length > 2) {
    const a20 = s20[s20.length - 1], b20 = s20[s20.length - 2];
    const a50 = s50[s50.length - 1], b50 = s50[s50.length - 2];
    if (b20 != null && b50 != null && a20 != null && a50 != null) {
      if (b20 <= b50 && a20 > a50) { cross = "GOLDEN"; buy += 3; reasons.push("Golden Cross 20/50"); }
      if (b20 >= b50 && a20 < a50) { cross = "DEATH"; sell += 3; reasons.push("Death Cross 20/50"); }
    }
  }

  if (buy > sell + 2) trend = "BULLISH";
  else if (sell > buy + 2) trend = "BEARISH";

  return {
    ema20: e20,
    ema50: e50,
    ema200: e200,
    trend,
    alignment,
    distance20: Number(dist20.toFixed(2)),
    distance200: Number(dist200.toFixed(2)),
    slope20: sl20,
    slope50: sl50,
    cross,
    buyScore: buy,
    sellScore: sell,
    reason: reasons.join(" · ") || "EMA neutral"
  };
}

window.GoldAI_EMA = { calcEMA, emaSeries, analyzeEMA };
