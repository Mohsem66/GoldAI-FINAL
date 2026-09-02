// =====================================
// GoldAI — Trade Management
// Lot sizing uses symbolSpecs when available (from MT5 bridge)
// =====================================

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

  let lot = 0.01;
  const tickSize = Number(specs.trade_tick_size || specs.tickSize || 0);
  const tickValue = Number(specs.trade_tick_value || specs.tickValue || 0);
  const volMin = Number(specs.volume_min || specs.volumeMin || 0.01);
  const volMax = Number(specs.volume_max || specs.volumeMax || 50);
  const volStep = Number(specs.volume_step || specs.volumeStep || 0.01);

  if (tickSize > 0 && tickValue > 0 && stopDist > 0) {
    const lossPerLot = (stopDist / tickSize) * tickValue;
    if (lossPerLot > 0) lot = riskMoney / lossPerLot;
  } else {
    let baseMultiplier = 100;
    if (sym.includes("EUR/USD") || sym.includes("GBP/USD") || sym.includes("AUD/USD") || sym.includes("USD/CAD")) {
      baseMultiplier = 100000;
    } else if (sym.includes("JPY")) {
      baseMultiplier = 1000;
    }
    lot = stopDist > 0 ? riskMoney / (stopDist * baseMultiplier) : volMin;
  }

  if (lot < volMin) lot = volMin;
  if (lot > volMax) lot = volMax;
  if (lot > 50) lot = 50;
  lot = Math.round(lot / volStep) * volStep;
  lot = Number(lot.toFixed(2));

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
    lotMethod: (tickSize > 0 && tickValue > 0) ? "broker_tick_value" : "approx_multiplier"
  };
}

window.GoldAI_Trade = { createTradePlan };
