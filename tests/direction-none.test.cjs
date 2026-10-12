// Self-contained unit test: RawDirection/WAIT attribution transparency (no CSV / no full engines).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "engines", "signal-attribution.js"), "utf8");
const window = {};
vm.runInNewContext(src, { window, console });
const A = window.GoldAI_Attribution;
if (!A || !A.build) { console.error("FAIL: GoldAI_Attribution missing"); process.exit(1); }

function assert(c, m) { if (!c) { console.error("FAIL:", m); process.exit(1); } }

// Case 1: score already WAIT (raw non-directional) with scores + LOW_EDGE style fields
const final1 = {
  signal: "WAIT 🟡",
  confidence: 40,
  buyScore: 5.2,
  sellScore: 5.0,
  directionalEdge: 0.2,
  primaryReject: "LOW_EDGE",
  rejectReasons: ["LOW_EDGE"],
  qualityReasons: [],
  waitStage: "QUALITY",
  confidenceSteps: [
    { id: "SEED", before: 40, after: 40, delta: 0, rawSignal: "WAIT 🟡", source: "score.js" },
    { id: "QUALITY_CLIP_ROUND", before: 40, after: 40, delta: 0 }
  ],
  diagnostics: {
    confidenceSeed: 40,
    confidenceAfterQuality: 40,
    signalAfterQuality: "WAIT 🟡",
    directionalEdge: 0.2,
    primaryReject: "LOW_EDGE"
  },
  layers: {
    structure: { trend: "RANGE", buyScore: 1, sellScore: 1 },
    ema: { buyScore: 0.5, sellScore: 0.4 },
    rsi: { buyScore: 0.2, sellScore: 0.2 },
    htf: { trend: "NEUTRAL", strength: "WEAK" },
    regime: "RANGE"
  },
  tradePermission: { allowed: true, reasons: [] }
};
// fill missing layer keys so reconcile doesn't require full weights identity
for (const [name] of A.LAYER_WEIGHTS) {
  if (!final1.layers[name]) final1.layers[name] = { buyScore: 0, sellScore: 0 };
}

const cfg = { ATTRIBUTION_ENABLED: true };
const a1 = A.build(final1, final1.layers, cfg);
assert(a1 && a1.decision && a1.decision.directionTrace, "directionTrace missing");
const t1 = a1.decision.directionTrace;
assert(t1.rawDirectionIsNone === true, "rawDirectionIsNone");
assert(t1.finalIsNonDirectional === true, "finalIsNonDirectional");
assert(t1.reasonAvailable === true, "reasonAvailable should be true when scores/reject present");
assert(t1.reasonSourceUnavailable === false, "reasonSourceUnavailable");
assert(t1.pipeline.primaryReject === "LOW_EDGE", "primaryReject");
assert(t1.pipeline.buyScore === 5.2 && t1.pipeline.sellScore === 5.0, "scores");
assert(t1.pipeline.directionalEdgeObserved === 0.2, "edge");
assert(t1.pipeline.regime === "RANGE", "regime");
assert(t1.pipeline.htf && t1.pipeline.htf.trend === "NEUTRAL", "htf");
assert(t1.stage === "RAW_OR_SCORE_NON_DIRECTIONAL", "stage raw none");
console.log("CASE1 PASS", t1.stage, "reasonAvailable="+t1.reasonAvailable);

// Case 2: raw BUY then quality forces WAIT
const final2 = {
  signal: "WAIT 🟡",
  confidence: 70,
  buyScore: 12,
  sellScore: 3,
  directionalEdge: 9,
  primaryReject: "REGIME_RANGE",
  rejectReasons: ["REGIME_RANGE"],
  qualityReasons: [],
  waitStage: "QUALITY",
  confidenceSteps: [
    { id: "SEED", before: 80, after: 80, delta: 0, rawSignal: "BUY 🟢", source: "score.js" },
    { id: "QUALITY_RANGE_REGIME", before: 80, after: 68, delta: -12 },
    { id: "QUALITY_CLIP_ROUND", before: 68, after: 68, delta: 0 }
  ],
  diagnostics: {
    confidenceSeed: 80,
    confidenceAfterQuality: 68,
    signalAfterQuality: "WAIT 🟡",
    directionalEdge: 9,
    primaryReject: "REGIME_RANGE"
  },
  layers: { regime: "RANGE", structure: { trend: "RANGE" }, htf: { trend: "BULLISH", strength: "MODERATE" } },
  tradePermission: { allowed: true }
};
for (const [name] of A.LAYER_WEIGHTS) {
  if (!final2.layers[name]) final2.layers[name] = { buyScore: name==="structure"?2:0, sellScore: 0 };
}
final2.layers.structure = { trend: "RANGE", buyScore: 2, sellScore: 0 };
const a2 = A.build(final2, final2.layers, cfg);
const t2 = a2.decision.directionTrace;
assert(t2.rawDirectionIsNone === false, "raw was BUY");
assert(t2.finalIsNonDirectional === true, "final wait");
assert(t2.stage === "QUALITY_FORCED_WAIT", "stage quality");
assert(t2.reasonAvailable === true, "reason available");
assert(t2.pipeline.primaryReject === "REGIME_RANGE", "reject");
assert(t2.pipeline.signalAfterQuality && String(t2.pipeline.signalAfterQuality).includes("WAIT"), "saq");
console.log("CASE2 PASS", t2.stage);

// Case 3: empty shell — reason unavailable
const final3 = {
  signal: "WAIT 🟡",
  confidence: null,
  confidenceSteps: [{ id: "SEED", before: 0, after: 0, delta: 0, rawSignal: "WAIT 🟡" }],
  diagnostics: {},
  layers: {}
};
const a3 = A.build(final3, final3.layers, cfg);
const t3 = a3.decision.directionTrace;
assert(t3.finalIsNonDirectional === true, "final none");
// rawSignal present so reasonAvailable may still be true — check honesty
assert(t3.pipeline.rawSignal != null, "raw present");
assert(Array.isArray(t3.missingFields), "missingFields array");
console.log("CASE3 PASS reasonAvailable="+t3.reasonAvailable, "missing="+JSON.stringify(t3.missingFields.slice(0,8)));

// Case 4: directional BUY — stage DIRECTIONAL_FINAL
const final4 = {
  signal: "BUY 🟢",
  confidence: 88,
  buyScore: 15,
  sellScore: 2,
  directionalEdge: 13,
  primaryReject: null,
  rejectReasons: [],
  waitStage: "NONE",
  confidenceSteps: [{ id: "SEED", before: 88, after: 88, delta: 0, rawSignal: "BUY 🟢" }],
  diagnostics: { confidenceSeed: 88, confidenceAfterQuality: 88, signalAfterQuality: "BUY 🟢", directionalEdge: 13 },
  layers: {}
};
for (const [name] of A.LAYER_WEIGHTS) final4.layers[name] = { buyScore: name==="ema"?5:0, sellScore: 0 };
const a4 = A.build(final4, final4.layers, cfg);
assert(a4.decision.directionTrace.stage === "DIRECTIONAL_FINAL", "directional stage");
assert(a4.decision.directionTrace.rawDirectionIsNone === false, "not none");
console.log("CASE4 PASS", a4.decision.directionTrace.stage);

// safeBuild off
assert(A.safeBuild(final1, final1.layers, { ATTRIBUTION_ENABLED: false }) === null, "off");
console.log("DIRECTION-NONE TESTS: PASS");
