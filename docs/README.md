# GoldAI Diagnostic Signal Attribution — Patch Package

## Apply
Copy these files into your GoldAI-FINAL tree, preserving paths:
- js/engines/conflict-filter.js        (replaces existing — additive instrumentation only, see docs/conflict-filter.diff)
- js/engines/signal-attribution.js     (new)
- backend/worker/attribution-writer.js (new)
- backend/worker/signal-worker.js      (replaces existing, see docs/signal-worker.diff)
- backend/worker/engine-loader.js      (replaces existing, see docs/engine-loader.diff)

index.html and js/config.js are UNCHANGED. Do not copy them from this package (not included).

## Enable (Worker-only, default OFF)
Set the environment variable before starting the worker process:
    ATTRIBUTION_ENABLED=true
Output: backend/worker/data/attribution.jsonl (rotates to attribution.1.jsonl / attribution.2.jsonl at 50MB, max 2 archives).
signals.json is never touched by this feature.

## Verify before deploying
    node tests/regression-matrix.cjs <path-to-M5-CSV>   # 8 scenarios x 4 modes, must print OVERALL MATRIX: PASS
    node tests/writer.test.cjs                          # rotation / I-O-failure isolation, must print WRITER TESTS: PASS
    node tests/mismatch.test.cjs                        # proves reconciliation actually detects a wrong weight

## Evaluation counts (evaluations vs. unique candle indices)

"Evaluations" and "unique candle indices" are different things and are kept distinct here:

- **Evaluations** = number of times the engine was run, for one (scenario x mode) pair.
  - M1-M7: 3,000 evaluations each (candle indices 300..3300, same range reused per scenario).
  - M8: 6,600 evaluations (candle indices 3300..9900, a separate, non-overlapping range).
  - **Per mode, all 8 scenarios summed: 7 x 3,000 + 6,600 = 27,600 evaluations.**
  - There are 4 modes (O = original, A = patched/Attribution OFF, B = patched/Attribution ON,
    BX = patched/Attribution ON with a forced attribution-input exception).
  - **Total engine executions across all 4 modes: 27,600 x 4 = 110,400.**
- **Unique candle indices actually covered** (deduplicated across scenarios, since M1-M7 all reuse the
  same 300..3300 window): 3,000 (from M1-M7's shared range) + 6,600 (M8's distinct range) =
  **9,600 unique candle indices** in the current test window.

An earlier version of this document said "30,600 evaluations" for one mode; that number was wrong
(it double-counted M8). The corrected, verified number for one mode is 27,600, as above.

## Guarantees demonstrated by the tests in this package
- Original vs Patched(Attribution OFF): 0 diffs across signal/confidence/buyScore/sellScore/directionalEdge/
  primaryReject/rejectReasons/waitStage/entryQuality/ATR/full final object, over 27,600 evaluations across
  8 scenarios (BUY, SELL, WAIT, quality-reject, permission-reject incl. dedup, RiskGuard-block, DATA_MODE,
  CHoCH-active, HTF bullish/bearish, m1.independent true/false).
- Patched(OFF) vs Patched(ON): 0 diffs except the added `confidenceSteps` key.
- Patched(ON) vs Patched(ON-with-forced-attribution-exception, "BX"): 0 diffs in decision fields;
  attribution=null on failure (fail-open, unchanged). `confidenceSteps` is still present as an own
  property on every BX record too, because it is written by runSignalQuality (real-engine instrumentation)
  independently of whether Attribution.safeBuild later succeeds or fails — this is asserted explicitly
  (hasOwnProperty check) for all 27,600 BX records, not just B.
- Call counts for analyzeMarketStructure / runTradePermission / RiskGuard.check / runScoreEngine / analyzeEMA / analyzeADX
  are identical across all 4 modes in all 8 scenarios — no engine is re-run for attribution.
- `layers`, `final`, and `cfg` are byte-identical before/after attribution build (0 mutations observed).
- Edge reconciliation: 27,600/27,600 reconciledWithScoreEngine=true, maxAbsDiff=0 (tolerance 1e-9, documented in code).
  A deliberately corrupted RSI weight (1.1->2.0), tested in isolation, is caught: reconciledWithScoreEngine=false.
- No per-indicator confidence field exists anywhere in the confidence block (checked programmatically, 0/27600).
- Writer: rotation (attribution.jsonl -> .1 -> .2, cap 2 archives, 50MB default), and failure isolation
  (bad directory, blocked rotation slot, malformed record, queue overflow) — all verified to never throw
  and never block the worker.

## Direction / WAIT transparency (v1.2.0)
When the final signal is non-directional (WAIT / NONE), `attribution.decision.directionTrace` records an observation-only snapshot:
- rawSignal, signalAfterQuality, finalSignal
- buyScore / sellScore / directionalEdge (observed + recomputed)
- primaryReject, rejectReasons, qualityReasons, waitStage
- confidenceSeed / afterQuality / final
- regime, HTF, structure summary, tradePermission flags when present on layers/final
- `reasonAvailable` / `reasonSourceUnavailable` (never invents thresholds not present in data)
- `stage`: RAW_OR_SCORE_NON_DIRECTIONAL | QUALITY_FORCED_WAIT | PERMISSION_OR_POST_QUALITY_WAIT | DIRECTIONAL_FINAL

Unit test: `node tests/direction-none.test.cjs`

## Not changed
- index.html, js/config.js: byte-identical to the original.
- trade-permission.js, RiskGuard, market-structure.js, score.js, and every other engine: byte-identical.
- signals.json format/writer: untouched.
