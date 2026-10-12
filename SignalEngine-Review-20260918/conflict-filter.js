// =====================================
// GoldAI — Conflict Filter (quality gates + safety)
// Hard gates for HTF-weak / Range / weak-BOS / signal clustering.
// Confidence here is a technical score, NOT a win-probability.
// =====================================

// In-process anti-cluster memory (shared by browser + worker via engine-loader).
// Prevents several near-identical directional signals on consecutive M5 bars
// from all becoming "actionable" without a real regime change.
const _clusterState = {
  lastDir: null,       // "BUY" | "SELL"
  lastAt: 0,           // ms epoch
  lastTf: null,
  lastBreakTs: 0
};

function _tfCooldownMs(tf) {
  const u = String(tf || "M5").toUpperCase();
  if (u === "M1") return 3 * 60 * 1000;
  if (u === "M5") return 12 * 60 * 1000;   // ~2–3 M5 bars
  if (u === "M15") return 25 * 60 * 1000;
  if (u === "M30") return 40 * 60 * 1000;
  if (u === "H1") return 70 * 60 * 1000;
  if (u === "H4") return 3 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function _isScalpTf(cfg) {
  const tf = String((cfg && cfg.ACTIVE_TIMEFRAME) || "m5").toLowerCase();
  return tf === "m1" || tf === "m5" || tf === "m15" || tf === "m30";
}

function runConflictFilter(score, layers, cfg) {
  let signal = score.signal;
  let confidence = score.confidence;
  const warnings = [];
  const confirms = [];
  const edge = Math.abs((score.buyScore || 0) - (score.sellScore || 0));

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

  // --- Risk Guard (circuit breaker, client UX only) ---
  if (window.GoldAI_RiskGuard && signal && !signal.includes("WAIT")) {
    const rg = window.GoldAI_RiskGuard.check(cfg || window.GoldAI_Config);
    if (!rg.allowed) {
      signal = "WAIT 🟡";
      confidence = Math.min(confidence, 30);
      warnings.push("Risk Guard: " + (rg.reason || "blocked"));
    }
  }

  // --- EMA disagreement ---
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

  // =====================================================================
  // HARD GATE: Range market (especially gold scalp on M5)
  // Soft -8 was insufficient; range + weak BOS produced many SL hits.
  // =====================================================================
  const adxRange = layers.adx && layers.adx.regime === "RANGE";
  const structRange = layers.structure && layers.structure.regime === "RANGE";
  const weakBos = layers.structure && layers.structure.bos &&
    (Number(layers.structure.breakStrength) || 0) < 0.25;
  const strongBos = layers.structure && layers.structure.bos &&
    (Number(layers.structure.breakStrength) || 0) >= 0.30;

  if (!signal.includes("WAIT") && (adxRange || structRange)) {
    if (_isScalpTf(cfg) && !strongBos) {
      signal = "WAIT 🟡";
      confidence = Math.min(confidence, 45);
      warnings.push(adxRange
        ? "Range market (ADX) — entry blocked on scalp TF"
        : "Range structure — entry blocked on scalp TF (need stronger BOS)");
    } else if (!strongBos) {
      confidence -= 12;
      warnings.push("Range market — reduced confidence");
    } else {
      confirms.push("Range break with strong BOS");
    }
  }

  // Weak BOS must not carry a directional trade alone
  if (!signal.includes("WAIT") && weakBos && edge < 7) {
    signal = "WAIT 🟡";
    confidence = Math.min(confidence, 50);
    warnings.push("Weak BOS — insufficient break strength for entry");
  } else if (!signal.includes("WAIT") && weakBos) {
    confidence -= 10;
    warnings.push("Weak BOS — confidence cut");
  }

  // =====================================================================
  // HARD GATE: HTF weak
  // Previous data showed 100% of actionable signals had HTF-weak warning
  // because strength was miscomputed (ema.confidence never existed).
  // With corrected strength, WEAK must actually block or demand exceptional edge.
  // =====================================================================
  if (layers.htf && !signal.includes("WAIT")) {
    const htfStr = String(layers.htf.strength || "WEAK").toUpperCase();
    const againstHtf =
      (signal.includes("BUY") && layers.htf.trend === "BEARISH") ||
      (signal.includes("SELL") && layers.htf.trend === "BULLISH");

    if (againstHtf) {
      signal = "WAIT 🟡";
      confidence = Math.min(confidence, 40);
      warnings.push("Against HTF trend — entry blocked");
    } else if (htfStr === "WEAK") {
      // Allow only exceptional edge + non-range + aligned structure
      const exceptional =
        edge >= 9 &&
        !adxRange &&
        !structRange &&
        layers.structure &&
        (layers.structure.trend === "BULLISH" || layers.structure.trend === "BEARISH");
      if (!exceptional) {
        signal = "WAIT 🟡";
        confidence = Math.min(confidence, 48);
        warnings.push("HTF weak — entry blocked (need stronger edge + clear structure)");
      } else {
        confidence -= 18;
        warnings.push("HTF weak — exceptional-edge override (reduced confidence)");
      }
    } else if (htfStr === "MODERATE") {
      confidence -= 4;
    } else if (htfStr === "STRONG") {
      confirms.push("HTF strength confirms");
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

  // =====================================================================
  // Anti-cluster / cooldown (same direction within TF cooldown → WAIT)
  // Does not touch execution path — only signal quality.
  // =====================================================================
  if (!signal.includes("WAIT")) {
    const dir = signal.includes("BUY") ? "BUY" : signal.includes("SELL") ? "SELL" : null;
    const tf = String((cfg && cfg.ACTIVE_TIMEFRAME) || "M5").toUpperCase();
    const now = Date.now();
    const cd = _tfCooldownMs(tf);
    if (
      dir &&
      _clusterState.lastDir === dir &&
      _clusterState.lastTf === tf &&
      (now - _clusterState.lastAt) < cd
    ) {
      signal = "WAIT 🟡";
      confidence = Math.min(confidence, 42);
      warnings.push("Signal cluster cooldown (" + Math.round(cd / 60000) + "m same direction)");
    } else if (dir) {
      // Record only when we keep a directional signal (after all gates)
      // deferred until end of function once final signal is known
      _clusterState._pending = { dir, tf, now };
    }
  }

  if (confidence > 100) confidence = 100;
  if (confidence < 0) confidence = 0;
  confidence = Math.round(confidence);

  // Balanced floor (AUTO_MIN_CONFIDENCE unchanged — used later by worker/backend)
  const minC = (cfg && cfg.MIN_CONFIDENCE) ? Math.max(cfg.MIN_CONFIDENCE, 66) : 70;
  if (cfg && cfg.STRICT_MODE && confidence < minC && !signal.includes("WAIT")) {
    signal = "WAIT 🟡";
    warnings.push("Confidence " + confidence + " < " + minC);
  }

  // Need a real edge
  if (edge < 2.2 && !signal.includes("WAIT")) {
    signal = "WAIT 🟡";
    warnings.push("No clear directional edge");
  }

  // Commit cluster state only for final directional signals
  if (!signal.includes("WAIT") && _clusterState._pending) {
    _clusterState.lastDir = _clusterState._pending.dir;
    _clusterState.lastTf = _clusterState._pending.tf;
    _clusterState.lastAt = _clusterState._pending.now;
  }
  _clusterState._pending = null;

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
