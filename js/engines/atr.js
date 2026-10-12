// =====================================
// GoldAI — ATR Risk Engine
// Structure-aware SL optional: widens stop to beyond swing when available.
// Wider SL automatically reduces lot via risk-based sizing (same $ risk).
// =====================================

function calcATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return Number(atr.toFixed(5)); // Keep full precision for Forex decimals
}

function analyzeATR(highs, lows, closes, cfg) {
  const atr = calcATR(highs, lows, closes, cfg.ATR_PERIOD || 14);
  let volatility = "UNKNOWN";
  if (atr == null) {
    return { atr: null, volatility, buyScore: 0, sellScore: 0, reason: "ATR N/A" };
  }

  const sym = (window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();
  if (sym.includes("XAU") || sym.includes("GOLD")) {
    if (atr >= 8) volatility = "HIGH";
    else if (atr >= 3) volatility = "MEDIUM";
    else volatility = "LOW";
  } else {
    if (atr >= 0.0030) volatility = "HIGH";
    else if (atr >= 0.0008) volatility = "MEDIUM";
    else volatility = "LOW";
  }

  return {
    atr,
    volatility,
    buyScore: 0,
    sellScore: 0,
    reason: `ATR ${atr} (${volatility})`
  };
}

function _tickSize(cfg, specs) {
  const s = specs || (cfg && cfg.SYMBOL_SPECS) || {};
  const t = Number(s.trade_tick_size || s.point);
  return t > 0 ? t : 0.001;
}

function _roundTick(price, tick, mode) {
  if (!(tick > 0) || !Number.isFinite(price)) return price;
  const n = price / tick;
  if (mode === "down") return Math.floor(n + 1e-9) * tick;
  if (mode === "up") return Math.ceil(n - 1e-9) * tick;
  return Math.round(n) * tick;
}

/**
 * Build SL/TP from structure + ATR. RR is not a fixed 1:1.5 —
 * TP sits at real swing/liquidity beyond entry (clamped 1R..10R).
 */
/**
 * RISK V2 (2026-10-07) — used when cfg.RISK_V2 === true.
 * Stop:   beyond the NEAREST recent swing (3-bar swings) on the protective
 *         side, kept between RISK_SL_MIN_ATR (1.5) and ATR_SL_MAX_MULT (2.8)
 *         x ATR. No usable swing -> ATR_SL_MULT (2) x ATR.
 * Target: the first real swing level in the trade direction that is at least
 *         AUTO_MIN_RR (1) x risk away. Levels that are too close are SKIPPED
 *         (old logic pinned TP to exactly 1R instead). No usable level ->
 *         ATR_TP1_MULT x ATR (now really an ATR multiple, as the name says),
 *         never below 1R.
 * TP2/TP3: next real levels beyond TP1, else ATR_TP2/3_MULT x ATR.
 */
function buildRiskLevelsV2(entry, signal, atr, cfg, structure, specs) {
  entry = Number(entry);
  const isBuy = String(signal).includes("BUY");
  const tick = _tickSize(cfg, specs);
  const buf = atr * 0.2;
  const slDef = (cfg && Number(cfg.ATR_SL_MULT) > 0) ? Number(cfg.ATR_SL_MULT) : 2;
  const slMin = (cfg && Number(cfg.RISK_SL_MIN_ATR) > 0) ? Number(cfg.RISK_SL_MIN_ATR) : 1.5;
  const slMax = (cfg && Number(cfg.ATR_SL_MAX_MULT) > 0) ? Number(cfg.ATR_SL_MAX_MULT) : 2.8;
  const minR = (cfg && Number(cfg.AUTO_MIN_RR) > 0) ? Number(cfg.AUTO_MIN_RR) : 1;
  const maxR = 10;
  const tpAtr = [
    (cfg && Number(cfg.ATR_TP1_MULT) > 0) ? Number(cfg.ATR_TP1_MULT) : 3,
    (cfg && Number(cfg.ATR_TP2_MULT) > 0) ? Number(cfg.ATR_TP2_MULT) : 3.5,
    (cfg && Number(cfg.ATR_TP3_MULT) > 0) ? Number(cfg.ATR_TP3_MULT) : 5
  ];
  const s = structure || {};
  const lows = (s.swingLowsFast && s.swingLowsFast.length ? s.swingLowsFast : (s.swingLows || [])).map(Number).filter(Number.isFinite);
  const highs = (s.swingHighsFast && s.swingHighsFast.length ? s.swingHighsFast : (s.swingHighs || [])).map(Number).filter(Number.isFinite);
  const dir = isBuy ? 1 : -1;

  // ---- stop: nearest protective swing whose stop distance fits [slMin, slMax] ATR
  const protect = (isBuy ? lows : highs)
    .map((p) => p - dir * buf)                         // stop sits just beyond the swing
    .filter((st) => dir * (entry - st) > 0)            // on the protective side
    .map((st) => ({ st, d: Math.abs(entry - st) / atr }))
    .sort((a, b) => a.d - b.d);                        // nearest first
  let stop = null;
  for (const c of protect) {
    if (c.d < slMin) continue;                         // too tight -> look further
    if (c.d <= slMax) stop = c.st;
    break;
  }
  let stopSource = "swing";
  if (stop == null) { stop = entry - dir * atr * slDef; stopSource = "atr"; }
  stop = _roundTick(stop, tick, isBuy ? "down" : "up");
  if (dir * (entry - stop) <= 0) stop = _roundTick(entry - dir * tick * 10, tick, isBuy ? "down" : "up");
  const risk = Math.abs(entry - stop);

  // ---- targets: real levels in trade direction, nearest first, >= minR
  const levels = (isBuy ? highs : lows)
    .map((p) => p - dir * buf)                         // target just before the level
    .filter((t) => dir * (t - entry) > 0)
    .sort((a, b) => dir * (a - b));
  const clampR = (t) => {
    let r = Math.abs(t - entry) / risk;
    if (r < minR) r = minR;
    if (r > maxR) r = maxR;
    return entry + dir * risk * r;
  };
  let tp1 = null, tpSource = "level";
  for (const t of levels) { if (Math.abs(t - entry) >= risk * minR) { tp1 = t; break; } }
  if (tp1 == null) { tp1 = clampR(entry + dir * atr * tpAtr[0]); tpSource = "atr"; }
  const beyond = (prev) => levels.find((t) => dir * (t - prev) >= risk * 0.5);
  tp1 = clampR(tp1);                                   // TP1: 1R .. 10R
  let tp2 = beyond(tp1);
  if (tp2 == null) tp2 = entry + dir * atr * tpAtr[1];
  if (dir * (tp2 - tp1) < risk * 0.5) tp2 = tp1 + dir * risk * 0.5;   // always beyond TP1
  let tp3 = beyond(tp2);
  if (tp3 == null) tp3 = entry + dir * atr * tpAtr[2];
  if (dir * (tp3 - tp2) < risk * 0.5) tp3 = tp2 + dir * risk * 0.5;   // always beyond TP2
  const mode = isBuy ? "down" : "up";
  tp1 = _roundTick(tp1, tick, mode); tp2 = _roundTick(tp2, tick, mode); tp3 = _roundTick(tp3, tick, mode);

  const rr = risk > 0 ? (Math.abs(tp1 - entry) / risk).toFixed(2) : "-";
  return {
    stopLoss: Number(stop.toFixed(5)),
    tp1: Number(tp1.toFixed(5)),
    tp2: Number(tp2.toFixed(5)),
    tp3: Number(tp3.toFixed(5)),
    riskReward: "1:" + rr,
    stopSource: stopSource,
    tpSource: tpSource
  };
}

function buildRiskLevels(entry, signal, atr, cfg, structure, specs) {
  if (cfg && cfg.RISK_V2 === true && atr && signal && !signal.includes("WAIT") && Number.isFinite(Number(entry))) {
    return buildRiskLevelsV2(entry, signal, atr, cfg, structure, specs);
  }
  if (!atr || !signal || signal.includes("WAIT") || !Number.isFinite(Number(entry))) {
    return { stopLoss: "-", tp1: "-", tp2: "-", tp3: "-", riskReward: "-" };
  }
  const slM = (cfg && cfg.ATR_SL_MULT) != null ? Number(cfg.ATR_SL_MULT) : 2;
  const t1 = (cfg && cfg.ATR_TP1_MULT) != null ? Number(cfg.ATR_TP1_MULT) : 3;
  const t2 = (cfg && cfg.ATR_TP2_MULT) != null ? Number(cfg.ATR_TP2_MULT) : 3.5;
  const t3 = (cfg && cfg.ATR_TP3_MULT) != null ? Number(cfg.ATR_TP3_MULT) : 5;
  const tick = _tickSize(cfg, specs);
  const buf = atr * 0.2;
  const maxAtr = (cfg && Number(cfg.ATR_SL_MAX_MULT) > 0) ? Number(cfg.ATR_SL_MAX_MULT) : 2.8;
  const minR = 1;
  const maxR = 10;
  const isBuy = String(signal).includes("BUY");

  let stop;
  if (isBuy) {
    stop = entry - atr * slM;
    if (structure && structure.swingLow != null && Number.isFinite(Number(structure.swingLow))) {
      const swing = Number(structure.swingLow);
      if (swing < entry) {
        const structStop = swing - buf;
        if (structStop < stop) stop = structStop;
      }
    }
    const maxWide = entry - atr * maxAtr;
    if (stop < maxWide) stop = maxWide;
    const minStop = entry - atr * Math.max(slM, 1);
    if (stop > minStop) stop = minStop;
    stop = _roundTick(stop, tick, "down");
    if (stop >= entry) stop = _roundTick(entry - tick * 10, tick, "down");
  } else {
    stop = entry + atr * slM;
    if (structure && structure.swingHigh != null && Number.isFinite(Number(structure.swingHigh))) {
      const swing = Number(structure.swingHigh);
      if (swing > entry) {
        const structStop = swing + buf;
        if (structStop > stop) stop = structStop;
      }
    }
    const maxWide = entry + atr * maxAtr;
    if (stop > maxWide) stop = maxWide;
    const minStop = entry + atr * Math.max(slM, 1);
    if (stop < minStop) stop = minStop;
    stop = _roundTick(stop, tick, "up");
    if (stop <= entry) stop = _roundTick(entry + tick * 10, tick, "up");
  }

  const risk = Math.abs(entry - stop);
  function clampByR(px) {
    const dist = Math.abs(px - entry);
    let r = risk > 0 ? dist / risk : minR;
    if (r < minR) r = minR;
    if (r > maxR) r = maxR;
    return isBuy ? entry + risk * r : entry - risk * r;
  }

  const highs = (structure && (structure.swingHighs || []).length)
    ? structure.swingHighs : (structure && structure.swingHigh != null ? [structure.swingHigh] : []);
  const lows = (structure && (structure.swingLows || []).length)
    ? structure.swingLows : (structure && structure.swingLow != null ? [structure.swingLow] : []);
  const beyond = (isBuy ? highs : lows)
    .map(Number)
    .filter((p) => Number.isFinite(p) && (isBuy ? p > entry + buf : p < entry - buf))
    .sort((a, b) => isBuy ? a - b : b - a);

  const fallback = [
    isBuy ? entry + risk * (t1 / slM) : entry - risk * (t1 / slM),
    isBuy ? entry + risk * (t2 / slM) : entry - risk * (t2 / slM),
    isBuy ? entry + risk * (t3 / slM) : entry - risk * (t3 / slM)
  ];

  let tp1 = clampByR(beyond[0] != null ? (isBuy ? beyond[0] - buf : beyond[0] + buf) : fallback[0]);
  let tp2 = clampByR(beyond[1] != null ? (isBuy ? beyond[1] - buf : beyond[1] + buf) : (isBuy ? tp1 + risk : tp1 - risk));
  let tp3 = clampByR(beyond[2] != null ? (isBuy ? beyond[2] - buf : beyond[2] + buf) : (isBuy ? tp2 + risk : tp2 - risk));

  if (isBuy) {
    if (tp2 <= tp1) tp2 = tp1 + risk;
    if (tp3 <= tp2) tp3 = tp2 + risk;
    tp1 = _roundTick(tp1, tick, "down");
    tp2 = _roundTick(tp2, tick, "down");
    tp3 = _roundTick(tp3, tick, "down");
  } else {
    if (tp2 >= tp1) tp2 = tp1 - risk;
    if (tp3 >= tp2) tp3 = tp2 - risk;
    tp1 = _roundTick(tp1, tick, "up");
    tp2 = _roundTick(tp2, tick, "up");
    tp3 = _roundTick(tp3, tick, "up");
  }

  const rr = risk > 0 ? (Math.abs(tp1 - entry) / risk).toFixed(2) : "-";
  return {
    stopLoss: Number(stop.toFixed(5)),
    tp1: Number(tp1.toFixed(5)),
    tp2: Number(tp2.toFixed(5)),
    tp3: Number(tp3.toFixed(5)),
    riskReward: "1:" + rr
  };
}

window.GoldAI_ATR = { calcATR, analyzeATR, buildRiskLevels, buildRiskLevelsV2 };
