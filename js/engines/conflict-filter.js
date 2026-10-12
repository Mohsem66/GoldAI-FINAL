// =====================================
// GoldAI — Signal Quality (technical)
// Pure setup quality: regime, HTF, structure, soft indicator checks, edge.
// Trade Permission (data/risk/dedup/conf floor) lives in trade-permission.js.
// Confidence = technical composite, NOT win probability. No threshold retunes.
// =====================================

function _isScalpTf(cfg) {
  const tf = String((cfg && cfg.ACTIVE_TIMEFRAME) || "m5").toLowerCase();
  return tf === "m1" || tf === "m5" || tf === "m15" || tf === "m30";
}

function _structureQuality(structure) {
  if (!structure) return { band: "unknown", bos: false, weakBos: false, strongBos: false, breakStrength: 0 };
  const bs = Number(structure.breakStrength) || 0;
  const bos = !!structure.bos;
  const weakBos = bos && bs < 0.25;
  const strongBos = bos && bs >= 0.30;
  let band = "medium";
  if (!bos) band = structure.regime === "TREND" ? "medium" : "weak";
  else if (strongBos) band = "strong";
  else if (weakBos) band = "weak";
  else band = "medium";
  return { band, bos, weakBos, strongBos, breakStrength: bs, choch: !!structure.choch, trend: structure.trend };
}

function _layerSnap(layer) {
  if (!layer) return null;
  return {
    buyScore: layer.buyScore != null ? layer.buyScore : 0,
    sellScore: layer.sellScore != null ? layer.sellScore : 0,
    trend: layer.trend || layer.regime || layer.zone || undefined
  };
}

function buildSignalDiagnostics(score, layers, qualityParts) {
  return {
    observationOnly: true,
    layers: {
      structure: _layerSnap(layers.structure),
      ema: _layerSnap(layers.ema),
      rsi: _layerSnap(layers.rsi),
      macd: _layerSnap(layers.macd),
      adx: _layerSnap(layers.adx),
      volume: _layerSnap(layers.volume),
      sr: _layerSnap(layers.sr),
      candles: _layerSnap(layers.candles),
      liquidity: _layerSnap(layers.liquidity),
      divergence: _layerSnap(layers.divergence),
      htf: layers.htf
        ? { trend: layers.htf.trend, strength: layers.htf.strength }
        : null,
      regime: layers.regime || (layers.marketRegime && layers.marketRegime.regime) || null,
      m1: layers.m1
        ? { microstructure: layers.m1.microstructure, independent: !!layers.m1.independent }
        : null
    },
    buyScore: score.buyScore,
    sellScore: score.sellScore,
    directionalEdge: qualityParts.edge,
    confidenceSeed: score.confidence,
    confidenceAfterQuality: qualityParts.confidence,
    signalAfterQuality: qualityParts.signal,
    qualityReasons: (qualityParts.qualityReasons || []).slice(),
    primaryReject: qualityParts.primaryReject,
    rejectReasons: qualityParts.rejectReasons
  };
}

/**
 * Signal Quality only — does not apply data-mode, risk guard, dedup, or STRICT conf floor.
 */
function runSignalQuality(score, layers, cfg) {
  let signal = score.signal;
  let confidence = score.confidence;
  const warnings = [];
  const confirms = [];
  const rejectReasons = [];
  const qualityReasons = []; // soft/attribution only — never blocks signal
  let primaryReject = null;
  const edge = Math.abs((score.buyScore || 0) - (score.sellScore || 0));

  let regimeInfo = layers.marketRegime || null;
  if (!regimeInfo && window.GoldAI_MarketRegime) {
    regimeInfo = window.GoldAI_MarketRegime.buildMarketRegime(layers.adx, layers.structure);
  }
  if (layers.regime && typeof layers.regime === "string") {
    if (!regimeInfo) regimeInfo = { regime: layers.regime, sources: null };
    else regimeInfo = Object.assign({}, regimeInfo, { regime: layers.regime });
  } else if (regimeInfo && regimeInfo.regime) {
    layers.regime = regimeInfo.regime;
  }
  const regime = (layers.regime || (regimeInfo && regimeInfo.regime) || "NEUTRAL");

  let htfAlign = "NEUTRAL";
  if (layers.htf && window.GoldAI_HtfContext && !String(signal).includes("WAIT")) {
    htfAlign = window.GoldAI_HtfContext.htfAlignmentState(layers.htf, signal);
  } else if (layers.htf && !String(signal).includes("WAIT")) {
    const against =
      (signal.includes("BUY") && layers.htf.trend === "BEARISH") ||
      (signal.includes("SELL") && layers.htf.trend === "BULLISH");
    if (against) htfAlign = "AGAINST";
    else if (String(layers.htf.strength || "").toUpperCase() === "WEAK") htfAlign = "WEAK";
    else htfAlign = "ALIGNED";
  }

  const sq = _structureQuality(layers.structure);

  const components = {
    directionalEdge: edge,
    buyScore: score.buyScore,
    sellScore: score.sellScore,
    htf: layers.htf
      ? { trend: layers.htf.trend, strength: layers.htf.strength, alignment: htfAlign }
      : null,
    regime: regime,
    regimeSources: regimeInfo ? regimeInfo.sources : null,
    structureQuality: sq.band,
    bos: sq.bos,
    breakStrength: sq.breakStrength,
    primaryTf: String((cfg && cfg.ACTIVE_TIMEFRAME) || "m5").toUpperCase()
  };

  const V2 = !!(cfg && cfg.ENGINE_V2 === true);

  // ENGINE V2: late-entry (over-extension) penalty. Distance of price from
  // EMA20 in ATRs, in the signal direction. Beyond EXT_FREE_ATR (1.5) each
  // extra ATR costs 8 confidence points (max -16). Entering after the move
  // has already run was a main reason for ~50% win rate.
  if (V2 && !String(signal).includes("WAIT") && layers.ema && layers.atr && Number(layers.atr.atr) > 0) {
    const d = Number(layers.ema.distance20) / Number(layers.atr.atr);
    const along = signal.includes("BUY") ? d : -d;
    const free = (cfg && Number(cfg.EXT_FREE_ATR) > 0) ? Number(cfg.EXT_FREE_ATR) : 1.5;
    if (Number.isFinite(along) && along > free) {
      const pen = Math.min(16, Math.round((along - free) * 8));
      confidence -= pen;
      qualityReasons.push("EXTENDED");
      warnings.push("Price " + along.toFixed(1) + " ATR from EMA20 — late entry (-" + pen + ")");
    }
  }

  // Soft technical checks (V1 only: in V2 EMA/structure are already inside the
  // single trend vote, so penalising them again would count trend twice)
  if (!V2 && !String(signal).includes("WAIT") && layers.ema) {
    if (signal.includes("BUY") && layers.ema.trend === "BEARISH") {
      confidence -= 14;
      warnings.push("BUY vs EMA bearish");
    }
    if (signal.includes("SELL") && layers.ema.trend === "BULLISH") {
      confidence -= 14;
      warnings.push("SELL vs EMA bullish");
    }
    if (signal.includes("BUY") && layers.ema.trend === "BULLISH") confirms.push("EMA confirms BUY");
    if (signal.includes("SELL") && layers.ema.trend === "BEARISH") confirms.push("EMA confirms SELL");
  }

  if (!String(signal).includes("WAIT") && layers.rsi && layers.rsi.rsi != null) {
    if (signal.includes("BUY") && layers.rsi.rsi >= 78) {
      confidence -= 16;
      warnings.push("BUY into extreme OB RSI");
    }
    if (signal.includes("SELL") && layers.rsi.rsi <= 22) {
      confidence -= 16;
      warnings.push("SELL into extreme OS RSI");
    }
  }

  if (!String(signal).includes("WAIT") && layers.structure) {
    if (!V2 && signal.includes("BUY") && layers.structure.trend === "BEARISH" && !layers.structure.choch) {
      confidence -= 12;
      warnings.push("BUY vs bearish structure");
    }
    if (!V2 && signal.includes("SELL") && layers.structure.trend === "BULLISH" && !layers.structure.choch) {
      confidence -= 12;
      warnings.push("SELL vs bullish structure");
    }
    if (layers.structure.bos) confirms.push("BOS active");
    if (layers.structure.choch) warnings.push("CHoCH — regime shift");
  }

  // Market Regime (RANGE) — hard gate only when canonical regime is RANGE
  // (true ADX+Structure range concurrence after regime architecture fix).
  // Thresholds / strongBos rules unchanged. Filter not removed.
  if (!String(signal).includes("WAIT") && regime === "RANGE") {
    if (_isScalpTf(cfg) && !sq.strongBos) {
      signal = "WAIT 🟡";
      primaryReject = primaryReject || "REGIME_RANGE";
      rejectReasons.push("REGIME_RANGE");
      warnings.push("Range regime — entry blocked on scalp TF without strong BOS");
    } else if (!sq.strongBos) {
      confidence -= 12;
      warnings.push("Range regime — reduced confidence");
    } else {
      confirms.push("Range break with strong BOS");
    }
  }

  if (!String(signal).includes("WAIT") && sq.weakBos) {
    confidence -= 10;
    warnings.push("Weak BOS — structure quality reduced (soft)");
  }

  // HTF — same rules as before
  if (layers.htf && !String(signal).includes("WAIT")) {
    if (htfAlign === "AGAINST") {
      signal = "WAIT 🟡";
      primaryReject = primaryReject || "HTF_AGAINST";
      rejectReasons.push("HTF_AGAINST");
      warnings.push("Against HTF trend — entry blocked");
    } else if (htfAlign === "WEAK" || String(layers.htf.strength || "").toUpperCase() === "WEAK") {
      // Unknown/weak HTF is NOT opposition. Hard-WAIT here blocked real
      // M5 trends whenever resampled H1 stayed NEUTRAL (default strength=WEAK).
      // Keep a soft penalty; HTF_AGAINST remains the only HTF veto.
      confidence -= 10;
      qualityReasons.push("HTF_WEAK");
      warnings.push("HTF weak/unknown — confidence reduced (not blocked)");
    } else if (String(layers.htf.strength || "").toUpperCase() === "MODERATE") {
      confidence -= 4;
    } else if (String(layers.htf.strength || "").toUpperCase() === "STRONG") {
      confirms.push("HTF strength confirms");
      confidence += 4;
    }
  }

  if (confidence > 100) confidence = 100;
  if (confidence < 0) confidence = 0;
  confidence = Math.round(confidence);

  // Low directional edge — quality (unchanged threshold 2.2)
  if (edge < 2.2 && signal && !String(signal).includes("WAIT")) {
    signal = "WAIT 🟡";
    primaryReject = primaryReject || "LOW_EDGE";
    rejectReasons.push("LOW_EDGE");
    warnings.push("No clear directional edge");
  }

  if (!String(signal).includes("WAIT")) primaryReject = null;

  const qualityParts = {
    signal,
    confidence,
    edge,
    primaryReject,
    rejectReasons: rejectReasons.slice(),
    qualityReasons: qualityReasons.slice()
  };

  let waitStage = score.waitStage || "NONE";
  if (String(signal).includes("WAIT") && primaryReject) waitStage = "QUALITY";
  else if (String(signal).includes("WAIT") && waitStage === "NONE") waitStage = "QUALITY";
  else if (!String(signal).includes("WAIT")) waitStage = "NONE";

  return {
    signal,
    confidence,
    confidenceNote: "technical composite score (not win probability)",
    buyScore: score.buyScore,
    sellScore: score.sellScore,
    directionalEdge: edge,
    signalQuality: confidence >= 78 ? "HIGH" : confidence >= 65 ? "MEDIUM" : "LOW",
    marketQuality: regime,
    contextQuality: htfAlign,
    entryQuality: confidence >= 78 ? "HIGH" : confidence >= 65 ? "MEDIUM" : "LOW",
    reason: score.reason,
    primaryReject,
    rejectReasons,
    qualityReasons: qualityReasons.slice(),
    components,
    warnings: warnings.concat(score.warnings || []),
    confirms: confirms.concat(score.confirms || []),
    diagnostics: buildSignalDiagnostics(score, layers, qualityParts),
    qualityLayer: true,
    waitStage: waitStage
  };
}

/**
 * Backward-compatible pipeline: Signal Quality → Trade Permission.
 * Same gates and thresholds as the previous monolithic filter; ownership is split.
 */
function runConflictFilter(score, layers, cfg) {
  const quality = runSignalQuality(score, layers, cfg);
  let final = quality;
  if (window.GoldAI_TradePermission && window.GoldAI_TradePermission.runTradePermission) {
    final = window.GoldAI_TradePermission.runTradePermission(quality, layers, cfg);
  }
  // Merge diagnostics with final decision (observation only)
  if (quality.diagnostics) {
    final.diagnostics = Object.assign({}, quality.diagnostics, {
      confidenceFinal: final.confidence,
      signalFinal: final.signal,
      primaryRejectFinal: final.primaryReject,
      tradePermission: final.tradePermission || null,
      qualityReasons: (final.qualityReasons || quality.qualityReasons || []).slice()
    });
  }
  if (final.qualityReasons == null && quality.qualityReasons) {
    final.qualityReasons = quality.qualityReasons.slice();
  }
  return final;
}

window.GoldAI_Conflict = { runConflictFilter, runSignalQuality };
