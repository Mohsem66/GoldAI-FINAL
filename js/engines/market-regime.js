// =====================================
// GoldAI — Canonical Market Regime
// ADX and Structure remain separate evidence; one regime label for Signal Quality.
// No new numeric thresholds — uses existing engine outputs only.
// =====================================

/**
 * @param {object} adx - from analyzeADX
 * @param {object} structure - from analyzeMarketStructure
 * @returns {{ regime: string, adxRegime: string|null, structureRegime: string|null, agree: boolean, sources: object }}
 */
function buildMarketRegime(adx, structure) {
  const adxRegime = adx && adx.regime ? String(adx.regime) : null;
  const structRegime = structure && structure.regime ? String(structure.regime) : null;
  const choch = !!(structure && structure.choch);

  let regime = "NEUTRAL";
  if (choch) {
    regime = "TRANSITION";
  } else {
    const adxTrend = adxRegime === "TREND" || adxRegime === "STRONG_TREND";
    const adxRange = adxRegime === "RANGE";
    const adxWeak = adxRegime === "WEAK";
    const stTrend = structRegime === "TREND";
    const stRange = structRegime === "RANGE";
    const stNeutral = !structRegime || structRegime === "NEUTRAL" || structRegime === "UNKNOWN";

    // Hard RANGE only when both sources agree on RANGE (true range concurrence).
    if (adxTrend && stTrend) regime = "TREND";
    else if (adxRange && stRange) regime = "RANGE";
    else if (adxTrend && stRange) regime = "TRANSITION";
    else if (adxRange && stTrend) regime = "TRANSITION";
    // Weak ADX + pullback/neutral structure: not hard RANGE (directional weakness ≠ range market)
    else if (adxWeak && stRange) regime = "TRANSITION";
    else if (adxWeak && stTrend) regime = "TREND";
    else if (adxWeak && stNeutral) regime = "TRANSITION";
    else if (adxTrend || stTrend) regime = "TREND";
    // Single-source RANGE only when the other side is not directional/weak-directional
    else if (adxRange && stNeutral) regime = "RANGE";
    else if (stRange && !adxTrend && !adxWeak) regime = "RANGE";
    else if (adxRange || stRange) regime = "TRANSITION";
    else regime = "NEUTRAL";
  }

  const agree =
    adxRegime &&
    structRegime &&
    ((adxRegime === "RANGE" && structRegime === "RANGE") ||
      ((adxRegime === "TREND" || adxRegime === "STRONG_TREND") && structRegime === "TREND"));

  return {
    regime: regime,
    adxRegime: adxRegime,
    structureRegime: structRegime,
    agree: !!agree,
    sources: { adx: adxRegime, structure: structRegime, choch: choch }
  };
}

window.GoldAI_MarketRegime = { buildMarketRegime };
