// =====================================
// GoldAI — Conflict Filter (balanced gate + safety)
// =====================================

function runConflictFilter(score, layers, cfg) {
  let signal = score.signal;
  let confidence = score.confidence;
  const warnings = [];
  const confirms = [];

  // --- Data mode hard guards ---
  const dataMode = (window.GoldAI_Data && window.GoldAI_Data.dataMode
    ? String(window.GoldAI_Data.dataMode).toLowerCase()
    : "demo");

  if (cfg && cfg.STRICT_DATA_MODE !== false) {
    if (dataMode === "demo" || dataMode === "offline") {
      if (signal && !signal.includes("WAIT")) {
        signal = "WAIT 🟡";
        confidence = Math.min(confidence, 35);
        warnings.push(dataMode === "offline"
          ? "MT5 OFFLINE → forced WAIT (price is not live)"
          : "DEMO data → forced WAIT (not tradable)");
      }
    } else if (dataMode === "mixed") {
      confidence = Math.max(0, confidence - 12);
      warnings.push("MIXED data (live price + synthetic candles) — reduced confidence");
    }
  }

  // --- Risk Guard (circuit breaker) ---
  if (window.GoldAI_RiskGuard && signal && !signal.includes("WAIT")) {
    const rg = window.GoldAI_RiskGuard.check(cfg || window.GoldAI_Config);
    if (!rg.allowed) {
      signal = "WAIT 🟡";
      confidence = Math.min(confidence, 30);
      warnings.push("Risk Guard: " + (rg.reason || "blocked"));
    }
  }

  if (layers.ema) {
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

  if (layers.rsi && layers.rsi.rsi != null) {
    if (signal.includes("BUY") && layers.rsi.rsi >= 78) {
      confidence -= 16;
      warnings.push("BUY into extreme OB RSI");
    }
    if (signal.includes("SELL") && layers.rsi.rsi <= 22) {
      confidence -= 16;
      warnings.push("SELL into extreme OS RSI");
    }
  }

  if (layers.structure) {
    if (signal.includes("BUY") && layers.structure.trend === "BEARISH" && !layers.structure.choch) {
      confidence -= 12;
      warnings.push("BUY vs bearish structure");
    }
    if (signal.includes("SELL") && layers.structure.trend === "BULLISH" && !layers.structure.choch) {
      confidence -= 12;
      warnings.push("SELL vs bullish structure");
    }
    if (layers.structure.bos) confirms.push("BOS active");
    if (layers.structure.choch) warnings.push("CHoCH — regime shift");
  }

  // Range: soften, do not always kill good breakout setups
  if (layers.adx && layers.adx.regime === "RANGE") {
    if (confidence < 78) {
      confidence -= 8;
      warnings.push("Range market — reduced confidence");
    }
  }

  if (layers.htf) {
    if (signal.includes("BUY") && layers.htf.trend === "BEARISH") {
      confidence -= 10;
      warnings.push("Against HTF trend");
    }
    if (signal.includes("SELL") && layers.htf.trend === "BULLISH") {
      confidence -= 10;
      warnings.push("Against HTF trend");
    }
  }

  if (layers.aiBrain) {
    if (signal.includes("BUY") && layers.aiBrain.aiSignal && layers.aiBrain.aiSignal.includes("SELL")) {
      confidence -= 14;
      warnings.push("AI meta opposite (SELL) vs BUY setup");
    }
    if (signal.includes("SELL") && layers.aiBrain.aiSignal && layers.aiBrain.aiSignal.includes("BUY")) {
      confidence -= 14;
      warnings.push("AI meta opposite (BUY) vs SELL setup");
    }
  }

  if (confidence > 100) confidence = 100;
  if (confidence < 0) confidence = 0;
  confidence = Math.round(confidence);

  // Balanced floor
  const minC = (cfg && cfg.MIN_CONFIDENCE) ? Math.max(cfg.MIN_CONFIDENCE, 66) : 70;
  if (cfg && cfg.STRICT_MODE && confidence < minC && !signal.includes("WAIT")) {
    signal = "WAIT 🟡";
    warnings.push("Confidence " + confidence + " < " + minC);
  }

  // Need a real edge
  const edge = Math.abs((score.buyScore || 0) - (score.sellScore || 0));
  if (edge < 2.2 && !signal.includes("WAIT")) {
    signal = "WAIT 🟡";
    warnings.push("No clear directional edge");
  }

  return {
    signal,
    confidence,
    // Explicit: this is a technical strength score (0-100), NOT a real win-probability
    confidenceNote: "score (not probability)",
    buyScore: score.buyScore,
    sellScore: score.sellScore,
    entryQuality: confidence >= 78 ? "HIGH" : confidence >= 65 ? "MEDIUM" : "LOW",
    reason: score.reason,
    warnings: warnings.concat(score.warnings || []),
    confirms: confirms.concat(score.confirms || [])
  };
}

window.GoldAI_Conflict = { runConflictFilter };
