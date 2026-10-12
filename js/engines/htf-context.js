// =====================================
// GoldAI — HTF Context (canonical, once)
// Bias/context for the PRIMARY signal TF. Not a duplicate score layer.
// WEAK ≠ AGAINST. Numeric thresholds unchanged from prior app/backtest logic.
// =====================================

/**
 * Build HTF context from higher-TF EMA + structure evidence already computed.
 * @returns {{ trend: string, strength: string, regimeTrend: boolean, edge: number }}
 */
function buildHtfContext(htfEma, htfStr) {
  htfEma = htfEma || {};
  htfStr = htfStr || {};
  const htfTrend = htfStr.trend && htfStr.trend !== "UNKNOWN" ? htfStr.trend : (htfEma.trend || "UNKNOWN");
  let strength = "WEAK";
  const regimeTrend = htfStr.regime === "TREND";
  const htfClear = htfTrend === "BULLISH" || htfTrend === "BEARISH";
  const htfEmaAligned =
    (htfEma.trend === "BULLISH" || htfEma.trend === "BEARISH") && htfEma.trend === htfTrend;
  const edge = Math.abs((htfStr.buyScore || 0) - (htfStr.sellScore || 0));
  // Same classification rules as previous app.js / backtest.js (thresholds unchanged)
  if (htfClear && regimeTrend && htfEmaAligned && edge >= 4) strength = "STRONG";
  else if (htfClear && regimeTrend && (htfEmaAligned || edge >= 3)) strength = "MODERATE";
  else if (htfClear && regimeTrend) strength = "MODERATE";
  return {
    trend: htfTrend,
    strength: strength,
    regimeTrend: !!regimeTrend,
    edge: edge,
    emaAligned: !!htfEmaAligned
  };
}

/**
 * Alignment of HTF vs a proposed directional signal (BUY/SELL string or side).
 * ALIGNED | NEUTRAL | WEAK | AGAINST — WEAK is not AGAINST.
 */
function htfAlignmentState(htf, signalSide) {
  if (!htf || !htf.trend) return "NEUTRAL";
  const side = String(signalSide || "").toUpperCase();
  const isBuy = side.includes("BUY");
  const isSell = side.includes("SELL");
  if (!isBuy && !isSell) return "NEUTRAL";
  const against =
    (isBuy && htf.trend === "BEARISH") || (isSell && htf.trend === "BULLISH");
  if (against) return "AGAINST";
  const aligned =
    (isBuy && htf.trend === "BULLISH") || (isSell && htf.trend === "BEARISH");
  const str = String(htf.strength || "WEAK").toUpperCase();
  if (aligned && str === "STRONG") return "ALIGNED";
  if (aligned && str === "MODERATE") return "ALIGNED";
  if (aligned && str === "WEAK") return "WEAK";
  if (!aligned && str === "WEAK") return "WEAK";
  return "NEUTRAL";
}

window.GoldAI_HtfContext = { buildHtfContext, htfAlignmentState };
