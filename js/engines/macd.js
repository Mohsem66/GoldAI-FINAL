// =====================================
// GoldAI — MACD Engine
// =====================================

function emaArr(prices, period) {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period - 1; i++) out.push(null);
  out.push(ema);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function analyzeMACD(prices) {
  const result = {
    macd: null, signal: null, hist: null,
    cross: "NONE", trend: "NEUTRAL",
    buyScore: 0, sellScore: 0, confidence: 0,
    reason: "MACD N/A"
  };
  if (!prices || prices.length < 35) return result;

  const ema12 = emaArr(prices, 12);
  const ema26 = emaArr(prices, 26);
  const macdLine = [];
  for (let i = 0; i < prices.length; i++) {
    if (ema12[i] == null || ema26[i] == null) macdLine.push(null);
    else macdLine.push(ema12[i] - ema26[i]);
  }

  const valid = macdLine.filter(v => v != null);
  if (valid.length < 9) return result;

  // Signal = EMA9 of MACD
  const start = macdLine.findIndex(v => v != null);
  const macdSlice = macdLine.slice(start);
  const sigArr = emaArr(macdSlice, 9);
  const macd = macdSlice[macdSlice.length - 1];
  const signal = sigArr[sigArr.length - 1];
  const hist = macd - signal;

  result.macd = Number(macd.toFixed(4));
  result.signal = Number(signal.toFixed(4));
  result.hist = Number(hist.toFixed(4));

  const reasons = [];

  if (hist > 0) { result.buyScore += 2; result.trend = "BULLISH"; reasons.push("MACD hist > 0"); }
  else if (hist < 0) { result.sellScore += 2; result.trend = "BEARISH"; reasons.push("MACD hist < 0"); }

  // Cross
  if (sigArr.length >= 2 && macdSlice.length >= 2) {
    const prevM = macdSlice[macdSlice.length - 2];
    const prevS = sigArr[sigArr.length - 2];
    if (prevM != null && prevS != null) {
      if (prevM <= prevS && macd > signal) {
        result.cross = "BULLISH";
        result.buyScore += 3;
        result.confidence += 10;
        reasons.push("MACD bullish cross");
      }
      if (prevM >= prevS && macd < signal) {
        result.cross = "BEARISH";
        result.sellScore += 3;
        result.confidence += 10;
        reasons.push("MACD bearish cross");
      }
    }
  }

  // Zero-line
  if (macd > 0 && hist > 0) { result.buyScore += 1; reasons.push("MACD above zero"); }
  if (macd < 0 && hist < 0) { result.sellScore += 1; reasons.push("MACD below zero"); }

  result.reason = reasons.join(" · ") || "MACD neutral";
  return result;
}

window.GoldAI_MACD = { analyzeMACD };
