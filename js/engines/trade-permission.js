// =====================================
// GoldAI — Trade Permission (not Signal Quality)
// Applies data-mode, client Risk Guard, signal dedup cooldown, STRICT confidence floor.
// Thresholds unchanged. Does not alter directional edge or indicator scoring.
//
// Dedup state is committed ONLY if the signal remains non-WAIT after ALL permission
// gates in this module (including STRICT confidence floor). Matches legacy behavior
// in the pre-separation conflict-filter (_pending then commit if !WAIT).
// =====================================

const _clusterState = {
  lastDir: null,
  lastAt: 0,
  lastTf: null,
  lastEntry: null,
  lastSL: null,
  lastTP: null,
  _pending: null
};

function _tfBarMs(tf) {
  const u = String(tf || "").toUpperCase();
  const m = /^M(\d+)$/.exec(u);
  if (m) return Number(m[1]) * 60 * 1000;
  const h = /^H(\d+)$/.exec(u);
  if (h) return Number(h[1]) * 3600 * 1000;
  const d = /^D(\d+)$/.exec(u);
  if (d) return Number(d[1]) * 86400 * 1000;
  return 60 * 1000;
}

function _tfCooldownMs(tf, cfg) {
  // N closed bars of the *active* TF — not a hardcoded M5 clock.
  const bars = (cfg && Number(cfg.SIGNAL_COOLDOWN_BARS) > 0) ? Number(cfg.SIGNAL_COOLDOWN_BARS) : 6;
  return _tfBarMs(tf) * bars;
}

function _livePrice(layers, cfg) {
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  return n(layers && layers.price)
    || n(cfg && cfg.LIVE_PRICE)
    || n(window.GoldAI_Data && (window.GoldAI_Data.lastPrice || window.GoldAI_Data.price))
    || null;
}

function _ideaStillOpen(dir, price, st) {
  if (!dir || !price || st.lastDir !== dir) return false;
  if (st.lastSL == null || st.lastTP == null) return false;
  if (dir === "BUY") return price > st.lastSL && price < st.lastTP;
  if (dir === "SELL") return price < st.lastSL && price > st.lastTP;
  return false;
}

/**
 * @param {object} qualityResult - output of runSignalQuality / partial conflict result
 * @param {object} layers
 * @param {object} cfg
 * @returns {object} same shape, possibly WAIT with permission primaryReject
 */
function runTradePermission(qualityResult, layers, cfg) {
  let signal = qualityResult.signal;
  let confidence = Number(qualityResult.confidence) || 0;
  const warnings = (qualityResult.warnings || []).slice();
  const confirms = (qualityResult.confirms || []).slice();
  const rejectReasons = (qualityResult.rejectReasons || []).slice();
  const qualityReasons = (qualityResult.qualityReasons || []).slice();
  let primaryReject = qualityResult.primaryReject || null;
  const permissionFlags = {
    dataModeOk: true,
    riskGuardOk: true,
    dedupOk: true,
    confidenceFloorOk: true
  };

  _clusterState._pending = null;

  const dataMode = (window.GoldAI_Data && window.GoldAI_Data.dataMode
    ? String(window.GoldAI_Data.dataMode).toLowerCase()
    : "demo");

  if (cfg && cfg.STRICT_DATA_MODE !== false) {
    if (dataMode === "demo" || dataMode === "offline") {
      if (signal && !String(signal).includes("WAIT")) {
        signal = "WAIT 🟡";
        primaryReject = primaryReject || "DATA_MODE";
        rejectReasons.push(dataMode === "offline" ? "DATA_OFFLINE" : "DATA_DEMO");
        warnings.push(dataMode === "offline"
          ? "MT5 OFFLINE → forced WAIT (price is not live)"
          : "DEMO data → forced WAIT (not tradable)");
        permissionFlags.dataModeOk = false;
      }
    } else if (dataMode === "mixed") {
      confidence = Math.max(0, confidence - 12);
      warnings.push("MIXED data (live price + synthetic candles) — reduced confidence");
    }
  }

  if (window.GoldAI_RiskGuard && signal && !String(signal).includes("WAIT")) {
    const rg = window.GoldAI_RiskGuard.check(cfg || window.GoldAI_Config);
    if (!rg.allowed) {
      signal = "WAIT 🟡";
      primaryReject = primaryReject || "RISK_GUARD";
      rejectReasons.push("RISK_GUARD");
      warnings.push("Risk Guard: " + (rg.reason || "blocked"));
      permissionFlags.riskGuardOk = false;
    }
  }

  // CHANGED 2026-10-07: same-direction repeat lock is now ONLY a short cooldown
  // of cfg.SIGNAL_COOLDOWN_BARS closed candles of the active timeframe.
  // (Was: blocked until the previous idea's virtual SL/TP was touched, which
  // could last for hours.) Opposite direction is never blocked.
  // Do NOT rewrite BUY/SELL → WAIT (dashboard showed 92% WAIT — contradictory).
  if (!String(signal).includes("WAIT")) {
    const dir = signal.includes("BUY") ? "BUY" : signal.includes("SELL") ? "SELL" : null;
    const tf = String((cfg && cfg.ACTIVE_TIMEFRAME) || "M5").toUpperCase();
    const now = (cfg && Number(cfg.SIGNAL_TIME_MS) > 0) ? Number(cfg.SIGNAL_TIME_MS) : Date.now();
    const cd = _tfCooldownMs(tf, cfg);
    const px = _livePrice(layers, cfg);
    const sameDir = dir && _clusterState.lastDir === dir && _clusterState.lastTf === tf;
    const openIdea = false; // "idea still open" lock removed — cooldown only
    const inCooldown = sameDir && (now - _clusterState.lastAt) < cd;
    if (openIdea || inCooldown) {
      primaryReject = primaryReject || (openIdea ? "SIGNAL_CLUSTER" : "SIGNAL_DEDUP");
      rejectReasons.push(openIdea ? "SIGNAL_CLUSTER" : "SIGNAL_DEDUP");
      warnings.push(openIdea
        ? "Same-direction idea still open (SL/TP not hit) — first signal of the move only"
        : "Signal cooldown (" + Math.round(cd / _tfBarMs(tf)) + " candles same direction) — order blocked, direction unchanged");
      permissionFlags.dedupOk = false;
    } else if (dir) {
      const atr = layers && layers.atr && Number(layers.atr.atr);
      const slM = (cfg && cfg.ATR_SL_MULT) != null ? Number(cfg.ATR_SL_MULT) : 2;
      const tpM = (cfg && cfg.ATR_TP1_MULT) != null ? Number(cfg.ATR_TP1_MULT) : 3;
      let lastSL = null, lastTP = null;
      if (px && atr > 0) {
        lastSL = dir === "BUY" ? px - atr * slM : px + atr * slM;
        lastTP = dir === "BUY" ? px + atr * tpM : px - atr * tpM;
      }
      _clusterState._pending = { dir: dir, tf: tf, now: now, entry: px, lastSL: lastSL, lastTP: lastTP };
    }
  }

  if (confidence > 100) confidence = 100;
  if (confidence < 0) confidence = 0;
  confidence = Math.round(confidence);

  // STRICT confidence floor (unchanged thresholds) — permission to treat as actionable
  let minC = (cfg && cfg.MIN_CONFIDENCE) ? Math.max(cfg.MIN_CONFIDENCE, 66) : 70;
  // ENGINE V2 has its own confidence scale -> its own floor
  if (cfg && cfg.ENGINE_V2 === true && Number(cfg.V2_MIN_CONFIDENCE) > 0) minC = Number(cfg.V2_MIN_CONFIDENCE);
  if (cfg && cfg.STRICT_MODE && confidence < minC && signal && !String(signal).includes("WAIT")) {
    signal = "WAIT 🟡";
    primaryReject = primaryReject || "LOW_CONFIDENCE";
    rejectReasons.push("LOW_CONFIDENCE");
    warnings.push("Confidence " + confidence + " < " + minC);
    permissionFlags.confidenceFloorOk = false;
  }

  // Commit dedup state ONLY if signal still actionable after all permission gates
  const permissionBlocked = !permissionFlags.dataModeOk || !permissionFlags.riskGuardOk
    || !permissionFlags.dedupOk || !permissionFlags.confidenceFloorOk;
  if (!String(signal).includes("WAIT") && !permissionBlocked && _clusterState._pending) {
    _clusterState.lastDir = _clusterState._pending.dir;
    _clusterState.lastTf = _clusterState._pending.tf;
    _clusterState.lastAt = _clusterState._pending.now;
    _clusterState.lastEntry = _clusterState._pending.entry;
    _clusterState.lastSL = _clusterState._pending.lastSL;
    _clusterState.lastTP = _clusterState._pending.lastTP;
  }
  _clusterState._pending = null;

  if (!String(signal).includes("WAIT") && !permissionBlocked) primaryReject = null;

  let waitStage = qualityResult.waitStage || "NONE";
  if (permissionBlocked && primaryReject &&
      (primaryReject === "DATA_MODE" || primaryReject === "RISK_GUARD" ||
       primaryReject === "SIGNAL_DEDUP" || primaryReject === "SIGNAL_CLUSTER" ||
       primaryReject === "LOW_CONFIDENCE" ||
       rejectReasons.indexOf("DATA_DEMO") >= 0 || rejectReasons.indexOf("DATA_OFFLINE") >= 0)) {
    waitStage = "PERMISSION";
  } else if (String(signal).includes("WAIT") && primaryReject) {
    waitStage = "PERMISSION";
  } else if (!String(signal).includes("WAIT")) {
    waitStage = "NONE";
  }

  return Object.assign({}, qualityResult, {
    signal,
    confidence,
    primaryReject,
    rejectReasons,
    qualityReasons,
    warnings,
    confirms,
    entryQuality: confidence >= 78 ? "HIGH" : confidence >= 65 ? "MEDIUM" : "LOW",
    tradePermission: permissionFlags,
    permissionLayer: true,
    executionBlocked: permissionBlocked,
    waitStage: waitStage
  });
}

window.GoldAI_TradePermission = {
  runTradePermission,
  snapshotCluster: function () {
    return {
      lastDir: _clusterState.lastDir,
      lastAt: _clusterState.lastAt,
      lastTf: _clusterState.lastTf,
      lastEntry: _clusterState.lastEntry,
      lastSL: _clusterState.lastSL,
      lastTP: _clusterState.lastTP
    };
  },
  restoreCluster: function (s) {
    _clusterState.lastDir = s && s.lastDir != null ? s.lastDir : null;
    _clusterState.lastAt = s && s.lastAt ? s.lastAt : 0;
    _clusterState.lastTf = s && s.lastTf != null ? s.lastTf : null;
    _clusterState.lastEntry = s && s.lastEntry != null ? s.lastEntry : null;
    _clusterState.lastSL = s && s.lastSL != null ? s.lastSL : null;
    _clusterState.lastTP = s && s.lastTP != null ? s.lastTP : null;
    _clusterState._pending = null;
  },
  resetCluster: function () {
    _clusterState.lastDir = null;
    _clusterState.lastAt = 0;
    _clusterState.lastTf = null;
    _clusterState.lastEntry = null;
    _clusterState.lastSL = null;
    _clusterState.lastTP = null;
    _clusterState._pending = null;
  }
};
