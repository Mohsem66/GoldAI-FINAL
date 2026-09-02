// =====================================================================
// GoldAI — REAL MT5 Walk-Forward Signal Backtest
// -----------------------------------------------------------------------
// Reuses the EXACT SAME live engines (EMA/RSI/MACD/ADX/ATR/Volume/SR/
// Candles/Structure/Liquidity/Score/ConflictFilter/TradeManagement) that
// app.js uses for live signals. This file does NOT change any of those
// engines — it only calls them with historically-sliced (look-ahead-safe)
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

  /** Real OHLC resample (aggregation of ALREADY-REAL MT5 bars) — no fabricated data. */
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
      htf = { trend: htfStr.trend !== "UNKNOWN" ? htfStr.trend : htfEma.trend, strength: htfEma.confidence > 70 ? "STRONG" : "WEAK" };
    }

    let m1 = null;
    if (microSlice && microSlice.closes.length > 5) {
      const m1Ema = window.GoldAI_EMA.analyzeEMA(microSlice.closes, microSlice.closes[microSlice.closes.length - 1], cfg);
      m1 = { microstructure: m1Ema.trend };
    }

    const layers = { ema, rsi, divergence: div, structure, macd, adx, atr: atrL, volume, sr, candles: candleP, liquidity: liq, htf, m1 };
    const raw = window.GoldAI_Score.runScoreEngine(layers);
    const final = window.GoldAI_Conflict.runConflictFilter(raw, layers, cfg);
    return { final, atr: atrL.atr, layers };
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
    const allowConcurrentTrades = !!opts.allowConcurrentTrades;
    const step = Math.max(1, Number(opts.step) || 1);
    const tpTarget = "tp" + (cfg.TP_COUNT || 3);

    const report = {
      method: "real-mt5-walk-forward",
      lookAheadSafe: true,
      dataSource: "MT5",
      symbol: cfg.SYMBOL || "XAUUSD.",
      entryTF, mode, minConfidence, capital, riskPercent, slippagePoints, commissionPerLot,
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

    // --- 1) Fetch REAL MT5 history for the entry timeframe ---------------
    const entryRes = await window.GoldAI_Data.fetchMT5History(entryTF, count);
    if (!entryRes || entryRes.status !== "ok" || !entryRes.candles || entryRes.candles.length < 220) {
      report.errors.push("Could not load enough real MT5 " + entryTF + " history: " +
        (entryRes && entryRes.message ? entryRes.message : "MT5 bridge unavailable"));
      return report;
    }
    const entryBars = toBars(entryRes.candles);
    const entrySeriesFull = seriesOf(entryBars);
    const barSeconds = TF_SECONDS[entryTF];

    // --- 2) Fetch REAL MT5 M1 (for microstructure + intrabar SL/TP tie-break) ---
    let m1Bars = [];
    if (entryTF === "M1") {
      m1Bars = entryBars;
    } else {
      const m1Count = Math.min(5000, Math.ceil((entryBars[entryBars.length - 1].time - entryBars[0].time) / 60) + 500);
      const m1Res = await window.GoldAI_Data.fetchMT5History("M1", m1Count);
      if (m1Res && m1Res.status === "ok" && m1Res.candles && m1Res.candles.length) {
        m1Bars = toBars(m1Res.candles);
      } else {
        report.notes.push("Real M1 data unavailable — same-bar SL/TP conflicts default to worst-case (SL-first).");
      }
    }
    const m1SeriesFull = seriesOf(m1Bars);

    // --- 3) Real symbol specs (point / tick size / tick value / lot limits) ---
    let specs = cfg.SYMBOL_SPECS || {};
    try {
      const s = await window.GoldAI_Data.fetchMT5SymbolSpecs();
      if (s && s.status === "ok") specs = s;
    } catch (_) {}
    const point = Number(specs.point) || 0.01;

    // --- 4) HTF bias — resampled from the SAME real bars (no Twelve Data, no fabrication) ---
    const htfBucketSeconds = mode === "swing" ? TF_SECONDS.H4 : TF_SECONDS.H1;
    const htfBarsFull = resample(entryBars, barSeconds, htfBucketSeconds);
    const htfSeriesFull = seriesOf(htfBarsFull);

    // --- 5) Micro/scalp bias for the m1 layer ---
    let microBarsFull, microBucketSeconds;
    if (mode === "swing") {
      // swing wants a coarser "micro" read than scalp — resample M1 up to ~M15
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
    const warmup = Math.max(210, cfg.EMA_SLOW ? cfg.EMA_SLOW + 10 : 210);
    if (entryBars.length < warmup + 5) {
      report.errors.push(`Not enough bars (${entryBars.length}) for warmup (${warmup})`);
      return report;
    }

    // Suspend the two LIVE-ONLY guards for the duration of this historical
    // run, WITHOUT modifying conflict-filter.js / risk-guard.js:
    //  - dataMode: we are feeding 100% real MT5 bars here, so it's genuinely
    //    "live" data for scoring purposes, not the CURRENT UI's live/offline state.
    //  - RiskGuard: a daily circuit breaker for REAL execution. Per requirement,
    //    the backtest must evaluate every valid signal even if the real system
    //    would have blocked it that day — so it must not gate virtual trades.
    const prevDataMode = window.GoldAI_Data.dataMode;
    const prevRiskCheck = window.GoldAI_RiskGuard ? window.GoldAI_RiskGuard.check : null;
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

    try {
      for (let i = warmup; i < entryBars.length - 1; i += step) {
        // "Known" instant = when bar i's OWN close became available (open-time + duration),
        // NOT bar i's open time. HTF/micro bars are only included once THEY have also closed
        // by that same instant — this is the actual look-ahead-safety boundary.
        const knownTime = entryBars[i].time + barSeconds;

        // Advance HTF / M1 pointers to the last fully-closed bar at/before knownTime
        while (htfPtr < htfBarsFull.length && (htfBarsFull[htfPtr].time + htfBucketSeconds) <= knownTime) htfPtr++;
        while (m1Ptr < microBarsFull.length && (microBarsFull[m1Ptr].time + microBucketSeconds) <= knownTime) m1Ptr++;

        const entrySlice = {
          closes: entrySeriesFull.closes.slice(0, i + 1),
          highs: entrySeriesFull.highs.slice(0, i + 1),
          lows: entrySeriesFull.lows.slice(0, i + 1),
          volumes: entrySeriesFull.volumes.slice(0, i + 1),
          candles: entrySeriesFull.candles.slice(0, i + 1)
        };
        const htfSlice = {
          closes: htfSeriesFull.closes.slice(0, htfPtr),
          highs: htfSeriesFull.highs.slice(0, htfPtr),
          lows: htfSeriesFull.lows.slice(0, htfPtr)
        };
        const microSlice = { closes: microSeriesFull.closes.slice(0, m1Ptr) };

        const price = entrySlice.closes[entrySlice.closes.length - 1];
        const { final, atr } = buildSignal(entrySlice, htfSlice, microSlice, cfg, price);

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

        const executable = !isWait && final.confidence >= minConfidence;
        report.executableSignals += executable ? 1 : 0;

        if (executable && (allowConcurrentTrades || i > openUntilIndex) && !atr) {
          journalEntry.skippedReason = "no ATR yet";
        } else if (executable && (allowConcurrentTrades || i > openUntilIndex)) {
          // ---- Fill at OPEN of the NEXT bar (not this bar's own close) ----
          const fillBarIdx = i + 1;
          const fillBar = entryBars[fillBarIdx];
          const isBuy = final.signal.includes("BUY");
          const spreadPrice = (fillBar.spread || 0) * point;
          const slip = slippagePoints * point;
          let execEntry = isBuy ? (fillBar.open + spreadPrice + slip) : (fillBar.open - slip);

          const plan = window.GoldAI_Trade.createTradePlan(final.signal, execEntry, atr, capital, riskPercent, cfg, specs);
          const slPrice = plan.stopLoss;
          const tpPrice = plan[tpTarget] || plan.tp1;
          const lot = plan.lot;

          // ---- Scan forward bars for SL / TP / time exit ----
          let exitIdx = -1, exitPrice = null, exitReason = null, ambiguous = false;
          const holdLimit = Math.min(entryBars.length - 1, fillBarIdx + maxHoldBars);
          for (let j = fillBarIdx; j <= holdLimit; j++) {
            const bar = entryBars[j];
            const hitSL = isBuy ? (bar.low <= slPrice) : (bar.high >= slPrice);
            const hitTP = isBuy ? (bar.high >= tpPrice) : (bar.low <= tpPrice);

            if (hitSL && hitTP) {
              const tie = resolveTieBreak(bar, isBuy, slPrice, tpPrice, m1Bars, barSeconds);
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
            exitIdx = holdLimit;
            exitPrice = entryBars[holdLimit].close;
            exitReason = "END_OF_DATA";
          }

          // Exit-side spread/slippage — applied consistently for EVERY exit reason
          // (closing a BUY = selling at Bid = raw price; closing a SELL = buying
          // back at Ask = raw price + spread). SL/TP were computed as plain
          // (bid-based) levels, so this is the correct fill on top of them too,
          // not just on the time/end-of-data fallback path.
          const exitSpread = (entryBars[exitIdx].spread || 0) * point;
          exitPrice = isBuy ? (exitPrice - slip) : (exitPrice + exitSpread + slip);

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
          journalEntry.ambiguousTieBreak = ambiguous;

          openUntilIndex = allowConcurrentTrades ? openUntilIndex : exitIdx;
        } else if (executable) {
          journalEntry.skippedReason = "position already open";
        }

        report.journal.push(journalEntry);
      }
    } finally {
      // Always restore live-only globals, even on error.
      window.GoldAI_Data.dataMode = prevDataMode;
      if (window.GoldAI_RiskGuard && prevRiskCheck) window.GoldAI_RiskGuard.check = prevRiskCheck;
    }

    // --- 7) Stats -----------------------------------------------------------
    const closedTrades = report.wins + report.losses + report.breakeven;
    report.winRate = closedTrades > 0 ? Number(((report.wins / closedTrades) * 100).toFixed(1)) : 0;
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
    report.barsUsed = entryBars.length;
    report.m1BarsUsed = m1Bars.length;
    report.notes.push(`Entry = OPEN of the bar AFTER the signal bar (never the signal bar's own close).`);
    report.notes.push(`HTF bias (${mode === "swing" ? "H4" : "H1"}) is built by resampling the same real MT5 bars — not Twelve Data, not fabricated.`);
    report.notes.push(`Exit target = ${tpTarget.toUpperCase()} (from cfg.TP_COUNT=${cfg.TP_COUNT}). SL/TP levels come from the unmodified ATR risk engine.`);
    report.notes.push(`"BREAKEVEN" = a time/end-of-data exit that landed within 15% of the SL distance from entry (no new stop-management logic was added).`);
    return report;
  }

  function resolveTieBreak(bar, isBuy, slPrice, tpPrice, m1Bars, barSeconds) {
    if (m1Bars && m1Bars.length) {
      const lo = bar.time, hi = bar.time + barSeconds;
      const sub = m1Bars.filter(b => b.time >= lo && b.time < hi).sort((a, b) => a.time - b.time);
      for (const s of sub) {
        const sSL = isBuy ? (s.low <= slPrice) : (s.high >= slPrice);
        const sTP = isBuy ? (s.high >= tpPrice) : (s.low <= tpPrice);
        if (sSL && sTP) return { price: slPrice, reason: "SL", ambiguous: true }; // still ambiguous at M1 -> conservative
        if (sSL) return { price: slPrice, reason: "SL", ambiguous: false };
        if (sTP) return { price: tpPrice, reason: "TP", ambiguous: false };
      }
    }
    // No real M1 data to disambiguate — conservative worst-case assumption.
    return { price: slPrice, reason: "SL", ambiguous: true };
  }

  return { runRealMT5Backtest, buildSignal, resample, toBars, seriesOf, TF_SECONDS };
})();
