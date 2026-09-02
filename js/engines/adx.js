// =====================================
// GoldAI — ADX / DI Engine
// Trend strength (Trend vs Range)
// =====================================

function analyzeADX(highs, lows, closes, period = 14) {
  const result = {
    adx: null, plusDI: null, minusDI: null,
    regime: "UNKNOWN",
    buyScore: 0, sellScore: 0, confidence: 0,
    reason: "ADX N/A"
  };
  if (!highs || highs.length < period + 2) return result;

  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < highs.length; i++) {
    const h = highs[i], l = lows[i], pc = closes[i - 1];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  function wilder(arr, p) {
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = p; i < arr.length; i++) {
      s = s - s / p + arr[i];
      out.push(s);
    }
    return out;
  }

  const atrS = wilder(tr, period);
  const pDM = wilder(plusDM, period);
  const mDM = wilder(minusDM, period);

  const dx = [];
  for (let i = 0; i < atrS.length; i++) {
    const atr = atrS[i] / period;
    if (atr === 0) { dx.push(0); continue; }
    const pdi = (pDM[i] / period) / atr * 100;
    const mdi = (mDM[i] / period) / atr * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : Math.abs(pdi - mdi) / sum * 100);
  }

  if (dx.length < period) return result;

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  const lastAtr = atrS[atrS.length - 1] / period;
  const plusDI = lastAtr ? (pDM[pDM.length - 1] / period) / lastAtr * 100 : 0;
  const minusDI = lastAtr ? (mDM[mDM.length - 1] / period) / lastAtr * 100 : 0;

  result.adx = Number(adx.toFixed(2));
  result.plusDI = Number(plusDI.toFixed(2));
  result.minusDI = Number(minusDI.toFixed(2));

  const reasons = [];
  if (adx >= 40) {
    result.regime = "STRONG_TREND";
    result.confidence += 12;
    reasons.push("ADX strong trend");
  } else if (adx >= 25) {
    result.regime = "TREND";
    result.confidence += 6;
    reasons.push("ADX trending");
  } else {
    result.regime = "RANGE";
    reasons.push("ADX range / weak trend");
  }

  if (plusDI > minusDI + 2) {
    result.buyScore += adx >= 25 ? 3 : 1;
    reasons.push("+DI > −DI");
  } else if (minusDI > plusDI + 2) {
    result.sellScore += adx >= 25 ? 3 : 1;
    reasons.push("−DI > +DI");
  }

  result.reason = reasons.join(" · ");
  return result;
}

window.GoldAI_ADX = { analyzeADX };
