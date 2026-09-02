// =====================================
// GoldAI — Candle Pattern Engine
// =====================================

function analyzeCandles(candles) {
  const result = {
    pattern: "NONE",
    buyScore: 0,
    sellScore: 0,
    confidence: 0,
    reason: "No pattern"
  };
  if (!candles || candles.length < 3) return result;

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.0001;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  // Pin bar / hammer
  if (lower > body * 2 && upper < body * 0.5 && body / range < 0.35) {
    result.pattern = "HAMMER";
    result.buyScore += 3;
    result.confidence += 8;
    result.reason = "Hammer / bullish pin";
    return result;
  }
  // Shooting star
  if (upper > body * 2 && lower < body * 0.5 && body / range < 0.35) {
    result.pattern = "SHOOTING_STAR";
    result.sellScore += 3;
    result.confidence += 8;
    result.reason = "Shooting star / bearish pin";
    return result;
  }
  // Bullish engulfing
  if (b.close < b.open && c.close > c.open &&
      c.close >= b.open && c.open <= b.close) {
    result.pattern = "BULL_ENGULF";
    result.buyScore += 3;
    result.confidence += 10;
    result.reason = "Bullish engulfing";
    return result;
  }
  // Bearish engulfing
  if (b.close > b.open && c.close < c.open &&
      c.open >= b.close && c.close <= b.open) {
    result.pattern = "BEAR_ENGULF";
    result.sellScore += 3;
    result.confidence += 10;
    result.reason = "Bearish engulfing";
    return result;
  }
  // Doji
  if (body / range < 0.12) {
    result.pattern = "DOJI";
    result.reason = "Doji — indecision";
    return result;
  }
  // Three bar momentum
  if (a.close < a.open && b.close < b.open && c.close > c.open && c.close > b.open) {
    result.pattern = "BULL_REVERSAL";
    result.buyScore += 2;
    result.reason = "Bullish reversal sequence";
    return result;
  }
  if (a.close > a.open && b.close > b.open && c.close < c.open && c.close < b.open) {
    result.pattern = "BEAR_REVERSAL";
    result.sellScore += 2;
    result.reason = "Bearish reversal sequence";
    return result;
  }

  return result;
}

window.GoldAI_Candles = { analyzeCandles };
