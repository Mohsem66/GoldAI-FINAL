// =====================================
// GoldAI — Diagnostic Signal Attribution (OBSERVATION-ONLY, Worker-only in v1)
// -------------------------------------
// - Pure reader of the ALREADY-COMPUTED `final` and `layers`. Calls NO engine
//   (no analyzeMarketStructure / runTradePermission / RiskGuard.check / runScoreEngine ...).
// - Never mutates layers, final, or cfg.
// - EDGE attribution: layer.buyScore/sellScore x the REAL weights of score.js, accumulated in the SAME
//   order and rounded at the SAME place (toFixed(1) once, after all additions). HTF and M1 are separate.
// - CONFIDENCE: pipeline ledger only (seed -> named quality adjustments -> clip/round -> permission
//   before/after/delta -> final). There is NO per-indicator confidence share, by design and by contract.
// - aiBrain / fundamental / correlation are not part of buildSignal layers and are not attributed.
// - Enabled only when cfg.ATTRIBUTION_ENABLED === true (default false).
// =====================================
(function () {
  const VERSION = "1.2.0";

  // MUST mirror score.js runScoreEngine (order matters for float-identical sums).
  const LAYER_WEIGHTS = [
    ["structure", 1.5], ["ema", 1.3], ["rsi", 1.1], ["divergence", 1.25], ["macd", 1.0],
    ["adx", 1.25], ["volume", 1.1], ["sr", 0.95], ["candles", 0.85], ["liquidity", 1.4]
  ];
  const HTF_BIAS = 3.5;   // score.js: htf.trend BULLISH -> buy += 3.5 ; BEARISH -> sell += 3.5
  const M1_BIAS = 1.2;    // score.js: m1.independent === true && microstructure BULLISH/BEARISH -> +1.2
  // Both sides are produced by the identical arithmetic, so equality is expected to be EXACT (diff 0).
  // The tolerance only absorbs representation noise if a future score.js reorders additions; it is recorded in every row.
  const RECONCILE_TOLERANCE = 1e-9;

  function round1(x) { return Number(x.toFixed(1)); } // score.js: Number(buy.toFixed(1))

  function isNonDirectionalSignal(s) {
    if (s == null || s === "") return true;
    var u = String(s).toUpperCase();
    return u.indexOf("WAIT") >= 0 || u === "NONE" || u === "—" || u === "-";
  }

  // Observation-only: explain RawDirection/Final non-direction from fields already on final/layers/diagnostics.
  // Never re-runs score/quality/permission. Never invents thresholds not present in data.
  function buildDirectionTrace(final, layers, diag, steps, totBuy, totSell, obsEdge, recomputedEdge) {
    diag = diag || {};
    layers = layers || {};
    var rawSignal = null;
    if (steps && steps.length && steps[0] && steps[0].rawSignal != null) rawSignal = steps[0].rawSignal;
    var signalAfterQuality = diag.signalAfterQuality != null ? diag.signalAfterQuality : null;
    var finalSignal = final.signal != null ? final.signal : null;
    var primaryReject = final.primaryReject || diag.primaryRejectFinal || diag.primaryReject || null;
    var rejectReasons = Array.isArray(final.rejectReasons) ? final.rejectReasons.slice() : [];
    var qualityReasons = Array.isArray(final.qualityReasons) ? final.qualityReasons.slice()
      : (Array.isArray(diag.qualityReasons) ? diag.qualityReasons.slice() : []);
    var waitStage = final.waitStage != null ? final.waitStage : null;
    var regime = null;
    if (typeof layers.regime === "string") regime = layers.regime;
    else if (layers.marketRegime && layers.marketRegime.regime) regime = layers.marketRegime.regime;
    else if (diag.layers && diag.layers.regime) regime = diag.layers.regime;

    var rawIsNone = isNonDirectionalSignal(rawSignal);
    var afterQualityIsWait = isNonDirectionalSignal(signalAfterQuality);
    var finalIsWait = isNonDirectionalSignal(finalSignal);

    var stage = null;
    if (finalIsWait && rawIsNone) stage = "RAW_OR_SCORE_NON_DIRECTIONAL";
    else if (finalIsWait && !rawIsNone && afterQualityIsWait) stage = "QUALITY_FORCED_WAIT";
    else if (finalIsWait && !rawIsNone && !afterQualityIsWait) stage = "PERMISSION_OR_POST_QUALITY_WAIT";
    else if (!finalIsWait) stage = "DIRECTIONAL_FINAL";

    var missing = [];
    function present(name, val) {
      if (val === undefined || val === null) { missing.push(name); return false; }
      if (Array.isArray(val) && val.length === 0) { missing.push(name); return false; }
      return true;
    }
    present("rawSignal", rawSignal);
    present("buyScore", final.buyScore);
    present("sellScore", final.sellScore);
    present("directionalEdge", obsEdge);
    present("signalAfterQuality", signalAfterQuality);
    present("finalSignal", finalSignal);
    present("primaryReject", primaryReject);
    present("waitStage", waitStage);

    var reasonAvailable = (
      Number.isFinite(final.buyScore) || Number.isFinite(final.sellScore) ||
      obsEdge != null ||
      primaryReject != null ||
      rejectReasons.length > 0 ||
      qualityReasons.length > 0 ||
      waitStage != null ||
      rawSignal != null ||
      signalAfterQuality != null
    );

    return {
      rawDirectionIsNone: rawIsNone,
      finalIsNonDirectional: finalIsWait,
      stage: stage,
      reasonAvailable: !!reasonAvailable,
      reasonSourceUnavailable: !reasonAvailable,
      missingFields: missing,
      pipeline: {
        rawSignal: rawSignal,
        signalAfterQuality: signalAfterQuality,
        finalSignal: finalSignal,
        buyScore: final.buyScore != null ? final.buyScore : null,
        sellScore: final.sellScore != null ? final.sellScore : null,
        buyScoreRecomputed: totBuy,
        sellScoreRecomputed: totSell,
        directionalEdgeObserved: obsEdge != null ? obsEdge : null,
        directionalEdgeRecomputed: recomputedEdge,
        primaryReject: primaryReject,
        rejectReasons: rejectReasons,
        qualityReasons: qualityReasons,
        waitStage: waitStage,
        confidenceSeed: diag.confidenceSeed != null ? diag.confidenceSeed : null,
        confidenceAfterQuality: diag.confidenceAfterQuality != null ? diag.confidenceAfterQuality : null,
        confidenceFinal: final.confidence != null ? final.confidence : null,
        regime: regime,
        htf: layers.htf ? {
          trend: layers.htf.trend != null ? layers.htf.trend : null,
          strength: layers.htf.strength != null ? layers.htf.strength : null
        } : null,
        structure: layers.structure ? {
          trend: layers.structure.trend != null ? layers.structure.trend : null,
          bos: layers.structure.bos != null,
          choch: layers.structure.choch != null
        } : null,
        tradePermission: final.tradePermission ? Object.assign({}, final.tradePermission) : null
      },
      note: "Observation-only snapshot from final/layers/diagnostics. No engine re-run; no invented thresholds."
    };
  }

  function build(final, layers, cfg) {
    if (!final || typeof final !== "object") throw new Error("ATTRIBUTION_NO_FINAL");
    layers = layers || {};

    // ---- Edge: same accumulation order as score.js ----
    let buy = 0, sell = 0;
    const layerRows = {};
    for (const [name, w] of LAYER_WEIGHTS) {
      const L = layers[name];
      if (!L) { layerRows[name] = { present: false, weight: w }; continue; }
      const b = (L.buyScore || 0), s = (L.sellScore || 0);
      buy += b * w; sell += s * w;
      layerRows[name] = { present: true, weight: w, buyScore: b, sellScore: s, buyContribution: b * w, sellContribution: s * w };
    }
    // (score.js adds aiBrain here if present in layers; not part of buildSignal -> flagged below, not attributed)
    const htfContribution = { applied: false, trend: layers.htf ? layers.htf.trend : null, buy: 0, sell: 0 };
    if (layers.htf) {
      if (layers.htf.trend === "BULLISH") { buy += HTF_BIAS; htfContribution.applied = true; htfContribution.buy = HTF_BIAS; }
      if (layers.htf.trend === "BEARISH") { sell += HTF_BIAS; htfContribution.applied = true; htfContribution.sell = HTF_BIAS; }
    }
    const m1Contribution = {
      applied: false, present: !!layers.m1, independent: layers.m1 ? layers.m1.independent === true : null,
      microstructure: layers.m1 ? layers.m1.microstructure : null, buy: 0, sell: 0
    };
    if (layers.m1 && layers.m1.independent === true) {
      if (layers.m1.microstructure === "BULLISH") { buy += M1_BIAS; m1Contribution.applied = true; m1Contribution.buy = M1_BIAS; }
      if (layers.m1.microstructure === "BEARISH") { sell += M1_BIAS; m1Contribution.applied = true; m1Contribution.sell = M1_BIAS; }
    }
    const notAttributed = [];
    for (const k of ["aiBrain", "fundamental", "correlation"]) if (layers[k]) notAttributed.push(k);

    const totBuy = round1(buy), totSell = round1(sell);
    const recomputedEdge = Math.abs(totBuy - totSell); // conflict-filter.js: Math.abs(score.buyScore - score.sellScore) (no re-rounding)
    const diag = final.diagnostics || {};
    const obsEdge = final.directionalEdge != null ? final.directionalEdge : diag.directionalEdge;
    const dBuy = Math.abs(totBuy - final.buyScore), dSell = Math.abs(totSell - final.sellScore), dEdge = Math.abs(recomputedEdge - obsEdge);
    const maxAbsDiff = Math.max(dBuy, dSell, dEdge);
    const reconciled = Number.isFinite(maxAbsDiff) && maxAbsDiff <= RECONCILE_TOLERANCE && notAttributed.indexOf("aiBrain") < 0;

    // ---- Confidence: pipeline ledger (real recorded steps only) ----
    const steps = Array.isArray(final.confidenceSteps) ? final.confidenceSteps.map(function (x) { return Object.assign({}, x); }) : null;
    let chainConsistent = null;
    if (steps && steps.length) {
      chainConsistent = true;
      for (let i = 1; i < steps.length; i++) if (steps[i].before !== steps[i - 1].after) chainConsistent = false;
    }
    const afterQuality = diag.confidenceAfterQuality != null ? diag.confidenceAfterQuality : null;
    const lastAfter = steps && steps.length ? steps[steps.length - 1].after : null;

    return {
      version: VERSION,
      evidence: layerRows,
      edge: {
        layers: layerRows,
        htfContribution: htfContribution,
        m1Contribution: m1Contribution,
        totals: { buyRaw: buy, sellRaw: sell, buy: totBuy, sell: totSell },
        directionalEdge: { recomputed: recomputedEdge, observed: obsEdge },
        reconciliation: {
          reconciledWithScoreEngine: reconciled, tolerance: RECONCILE_TOLERANCE, maxAbsDiff: maxAbsDiff,
          observed: { buyScore: final.buyScore, sellScore: final.sellScore, directionalEdge: obsEdge }
        },
        notAttributedButPresentInLayers: notAttributed
      },
      confidence: {
        note: "pipeline ledger only; no per-indicator confidence share exists or is computed",
        seed: diag.confidenceSeed != null ? diag.confidenceSeed : null,      // score.js result; not decomposed
        steps: steps,                                                         // SEED, QUALITY_* adjustments, QUALITY_CLIP_ROUND (before/after/delta)
        chain: { consistent: chainConsistent, lastStepAfterEqualsAfterQuality: lastAfter !== null && afterQuality !== null ? lastAfter === afterQuality : null },
        afterQuality: afterQuality,
        permission: {
          before: afterQuality, after: final.confidence,
          delta: (afterQuality != null && Number.isFinite(final.confidence)) ? final.confidence - afterQuality : null,
          breakdown: "NOT_RECORDED (trade-permission.js not instrumented; aggregate only)",
          dataMode: (typeof window !== "undefined" && window.GoldAI_Data && window.GoldAI_Data.dataMode) || null,
          flags: final.tradePermission ? Object.assign({}, final.tradePermission) : null
        },
        final: final.confidence
      },
      decision: {
        rawSignal: steps && steps[0] ? (steps[0].rawSignal || null) : null,
        signalAfterQuality: diag.signalAfterQuality != null ? diag.signalAfterQuality : null,
        finalSignal: final.signal,
        quality: { signalQuality: final.signalQuality || null, marketQuality: final.marketQuality || null, contextQuality: final.contextQuality || null, entryQuality: final.entryQuality || null },
        permission: final.tradePermission ? Object.assign({}, final.tradePermission) : null,
        primaryReject: final.primaryReject || null,
        rejectReasons: (final.rejectReasons || []).slice(),
        qualityReasons: (final.qualityReasons || []).slice(),
        waitStage: final.waitStage || null,
        directionTrace: buildDirectionTrace(final, layers, diag, steps, totBuy, totSell, obsEdge, recomputedEdge)
      }
    };
  }

  // Never throws. Returns null when disabled or on any error.
  function safeBuild(final, layers, cfg) {
    try {
      if (!cfg || cfg.ATTRIBUTION_ENABLED !== true) return null;
      return build(final, layers, cfg);
    } catch (_) {
      return null;
    }
  }

  window.GoldAI_Attribution = { build: build, safeBuild: safeBuild, VERSION: VERSION, LAYER_WEIGHTS: LAYER_WEIGHTS, RECONCILE_TOLERANCE: RECONCILE_TOLERANCE };
})();
