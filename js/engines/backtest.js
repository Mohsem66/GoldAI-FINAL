// =====================================================================
// GoldAI — REAL MT5 Walk-Forward Signal Backtest
// -----------------------------------------------------------------------
// Reuses the EXACT SAME live engines (EMA/RSI/MACD/ADX/ATR/Volume/SR/
// Candles/Structure/Liquidity/Score/ConflictFilter/TradeManagement) that
// app.js uses for live signals. This file does NOT change any of those
// engines — it only calls them with historically-sliced (look-ahead-safe)
// inputs and simulates what a Virtual Trade would have done afterward.
//
// Look-ahead safety:
//   - Signal at bar i is generated using ONLY bars [0..i] (entry TF),
//     and HTF/M1 bars whose own timestamp <= bar[i].time.
//   - The trade is NOT filled at bar[i]'s own close (that would be a
//     subtle look-ahead / unrealistically optimistic fill). It is filled
//     at the OPEN of bar[i+1] (+ spread + slippage), which is the first
//     tradable price after the signal existed.
//   - Only bars AFTER the fill bar are used to resolve the outcome
//     (SL / TP / time exit).
//
// Data source: 100% MT5 (via /api/mt5/candles + /api/mt5/symbol-info).
// Twelve Data / seedDemo / DEMO_BASE_PRICE are never used here.
// =====================================================================

window.GoldAI_Backtest = (function () {

  const TF_SECONDS = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };

  // ---- helpers ---------------------------------------------------------

  /** Real OHLC resample (aggregation of ALREADY-REAL MT5 bars) — no fabricated data. */
  function resample(bars, srcSeconds, bucketSeconds) {
    if (!bars.length || bucketSeconds <= srcSeconds) return bars.slice();
    const out = [];
    let cur = null;
    let curBucketStart = null;
    for (const b of bars) {
      const bucketStart = Math.floor(b.time / bucketSeconds) * bucketSeconds;
      if (curBucketStart === null || bucketStart !== curBucketStart) {
        if (cur) out.push(cur);
        curBucketStart = bucketStart;
        cur = { time: bucketStart, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
      } else {
        cur.high = Math.max(cur.high, b.high);
        cur.low = Math.min(cur.low, b.low);
        cur.close = b.close;
        cur.volume += (b.volume || 0);
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * Higher-timeframe used for the HTF bias layer. SAME rule for live worker
   * and backtest. CHANGED 2026-10-07: the next higher timeframe
   * (M1->M5, M5->M15, M15->H1, M30->H4, H1->H4, H4->D1, D1->D1).
   */
  const HTF_OF = { M1: "M5", M5: "M15", M15: "H1", M30: "H4", H1: "H4", H4: "D1", D1: "D1" };
  function htfTimeframeFor(entryTF, mode) {
    const tf = String(entryTF || "M5").toUpperCase();
    return HTF_OF[tf] || "H1";
  }

  /** Only HTF bars that were fully CLOSED at `knownTime` (unix sec). */
  function closedHtfBars(htfBars, htfSeconds, knownTime) {
    const out = [];
    for (const b of htfBars) {
      if (b.time + htfSeconds <= knownTime) out.push(b);
      else break;
    }
    return out;
  }

  function toBars(raw) {
    // raw = backend /candles item {time,open,high,low,close,tick_volume,spread,real_volume}
    return raw.map(r => ({
      time: r.time, open: r.open, high: r.high, low: r.low, close: r.close,
      volume: r.tick_volume || r.real_volume || 0, spread: r.spread || 0
    }));
  }

  function seriesOf(bars) {
    return {
      closes: bars.map(b => b.close),
      highs: bars.map(b => b.high),
      lows: bars.map(b => b.low),
      volumes: bars.map(b => b.volume),
      candles: bars.map(b => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
      times: bars.map(b => b.time)
    };
  }

  function spreadAsPrice(bar, specs, point, symbol) {
    const p = Number(point) || 0.01;
    const specPts = specs && Number(specs.spread);
    const barPts = bar && Number(bar.spread);
    const pts = (Number.isFinite(specPts) && specPts > 0) ? specPts : (Number.isFinite(barPts) ? barPts : 0);
    let s = pts * p;
    const sym = String(symbol || "").toUpperCase();
    if ((sym.includes("XAU") || sym.includes("GOLD")) && s > 0.8) {
      s = pts * 0.001; // candle spread often stored as 190 → 0.19
    }
    if (!Number.isFinite(s) || s < 0) s = 0;
    return s;
  }

  /** Build one signal (identical pipeline to app.js's analyze()) from look-ahead-safe slices. */
  function buildSignal(entrySlice, htfSlice, microSlice, cfg, price) {
    const { closes, highs, lows, volumes, candles } = entrySlice;

    const ema = window.GoldAI_EMA.analyzeEMA(closes, price, cfg);
    const rsi = window.GoldAI_RSI.analyzeRSI(closes, cfg);
    const div = window.GoldAI_Divergence.analyzeDivergence(closes, rsi.history || []);
    const structure = window.GoldAI_MarketStructure.analyzeMarketStructure(highs, lows, closes, cfg);
    const macd = window.GoldAI_MACD.analyzeMACD(closes);
    const adx = window.GoldAI_ADX.analyzeADX(highs, lows, closes, cfg.ADX_PERIOD || 14);
    const atrL = window.GoldAI_ATR.analyzeATR(highs, lows, closes, cfg);
    const volume = window.GoldAI_Volume.analyzeVolume(volumes, closes);
    const sr = window.GoldAI_SR.analyzeSR(highs, lows, price, cfg);
    const candleP = window.GoldAI_Candles.analyzeCandles(candles);
    const liq = window.GoldAI_Liquidity.analyzeLiquidity(highs, lows, closes);

    let htf = null;
    if (htfSlice && htfSlice.closes.length > 5) {
      const htfEma = window.GoldAI_EMA.analyzeEMA(htfSlice.closes, htfSlice.closes[htfSlice.closes.length - 1], cfg);
      const htfStr = window.GoldAI_MarketStructure.analyzeMarketStructure(htfSlice.highs, htfSlice.lows, htfSlice.closes, cfg);
      htf = (window.GoldAI_HtfContext && window.GoldAI_HtfContext.buildHtfContext)
        ? window.GoldAI_HtfContext.buildHtfContext(htfEma, htfStr)
        : { trend: (htfStr.trend !== "UNKNOWN" ? htfStr.trend : htfEma.trend), strength: "WEAK" };
    }

    let m1 = null;
    if (microSlice && microSlice.closes.length > 5) {
      const m1Ema = window.GoldAI_EMA.analyzeEMA(microSlice.closes, microSlice.closes[microSlice.closes.length - 1], cfg);
      // independent only when micro TF differs from entry series length context (caller sets)
      const entryKey = String((cfg && cfg.ACTIVE_TIMEFRAME) || "m5").toLowerCase();
      m1 = { microstructure: m1Ema.trend, independent: entryKey !== "m1" };
    }

    const layers = { ema, rsi, divergence: div, structure, macd, adx, atr: atrL, volume, sr, candles: candleP, liquidity: liq, htf, m1, price };

    if (window.GoldAI_MarketRegime) {
      layers.marketRegime = window.GoldAI_MarketRegime.buildMarketRegime(adx, structure);
      layers.regime = layers.marketRegime.regime; // canonical regime string
    }
    const raw = window.GoldAI_Score.runScoreEngine(layers);
    const final = window.GoldAI_Conflict.runConflictFilter(raw, layers, cfg);
    return { final, atr: atrL.atr, layers, structure, raw };
  }

  // ---- date range helpers (NEW — additive, used only when opts.rangePreset is given) ----

  /** Resolves a preset ('1d'|'1w'|'1m'|'1y'|'custom') to {start:Date, end:Date}. */
  function resolveDateRange(rangePreset, customStart, customEnd) {
    if (!rangePreset) return { start: null, end: null };
    const now = new Date();
    if (rangePreset === "custom") {
      const start = customStart ? new Date(customStart) : null;
      const end = customEnd ? new Date(customEnd) : null;
      return { start, end };
    }
    const days = { "1d": 1, "1w": 7, "1m": 30, "1y": 365 }[rangePreset];
    if (!days) return { start: null, end: null };
    return { start: new Date(now.getTime() - days * 24 * 3600 * 1000), end: now };
  }

  // ---- main entry point --------------------------------------------------

  async function runRealMT5Backtest(opts) {
    const cfg = { ...(window.GoldAI_Config || {}), ...(opts.cfgOverride || {}) };
    const entryTF = (opts.entryTF || "M5").toUpperCase();
    const mode = opts.mode === "swing" ? "swing" : "scalp";
    const capital = Number(opts.capital) || cfg.DEFAULT_CAPITAL || 10000;
    const riskPercent = Number(opts.riskPercent) || cfg.DEFAULT_RISK_PERCENT || 1;
    const minConfidence = opts.minConfidence != null ? Number(opts.minConfidence) : (cfg.MIN_CONFIDENCE || 68);
    const slippagePoints = Number(opts.slippagePoints) || 0;
    const commissionPerLot = opts.commissionPerLot != null ? Number(opts.commissionPerLot) : 7;
    const count = Math.max(210, Math.min(Number(opts.count) || 1500, 5000));
    const maxHoldBars = Number(opts.maxHoldBars) || 100;
    // CHANGED 2026-10-07: live can now open a new trade while a previous one is
    // still open (cooldown only), so the backtest does the same by default.
    const allowConcurrentTrades = opts.allowConcurrentTrades != null ? !!opts.allowConcurrentTrades : true;
    const step = Math.max(1, Number(opts.step) || 1);
    // Live dashboard / worker execute against TP1. Do not use TP_COUNT (often 3).
    const tpTarget = opts.tpTarget || "tp1";
    // ADDED 2026-10-07 (opt-in; scripts that do not pass these behave exactly as before):
    //  liveWindow: indicators see the SAME amount of history as the live worker
    //              (last 400 entry bars, 300 closed HTF bars, 1500 micro bars)
    //              instead of everything since the start of the download.
    //  shadow:     signals that were NOT traded (filtered, cooldown, low confidence,
    //              reward:risk too small, ...) are also simulated "on paper" with the
    //              same stop/target rules, so we can see whether the filters were right.
    //              Shadow trades never touch equity / win-rate / P&L.
    //  onProgress(fraction) + shouldStop(): keep the page responsive / allow a stop button.
    const liveWindow = opts.liveWindow === true;
    const shadowOn = opts.shadow === true;
    const ENTRY_WIN = Number(opts.entryWindow) > 0 ? Number(opts.entryWindow) : 400;
    const HTF_WIN = Number(opts.htfWindow) > 0 ? Number(opts.htfWindow) : 300;
    const MICRO_WIN = Number(opts.microWindow) > 0 ? Number(opts.microWindow) : 1500;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const shouldStop = typeof opts.shouldStop === "function" ? opts.shouldStop : null;
    const withFeatures = opts.features === true; // diagnostics only: copy a few indicator values into each journal row
    cfg.ACTIVE_TIMEFRAME = String(entryTF).toLowerCase();

    // NEW: optional date-range mode. rangePreset defaults to null so any
    // existing caller that never passes it (or the previous UI) gets the
    // EXACT same count-based behavior as before — fully backward compatible.
    const rangePreset = opts.rangePreset || null;
    const { start: rangeStart, end: rangeEnd } = resolveDateRange(rangePreset, opts.customStart, opts.customEnd);

    const report = {
      method: "real-mt5-walk-forward",
      lookAheadSafe: true,
      dataSource: "MT5",
      symbol: cfg.SYMBOL || "XAUUSD.",
      entryTF, mode, minConfidence, capital, riskPercent, slippagePoints, commissionPerLot,
      rangeMode: false, rangePreset: rangePreset || null, requestedStart: null, requestedEnd: null,
      testStart: null, testEnd: null, testCandles: 0,
      totalSignals: 0, executableSignals: 0, buySignals: 0, sellSignals: 0,
      wins: 0, losses: 0, breakeven: 0,
      winRate: 0, profitFactor: 0, netPL: 0, avgWin: 0, avgLoss: 0, avgR: 0,
      expectancy: 0, maxDrawdown: 0, maxDrawdownPct: 0, maxConsecLosses: 0,
      totalTradingCosts: 0,
      equityCurve: [],
      journal: [],
      notes: [],
      errors: []
    };

    if (!TF_SECONDS[entryTF]) {
      report.errors.push(`unsupported entryTF ${entryTF}`);
      return report;
    }
    const barSeconds = TF_SECONDS[entryTF];
    const warmup = Math.max(210, cfg.EMA_SLOW ? cfg.EMA_SLOW + 10 : 210);

    // --- Validate & resolve the requested date range (Custom needs Start < End) ---
    let testStartEpoch = null, testEndEpoch = null;
    if (rangePreset) {
      if (rangePreset === "custom") {
        if (!rangeStart || isNaN(rangeStart.getTime()) || !rangeEnd || isNaN(rangeEnd.getTime())) {
          report.errors.push("تاریخ شروع یا پایان نامعتبر است.");
          return report;
        }
      }
      if (!rangeStart || !rangeEnd || isNaN(rangeStart.getTime()) || isNaN(rangeEnd.getTime()) || rangeStart.getTime() >= rangeEnd.getTime()) {
        report.errors.push("بازه زمانی نامعتبر است: تاریخ شروع باید قبل از تاریخ پایان باشد.");
        return report;
      }
      testStartEpoch = Math.floor(rangeStart.getTime() / 1000);
      testEndEpoch = Math.floor(rangeEnd.getTime() / 1000);
      if (Number(opts.maxTestBars) > 0 && TF_SECONDS[entryTF] && (testEndEpoch - testStartEpoch) / TF_SECONDS[entryTF] > Number(opts.maxTestBars)) {
        report.errors.push("این بازه برای تایم‌فریم " + entryTF + " خیلی بزرگ است (بیش از " + opts.maxTestBars + " کندل). بازه را کوتاه‌تر کنید یا تایم‌فریم بزرگ‌تری انتخاب کنید.");
        return report;
      }
      report.rangeMode = true;
      report.requestedStart = rangeStart.toISOString();
      report.requestedEnd = rangeEnd.toISOString();
    }

    // --- 1) Fetch REAL MT5 history for the entry timeframe ---------------
    let entryRes;
    if (report.rangeMode) {
      // Fetch warm-up buffer BEFORE Start Date + the full test range itself.
      // Indicators need history before Start Date, but the WALK-FORWARD LOOP
      // below only ever evaluates/report bars from Start..End (see loopStartIdx).
      const fetchStartEpoch = testStartEpoch - ((liveWindow ? Math.max(warmup, ENTRY_WIN) : warmup) + 20) * barSeconds;
      entryRes = await window.GoldAI_Data.fetchMT5RangeChunked(entryTF, fetchStartEpoch, testEndEpoch, barSeconds, Number(opts.count) || 4000);
    } else {
      entryRes = await window.GoldAI_Data.fetchMT5History(entryTF, count);
    }
    if (!entryRes || entryRes.status !== "ok" || !entryRes.candles || entryRes.candles.length < 220) {
      report.errors.push("Could not load enough real MT5 " + entryTF + " history: " +
        (entryRes && entryRes.message ? entryRes.message : "MT5 bridge unavailable"));
      return report;
    }
    const entryBars = toBars(entryRes.candles);
    const entrySeriesFull = seriesOf(entryBars);

    // --- 2) Fetch REAL MT5 M1 (for microstructure + intrabar SL/TP tie-break) ---
    let m1Bars = [];
    if (entryTF === "M1") {
      m1Bars = entryBars;
    } else if (report.rangeMode && (testEndEpoch - testStartEpoch) > 60 * 24 * 3600) {
      // A full M1 pull over a range this long (>60 days) is impractical — skip
      // the M1 tie-break layer for this run, same conservative fallback the
      // engine already uses whenever real M1 data isn't available.
      report.notes.push("Date range > 60 days — skipping real M1 tie-break fetch (would be too large); using conservative SL-first tie-break instead.");
    } else if (report.rangeMode) {
      const m1Res = await window.GoldAI_Data.fetchMT5RangeChunked("M1", testStartEpoch - 500 * 60, testEndEpoch, 60, 4000);
      if (m1Res && m1Res.status === "ok" && m1Res.candles && m1Res.candles.length) {
        m1Bars = toBars(m1Res.candles);
      } else {
        report.notes.push("Real M1 data unavailable — same-bar SL/TP conflicts default to worst-case (SL-first).");
      }
    } else {
      const m1Count = Math.min(5000, Math.ceil((entryBars[entryBars.length - 1].time - entryBars[0].time) / 60) + 500);
      const m1Res = await window.GoldAI_Data.fetchMT5History("M1", m1Count);
      if (m1Res && m1Res.status === "ok" && m1Res.candles && m1Res.candles.length) {
        m1Bars = toBars(m1Res.candles);
      } else {
        report.notes.push("Real M1 data unavailable — same-bar SL/TP conflicts default to worst-case (SL-first).");
      }
    }
    const m1SeriesFull = seriesOf(m1Bars);
    // tie-break lookups use a binary search, which needs time order
    let m1Sorted = m1Bars;
    for (let q = 1; q < m1Bars.length; q++) { if (m1Bars[q].time < m1Bars[q - 1].time) { m1Sorted = m1Bars.slice().sort((a, b) => a.time - b.time); break; } }

    // --- 3) Real symbol specs (point / tick size / tick value / lot limits) ---
    let specs = cfg.SYMBOL_SPECS || {};
    try {
      const s = await window.GoldAI_Data.fetchMT5SymbolSpecs();
      if (s && s.status === "ok") specs = s;
    } catch (_) {}
    const point = Number(specs.point) || 0.01;

    // --- 4) HTF bias — resampled from the SAME real bars (no Twelve Data, no fabrication) ---
    // CHANGED: HTF now comes from REAL MT5 bars of the HTF timeframe (same as the
    // live worker), with enough history for EMA50/EMA200. Falls back to
    // resampling the entry bars only if the bridge cannot provide them.
    const htfTF = htfTimeframeFor(entryTF, mode);
    const htfBucketSeconds = TF_SECONDS[htfTF];
    const HTF_WARMUP = 260;
    let htfBarsFull = null;
    try {
      let htfRes;
      if (report.rangeMode) {
        htfRes = await window.GoldAI_Data.fetchMT5RangeChunked(htfTF, entryBars[0].time - HTF_WARMUP * htfBucketSeconds, testEndEpoch, htfBucketSeconds, 4000);
      } else {
        const need = Math.ceil((entryBars[entryBars.length - 1].time - entryBars[0].time) / htfBucketSeconds) + HTF_WARMUP;
        htfRes = await window.GoldAI_Data.fetchMT5History(htfTF, Math.min(5000, need));
      }
      if (htfRes && htfRes.status === "ok" && htfRes.candles && htfRes.candles.length > 5) {
        htfBarsFull = toBars(htfRes.candles).sort((a, b) => a.time - b.time);
      }
    } catch (_) { htfBarsFull = null; }
    report.htfTimeframe = htfTF;
    report.htfSource = htfBarsFull ? "MT5_REAL_" + htfTF : "RESAMPLED_FALLBACK";
    if (!htfBarsFull) {
      htfBarsFull = resample(entryBars, barSeconds, htfBucketSeconds);
      report.notes.push("Real " + htfTF + " bars unavailable - HTF fell back to resampling entry bars (results less reliable).");
    }
    const htfSeriesFull = seriesOf(htfBarsFull);

    // --- 5) Micro/scalp bias for the m1 layer ---
    let microBarsFull, microBucketSeconds;
    if (mode === "swing") {
      // swing wants a coarser "micro" read than scalp — resample M1 up to ~M15
      if (entryTF === "M1") {
        microBarsFull = resample(m1Bars, 60, TF_SECONDS.M15);
        microBucketSeconds = TF_SECONDS.M15;
      } else {
        microBarsFull = entryBars;
        microBucketSeconds = barSeconds;
      }
    } else if (m1Bars.length) {
      microBarsFull = m1Bars;
      microBucketSeconds = 60;
    } else {
      microBarsFull = entryBars;
      microBucketSeconds = barSeconds;
    }
    const microSeriesFull = seriesOf(microBarsFull);

    // --- 6) Walk-forward loop ---------------------------------------------
    if (entryBars.length < warmup + 5) {
      report.errors.push(`Not enough bars (${entryBars.length}) for warmup (${warmup})`);
      return report;
    }

    // Determine the actual walk-forward window. In range mode, the loop must
    // only EVALUATE/REPORT bars from Start..End — the extra bars fetched
    // before Start Date exist purely to warm up the indicators and are never
    // themselves scored or counted as test candles.
    let loopStartIdx = warmup;
    if (report.rangeMode) {
      let idx = entryBars.findIndex(b => b.time >= testStartEpoch);
      if (idx === -1) idx = entryBars.length; // no bars at/after Start Date at all
      if (idx < warmup) {
        report.notes.push(`Only ${idx} warm-up bars were available before Start Date (wanted ${warmup}) — the test effectively begins a bit later than requested.`);
      }
      loopStartIdx = Math.max(warmup, idx);
      const testBarsInRange = entryBars.filter(b => b.time >= testStartEpoch && b.time <= testEndEpoch);
      report.testCandles = testBarsInRange.length;
      report.testStart = testBarsInRange.length ? new Date(testBarsInRange[0].time * 1000).toISOString() : report.requestedStart;
      report.testEnd = testBarsInRange.length ? new Date(testBarsInRange[testBarsInRange.length - 1].time * 1000).toISOString() : report.requestedEnd;
    } else {
      report.testStart = entryBars[loopStartIdx] ? new Date(entryBars[loopStartIdx].time * 1000).toISOString() : null;
      report.testEnd = new Date(entryBars[entryBars.length - 1].time * 1000).toISOString();
      report.testCandles = Math.max(0, entryBars.length - 1 - loopStartIdx);
    }

    // Suspend the two LIVE-ONLY guards for the duration of this historical
    // run, WITHOUT modifying conflict-filter.js / risk-guard.js:
    //  - dataMode: we are feeding 100% real MT5 bars here, so it's genuinely
    //    "live" data for scoring purposes, not the CURRENT UI's live/offline state.
    //  - RiskGuard: a daily circuit breaker for REAL execution. Per requirement,
    //    the backtest must evaluate every valid signal even if the real system
    //    would have blocked it that day — so it must not gate virtual trades.
    const prevDataMode = window.GoldAI_Data.dataMode;
    const prevRiskCheck = window.GoldAI_RiskGuard ? window.GoldAI_RiskGuard.check : null;
    const perm = window.GoldAI_TradePermission;
    const prevCluster = perm && perm.snapshotCluster ? perm.snapshotCluster() : null;
    if (perm && perm.resetCluster) perm.resetCluster();
    window.GoldAI_Data.dataMode = "live";
    if (window.GoldAI_RiskGuard) window.GoldAI_RiskGuard.check = () => ({ allowed: true });

    let m1Ptr = 0, htfPtr = 0;
    let equity = capital;
    let peakEquity = capital;
    let maxDD = 0, maxDDPct = 0;
    let consecLoss = 0, maxConsecLoss = 0;
    let grossWin = 0, grossLoss = 0, totalCosts = 0;
    const winPnls = [], lossPnls = [], rMultiples = [];
    let openUntilIndex = -1; // walk-forward index up to which a virtual trade is still open

    // Fill price at the OPEN of bar fillBarIdx (spread for BUY + slippage). Same math as before.
    function fillFor(fillBarIdx, isBuy) {
      const fillBar = entryBars[fillBarIdx];
      const spreadPrice = spreadAsPrice(fillBar, specs, point, report.symbol);
      const slip = slippagePoints * point;
      const execEntry = isBuy ? (fillBar.open + spreadPrice + slip) : (fillBar.open - slip);
      return { execEntry, spreadPrice };
    }

    // Walk forward from the fill bar until SL / TP / time exit. No side effects
    // (used for real backtest trades AND for shadow trades). Same rules as before.
    // ADDED 2026-10-08: trailing stop (only when cfg.TRAIL_ENABLED; otherwise unchanged)
    const trailOn = cfg.TRAIL_ENABLED === true && !!(window.GoldAI_Trade && window.GoldAI_Trade.trailStep);
    let trailAtr = null;
    function simulateTrailed(fillBarIdx, isBuy, plan, execEntry) {
      const T = window.GoldAI_Trade;
      if (!trailAtr) trailAtr = T.atrWilder(entryBars, 14);
      const slip = slippagePoints * point;
      const slPrice = plan.stopLoss;
      const tpPrice = Number(T.farTakeProfit(isBuy, execEntry, slPrice, cfg).toFixed(5));
      const lot = plan.lot;
      const st = T.trailInit(isBuy, execEntry, slPrice);
      const hold = Math.max(maxHoldBars, Number(cfg.TRAIL_MAX_HOLD_BARS) || 400);
      const holdLimit = Math.min(entryBars.length - 1, fillBarIdx + hold);
      let exitIdx = -1, exitPrice = null, exitReason = null, ambiguous = false;
      for (let j = fillBarIdx; j <= holdLimit; j++) {
        const bar = entryBars[j];
        const askOff = isBuy ? 0 : spreadAsPrice(bar, specs, point, report.symbol);
        const stop = st.stop;
        const moved = isBuy ? stop > slPrice : stop < slPrice;
        const hitSL = isBuy ? (bar.low <= stop) : (bar.high + askOff >= stop);
        const hitTP = isBuy ? (bar.high >= tpPrice) : (bar.low + askOff <= tpPrice);
        if (hitSL) {   // stop first when both are touched (conservative)
          exitIdx = j; exitPrice = stop; exitReason = moved ? "TRAIL" : "SL"; break;
        } else if (hitTP) {
          exitIdx = j; exitPrice = tpPrice; exitReason = "TP"; break;
        } else if (j === holdLimit) {
          exitIdx = j; exitPrice = bar.close; exitReason = "TIME"; break;
        }
        T.trailStep(st, bar, trailAtr[j], askOff, cfg);   // new stop applies from the next bar
      }
      if (exitIdx === -1) return { slPrice, tpPrice, lot, exitReason: 'UNRESOLVED' };
      const exitSpread = spreadAsPrice(entryBars[exitIdx], specs, point, report.symbol);
      if (exitReason === "TIME") exitPrice = isBuy ? (exitPrice - slip) : (exitPrice + exitSpread + slip);
      else exitPrice = isBuy ? (exitPrice - slip) : (exitPrice + slip);
      const riskDist = Math.abs(execEntry - slPrice);
      if ((exitReason === "TIME" || exitReason === "TRAIL") && riskDist > 0 &&
          Math.abs(exitPrice - execEntry) < riskDist * 0.15) {
        exitReason = "BREAKEVEN";
      }
      const priceDist = isBuy ? (exitPrice - execEntry) : (execEntry - exitPrice);
      const tickSize = Number(specs.trade_tick_size) || point;
      const tickValue = Number(specs.trade_tick_value) || 1;
      const grossPnl = (priceDist / tickSize) * tickValue * lot;
      const commission = commissionPerLot * lot;
      const netPnl = grossPnl - commission;
      const riskMoney = plan.riskMoney || (capital * riskPercent / 100);
      const rMultiple = riskMoney > 0 ? Number((netPnl / riskMoney).toFixed(2)) : 0;
      return { slPrice, tpPrice, lot, exitIdx, exitPrice, exitReason, ambiguous, netPnl, commission, rMultiple };
    }

    function simulateTrade(fillBarIdx, isBuy, plan, execEntry) {
      if (trailOn) return simulateTrailed(fillBarIdx, isBuy, plan, execEntry);
      const slip = slippagePoints * point;
      const slPrice = plan.stopLoss;
      const tpPrice = plan.tp1; // auto = TP1 only (TP2/TP3 are manual-only)
      const lot = plan.lot;
      let exitIdx = -1, exitPrice = null, exitReason = null, ambiguous = false;
      const holdLimit = Math.min(entryBars.length - 1, fillBarIdx + maxHoldBars);
      for (let j = fillBarIdx; j <= holdLimit; j++) {
        const bar = entryBars[j];
        const askOff = isBuy ? 0 : spreadAsPrice(bar, specs, point, report.symbol);
        const hitSL = isBuy ? (bar.low <= slPrice) : (bar.high + askOff >= slPrice);
        const hitTP = isBuy ? (bar.high >= tpPrice) : (bar.low + askOff <= tpPrice);
        if (hitSL && hitTP) {
          const tie = resolveTieBreak(bar, isBuy, slPrice, tpPrice, m1Sorted, barSeconds, askOff);
          exitIdx = j; exitPrice = tie.price; exitReason = tie.reason; ambiguous = tie.ambiguous;
          break;
        } else if (hitSL) {
          exitIdx = j; exitPrice = slPrice; exitReason = "SL"; break;
        } else if (hitTP) {
          exitIdx = j; exitPrice = tpPrice; exitReason = "TP"; break;
        } else if (j === holdLimit) {
          exitIdx = j; exitPrice = bar.close; exitReason = "TIME"; break;
        }
      }
      if (exitIdx === -1) {
        if (holdLimit < entryBars.length - 1) {
          exitIdx = holdLimit; exitPrice = entryBars[holdLimit].close; exitReason = 'TIME';
        } else {
          return { slPrice, tpPrice, lot, exitReason: 'UNRESOLVED' };
        }
      }
      // Exit-side spread/slippage. SL/TP are broker-side levels and fill AT the
      // level (SELL triggers already include the spread above). Only a TIME exit
      // closes at market, where a SELL pays the spread.
      const exitSpread = spreadAsPrice(entryBars[exitIdx], specs, point, report.symbol);
      if (exitReason === "SL" || exitReason === "TP") {
        exitPrice = isBuy ? (exitPrice - slip) : (exitPrice + slip);
      } else {
        exitPrice = isBuy ? (exitPrice - slip) : (exitPrice + exitSpread + slip);
      }
      const riskDist = Math.abs(execEntry - slPrice);
      if ((exitReason === "TIME" || exitReason === "END_OF_DATA") && riskDist > 0 &&
          Math.abs(exitPrice - execEntry) < riskDist * 0.15) {
        exitReason = "BREAKEVEN";
      }
      const priceDist = isBuy ? (exitPrice - execEntry) : (execEntry - exitPrice);
      const tickSize = Number(specs.trade_tick_size) || point;
      const tickValue = Number(specs.trade_tick_value) || 1;
      const grossPnl = (priceDist / tickSize) * tickValue * lot;
      const commission = commissionPerLot * lot;
      const netPnl = grossPnl - commission;
      const riskMoney = plan.riskMoney || (capital * riskPercent / 100);
      const rMultiple = riskMoney > 0 ? Number((netPnl / riskMoney).toFixed(2)) : 0;
      return { slPrice, tpPrice, lot, exitIdx, exitPrice, exitReason, ambiguous, netPnl, commission, rMultiple };
    }

    // ---- shadow ("paper") trades for signals that were NOT traded ----
    const lastShadowIdx = { BUY: -1e9, SELL: -1e9 };
    const shadowGap = Math.max(1, Number(cfg.SIGNAL_COOLDOWN_BARS) || 4);
    function addShadow(journalEntry, i, isBuy, reason, plan, execEntry, spreadPrice) {
      const dir = isBuy ? "BUY" : "SELL";
      // one paper trade per idea: same-direction repeats inside the cooldown window are not re-counted
      if (i - lastShadowIdx[dir] < shadowGap) { journalEntry.shadowDuplicate = true; return; }
      if (![plan.stopLoss, plan.tp1].every(Number.isFinite) || !(plan.lot > 0)) return;
      lastShadowIdx[dir] = i;
      const sim = simulateTrade(i + 1, isBuy, plan, execEntry);
      journalEntry.shadow = {
        reason, dir, entry: Number(execEntry.toFixed(5)), stopLoss: sim.slPrice, takeProfit: sim.tpPrice,
        rr: plan.rr != null ? plan.rr : null,
        exitReason: sim.exitReason,
        exit: sim.exitPrice != null ? Number(sim.exitPrice.toFixed(5)) : null,
        profitLoss: sim.netPnl != null ? Number(sim.netPnl.toFixed(2)) : null,
        rMultiple: sim.rMultiple != null ? sim.rMultiple : null,
        duration: sim.exitIdx != null && sim.exitIdx >= 0 ? sim.exitIdx - (i + 1) : null
      };
    }
    function shadowFromSignal(journalEntry, i, signal, reason, atr, structure) {
      if (!atr || !entryBars[i + 1]) return;
      const isBuy = String(signal).includes("BUY");
      const fill = fillFor(i + 1, isBuy);
      const plan = window.GoldAI_Trade.createAutoExecutionPlan(isBuy ? "BUY" : "SELL", fill.execEntry, atr, capital, riskPercent, cfg, specs, structure, fill.spreadPrice);
      addShadow(journalEntry, i, isBuy, reason, plan, fill.execEntry, fill.spreadPrice);
    }

    try {
      for (let i = loopStartIdx; i < entryBars.length - 1; i += step) {
        // In range mode, never evaluate/report a bar past the requested End Date.
        if (report.rangeMode && entryBars[i].time > testEndEpoch) break;
        if ((onProgress || shouldStop) && ((i - loopStartIdx) % 150 === 0)) {
          if (shouldStop && shouldStop()) { report.stopped = true; report.notes.push("Stopped by user before the end of the range."); break; }
          if (onProgress) { try { onProgress((i - loopStartIdx) / Math.max(1, entryBars.length - 1 - loopStartIdx)); } catch (_) {} }
          await new Promise(r => setTimeout(r, 0));
        }
        // "Known" instant = when bar i's OWN close became available (open-time + duration),
        // NOT bar i's open time. HTF/micro bars are only included once THEY have also closed
        // by that same instant — this is the actual look-ahead-safety boundary.
        const knownTime = entryBars[i].time + barSeconds;

        // Advance HTF / M1 pointers to the last fully-closed bar at/before knownTime
        while (htfPtr < htfBarsFull.length && (htfBarsFull[htfPtr].time + htfBucketSeconds) <= knownTime) htfPtr++;
        while (m1Ptr < microBarsFull.length && (microBarsFull[m1Ptr].time + microBucketSeconds) <= knownTime) m1Ptr++;

        const e0 = liveWindow ? Math.max(0, i + 1 - ENTRY_WIN) : 0;
        const h0 = liveWindow ? Math.max(0, htfPtr - HTF_WIN) : 0;
        const m0 = liveWindow ? Math.max(0, m1Ptr - MICRO_WIN) : 0;
        const entrySlice = {
          closes: entrySeriesFull.closes.slice(e0, i + 1),
          highs: entrySeriesFull.highs.slice(e0, i + 1),
          lows: entrySeriesFull.lows.slice(e0, i + 1),
          volumes: entrySeriesFull.volumes.slice(e0, i + 1),
          candles: entrySeriesFull.candles.slice(e0, i + 1)
        };
        const htfSlice = {
          closes: htfSeriesFull.closes.slice(h0, htfPtr),
          highs: htfSeriesFull.highs.slice(h0, htfPtr),
          lows: htfSeriesFull.lows.slice(h0, htfPtr)
        };
        const microSlice = { closes: microSeriesFull.closes.slice(m0, m1Ptr) };

        const price = entrySlice.closes[entrySlice.closes.length - 1];
        cfg.SIGNAL_TIME_MS = knownTime * 1000;
        cfg.LIVE_PRICE = price;
        const { final, atr, structure, raw, layers } = buildSignal(entrySlice, htfSlice, microSlice, cfg, price);

        report.totalSignals++;
        const isWait = !final.signal || final.signal.includes("WAIT");
        if (!isWait) {
          if (final.signal.includes("BUY")) report.buySignals++;
          else if (final.signal.includes("SELL")) report.sellSignals++;
        }

        const journalEntry = {
          index: i,
          time: knownTime,
          timeISO: new Date(knownTime * 1000).toISOString(),
          timeframe: entryTF,
          signal: final.signal,
          confidence: final.confidence,
          price,
          executed: false,
          exitReason: null
        };
        if (withFeatures) journalEntry.f = featuresOf(layers, final, raw, entryBars, i, barSeconds);

        const permBlocked = !!(final.executionBlocked ||
          (final.tradePermission && final.tradePermission.dedupOk === false) ||
          final.primaryReject === "SIGNAL_DEDUP" ||
          final.primaryReject === "SIGNAL_CLUSTER");
        const executable = !isWait && !permBlocked && final.confidence >= minConfidence;
        report.executableSignals += executable ? 1 : 0;

        if (executable && (allowConcurrentTrades || i > openUntilIndex) && !atr) {
          journalEntry.skippedReason = "no ATR yet";
        } else if (executable && (allowConcurrentTrades || i > openUntilIndex)) {
          // ---- Fill at OPEN of the NEXT bar (not this bar's own close) ----
          const fillBarIdx = i + 1;
          const isBuy = final.signal.includes("BUY");
          const fill = fillFor(fillBarIdx, isBuy);
          const execEntry = fill.execEntry, spreadPrice = fill.spreadPrice;

          // CHANGED: same function the live worker uses — levels from the FILL price,
          // single TP for auto, and minimum reward:risk (cfg.AUTO_MIN_RR) enforced.
          const plan = window.GoldAI_Trade.createAutoExecutionPlan(final.signal, execEntry, atr, capital, riskPercent, cfg, specs, structure, spreadPrice);
          if (!plan.rrOk) {
            report.rrSkipped = (report.rrSkipped || 0) + 1;
            journalEntry.skippedReason = "RR_BELOW_MIN";
            journalEntry.rr = plan.rr;
            if (shadowOn) addShadow(journalEntry, i, isBuy, "RR_BELOW_MIN", plan, execEntry, spreadPrice);
            report.journal.push(journalEntry);
            continue;
          }
          const sim = simulateTrade(fillBarIdx, isBuy, plan, execEntry);
          const slPrice = sim.slPrice, tpPrice = sim.tpPrice, lot = sim.lot;
          // Unresolved: no SL/TP exit occurred before the end of available data.
          if (sim.exitReason === 'UNRESOLVED') {
            journalEntry.executed = true;
            journalEntry.entry = Number(execEntry.toFixed(5));
            journalEntry.stopLoss = slPrice;
            journalEntry.takeProfit = tpPrice;
            journalEntry.lot = lot;
            journalEntry.exitTime = null;
            journalEntry.exitTimeISO = null;
            journalEntry.exit = null;
            journalEntry.exitReason = 'UNRESOLVED';
            journalEntry.profitLoss = null;
            journalEntry.profitPercent = null;
            journalEntry.rMultiple = null;
            journalEntry.duration = null;
            journalEntry.spread = Number(spreadPrice.toFixed(5));
            journalEntry.slippage = slippagePoints;
            journalEntry.commission = 0;
            journalEntry.ambiguousTieBreak = false;
            openUntilIndex = entryBars.length - 1;
            report.journal.push(journalEntry);
            continue;
          }
          const exitIdx = sim.exitIdx, exitPrice = sim.exitPrice, exitReason = sim.exitReason;
          const netPnl = sim.netPnl, commission = sim.commission, rMultiple = sim.rMultiple;

          equity += netPnl;
          peakEquity = Math.max(peakEquity, equity);
          const dd = peakEquity - equity;
          if (dd > maxDD) { maxDD = dd; maxDDPct = peakEquity > 0 ? (dd / peakEquity) * 100 : 0; }

          if (exitReason === "BREAKEVEN") {
            report.breakeven++;
            consecLoss = 0;
          } else if (netPnl > 0) {
            report.wins++; grossWin += netPnl; winPnls.push(netPnl); consecLoss = 0;
          } else {
            report.losses++; grossLoss += Math.abs(netPnl); lossPnls.push(netPnl);
            consecLoss++; maxConsecLoss = Math.max(maxConsecLoss, consecLoss);
          }
          totalCosts += commission;
          rMultiples.push(rMultiple);
          report.equityCurve.push({ time: entryBars[exitIdx].time, equity: Number(equity.toFixed(2)) });

          journalEntry.executed = true;
          journalEntry.entry = Number(execEntry.toFixed(5));
          journalEntry.stopLoss = slPrice;
          journalEntry.takeProfit = tpPrice;
          journalEntry.lot = lot;
          journalEntry.exitTime = entryBars[exitIdx].time;
          journalEntry.exitTimeISO = new Date(entryBars[exitIdx].time * 1000).toISOString();
          journalEntry.exit = Number(exitPrice.toFixed(5));
          journalEntry.exitReason = exitReason;
          journalEntry.profitLoss = Number(netPnl.toFixed(2));
          journalEntry.profitPercent = Number(((netPnl / capital) * 100).toFixed(3));
          journalEntry.rMultiple = rMultiple;
          journalEntry.duration = exitIdx - fillBarIdx;
          journalEntry.spread = Number(spreadPrice.toFixed(5));
          journalEntry.slippage = slippagePoints;
          journalEntry.commission = Number(commission.toFixed(2));
          journalEntry.ambiguousTieBreak = sim.ambiguous;

          openUntilIndex = allowConcurrentTrades ? openUntilIndex : exitIdx;
        } else if (!isWait && permBlocked) {
          journalEntry.skippedReason = final.primaryReject || "permission";
          if (shadowOn) shadowFromSignal(journalEntry, i, final.signal, journalEntry.skippedReason, atr, structure);
        } else if (executable) {
          journalEntry.skippedReason = "position already open";
          if (shadowOn) shadowFromSignal(journalEntry, i, final.signal, "POSITION_OPEN", atr, structure);
        } else if (shadowOn && !isWait) {
          // direction allowed by the engine, but below the AUTO confidence used live
          journalEntry.skippedReason = "AUTO_MIN_CONFIDENCE";
          shadowFromSignal(journalEntry, i, final.signal, "AUTO_MIN_CONFIDENCE", atr, structure);
        } else if (shadowOn && isWait && raw && raw.signal && !String(raw.signal).includes("WAIT")) {
          // the score picked a direction but a quality/permission gate turned it into WAIT
          journalEntry.candidate = String(raw.signal).includes("BUY") ? "BUY" : "SELL";
          journalEntry.skippedReason = final.primaryReject || "FILTERED";
          shadowFromSignal(journalEntry, i, raw.signal, journalEntry.skippedReason, atr, structure);
        }

        report.journal.push(journalEntry);
      }
    } finally {
      // Always restore live-only globals, even on error.
      window.GoldAI_Data.dataMode = prevDataMode;
      if (window.GoldAI_RiskGuard && prevRiskCheck) window.GoldAI_RiskGuard.check = prevRiskCheck;
      if (perm && perm.restoreCluster) perm.restoreCluster(prevCluster);
    }

    // --- 7) Stats -----------------------------------------------------------
    const closedTrades = report.wins + report.losses + report.breakeven;
    report.winRate = (report.wins + report.losses) > 0
      ? Number(((report.wins / (report.wins + report.losses)) * 100).toFixed(1))
      : 0;
    report.profitFactor = grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : (grossWin > 0 ? 99 : 0);
    report.netPL = Number((equity - capital).toFixed(2));
    report.avgWin = winPnls.length ? Number((winPnls.reduce((a, b) => a + b, 0) / winPnls.length).toFixed(2)) : 0;
    report.avgLoss = lossPnls.length ? Number((lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length).toFixed(2)) : 0;
    report.avgR = rMultiples.length ? Number((rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length).toFixed(2)) : 0;
    report.expectancy = closedTrades > 0 ? Number((report.netPL / closedTrades).toFixed(2)) : 0;
    report.maxDrawdown = Number(maxDD.toFixed(2));
    report.maxDrawdownPct = Number(maxDDPct.toFixed(2));
    report.maxConsecLosses = maxConsecLoss;
    report.totalTradingCosts = Number(totalCosts.toFixed(2));
    report.finalEquity = Number(equity.toFixed(2));
    if (shadowOn) report.groups = groupStats(report.journal);
    report.barsUsed = entryBars.length;
    report.m1BarsUsed = m1Bars.length;
    report.notes.push(`Entry = OPEN of the bar AFTER the signal bar (never the signal bar's own close).`);
    report.notes.push(`HTF bias (${htfTF}) source: ${report.htfSource}. Only HTF bars closed at the signal time are used.`);
    report.notes.push(`Auto plan: SL/TP from the fill price, TP1 only, min reward:risk ${Number(cfg.AUTO_MIN_RR) > 0 ? cfg.AUTO_MIN_RR : 1} (skipped: ${report.rrSkipped || 0}).`);
    report.notes.push(`Exit target = TP1 (aligned with live). SL/TP from ATR risk engine.`);
    report.notes.push(`Same-direction cluster/cooldown uses candle time (not wall clock) and is restored after the run.`);
    report.notes.push(`"BREAKEVEN" = a time/end-of-data exit that landed within 15% of the SL distance from entry (no new stop-management logic was added).`);
    return report;
  }

  /** Diagnostics only (opts.features): indicator values at the signal bar. Never used for decisions. */
  function featuresOf(L, final, raw, bars, i, barSec) {
    const n = (v, d) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(d)));
    L = L || {};
    const atr = L.atr && Number(L.atr.atr);
    const close = bars[i].close;
    // move of the last 12 bars and of the last 48 bars, in ATR units (signed, + = up)
    const mv = (k) => (i - k >= 0 && atr > 0 ? n((close - bars[i - k].close) / atr, 2) : null);
    // efficiency of the last 12 bars: |net move| / sum of |bar moves| (1 = straight line, ~0 = chop)
    let path = 0; for (let q = Math.max(1, i - 11); q <= i; q++) path += Math.abs(bars[q].close - bars[q - 1].close);
    const eff = path > 0 && i >= 12 ? n(Math.abs(close - bars[i - 12].close) / path, 2) : null;
    const rng = (bars[i].high - bars[i].low);
    return {
      atr: n(atr, 3), adx: n(L.adx && L.adx.adx, 1), regime: L.regime || null,
      rsi: n(L.rsi && L.rsi.rsi, 1), emaTrend: L.ema && L.ema.trend || null,
      dist20: n(L.ema && atr > 0 ? (close - L.ema.ema20) / atr : null, 2),
      structTrend: L.structure && L.structure.trend || null, bos: !!(L.structure && L.structure.bos), choch: !!(L.structure && L.structure.choch),
      htfTrend: L.htf && L.htf.trend || null, htfStrength: L.htf && L.htf.strength || null,
      htfAlign: final && final.contextQuality || null, edge: n(final && final.directionalEdge, 1),
      rawSignal: raw && raw.signal ? (String(raw.signal).includes("BUY") ? "BUY" : String(raw.signal).includes("SELL") ? "SELL" : "WAIT") : null,
      mv12: mv(12), mv48: mv(48), eff12: eff, barRangeAtr: atr > 0 ? n(rng / atr, 2) : null,
      spread: n(bars[i].spread, 0), volRatio: n(L.volume && L.volume.ratio, 2)
    };
  }

  /** Results in R (risk units) for traded vs. not-traded (shadow) signals, by reason. */
  function groupStats(journal) {
    const blank = () => ({ n: 0, wins: 0, losses: 0, breakeven: 0, open: 0, sumR: 0, winRate: 0, avgR: 0 });
    const add = (g, exitReason, r) => {
      g.n++;
      if (exitReason === "UNRESOLVED" || r == null) { g.open++; return; }
      if (exitReason === "BREAKEVEN") g.breakeven++;
      else if (r > 0) g.wins++;
      else g.losses++;
      g.sumR += r;
    };
    const fin = (g) => {
      const closed = g.wins + g.losses;
      g.winRate = closed ? Number(((g.wins / closed) * 100).toFixed(1)) : 0;
      const done = g.n - g.open;
      g.avgR = done ? Number((g.sumR / done).toFixed(2)) : 0;
      g.sumR = Number(g.sumR.toFixed(2));
      return g;
    };
    const traded = blank(), notTraded = blank(), byReason = {};
    for (const j of journal) {
      if (j.executed) add(traded, j.exitReason, j.rMultiple);
      if (j.shadow) {
        add(notTraded, j.shadow.exitReason, j.shadow.rMultiple);
        const k = j.shadow.reason || "OTHER";
        byReason[k] = byReason[k] || blank();
        add(byReason[k], j.shadow.exitReason, j.shadow.rMultiple);
      }
    }
    Object.keys(byReason).forEach(k => fin(byReason[k]));
    return { traded: fin(traded), notTraded: fin(notTraded), byReason };
  }

  /**
   * Check REAL worker signals (signals.json) against real M1 candles: for each
   * BUY/SELL entry, did the price reach TP1 or SL first? Executed entries use the
   * levels actually sent (autoPlan); the others use the signal's own levels.
   * Rough check only (the true result is in the MT5 account history).
   */
  function auditSignals(entries, m1Bars, opts) {
    opts = opts || {};
    const maxHoldBars = Number(opts.maxHoldBars) || 100; // same time limit as the backtest (100 candles)
    const spreadOf = (bar) => spreadAsPrice(bar, opts.specs || {}, Number((opts.specs || {}).point) || 0.01, opts.symbol || "XAUUSD.");
    const bars = (m1Bars || []).slice().sort((a, b) => a.time - b.time);
    const times = bars.map(b => b.time);
    const firstAt = (t) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; } return lo; };
    const rows = [];
    for (const e of entries || []) {
      const sig = String(e.signal || "").toUpperCase();
      const isBuy = sig.includes("BUY"), isSell = sig.includes("SELL");
      if (!isBuy && !isSell) continue;
      const executed = e.executionStatus === "EXECUTED";
      const ap = e.autoPlan || null;
      const toNum = (v) => (v == null || v === "" ? NaN : Number(v)); // null must not become 0
      const useAuto = ap && Number.isFinite(toNum(ap.stopLoss)) && Number.isFinite(toNum(ap.tp1)) && Number.isFinite(toNum(ap.fillPrice));
      const entry = toNum(useAuto ? ap.fillPrice : e.price);
      const sl = toNum(useAuto ? ap.stopLoss : e.stopLoss);
      const tp = toNum(useAuto ? ap.tp1 : e.tp1);
      const tfSec = TF_SECONDS[String(e.timeframe || "M5").toUpperCase()] || 300;
      const start = Number(e.candleTimestamp) + tfSec; // first moment after the signal candle closed
      const maxHoldSec = maxHoldBars * tfSec;
      const row = { time: start, timeISO: new Date(start * 1000).toISOString(), timeframe: e.timeframe, signal: isBuy ? "BUY" : "SELL",
        confidence: e.confidence, executed, status: e.executionStatus || "-", reason: e.primaryReject || null,
        entry, stopLoss: sl, takeProfit: tp, result: "NO_LEVELS", rMultiple: null, minutes: null };
      if (![entry, sl, tp].every(Number.isFinite) || Math.abs(entry - sl) <= 0) { rows.push(row); continue; }
      const risk = Math.abs(entry - sl), reward = Math.abs(tp - entry);
      row.rr = Number((reward / risk).toFixed(2));
      let k = firstAt(start), res = null;
      for (; k < bars.length && bars[k].time < start + maxHoldSec; k++) {
        const b = bars[k];
        const off = isBuy ? 0 : spreadOf(b);
        const hitSL = isBuy ? b.low <= sl : b.high + off >= sl;
        const hitTP = isBuy ? b.high >= tp : b.low + off <= tp;
        if (hitSL) { res = "SL"; break; }       // same bar: count the loss (conservative)
        if (hitTP) { res = "TP"; break; }
      }
      if (res) {
        row.result = res; row.rMultiple = res === "TP" ? row.rr : -1;
        row.minutes = Math.round((bars[k].time - start) / 60);
      } else if (k >= bars.length) { row.result = "OPEN"; }
      else { row.result = "TIME"; }
      rows.push(row);
    }
    const g = () => ({ n: 0, tp: 0, sl: 0, other: 0, sumR: 0, winRate: 0 });
    const sum = { executed: g(), notExecuted: g(), byStatus: {} };
    for (const r of rows) {
      const tgt = [r.executed ? sum.executed : sum.notExecuted];
      const key = r.executed ? "EXECUTED" : (r.status === "SKIPPED_WAIT_OR_INVALID" && r.reason ? r.reason : r.status);
      sum.byStatus[key] = sum.byStatus[key] || g();
      tgt.push(sum.byStatus[key]);
      for (const x of tgt) {
        x.n++;
        if (r.result === "TP") { x.tp++; x.sumR += r.rMultiple; }
        else if (r.result === "SL") { x.sl++; x.sumR -= 1; }
        else x.other++;
      }
    }
    const fin = (x) => { x.winRate = (x.tp + x.sl) ? Number(((x.tp / (x.tp + x.sl)) * 100).toFixed(1)) : 0; x.sumR = Number(x.sumR.toFixed(2)); return x; };
    fin(sum.executed); fin(sum.notExecuted); Object.keys(sum.byStatus).forEach(k => fin(sum.byStatus[k]));
    return { rows, summary: sum };
  }

  function resolveTieBreak(bar, isBuy, slPrice, tpPrice, m1Bars, barSeconds, askOff) {
    const off = isBuy ? 0 : (Number(askOff) || 0);
    if (m1Bars && m1Bars.length) {
      const lo = bar.time, hi = bar.time + barSeconds;
      let a = 0, z = m1Bars.length;
      while (a < z) { const m = (a + z) >> 1; if (m1Bars[m].time < lo) a = m + 1; else z = m; }
      const sub = [];
      for (let q = a; q < m1Bars.length && m1Bars[q].time < hi; q++) sub.push(m1Bars[q]);
      for (const s of sub) {
        const sSL = isBuy ? (s.low <= slPrice) : (s.high + off >= slPrice);
        const sTP = isBuy ? (s.high >= tpPrice) : (s.low + off <= tpPrice);
        if (sSL && sTP) return { price: slPrice, reason: "SL", ambiguous: true }; // still ambiguous at M1 -> conservative
        if (sSL) return { price: slPrice, reason: "SL", ambiguous: false };
        if (sTP) return { price: tpPrice, reason: "TP", ambiguous: false };
      }
    }
    // No real M1 data to disambiguate — conservative worst-case assumption.
    return { price: slPrice, reason: "SL", ambiguous: true };
  }

  return { runRealMT5Backtest, buildSignal, resample, toBars, seriesOf, TF_SECONDS, htfTimeframeFor, closedHtfBars, auditSignals, groupStats };
})();
