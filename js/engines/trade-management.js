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

function createTradePlan(signal, entry, atr, capital, riskPercent, cfg, symbolSpecs, structure) {
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

  // structure optional — when provided, SL can sit beyond swing (lot auto-adjusts)
  const specs = symbolSpecs || cfg.SYMBOL_SPECS || window.GoldAI_Config.SYMBOL_SPECS || {};
  const levels = window.GoldAI_ATR.buildRiskLevels(entry, signal, atr, cfg, structure || null, specs);
  const riskPct = riskPercent || cfg.DEFAULT_RISK_PERCENT || 2;
  const riskMoney = Number(((capital * riskPct) / 100).toFixed(2));
  const stopDist = Math.abs(entry - levels.stopLoss);

  const sym = (cfg.SYMBOL || window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();

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

/**
 * AUTO execution plan — built from the price the order will ACTUALLY fill at
 * (ask for BUY, bid for SELL), not from the signal candle's close.
 * Used by BOTH the live worker and the backtest so they can never drift apart.
 *
 * - Auto trades carry a single take-profit (TP1). TP2/TP3 are manual-only.
 * - Reward:risk to TP1 is measured from the fill price; if it is below
 *   cfg.AUTO_MIN_RR (default 1.0) the plan is marked rrOk=false and must
 *   not be sent.
 */
function createAutoExecutionPlan(signal, fillPrice, atr, capital, riskPercent, cfg, symbolSpecs, structure, spread) {
  const base = createTradePlan(signal, fillPrice, atr, capital, riskPercent, cfg, symbolSpecs, structure);
  const minRR = (cfg && Number(cfg.AUTO_MIN_RR) > 0) ? Number(cfg.AUTO_MIN_RR) : 1.0;
  const e = Number(fillPrice);
  let sl = Number(base.stopLoss);
  let tp = Number(base.tp1);
  // ADDED 2026-10-07: SELL positions close at the ASK price, but the chart and
  // all our levels are BID. A SELL's TP only fills when the ASK reaches it, so
  // the chart's wick can touch TP without closing the trade (by the spread).
  // Shift SELL TP and SL up by the current spread so they trigger exactly when
  // the chart (bid) touches the level. BUY needs no change (closes at bid).
  // Lot is re-sized for the new stop distance, so money risk stays the same.
  const isSell = String(signal).toUpperCase().includes("SELL");
  const sp = Number(spread);
  let spreadAdjusted = 0;
  let lot = base.lot;
  if (isSell && cfg && cfg.SELL_SPREAD_ADJUST !== false && Number.isFinite(sp) && sp > 0 && Number.isFinite(sl) && Number.isFinite(tp)) {
    const specs = symbolSpecs || {};
    const tick = Number(specs.trade_tick_size || specs.point) > 0 ? Number(specs.trade_tick_size || specs.point) : 0.001;
    const up = (v) => Number((Math.ceil(v / tick - 1e-9) * tick).toFixed(5));
    sl = up(sl + sp);
    tp = up(tp + sp);
    // keep the minimum reward:risk measured honestly (with the spread included):
    // if the shift pulled TP under minRR, place TP exactly at minRR.
    if ((e - tp) < minRR * (sl - e)) {
      tp = Number((Math.floor((e - minRR * (sl - e)) / tick + 1e-9) * tick).toFixed(5));
    }
    spreadAdjusted = Number(sp.toFixed(5));
    const sym = (cfg.SYMBOL || "XAU/USD").toUpperCase();
    if (Number.isFinite(Number(base.riskMoney))) lot = computeRiskLot(Number(base.riskMoney), Math.abs(sl - e), specs, sym).lot;
  }
  if (![e, sl, tp].every(Number.isFinite)) {
    return Object.assign({}, base, { tp2: null, tp3: null, rr: null, minRR: minRR, rrOk: false, rrReason: "NO_LEVELS" });
  }
  const risk = Math.abs(e - sl);
  const reward = Math.abs(tp - e);
  const rr = risk > 0 ? reward / risk : 0;
  // tiny epsilon only for floating-point / tick rounding noise (0.1% of 1R)
  const rrOk = risk > 0 && rr + 0.001 >= minRR;
  return Object.assign({}, base, {
    entry: e,
    stopLoss: sl,
    tp1: tp,
    lot: lot,
    spreadAdjusted: spreadAdjusted,
    tp2: null,
    tp3: null,
    riskReward: "1:" + rr.toFixed(2),
    rr: Number(rr.toFixed(3)),
    minRR: minRR,
    rrOk: rrOk,
    rrReason: rrOk ? null : "RR_BELOW_MIN"
  });
}

// ---- ADDED 2026-10-08: trailing stop (shared by live worker and backtest) ----
function trailSettings(cfg) {
  const c = cfg || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    startR: num(c.TRAIL_START_R, 1.0),
    atrMult: num(c.TRAIL_ATR_MULT, 2.0),
    breakeven: c.TRAIL_BREAKEVEN !== false,
    farTpR: num(c.TRAIL_FAR_TP_R, 10)
  };
}

// Wilder ATR(14) per bar (value at i includes bar i). Same formula as research.
function atrWilder(bars, period) {
  const n = period || 14, a = 1 / n, out = new Array(bars.length);
  let v = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const pc = i > 0 ? bars[i - 1].close : b.close;
    const tr = i > 0 ? Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)) : (b.high - b.low);
    v = v == null ? tr : v + a * (tr - v);
    out[i] = v;
  }
  return out;
}

// Far take-profit used while trailing is on (entry +/- farTpR x risk).
function farTakeProfit(isBuy, entry, stopLoss, cfg) {
  const risk = Math.abs(Number(entry) - Number(stopLoss));
  if (!(risk > 0)) return null;
  const k = trailSettings(cfg).farTpR;
  return isBuy ? entry + k * risk : entry - k * risk;
}

// Start a trail state. stop = current stop, best = best price seen so far.
function trailInit(isBuy, entry, initialSL) {
  return { dir: isBuy ? 1 : -1, entry: Number(entry), risk: Math.abs(Number(entry) - Number(initialSL)),
           stop: Number(initialSL), best: Number(entry), active: false };
}

// One CLOSED bar: update best price, then (if profit >= startR x risk) move the
// stop to max(best - k*ATR, entry) for BUY (mirror for SELL). Tighter only.
// sellOff = spread in price (SELL closes at ask = bid + spread).
function trailStep(st, bar, atr, sellOff, cfg) {
  const s = trailSettings(cfg);
  if (!(st.risk > 0) || !Number.isFinite(atr)) return st;
  if (st.dir > 0) st.best = Math.max(st.best, bar.high);
  else st.best = Math.min(st.best, bar.low + (sellOff || 0));
  if ((st.best - st.entry) * st.dir >= s.startR * st.risk) {
    st.active = true;
    let cand = st.best - st.dir * s.atrMult * atr;
    if (s.breakeven) cand = st.dir > 0 ? Math.max(cand, st.entry) : Math.min(cand, st.entry);
    st.stop = st.dir > 0 ? Math.max(st.stop, cand) : Math.min(st.stop, cand);
  }
  return st;
}

window.GoldAI_Trade = { createTradePlan, computeRiskLot, createAutoExecutionPlan,
  trailSettings, atrWilder, farTakeProfit, trailInit, trailStep };
