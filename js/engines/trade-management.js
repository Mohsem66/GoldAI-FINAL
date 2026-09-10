// =====================================
// GoldAI — Trade Management
// Lot sizing uses symbolSpecs when available (from MT5 bridge)
// =====================================

/**
 * Shared risk-based lot sizing math.
 * Given the money amount the user is willing to risk and the actual SL
 * distance (in price units), returns the lot size that keeps the maximum
 * monetary loss (approximately) equal to riskMoney — using the broker's
 * real tick size/value from MT5 symbolSpecs when available, falling back
 * to an approximate pip-value multiplier otherwise.
 *
 * This is the SINGLE source of truth for lot sizing: both the actual
 * trade plan (createTradePlan, used for execution) and the Risk
 * Management UI card call this same function, so the displayed lot and
 * the executed lot can never drift apart.
 */
function computeRiskLot(riskMoney, stopDist, symbolSpecs, symbol) {
  const sym = (symbol || "XAU/USD").toUpperCase();
  const specs = symbolSpecs || {};

  const tickSize = Number(specs.trade_tick_size || specs.tickSize || 0);
  const tickValue = Number(specs.trade_tick_value || specs.tickValue || 0);
  const volMin = Number(specs.volume_min || specs.volumeMin || 0.01);
  const volMax = Number(specs.volume_max || specs.volumeMax || 50);
  const volStep = Number(specs.volume_step || specs.volumeStep || 0.01);

  let lot = volMin;
  let method = "approx_multiplier";
  const risk = Number(riskMoney) || 0;
  const dist = Number(stopDist) || 0;

  if (tickSize > 0 && tickValue > 0 && dist > 0) {
    // Real MT5 broker specs: exact loss-per-lot for this SL distance.
    const lossPerLot = (dist / tickSize) * tickValue;
    if (lossPerLot > 0) lot = risk / lossPerLot;
    method = "broker_tick_value";
  } else if (dist > 0) {
    // No broker specs available yet — approximate pip-value multiplier.
    let baseMultiplier = 100;
    if (sym.includes("EUR/USD") || sym.includes("GBP/USD") || sym.includes("AUD/USD") || sym.includes("USD/CAD")) {
      baseMultiplier = 100000;
    } else if (sym.includes("JPY")) {
      baseMultiplier = 1000;
    }
    lot = risk / (dist * baseMultiplier);
  }

  if (!isFinite(lot) || lot <= 0) lot = volMin;
  if (lot < volMin) lot = volMin;
  if (lot > volMax) lot = volMax;
  if (lot > 50) lot = 50;
  lot = Math.round(lot / volStep) * volStep;
  lot = Number(lot.toFixed(2));

  return { lot, method };
}

function createTradePlan(signal, entry, atr, capital, riskPercent, cfg, symbolSpecs) {
  if (!signal || signal.includes("WAIT") || !atr) {
    return {
      entry: entry || "-",
      stopLoss: "-",
      tp1: "-", tp2: "-", tp3: "-",
      lot: "-",
      riskMoney: "-",
      riskReward: "-",
      volatility: "-"
    };
  }

  const levels = window.GoldAI_ATR.buildRiskLevels(entry, signal, atr, cfg);
  const riskPct = riskPercent || cfg.DEFAULT_RISK_PERCENT || 2;
  const riskMoney = Number(((capital * riskPct) / 100).toFixed(2));
  const stopDist = Math.abs(entry - levels.stopLoss);

  const sym = (cfg.SYMBOL || window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();
  const specs = symbolSpecs || cfg.SYMBOL_SPECS || window.GoldAI_Config.SYMBOL_SPECS || {};

  const { lot, method: lotMethod } = computeRiskLot(riskMoney, stopDist, specs, sym);

  let vol = "MEDIUM";
  if (sym.includes("XAU") || sym.includes("GOLD")) {
    if (atr >= 8) vol = "HIGH";
    else if (atr < 3) vol = "LOW";
  } else {
    if (atr >= 0.0030) vol = "HIGH";
    else if (atr < 0.0008) vol = "LOW";
  }

  return {
    entry: Number(entry),
    stopLoss: levels.stopLoss,
    tp1: levels.tp1,
    tp2: levels.tp2,
    tp3: levels.tp3,
    lot,
    riskMoney,
    riskPercent: riskPct,
    riskReward: levels.riskReward,
    volatility: vol,
    atr,
    lotMethod
  };
}

window.GoldAI_Trade = { createTradePlan, computeRiskLot };
