// =====================================
// GoldAI — Wilder RSI Engine
// =====================================

function calcWilderRSI(prices, period = 14) {
  if (!prices || prices.length <= period) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Number((100 - 100 / (1 + rs)).toFixed(2));
}

function rsiHistory(prices, period = 14) {
  const out = [];
  for (let i = period; i < prices.length; i++) {
    out.push(calcWilderRSI(prices.slice(0, i + 1), period));
  }
  return out;
}

function analyzeRSI(prices, cfg) {
  const period = cfg.RSI_PERIOD || 14;
  const rsi = calcWilderRSI(prices, period);
  const hist = rsiHistory(prices, period);

  let buy = 0, sell = 0, conf = 0;
  const reasons = [];
  let zone = "NEUTRAL";

  if (rsi == null) {
    return { rsi: null, zone, buyScore: 0, sellScore: 0, confidence: 0, reason: "RSI N/A" };
  }

  if (rsi <= 20) { zone = "EXTREME_OS"; buy += 5; conf += 12; reasons.push("RSI extreme oversold"); }
  else if (rsi <= 30) { zone = "OVERSOLD"; buy += 3; conf += 7; reasons.push("RSI oversold"); }
  else if (rsi >= 80) { zone = "EXTREME_OB"; sell += 5; conf += 12; reasons.push("RSI extreme overbought"); }
  else if (rsi >= 70) { zone = "OVERBOUGHT"; sell += 3; conf += 7; reasons.push("RSI overbought"); }
  else if (rsi >= 55) { zone = "BULL_MOM"; buy += 1; reasons.push("RSI bullish momentum"); }
  else if (rsi <= 45) { zone = "BEAR_MOM"; sell += 1; reasons.push("RSI bearish momentum"); }

  // Cooling / recovery
  if (hist.length >= 3) {
    const a = hist[hist.length - 1], b = hist[hist.length - 2], c = hist[hist.length - 3];
    if (a >= 70 && a < b && b < c) { sell += 1; reasons.push("RSI cooling from OB"); }
    if (a <= 30 && a > b && b > c) { buy += 1; reasons.push("RSI recovery from OS"); }
  }

  return {
    rsi,
    zone,
    buyScore: buy,
    sellScore: sell,
    confidence: Math.min(conf, 20),
    history: hist,
    reason: reasons.join(" · ") || "RSI neutral"
  };
}

window.GoldAI_RSI = { calcWilderRSI, rsiHistory, analyzeRSI };
