// =====================================
// GoldAI Pro — Main Orchestrator
// =====================================

window.GoldAI = {

  lastResult: null,
  _workerPollTimer: null,
  _workerPollBusy: false,
  _lastHydratedCandleTs: null,
  backendURL: 'http://localhost:5000/api',
  // Demo: set window.GOLD_AI_API_TOKEN or localStorage goldai_api_token (same value as backend GOLD_AI_API_TOKEN).
  // Never hardcode production secrets in repo.
  apiAuthHeaders() {
    const t = (typeof window !== 'undefined' && window.GOLD_AI_API_TOKEN)
      || (function(){ try { return localStorage.getItem('goldai_api_token'); } catch(_){ return null; } })()
      || '';
    const h = { 'Content-Type': 'application/json' };
    if (t) h['X-GoldAI-Token'] = t;
    return h;
  },
  currentUID: null,
  signalHistory: [],
  dynamicWeights: {},
  theme: 'dark',

  async init() {
    const data = window.GoldAI_Data;
    this.loadSettings();
    this.loadTheme();
    await data.loadAll();
    data.seedDemo(); // no-op for any timeframe that already has real MT5/backend candles
    this.updatePriceUI();
    this.updateMarketClock();
    this.updateRiskUI();
    // Sync MANUAL/AUTO dashboard buttons + execution panel visibility on first paint
    // (display-only; lastResult is null pre-analysis, so panel stays hidden as before).
    this.updateExecutionPanel(this.lastResult);
    this.syncAutoTradeSignalVisibility();
    // Restore SYSTEM ON/OFF from backend after dashboard load (independent of AUTO)
    this.refreshSystemPowerFromServer();
    // Mobile-First patch: paint the Live Chart with whatever candles loadAll()
    // just fetched. Display-only — does not call analyze() or touch signals.
    if (window.GoldAI_Chart && typeof window.GoldAI_Chart.render === "function") {
      try { window.GoldAI_Chart.render(); } catch (_) {}
    }
    // Hydrate last Worker signal for display only (no analyze side-effects)
    // MUST run before AutoSignal.start so a local analyze() does not wipe diagnostics.
    try {
      const ok = await this.hydrateFromWorkerLatest();
      if (!ok && !this.lastResult) this.renderNoAnalysisYet();
    } catch (_) {
      if (!this.lastResult) this.renderNoAnalysisYet();
    }
    // Start auto monitor only after hydrate; mark worker candle as already evaluated
    if (window.GoldAI_AutoSignal && typeof window.GoldAI_AutoSignal.start === 'function') {
      try {
        if (this.lastResult && this.lastResult.hydratedFromWorker && this.lastResult._workerCandleKey
            && typeof window.GoldAI_AutoSignal.markCandleEvaluated === 'function') {
          window.GoldAI_AutoSignal.markCandleEvaluated(this.lastResult._workerCandleKey);
        }
      } catch (_) {}
      window.GoldAI_AutoSignal.start({ skipImmediateTick: !!(this.lastResult && this.lastResult.hydratedFromWorker) });
    }
    this.setupSettingsPanel();
    this.setupNotificationPermission();
    setInterval(() => this.updateMarketClock(), 1000);
    setInterval(async () => {
      await this.fetchPriceFromBackend();
      this.updatePriceUI();
    }, window.GoldAI_Config.PRICE_REFRESH_MS);
    // Auto-refresh Worker signal when SYSTEM ON (display only — no analyze())
    this.startWorkerSignalPolling();
    // Real account equity for the risk card (read-only), refreshed every minute
    this.refreshAccountFromServer();
    setInterval(() => this.refreshAccountFromServer(), 60000);
    console.log("✅ GoldAI Pro ready");
  },

  isMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (day === 6) return false;
    if (day === 0 && hour < 22) return false;
    if (day === 5 && hour >= 22) return false;
    return true;
  },

  // MT5-only now. window.GoldAI_Data.loadPrice() hits /api/mt5/current-price
  // exclusively — no Twelve Data, no public fallback — see js/core/data.js.
  async fetchPriceFromBackend() {
    return window.GoldAI_Data.loadPrice(true);
  },

  loadTheme() {
    try {
      const saved = localStorage.getItem('goldai_theme');
      if (saved) {
        this.theme = saved;
        document.body.classList.toggle('light', saved === 'light');
        document.getElementById('themeToggle').textContent = saved === 'light' ? '☀️' : '🌙';
      }
    } catch (_) {}
  },
  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.body.classList.toggle('light', this.theme === 'light');
    document.getElementById('themeToggle').textContent = this.theme === 'light' ? '☀️' : '🌙';
    localStorage.setItem('goldai_theme', this.theme);
  },

  setupNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  },
  async sendNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.5);
    } catch (_) {}
    try {
      const topic = window.GoldAI_Config.NTFY_TOPIC || 'goldai_signals';
      await fetch(`https://ntfy.sh/${topic}`, {
        method: 'POST',
        body: `${title}\n${body}`,
        headers: { 'Title': title }
      });
    } catch (_) {}
  },

  updateTradeSettings() {
    const tpCount = parseInt(document.getElementById('userTpCount').value) || 3;
    const slMult = parseFloat(document.getElementById('userSlMult').value) || 1.5;
    const tp1Mult = parseFloat(document.getElementById('userTp1Mult').value) || 2.0;
    const tp2Mult = parseFloat(document.getElementById('userTp2Mult').value) || 3.5;
    const tp3Mult = parseFloat(document.getElementById('userTp3Mult').value) || 5.0;
    const userLot = parseFloat(document.getElementById('userLot').value) || 0;
    window.GoldAI_Config.TP_COUNT = tpCount;
    window.GoldAI_Config.ATR_SL_MULT = slMult;
    window.GoldAI_Config.ATR_TP1_MULT = tp1Mult;
    window.GoldAI_Config.ATR_TP2_MULT = tp2Mult;
    window.GoldAI_Config.ATR_TP3_MULT = tp3Mult;
    window.GoldAI_Config.USER_LOT = userLot;
    const stored = JSON.parse(localStorage.getItem('goldai_settings') || '{}');
    stored.tpCount = tpCount; stored.slMult = slMult; stored.tp1Mult = tp1Mult;
    stored.tp2Mult = tp2Mult; stored.tp3Mult = tp3Mult; stored.userLot = userLot;
    localStorage.setItem('goldai_settings', JSON.stringify(stored));
  },
  applyTradeSettings() {
    this.updateTradeSettings();
    this.updateRiskUI();
    alert('✅ تنظیمات معامله اعمال شد');
  },

  updateAdvancedSettings() {
    const capital = parseFloat(document.getElementById('advCapital').value) || 10000;
    const risk = parseFloat(document.getElementById('advRisk').value) || 1;
    if (capital > 0) window.GoldAI_Data.setCapital(capital);
    window.GoldAI_Config.DEFAULT_RISK_PERCENT = risk;
    const stored = JSON.parse(localStorage.getItem('goldai_settings') || '{}');
    stored.capital = capital; stored.risk = risk;
    localStorage.setItem('goldai_settings', JSON.stringify(stored));
    this.updateRiskUI();
  },

  detectReversal(closes, rsiHistory) {
    if (closes.length < 30) return { signal: 'NONE', strength: 0 };
    const last = closes.length - 1;
    const price = closes[last];
    const price20 = closes[last - 20] || price;
    let reversal = { signal: 'NONE', strength: 0, type: '' };
    if (rsiHistory && rsiHistory.length > 20) {
      const rsi = rsiHistory[last];
      const rsi20 = rsiHistory[last - 20] || rsi;
      if (price < price20 && rsi > rsi20 && rsi < 50) reversal = { signal: 'BUY', strength: 70, type: 'HIDDEN_BULLISH_RSI' };
      if (price > price20 && rsi < rsi20 && rsi > 50) reversal = { signal: 'SELL', strength: 70, type: 'HIDDEN_BEARISH_RSI' };
    }
    return reversal;
  },

  updateDynamicWeights() {
    const engines = ['ema', 'rsi', 'macd', 'structure', 'volume', 'sr', 'candles'];
    const history = this.signalHistory.slice(-20);
    const weights = {};
    engines.forEach(eng => {
      let score = 50;
      const matches = history.filter(h => h.engine === eng && h.correct === true);
      const total = history.filter(h => h.engine === eng);
      if (total.length > 5) score = 50 + ((matches.length / total.length) * 50);
      weights[eng] = Math.min(100, Math.max(20, score));
    });
    this.dynamicWeights = weights;
    return weights;
  },


  /**
   * Read-only hydrate of last Worker signal into the dashboard after refresh.
   * Does NOT run analyze side-effects (saveHistory / sendToBackend / notify / orders).
   * Source: GET /api/worker/signal/latest (journal written by signal-worker).
   */
  /** Normalize symbol|TF|time so Worker journal and AutoSignal share one key. */
  _normalizeCandleKey(symbol, tf, time) {
    let sym = String(symbol || (window.GoldAI_Config && window.GoldAI_Config.SYMBOL) || "XAUUSD.").toUpperCase();
    if (sym.endsWith(".")) sym = sym.slice(0, -1);
    const tfu = String(tf || "M5").toUpperCase();
    const ts = String(time != null ? time : "");
    return sym + "|" + tfu + "|" + ts;
  },

  /** Seconds per bar for display close-time only (does not change candle identity). */
  _tfBarSeconds(tf) {
    const u = String(tf || "M5").toUpperCase();
    return ({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 })[u] || 300;
  },

  /**
   * Display-only: candle CLOSE time from MT5 open time + TF duration.
   * candleTimestamp / identity remain OPEN; do not use for dedup keys.
   */
  _signalDisplayClose(openUnixSec, tf) {
    const open = Number(openUnixSec);
    if (!open || isNaN(open)) return null;
    const closeSec = open + this._tfBarSeconds(tf);
    const d = new Date(closeSec * 1000);
    return {
      closeUnix: closeSec,
      iso: d.toISOString(),
      timeFa: d.toLocaleString("fa-IR"),
      dateFa: d.toLocaleDateString("fa-IR"),
      timeOnlyFa: d.toLocaleTimeString("fa-IR")
    };
  },

  async hydrateFromWorkerLatest(opts) {
    opts = opts || {};
    const onlyIfNewer = !!opts.onlyIfNewer;
    const requireSystemOn = !!opts.requireSystemOn;
    try {
      if (requireSystemOn) {
        // Display policy: do not apply new Worker snapshots while SYSTEM is OFF
        const btn = document.getElementById("systemPowerBtn");
        const sysOn = btn && btn.getAttribute("aria-pressed") === "true";
        if (!sysOn) return false;
      }

      const res = await fetch(`${this.backendURL}/worker/signal/latest`, { cache: "no-store" });
      if (!res.ok) return false;
      const entry = await res.json();
      if (!entry || !entry.signal) return false;

      // Freshness: candle close must be within max age by TF (no stale display)
      const tf = String(entry.timeframe || "M5").toUpperCase();
      const barSec = ({ M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 })[tf] || 300;
      const maxAgeMs = (barSec * 2 + 120) * 1000;
      const candleTs = entry.candleTimestamp != null ? Number(entry.candleTimestamp) : null;
      const candleMs = candleTs
        ? candleTs * 1000
        : (entry.candleTimeISO ? Date.parse(entry.candleTimeISO) : NaN);
      if (!candleMs || isNaN(candleMs)) return false;
      if (Date.now() - candleMs > maxAgeMs) return false;

      // Poll path: only re-render when Worker closed-candle identity changes
      if (onlyIfNewer) {
        const prev = this._lastHydratedCandleTs;
        if (prev != null && candleTs != null && String(prev) === String(candleTs)) {
          return false; // same candle — keep current UI
        }
        // Also compare against lastResult key if set
        if (this.lastResult && this.lastResult.candleTimestamp != null && candleTs != null
            && String(this.lastResult.candleTimestamp) === String(candleTs)
            && this.lastResult.hydratedFromWorker) {
          return false;
        }
      }

      const d = entry.diagnostics || {};
      const result = {
        signal: entry.signal,
        confidence: entry.confidence,
        directionalEdge: entry.directionalEdge != null ? entry.directionalEdge : d.directionalEdge,
        primaryReject: entry.primaryReject || d.primaryRejectFinal || d.primaryReject || null,
        entryQuality: entry.entryQuality || null,
        diagnostics: d,
        layers: entry.layers || { htf: d.layers && d.layers.htf, regime: d.layers && d.layers.regime },
        reason: entry.reason || "",
        warnings: entry.warnings || [],
        entry: entry.price,
        price: entry.price,
        stopLoss: entry.stopLoss,
        tp1: entry.tp1,
        tp2: entry.tp2,
        tp3: entry.tp3,
        lot: entry.lot,
        executionEligible: (typeof entry.executionEligible === "boolean") ? entry.executionEligible : null,
        executionStatus: entry.executionStatus || null,
        executionResponse: entry.executionResponse || null,
        autoPlan: entry.autoPlan || null,
        riskReward: (function () {
          const e = Number(entry.price), s = Number(entry.stopLoss), t = Number(entry.tp1);
          if (![e, s, t].every(Number.isFinite) || Math.abs(e - s) <= 0) return null;
          return "1:" + (Math.abs(t - e) / Math.abs(e - s)).toFixed(2);
        })(),
        candleTimestamp: candleTs, // OPEN identity — unchanged for dedup/keys
        candleTimeISO: entry.candleTimeISO || null, // OPEN ISO from Worker
        // Display times = CLOSE (open + TF seconds); not wall-clock, not open
        timestamp: (function () {
          const disp = this._signalDisplayClose(candleTs, tf);
          return disp ? disp.iso : (entry.timestamp || entry.candleTimeISO || null);
        }).call(this),
        time: (function () {
          const disp = this._signalDisplayClose(candleTs, tf);
          return disp ? disp.timeFa : (entry.timestamp || entry.candleTimeISO || null);
        }).call(this),
        signalDisplayCloseISO: (function () {
          const disp = this._signalDisplayClose(candleTs, tf);
          return disp ? disp.iso : null;
        }).call(this),
        tf: tf,
        hydratedFromWorker: true,
        source: "worker-journal",
        _workerCandleKey: this._normalizeCandleKey(entry.symbol, tf, entry.candleTimestamp)
      };

      this.lastResult = result;
      this._lastHydratedCandleTs = candleTs;
      try { window.GoldAI_V1_Result = result; } catch (_) {}
      this.render(result);
      // Keep AutoSignal dedup key aligned with displayed Worker candle
      try {
        if (result._workerCandleKey && window.GoldAI_AutoSignal
            && typeof window.GoldAI_AutoSignal.markCandleEvaluated === "function") {
          window.GoldAI_AutoSignal.markCandleEvaluated(result._workerCandleKey);
        }
      } catch (_) {}
      return true;
    } catch (e) {
      console.warn("hydrateFromWorkerLatest failed:", e && e.message);
      return false;
    }
  },

  /**
   * Poll Worker latest and render when candleTimestamp changes.
   * SYSTEM OFF still shows signals (orders remain blocked server-side).
   * Never calls analyze(). Single interval, no concurrent fetches.
   */
  startWorkerSignalPolling() {
    if (this._workerPollTimer) return; // prevent duplicate intervals
    const intervalMs = 5000; // UI pickup ≤5s after Worker writes; Worker itself ≤15s post-close
    this._workerPollTimer = setInterval(() => {
      this.pollWorkerSignalLatest();
    }, intervalMs);
  },

  stopWorkerSignalPolling() {
    if (this._workerPollTimer) {
      clearInterval(this._workerPollTimer);
      this._workerPollTimer = null;
    }
  },

  async pollWorkerSignalLatest() {
    if (this._workerPollBusy) return;
    this._workerPollBusy = true;
    try {
      await this.hydrateFromWorkerLatest({ onlyIfNewer: true });
    } catch (e) {
      try { console.warn("worker poll failed:", e && e.message); } catch (_) {}
    } finally {
      this._workerPollBusy = false;
    }
  },

  /** Empty / pre-analysis UI — avoid implying conf=0 is a real engine result */
  renderNoAnalysisYet() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("signal", "NO ANALYSIS");
    set("confidence", "—");
    set("signalStrengthText", "—");
    set("signalStrengthPercentText", "—");
    set("semEdge", "—");
    set("semQuality", "—");
    set("semPermission", "—");
    set("semReject", "—");
    set("semHtf", "—");
    set("semSeed", "—");
    set("semRegime", "—");
    const tag = document.getElementById("signalStrengthTag");
    if (tag) { tag.className = "strength-tag weak"; tag.textContent = "Waiting"; }
    const ar = document.getElementById("aiReason");
    if (ar) ar.textContent = "Waiting for live signal — open Analyze or wait for Worker hydrate";
  },

  async analyze() {
    const btn = document.getElementById("analyzeBtn");
    const status = document.getElementById("aiStatus");
    if (btn) btn.disabled = true;
    if (status) status.textContent = "🟡 Analyzing...";

    try {
      const open = this.isMarketOpen();
      if (!open) console.warn("⚠️ Market is closed, signal for educational purposes only");

      const data = window.GoldAI_Data;
      const cfg = window.GoldAI_Config;
      await data.loadAll();
      data.seedDemo(); // no-op for any timeframe that already has real MT5/backend candles
      this.updatePriceUI();

      // Real MT5 broker specs (tick size/value, contract size, volume step) for lot sizing.
      // Previously only the backtest engine fetched these — the live/manual trade plan
      // fell back to an approximate multiplier because cfg.SYMBOL_SPECS was never
      // populated here, so the executed lot could drift from a broker-correct value.
      // Cached per-symbol, refreshed at most every 5 minutes (these rarely change).
      const specsStale = !cfg.SYMBOL_SPECS || cfg.__specsSymbol !== cfg.SYMBOL || (Date.now() - (cfg.__specsFetchedAt || 0)) > 5 * 60 * 1000;
      if (specsStale) {
        try {
          const specsRes = await data.fetchMT5SymbolSpecs();
          if (specsRes && specsRes.status === "ok") {
            cfg.SYMBOL_SPECS = specsRes;
            cfg.__specsSymbol = cfg.SYMBOL;
            cfg.__specsFetchedAt = Date.now();
          }
        } catch (_) { /* keep last known specs (or none) — computeRiskLot() falls back safely */ }
      }

      // CENTRAL ACTIVE TIMEFRAME — single source of truth for live analysis,
      // indicators, signal, entry/SL/TP, trade plan, AND Backtest (see
      // setActiveTimeframe() / the header dropdown). Bias/micro layers are
      // derived from it (same pipeline, same scoring — only the candle
      // series changes): intraday timeframes bias off H1 with an M1 micro
      // read; H1/H4 bias off Daily with an M15 micro read (same pairing the
      // old scalp/swing modes already used).
      const activeTF = ["m1", "m5", "m15", "m30", "h1", "h4"].includes(String(cfg.ACTIVE_TIMEFRAME || "").toLowerCase())
        ? String(cfg.ACTIVE_TIMEFRAME).toLowerCase() : "m5";
      const isIntraday = ["m1", "m5", "m15", "m30"].includes(activeTF);
      const entryTF = activeTF;
      const biasTF = isIntraday ? "h1" : "daily";
      const scalpTF = isIntraday ? "m1" : "m15";
      cfg.STRATEGY_MODE = isIntraday ? "scalp" : "swing"; // derived, not user-set — kept for any legacy reader

      const closes = data.closes[entryTF];
      const highs = data.highs[entryTF];
      const lows = data.lows[entryTF];
      const vols = data.volumes[entryTF];
      const candles = data.candles[entryTF];

      // Mobile-First patch: keep the Live Chart in sync with the exact candle
      // set the analysis pipeline is using for this run. Display-only.
      if (window.GoldAI_Chart && typeof window.GoldAI_Chart.render === "function") {
        try { window.GoldAI_Chart.render(entryTF, candles); } catch (_) {}
      }

      let price = data.goldPrice || closes[closes.length - 1];
      const manualInput = document.getElementById("manualEntryInput");
      if (manualInput && manualInput.value.trim() !== "") {
        const parsed = Number(manualInput.value);
        if (!isNaN(parsed) && parsed > 0) price = parsed;
      }

      // ========== ONE SIGNAL TRUTH: canonical buildSignal (same as Worker/Backtest) ==========
      // Decision path: closed entry bars → deterministic HTF resample → buildSignal
      // AI / Reversal are DISPLAY-ONLY (computed after decision; never mutate final).
      const BT = window.GoldAI_Backtest;
      if (!BT || typeof BT.buildSignal !== "function") {
        throw new Error("GoldAI_Backtest.buildSignal missing — cannot produce canonical signal");
      }
      const TF_SECONDS = BT.TF_SECONDS || { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400, D1: 86400 };
      const entryKey = String(entryTF).toUpperCase();
      const barSeconds = TF_SECONDS[entryKey] || TF_SECONDS.M5 || 300;

      // Build entry bars from closed series (prefer candle objects with time when available)
      const n = closes.length;
      const entryBars = [];
      for (let i = 0; i < n; i++) {
        const c = candles && candles[i] ? candles[i] : null;
        const t = (c && (c.time || c.timestamp))
          ? Number(c.time || c.timestamp)
          : (Math.floor(Date.now() / 1000) - (n - 1 - i) * barSeconds);
        entryBars.push({
          time: t,
          open: c && c.open != null ? Number(c.open) : Number(closes[i]),
          high: c && c.high != null ? Number(c.high) : Number(highs[i]),
          low: c && c.low != null ? Number(c.low) : Number(lows[i]),
          close: Number(closes[i]),
          volume: (vols && vols[i] != null) ? Number(vols[i]) : (c && (c.volume || c.tick_volume) || 0)
        });
      }

      const mode = isIntraday ? "scalp" : "swing";
      const htfBucketSeconds = mode === "swing" ? (TF_SECONDS.H4 || 14400) : (TF_SECONDS.H1 || 3600);
      const htfBars = BT.resample(entryBars, barSeconds, htfBucketSeconds);
      const entrySeries = BT.seriesOf(entryBars);
      const htfSeries = BT.seriesOf(htfBars);

      // Micro: same policy as worker (M1 series when scalp; else entry)
      let microSeries = entrySeries;
      const m1Closes = data.closes[scalpTF] || [];
      const m1Candles = data.candles[scalpTF] || [];
      if (mode === "scalp" && m1Closes.length > 5) {
        const m1Bars = [];
        for (let i = 0; i < m1Closes.length; i++) {
          const c = m1Candles[i] || null;
          const t = (c && (c.time || c.timestamp))
            ? Number(c.time || c.timestamp)
            : (Math.floor(Date.now() / 1000) - (m1Closes.length - 1 - i) * 60);
          m1Bars.push({
            time: t,
            open: c && c.open != null ? Number(c.open) : Number(m1Closes[i]),
            high: c && c.high != null ? Number(c.high) : Number(m1Closes[i]),
            low: c && c.low != null ? Number(c.low) : Number(m1Closes[i]),
            close: Number(m1Closes[i]),
            volume: (c && (c.volume || c.tick_volume)) || 0
          });
        }
        microSeries = BT.seriesOf(m1Bars);
      }

      // Align GoldAI_Data.dataMode with permission layer (no extra frontend decision mutation)
      if (window.GoldAI_Data) {
        window.GoldAI_Data.dataMode = (data.dataMode || "demo").toLowerCase();
      }

      const built = BT.buildSignal(
        {
          closes: entrySeries.closes,
          highs: entrySeries.highs,
          lows: entrySeries.lows,
          volumes: entrySeries.volumes,
          candles: entrySeries.candles
        },
        {
          closes: htfSeries.closes,
          highs: htfSeries.highs,
          lows: htfSeries.lows
        },
        { closes: microSeries.closes },
        cfg,
        price
      );

      let final = built.final;
      const atrVal = built.atr;
      const structure = built.structure;
      const layers = built.layers || {};
      if (atrVal) window.GoldAI_LastATR = atrVal;

      // DISPLAY-ONLY metadata (must not mutate final.signal / confidence / permission)
      let reversalMeta = { signal: "NONE", strength: 0, type: "" };
      try {
        const rsiHist = layers.rsi && layers.rsi.history ? layers.rsi.history : [];
        reversalMeta = this.detectReversal(closes, rsiHist) || reversalMeta;
      } catch (_) {}
      let aiMeta = null;
      try {
        if (window.GoldAI_AIBrain && typeof window.GoldAI_AIBrain.analyze === "function") {
          // Pass a copy so AI cannot attach itself into decision layers
          const displayLayers = Object.assign({}, layers);
          aiMeta = window.GoldAI_AIBrain.analyze(displayLayers);
        }
      } catch (_) {}
      try {
        if (window.GoldAI_Fundamental) {
          layers.displayFundamental = window.GoldAI_Fundamental.analyzeFundamentals(cfg);
        }
        if (window.GoldAI_Correlation) {
          layers.displayCorrelation = window.GoldAI_Correlation.analyzeCorrelation(closes, price);
        }
      } catch (_) {}

      const userLot = cfg.USER_LOT || 0;
      const plan = window.GoldAI_Trade.createTradePlan(
        final.signal, price, atrVal, data.getCapital(),
        cfg.DEFAULT_RISK_PERCENT, cfg, cfg.SYMBOL_SPECS, structure
      );
      if (userLot > 0) plan.lot = userLot;

      const now = new Date();
      const result = {
        ...final, ...plan, price, layers,
        // Explicit semantic fields (plan must not wipe diagnostics from final)
        directionalEdge: final.directionalEdge != null ? final.directionalEdge
          : (final.diagnostics && final.diagnostics.directionalEdge),
        primaryReject: final.primaryReject || (final.diagnostics && (final.diagnostics.primaryRejectFinal || final.diagnostics.primaryReject)) || null,
        diagnostics: final.diagnostics || null,
        entryQuality: final.entryQuality,
        // Display signal time = last closed candle CLOSE (open+TF), not wall-clock
        time: (function () {
          let openSec = null;
          try {
            if (typeof entryBars !== "undefined" && entryBars && entryBars.length) {
              openSec = Number(entryBars[entryBars.length - 1].time);
            } else if (candles && candles.length && candles[candles.length - 1].time) {
              openSec = Number(candles[candles.length - 1].time);
            }
          } catch (_) {}
          const disp = openSec ? this._signalDisplayClose(openSec, entryTF) : null;
          return disp ? disp.timeFa : now.toLocaleString("fa-IR");
        }).call(this),
        timestamp: (function () {
          let openSec = null;
          try {
            if (typeof entryBars !== "undefined" && entryBars && entryBars.length) {
              openSec = Number(entryBars[entryBars.length - 1].time);
            } else if (candles && candles.length && candles[candles.length - 1].time) {
              openSec = Number(candles[candles.length - 1].time);
            }
          } catch (_) {}
          const disp = openSec ? this._signalDisplayClose(openSec, entryTF) : null;
          return disp ? disp.iso : now.toISOString();
        }).call(this),
        candleTimestamp: (function () {
          try {
            if (typeof entryBars !== "undefined" && entryBars && entryBars.length) {
              return Number(entryBars[entryBars.length - 1].time);
            }
            if (candles && candles.length && candles[candles.length - 1].time) {
              return Number(candles[candles.length - 1].time);
            }
          } catch (_) {}
          return null;
        })(),
        tf: entryTF.toUpperCase(),
        // Display-only fields — do not use for trading decisions
        reversal: reversalMeta.signal,
        reversalMeta: reversalMeta,
        aiMeta: aiMeta,
        htfSource: "resample:entry→" + (mode === "swing" ? "H4" : "H1"),
        canonicalPath: "GoldAI_Backtest.buildSignal"
      };

      result.warnings = result.warnings || [];
      if (!open && result.signal && !result.signal.includes("WAIT")) {
        result.warnings.push("⛔ بازار بسته است - این سیگنال فقط جنبه آموزشی دارد");
      }
      const dMode = (data.dataMode || "demo").toLowerCase();
      if (dMode === "demo") {
        result.warnings.push("⚠️ داده Demo (ساختگی) — سیگنال قابل معامله نیست");
        // Permission already enforces DATA_MODE WAIT when STRICT_DATA_MODE; UI warning only here
      } else if (dMode === "mixed") {
        result.warnings.push("⚠️ داده Mixed (قیمت زنده + کندل ساختگی) — با احتیاط استفاده شود");
      }

      this.lastResult = result;
      window.GoldAI_V1_Result = result;
      this.render(result);
      this.updateExecutionPanel(result);
      this.saveHistory(result);
      this.updateRiskUI();

      if (result.signal && !result.signal.includes('WAIT') && result.confidence >= 90) {
        this.sendNotification(`🥇 ${result.signal}`, `ورود: ${result.entry} | SL: ${result.stopLoss} | TP1: ${result.tp1}`);
      }

      this.sendToBackend(result);
      if (status) status.textContent = "🟢 Done";
    } catch (e) {
      console.error(e);
      if (status) status.textContent = "🔴 Error";
      alert("خطا: " + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  },


  /** Map engine reject codes to short UI labels (display only — does not change gates). */
  semanticRejectLabel(code) {
    const c = String(code || "").toUpperCase();
    const map = {
      LOW_CONFIDENCE: "Permission: quality conf below floor (not weak edge)",
      LOW_EDGE: "Directional edge too weak",
      HTF_WEAK: "Quality: HTF context weak",
      HTF_AGAINST: "Quality: against HTF trend",
      REGIME_RANGE: "Quality: range regime block",
      RISK_GUARD: "Permission: risk guard",
      DATA_MODE: "Permission: data mode",
      DATA_DEMO: "Permission: demo data",
      DATA_OFFLINE: "Permission: offline",
      SIGNAL_DEDUP: "Permission: signal dedup cooldown",
      SCORE_NO_EDGE: "Score: no directional edge"
    };
    return map[c] || (c ? c : "—");
  },

  /** Display-only Persian translation of engine messages (engine text itself is unchanged). */
  faMessage(msg) {
    const s = String(msg == null ? "" : msg);
    const rules = [
      [/^Against HTF trend — entry blocked$/, "خلاف روند تایم بالاتر — ورود مسدود شد"],
      [/^SELL into extreme OS RSI$/, "فروش در منطقه‌ی فروش شدید (RSI خیلی پایین) — اطمینان کم شد"],
      [/^BUY into extreme OB RSI$/, "خرید در منطقه‌ی خرید شدید (RSI خیلی بالا) — اطمینان کم شد"],
      [/^HTF weak\/unknown — confidence reduced \(not blocked\)$/, "روند تایم بالاتر ضعیف یا نامشخص — اطمینان کم شد"],
      [/^Range regime — entry blocked on scalp TF without strong BOS$/, "بازار رنج است — ورود اسکلپ بدون شکست قوی مسدود شد"],
      [/^Range regime — reduced confidence$/, "بازار رنج است — اطمینان کم شد"],
      [/^Range break with strong BOS$/, "شکست قوی از محدوده‌ی رنج"],
      [/^Weak BOS — structure quality reduced \(soft\)$/, "شکست ساختار ضعیف — اطمینان کم شد"],
      [/^No clear directional edge$/, "جهت مشخصی وجود ندارد"],
      [/^Conflicting \/ weak edge$/, "نشانه‌ها متضاد یا ضعیف‌اند"],
      [/^Signal cooldown \((\d+) candles same direction\) — order blocked, direction unchanged$/, "سیگنال هم‌جهت تکراری (فاصله‌ی $1 کندل) — سفارش ارسال نشد"],
      [/^Signal cooldown \((\d+)m same direction\) — order blocked, direction unchanged$/, "سیگنال هم‌جهت تکراری ($1 دقیقه) — سفارش ارسال نشد"],
      [/^Same-direction idea still open \(SL\/TP not hit\) — first signal of the move only$/, "ایده‌ی هم‌جهت قبلی هنوز باز است — سفارش ارسال نشد"],
      [/^Confidence (\d+) < (\d+)$/, "اطمینان $1 کمتر از حداقل $2 است"],
      [/^BUY vs EMA bearish$/, "خرید خلاف روند نزولی میانگین‌ها"],
      [/^SELL vs EMA bullish$/, "فروش خلاف روند صعودی میانگین‌ها"],
      [/^BUY vs bearish structure$/, "خرید خلاف ساختار نزولی"],
      [/^SELL vs bullish structure$/, "فروش خلاف ساختار صعودی"],
      [/^CHoCH — regime shift$/, "تغییر ساختار بازار (CHoCH)"],
      [/^EMA confirms BUY$/, "میانگین‌ها خرید را تأیید می‌کنند"],
      [/^EMA confirms SELL$/, "میانگین‌ها فروش را تأیید می‌کنند"],
      [/^BOS active$/, "شکست ساختار فعال است"],
      [/^HTF strength confirms$/, "روند تایم بالاتر تأیید می‌کند"],
      [/^Price ([\d.]+) ATR from EMA20 — late entry \(-(\d+)\)$/, "قیمت $1 برابر نوسان از میانگین ۲۰ دور است — ورود دیر (اطمینان −$2)"],
      [/^MT5 OFFLINE → forced WAIT \(price is not live\)$/, "متاتریدر قطع است — صبر اجباری"],
      [/^DEMO data → forced WAIT \(not tradable\)$/, "داده‌ی نمایشی — صبر اجباری"],
      [/^MIXED data \(live price \+ synthetic candles\) — reduced confidence$/, "داده‌ی ترکیبی — اطمینان کم شد"],
      [/^Risk Guard: (.*)$/, "محافظ ریسک: $1"]
    ];
    for (const [re, fa] of rules) { if (re.test(s)) return s.replace(re, fa); }
    return s;
  },

  /** Shows what actually happened with the latest worker signal (display only). */
  renderExecutionStatus(r) {
    const el = document.getElementById("signalExecStatus");
    if (!el) return;
    const st = r && r.executionStatus ? String(r.executionStatus) : "";
    const sig = r && r.signal ? String(r.signal) : "";
    const isWait = !sig || sig.includes("WAIT");
    const rej = r && r.primaryReject ? String(r.primaryReject) : "";
    const rejFa = {
      HTF_AGAINST: "خلاف روند تایم بالاتر", REGIME_RANGE: "بازار رنج است", LOW_EDGE: "جهت مشخصی وجود ندارد",
      LOW_CONFIDENCE: "اطمینان کمتر از حداقل", SIGNAL_DEDUP: "سیگنال هم‌جهت تکراری (فاصله‌ی چند کندل)",
      SIGNAL_CLUSTER: "سیگنال هم‌جهت تکراری", RISK_GUARD: "محافظ ریسک", DATA_MODE: "داده زنده نیست"
    };
    const map = {
      EXECUTED: ["✅ معامله در متاتریدر اجرا شد", "ok"],
      SKIPPED_SYSTEM_OFF: ["سیستم خاموش است — سفارشی ارسال نشد", "off"],
      SKIPPED_MODE_NOT_AUTO: ["حالت دستی است — سفارش خودکار ارسال نمی‌شود", "off"],
      SKIPPED_AUTO_TRADING_OFF: ["ارسال خودکار سفارش خاموش است", "off"],
      SKIPPED_CONFIDENCE_LOW: ["اجرا نشد: اطمینان کمتر از حداقل تنظیم‌شده", "blocked"],
      SKIPPED_RR_BELOW_MIN: ["اجرا نشد: نسبت سود به ضرر کمتر از ۱ به ۱ بود", "blocked"],
      SKIPPED_NO_LIVE_PRICE: ["اجرا نشد: قیمت لحظه‌ای در دسترس نبود", "blocked"],
      SKIPPED_NO_PLAN: ["اجرا نشد: محاسبه‌ی حد ضرر و حد سود ممکن نبود", "blocked"],
      RISK_BLOCKED: ["اجرا نشد: سقف ضرر روزانه پر شده است", "blocked"],
      STALE_CANDLE_REJECTED: ["اجرا نشد: کندل قبل از روشن شدن سیستم بسته شده بود", "blocked"],
      AUTH_FAILED: ["اجرا نشد: رمز دسترسی ورکر پذیرفته نشد", "blocked"],
      REJECTED_DUPLICATE: ["برای این کندل قبلاً سفارش ثبت شده است", "off"],
      CONFIDENCE_LOW: ["اجرا نشد: اطمینان کمتر از حداقل سرور", "blocked"],
      MODE_NOT_AUTO: ["سرور در حالت دستی است — سفارش ارسال نشد", "off"],
      AUTO_TRADING_OFF: ["ارسال خودکار در سرور خاموش است", "off"],
      SYSTEM_OFF: ["سیستم در سرور خاموش است", "off"]
    };
    let text = "", cls = "off";
    if (!st) {
      text = ""; // older records have no status
    } else if (st === "SKIPPED_WAIT_OR_INVALID") {
      if (isWait) { text = "صبر" + (rejFa[rej] ? " — " + rejFa[rej] : ""); cls = "off"; }
      else { text = "اجرا نشد" + (rejFa[rej] ? ": " + rejFa[rej] : ""); cls = "blocked"; }
    } else if (map[st]) {
      text = map[st][0]; cls = map[st][1];
    } else {
      text = "وضعیت اجرا: " + st; cls = "blocked";
    }
    el.textContent = text;
    el.className = "signal-exec-status" + (text ? " " + cls : " hidden");
  },

  render(r) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const decs = this.getDecimals();
    const fmt = (num) => (num == null || isNaN(num) ? "—" : num.toFixed(decs));
    set("signal", r.signal);
    set("confidence", (r.confidence || 0) + "%");
    set("entry", fmt(r.entry));
    set("sl", fmt(r.stopLoss));

    const tpCount = window.GoldAI_Config.TP_COUNT || 3;
    let detailsHtml = `<div class="detail-item"><span>ورود</span><b>${fmt(r.entry)}</b></div><div class="detail-item"><span>SL</span><b>${fmt(r.stopLoss)}</b></div><div class="detail-item"><span>TP1</span><b>${fmt(r.tp1)}</b></div>`;
    // 2026-10-07: TP2/TP3 are manual-only — shown in Settings (gear), not on the dashboard card.
    detailsHtml += `<div class="detail-item"><span>R:R</span><b>${r.riskReward || "—"}</b></div>`;
    const sd = document.getElementById('signalDetails');
    if (sd) sd.innerHTML = detailsHtml;

    const isBuy = !!(r.signal && r.signal.includes("BUY"));
    const isSell = !!(r.signal && r.signal.includes("SELL"));
    const strength = Math.min(100, Math.max(0, r.confidence || 0));

    // Semicircular gauge (قدرت سیگنال). UI-presentation change only: was a
    // full-circle SVG <circle>, now a half-circle SVG <path> (radius 50) per
    // the reference design. strength/color/glow logic below is unchanged —
    // only the dash-length constant changes, from a full circumference
    // (2·π·r) to a half circumference (π·r), matching the new arc's length.
    const gaugeFill = document.getElementById("signalGaugeFill");
    const gaugeText = document.getElementById("signalStrengthText");
    if (gaugeFill) {
      const halfCircumference = Math.PI * 50; // radius 50 arc — unchanged geometry
      gaugeFill.style.strokeDasharray = halfCircumference;
      gaugeFill.style.strokeDashoffset = halfCircumference * (1 - strength / 100);
      const gaugeColor = strength >= 75 ? (isBuy ? "var(--green)" : isSell ? "var(--red)" : "var(--gold-soft)") : strength >= 55 ? "var(--yellow)" : "var(--text-faint)";
      gaugeFill.style.stroke = gaugeColor;
      // Subtle glow only for a strong, actionable signal — kept small so it reads as premium, not neon.
      gaugeFill.style.filter = (strength >= 75 && (isBuy || isSell)) ? `drop-shadow(0 0 6px ${gaugeColor})` : "none";
      // Tip indicator at arc end (presentation only; center 70,72 matches SVG viewBox)
      const tip = document.getElementById("signalGaugeTip");
      if (tip) {
        const t = Math.max(0, Math.min(1, strength / 100));
        const angle = Math.PI * (1 - t); // PI → 0 left-to-right along upper semicircle
        tip.setAttribute("cx", String(70 + 50 * Math.cos(angle)));
        tip.setAttribute("cy", String(72 - 50 * Math.sin(angle)));
        tip.setAttribute("opacity", t > 0.02 ? "1" : "0");
        tip.style.fill = gaugeColor;
        tip.style.filter = (strength >= 75 && (isBuy || isSell)) ? `drop-shadow(0 0 3px ${gaugeColor})` : "none";
      }
    }
    if (gaugeText) gaugeText.textContent = strength + "%";
    const strengthPctText = document.getElementById("signalStrengthPercentText");
    if (strengthPctText) strengthPctText.textContent = strength + "%";

    // Setup-quality tag (NOT "directional edge strength")
    const tagEl = document.getElementById("signalStrengthTag");
    if (tagEl) {
      const edgeN = Number(r.directionalEdge != null ? r.directionalEdge : (r.diagnostics && r.diagnostics.directionalEdge));
      const highEdge = !isNaN(edgeN) && edgeN >= 9;
      if (!isBuy && !isSell) {
        tagEl.className = "strength-tag weak";
        // Distinguish blocked/waiting from weak direction
        if (highEdge && r.primaryReject) {
          tagEl.textContent = "Blocked";
        } else if (highEdge) {
          tagEl.textContent = "Context";
        } else {
          tagEl.textContent = "—";
        }
      } else if (strength >= 75) {
        tagEl.className = "strength-tag strong" + (isBuy ? " buy-tag" : "");
        tagEl.textContent = "قوی";
      } else if (strength >= 55) {
        tagEl.className = "strength-tag medium";
        tagEl.textContent = "متوسط";
      } else {
        tagEl.className = "strength-tag weak";
        tagEl.textContent = highEdge ? "Quality" : "ضعیف";
      }
    }

    // Semantic panel: Edge / Quality / Permission / HTF / Reject (display-only)
    // Parentheses required: (a) || (b) — avoid a || b && c precedence bugs.
    {
      const setSem = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (v == null || v === "") ? "—" : String(v);
      };
      try {
        const d = (r && r.diagnostics) ? r.diagnostics : {};
        const dLayers = (d && d.layers) ? d.layers : {};
        const rLayers = (r && r.layers) ? r.layers : {};
        let edgeVal = null;
        if (r && r.directionalEdge != null && r.directionalEdge !== "") edgeVal = r.directionalEdge;
        else if (d.directionalEdge != null && d.directionalEdge !== "") edgeVal = d.directionalEdge;
        const seedVal = (d.confidenceSeed != null) ? d.confidenceSeed : null;
        let qualVal = null;
        if (d.confidenceAfterQuality != null) qualVal = d.confidenceAfterQuality;
        else if (d.confidenceFinal != null) qualVal = d.confidenceFinal;
        else if (r && r.confidence != null) qualVal = r.confidence;
        const rej = (r && r.primaryReject) || d.primaryRejectFinal || d.primaryReject || null;
        const htf = (rLayers.htf) || (dLayers.htf) || null;
        let htfAlign = "";
        if (htf && window.GoldAI_HtfContext && typeof window.GoldAI_HtfContext.htfAlignmentState === "function" && r && r.signal) {
          try { htfAlign = window.GoldAI_HtfContext.htfAlignmentState(htf, r.signal) || ""; } catch (_) { htfAlign = ""; }
        }
        const htfStr = htf
          ? (String(htf.trend || "—") + " / " + String(htf.strength || "—") + (htfAlign ? (" · align " + htfAlign) : ""))
          : "—";
        const regime = rLayers.regime
          || (rLayers.marketRegime && rLayers.marketRegime.regime)
          || dLayers.regime
          || "—";
        // Trade Permission must NOT be inferred from BUY/SELL alone.
        // Prefer canonical executionEligible from Worker/result when present.
        let perm = "UNKNOWN";
        if (r && typeof r.executionEligible === "boolean") {
          perm = r.executionEligible ? "ALLOWED" : "BLOCKED";
        } else if (r && r.executionStatus != null && String(r.executionStatus).toUpperCase() === "NOT_EXECUTED"
                   && r.hydratedFromWorker) {
          // Worker journal always sets executionEligible; if missing status only, stay UNKNOWN
          perm = "UNKNOWN";
        } else if (rej) {
          // Reject reason exists but no explicit eligibility flag → show blocked context without inventing ALLOWED
          perm = "BLOCKED";
        } else {
          perm = "UNKNOWN";
        }
        const edgeText = (edgeVal != null && edgeVal !== "" && !isNaN(Number(edgeVal))) ? Number(edgeVal).toFixed(1) : "—";
        const qualityText = (qualVal != null && !isNaN(Number(qualVal))) ? (Number(qualVal) + "%") : "—";
        const seedText = (seedVal != null && !isNaN(Number(seedVal))) ? (Number(seedVal) + "%") : "—";
        const rejectText = this.semanticRejectLabel(rej);
        setSem("edgeValue", edgeText);
        setSem("semEdge", edgeText);
        setSem("qualityValue", qualityText);
        setSem("semQuality", qualityText);
        setSem("permissionValue", perm);
        setSem("semPermission", perm);
        setSem("rejectValue", rejectText);
        setSem("semReject", rejectText);
        setSem("htfValue", htfStr);
        setSem("semHtf", htfStr);
        setSem("seedValue", seedText);
        setSem("semSeed", seedText);
        setSem("regimeValue", regime);
        setSem("semRegime", regime);
      } catch (err) {
        try { console.warn("semantic panel render failed", err); } catch (_) {}
      }
    }

    // BUY/SELL icon circle
    const iconEl = document.getElementById("signalIconCircle");
    const arrowEl = document.getElementById("signalArrowIcon");
    if (iconEl) iconEl.className = "signal-icon-circle" + (isBuy ? " buy" : isSell ? " sell" : " wait");
    if (arrowEl) arrowEl.textContent = isBuy ? "↑" : isSell ? "↓" : "•";

    // Meta row: timeframe / date / time — prefer candle CLOSE display fields
    const dtSrc = r.signalDisplayCloseISO || r.timestamp;
    const dt = dtSrc ? new Date(dtSrc) : new Date();
    set("signalMetaTF", "⏱ " + (r.tf || "—"));
    set("signalMetaDate", "📅 " + (isNaN(dt.getTime()) ? "—" : dt.toLocaleDateString("fa-IR")));
    set("signalMetaTime", "🕒 " + (isNaN(dt.getTime()) ? "—" : dt.toLocaleTimeString("fa-IR")));

    // Active/inactive status badge
    const statusEl = document.getElementById("signalActiveStatus");
    if (statusEl) {
      const live = window.GoldAI_Data && window.GoldAI_Data.dataMode === "live";
      statusEl.classList.toggle("inactive", !live);
      const label = statusEl.querySelector("span:last-child");
      if (label) label.textContent = live ? "فعال" : "غیرفعال";
    }

    const sig = document.getElementById("signal");
    if (sig) {
      sig.className = "signal-value";
      if (r.signal && r.signal.includes("BUY")) sig.classList.add("buy");
      else if (r.signal && r.signal.includes("SELL")) sig.classList.add("sell");
      else sig.classList.add("wait");
    }

    const ar = document.getElementById("aiReason");
    if (ar) ar.textContent = r.reason || "—";

    const L = r.layers || {};
    const details = {
      dEma20: L.ema?.ema20, dEma50: L.ema?.ema50, dEma200: L.ema?.ema200,
      dRsi: L.rsi?.rsi, dMacd: L.macd?.hist, dAdx: L.adx?.adx,
      dAtr: L.atr?.atr, dVol: L.volume?.ratio, dReversal: L.reversal?.signal,
      dStruct: L.structure?.structure, dBos: L.structure?.bosDir, dChoch: L.structure?.chochDir,
      dDiv: L.divergence?.type, dLiq: L.liquidity?.sweep, dCandle: L.candles?.pattern
    };
    Object.keys(details).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = details[id] ?? "—";
    });

    const AI = L.aiBrain || {};
    const FUND = L.fundamental || { details: {} };
    const CORR = L.correlation || { details: {} };
    set("dAiSignal", AI.aiSignal ?? "—");
    set("dAiConf", AI.aiConfidence ? AI.aiConfidence + "%" : "—");
    set("dAiCpi", FUND.details?.cpi ?? "—");
    set("dAiNfp", FUND.details?.nfp ?? "—");
    set("dAiFed", FUND.details?.fed ?? "—");
    set("dAiDxy", CORR.details?.dxy ?? "—");
    set("dAiUs10y", CORR.details?.us10y ?? "—");
    set("dAiSilverSpx", `${CORR.details?.silver ?? "—"} | ${CORR.details?.spx ?? "—"}`);
    const reasonEl = document.getElementById("dAiReasoning");
    if (reasonEl) reasonEl.textContent = AI.reasoning || "منتظر تحلیل...";

    // Dashboard indicator-tile mirrors — display duplication only, reading the
    // same already-computed layer values as the Analysis panel above (no new
    // indicators, no changed scoring/thresholds).
    const trendLabel = { BULLISH: "صعودی", BEARISH: "نزولی", NEUTRAL: "خنثی", VOLATILE: "پرنوسان", RANGE: "رنج" };
    set("dashEmaTrend", trendLabel[L.ema?.trend] || L.ema?.trend || "—");
    set("dashRsiValue", L.rsi?.rsi != null ? Number(L.rsi.rsi).toFixed(1) : "—");
    const rsiZoneLabel = { EXTREME_OS: "فروش شدید (زیر ۲۰)", OVERSOLD: "فروش زیاد (زیر ۳۰)", EXTREME_OB: "خرید شدید (بالای ۸۰)",
      OVERBOUGHT: "خرید زیاد (بالای ۷۰)", BULL_MOM: "حرکت صعودی", BEAR_MOM: "حرکت نزولی", NEUTRAL: "خنثی" };
    set("dashRsiZone", L.rsi?.zone ? (rsiZoneLabel[L.rsi.zone] || L.rsi.zone) : "—");
    set("dashAtrValue", L.atr?.atr != null ? Number(L.atr.atr).toFixed(2) : "—");
    const volLabel = { LOW: "کم", MEDIUM: "متوسط", HIGH: "زیاد" };
    set("dashAtrZone", "شدت نوسان: " + (volLabel[L.atr?.volatility] || L.atr?.volatility || "—"));
    const structTrendLabel = { BULLISH: "روند صعودی", BEARISH: "روند نزولی", VOLATILE: "پرنوسان", RANGE: "رنج", UNKNOWN: "نامشخص" };
    set("dashStructValue", structTrendLabel[L.structure?.trend] || L.structure?.trend || "—");
    const hasConflictWarning = (r.warnings || []).some(w => /vs EMA|vs bearish|vs bullish|vs structure|opposite|HTF trend|CHoCH/i.test(String(w)));
    set("dashConflictValue", hasConflictWarning ? "تضاد دارد" : "بدون تضاد");
    this.renderExecutionStatus(r);
    // Read-only mirror of the exact same r.lot the execution panel's #execLot
    // uses (see updateExecutionPanel) — not a second computation.
    set("dashSuggestedLot", r.lot != null && r.lot !== "" ? r.lot : "—");

    const warnBox = document.getElementById("warnings");
    const cText = (r.confirms || []).map(x => `✅ ${this.faMessage(x)}`).join("<br>");
    const wText = (r.warnings || []).map(x => `⚠️ ${this.faMessage(x)}`).join("<br>");
    if (warnBox) warnBox.innerHTML = (cText ? cText + "<br>" : "") + (wText || "");

    const notifContent = document.getElementById("notifDropdownContent");
    if (notifContent) {
      const combined = (cText ? cText + "<br>" : "") + (wText || "");
      notifContent.innerHTML = combined
        ? `<div style="margin-bottom:8px"><b>${r.signal || "—"}</b> · ${dt.toLocaleTimeString("fa-IR")}</div>${combined}`
        : `<span class="notif-empty">هشدار یا تأییدی برای آخرین سیگنال ثبت نشده</span>`;
      const dot = document.getElementById("notifDot");
      if (dot) dot.classList.toggle("hidden", !combined);
    }

    document.getElementById("resultCard")?.classList.remove("hidden");
  },

  updateExecutionPanel(r) {
    // Dashboard MANUAL/AUTO quick-switch buttons — display-only sync, mirrors
    // the execution panel's mode-switch below. Runs regardless of whether a
    // signal is actionable so the buttons reflect TRADE_MODE at rest too.
    const modeNow = (window.GoldAI_Config.TRADE_MODE || "manual").toLowerCase();
    const manualBig = document.getElementById("modeManualBigBtn");
    const autoBig = document.getElementById("modeAutoBigBtn");
    if (manualBig) manualBig.classList.toggle("active", modeNow !== "auto");
    if (autoBig) autoBig.classList.toggle("active", modeNow === "auto");

    const panel = document.getElementById("tradeExecutionPanel");
    if (!panel) return;
    const actionable = r && r.signal && !String(r.signal).includes("WAIT");
    panel.classList.toggle("hidden", !actionable);
    if (!actionable) return;
    const decs = this.getDecimals();
    const fmt = n => (n == null || isNaN(n) ? "" : Number(n).toFixed(decs));
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal("execEntry", fmt(r.entry)); setVal("execSL", fmt(r.stopLoss));
    // execTP feeds the actual order sent to MT5 (TP1) — unchanged execution behavior.
    // execTP2 is display-only context (matches the AI's plan) and is never sent to the backend.
    setVal("execTP", fmt(r.tp1)); setVal("execTP2", fmt(r.tp2)); setVal("execLot", r.lot || "");
    const mode = (window.GoldAI_Config.TRADE_MODE || "manual").toLowerCase();
    const manualBtn = document.getElementById("modeManualBtn");
    const autoBtn = document.getElementById("modeAutoBtn");
    if (manualBtn) manualBtn.classList.toggle("active", mode !== "auto");
    if (autoBtn) autoBtn.classList.toggle("active", mode === "auto");
    const note = document.getElementById("executionModeNote");
    if (note) note.textContent = mode === "auto"
      ? "حالت AUTO: مقادیر AI بدون ویرایش کاربر، پس از کنترل‌های ایمنی ارسال می‌شوند."
      : "حالت MANUAL: مقادیر توسط AI محاسبه شده‌اند و قبل از ارسال قابل ویرایش هستند.";
    const hint = document.getElementById("executionHint");
    if (hint) hint.textContent = mode === "auto"
      ? "در حالت AUTO ویرایش کاربر دخالت ندارد."
      : "در حالت MANUAL امکان ویرایش مقادیر وجود دارد.";
  },

  resetExecutionForm() {
    this.updateExecutionPanel(this.lastResult);
    // Restore SYSTEM ON/OFF from backend after dashboard load
    this.refreshSystemPowerFromServer();
  },

  reflectSystemPowerUI(enabled) {
    const btn = document.getElementById("systemPowerBtn");
    const label = document.getElementById("systemPowerLabel");
    if (!btn || !label) return;
    btn.classList.toggle("on", Boolean(enabled));
    btn.classList.toggle("off", !Boolean(enabled));
    btn.setAttribute("aria-pressed", Boolean(enabled) ? "true" : "false");
    label.textContent = Boolean(enabled) ? "SYSTEM ON" : "SYSTEM OFF";
    // SYSTEM is independent of AUTO_TRADING_ENABLED / autoTradeToggle —
    // never mirror SYSTEM state onto the Auto Trade Signal control.
  },

  async refreshSystemPowerFromServer() {
    try {
      const r = await fetch(`${this.backendURL}/mt5/system-state`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.reflectSystemPowerUI(Boolean(data.enabled));
      // Mirror server trading controls into UI config (server is source of truth)
      if (data.tradeMode) {
        this._serverTradeMode = data.tradeMode === "auto" ? "auto" : "manual";
        window.GoldAI_Config.TRADE_MODE = data.tradeMode === "auto" ? "auto" : "manual";
        // repaint MANUAL/AUTO buttons with the server's mode (was painted before this fetch)
        try { this.updateExecutionPanel(this.lastResult); } catch (_) {}
      }
      if (typeof data.autoTradingEnabled === "boolean") {
        window.GoldAI_Config.AUTO_TRADING_ENABLED = data.autoTradingEnabled;
        const auto = document.getElementById("autoTradeToggle");
        if (auto) auto.checked = data.autoTradingEnabled;
      }
      if (data.activeTimeframe) {
        window.GoldAI_Config.ACTIVE_TIMEFRAME = String(data.activeTimeframe).toLowerCase();
      }
      this.syncAutoTradeSignalVisibility && this.syncAutoTradeSignalVisibility();
      return Boolean(data.enabled);
    } catch (e) {
      console.warn("SYSTEM state read failed:", e.message);
      return null;
    }
  },

  resetBacktest() {
    const box = document.getElementById("backtestSummary");
    const wrap = document.getElementById("backtestJournalWrap");
    const table = document.getElementById("backtestJournal");
    const err = document.getElementById("btRangeError");
    const empty = document.getElementById("backtestEmptyState");
    if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
    if (wrap) wrap.classList.add("hidden");
    if (table) table.innerHTML = "";
    if (err) { err.classList.add("hidden"); err.textContent = ""; }
    if (empty) empty.classList.remove("hidden");
    this._lastBacktestReport = null;
  },

  deleteBacktestResults() {
    if (!confirm("نتایج بک‌تست فعلی حذف شود؟")) return;
    this.resetBacktest();
  },

  async toggleSystemPower() {
    const btn = document.getElementById("systemPowerBtn");
    if (btn) btn.disabled = true;
    try {
      const current = btn?.getAttribute("aria-pressed") === "true";
      const next = !current;
      // SYSTEM ON/OFF only — does NOT touch AUTO_TRADING_ENABLED, TRADE_MODE,
      // or autoTradeToggle. Backend /api/mt5/system-state is the sole authority.
      const res = await fetch(`${this.backendURL}/mt5/system-state`, {
        method: "POST",
        headers: this.apiAuthHeaders(),
        body: JSON.stringify({ enabled: next })
      });
      if (res.status === 401) {
        if (window.GoldAIAuthUI && typeof window.GoldAIAuthUI.reportUnauthorized === "function") {
          window.GoldAIAuthUI.reportUnauthorized("system");
        }
        throw new Error("HTTP 401");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.reflectSystemPowerUI(Boolean(data.enabled));
      if (window.GoldAIAuthUI && typeof window.GoldAIAuthUI.reportOk === "function") {
        window.GoldAIAuthUI.reportOk();
      }
    } catch (e) {
      console.error("SYSTEM power toggle failed:", e);
      await this.refreshSystemPowerFromServer();
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  setAutoTradingEnabled(on) {
    // Auto Trade Signal only — does NOT change SYSTEM.
    // Server trading-state is source of truth for Worker 24/7.
    window.GoldAI_Config.AUTO_TRADING_ENABLED = Boolean(on);
    const stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
    stored.autoTradingEnabled = Boolean(on);
    localStorage.setItem("goldai_settings", JSON.stringify(stored));
    const auto = document.getElementById("autoTradeToggle");
    if (auto) auto.checked = Boolean(on);
    fetch(`${this.backendURL}/mt5/trading-state`, {
      method: "POST",
      headers: this.apiAuthHeaders(),
      body: JSON.stringify({ autoTradingEnabled: Boolean(on) })
    }).then(async (res) => {
      if (res.status === 401 && window.GoldAIAuthUI) {
        window.GoldAIAuthUI.reportUnauthorized("trading");
      }
    }).catch(e => console.warn("trading-state autoTrading sync failed:", e.message));
  },

  setTradeMode(mode) {
    mode = String(mode || "manual").toLowerCase() === "auto" ? "auto" : "manual";
    window.GoldAI_Config.TRADE_MODE = mode;
    const stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
    stored.tradeMode = mode;
    localStorage.setItem("goldai_settings", JSON.stringify(stored));
    this.updateExecutionPanel(this.lastResult);
    this.syncAutoTradeSignalVisibility();
    const prevMode = this._serverTradeMode || null;
    fetch(`${this.backendURL}/mt5/trading-state`, {
      method: "POST",
      headers: this.apiAuthHeaders(),
      body: JSON.stringify({ tradeMode: mode })
    }).then(async (res) => {
      if (res.ok) { this._serverTradeMode = mode; return; }
      // Server did NOT accept the change: show the server's real mode again
      if (res.status === 401 && window.GoldAIAuthUI && typeof window.GoldAIAuthUI.reportUnauthorized === "function") {
        window.GoldAIAuthUI.reportUnauthorized("trading");
      }
      console.warn("trading-state tradeMode rejected by server: HTTP " + res.status);
      try { alert("⛔ تغییر حالت معامله در سرور ثبت نشد" + (res.status === 401 ? " (رمز دسترسی را بررسی کنید)" : "") + ". حالت واقعی سرور دوباره نمایش داده می‌شود."); } catch (_) {}
      await this.refreshSystemPowerFromServer();
    }).catch(e => console.warn("trading-state tradeMode sync failed:", e.message));
  },

  syncAutoTradeSignalVisibility() {
    const row = document.getElementById("autoTradeSignalRow");
    if (!row) return;
    const isAuto = (window.GoldAI_Config.TRADE_MODE || "manual").toLowerCase() === "auto";
    row.classList.toggle("auto-trade-dimmed", !isAuto);
    row.title = isAuto
      ? "در حالت AUTO: در صورت روشن بودن، سیگنال معتبر به‌صورت خودکار ارسال می‌شود (SYSTEM باید ON باشد)."
      : "فقط در حالت AUTO فعال است — در MANUAL سفارش خودکار ارسال نمی‌شود.";
  },

  async executeCurrentTrade(source, autoMeta) {
    // Browser is NOT the Auto executor. Only manual (or explicit non-auto) may use this path.
    if (String(source || "").toLowerCase() === "auto") {
      console.warn("executeCurrentTrade(auto) blocked — Auto orders are Worker/Backend only");
      return { ok: false, status: "BROWSER_AUTO_FORBIDDEN", message: "Auto execution is server-side only (Worker → Backend → Bridge)" };
    }

    const r = this.lastResult;
    if (!r || !r.signal || String(r.signal).includes("WAIT")) {
      if (source !== "auto") alert("ابتدا یک سیگنال BUY/SELL معتبر ایجاد کنید.");
      return { ok: false };
    }
    const cfg = window.GoldAI_Config || {};
    const guard = window.GoldAI_RiskGuard;
    if (guard) {
      const g = guard.canExecute(cfg);
      if (!g.allowed) {
        if (source !== "auto") alert("⛔ معامله مسدود شد: " + (g.reason || "Risk Guard"));
        this.updateRiskUI();
        return { ok: false };
      }
    }
    const num = id => { const el = document.getElementById(id); return el ? Number(el.value) : NaN; };
    const entry = num("execEntry"), sl = num("execSL"), tp1 = num("execTP"), volume = num("execLot");
    if (![entry, sl, tp1, volume].every(Number.isFinite) || entry <= 0 || sl <= 0 || tp1 <= 0 || volume <= 0) {
      if (source !== "auto") alert("مقادیر Entry / SL / TP / Lot معتبر نیستند.");
      return { ok: false };
    }
    const isBuy = String(r.signal).toUpperCase().includes("BUY");
    if ((isBuy && (sl >= entry || tp1 <= entry)) || (!isBuy && (sl <= entry || tp1 >= entry))) {
      if (source !== "auto") alert("⛔ برای جهت معامله، SL و TP در سمت صحیح قیمت قرار ندارند.");
      return { ok: false };
    }
    const payload = {
      signal: isBuy ? "BUY" : "SELL", symbol: cfg.SYMBOL || "XAUUSD.",
      entry, sl, tp1, volume, mode: source === "auto" ? "auto" : "manual",
      clientOrderId: "GA-" + Date.now() + "-" + Math.random().toString(36).slice(2,8),
      deviation: Number(cfg.EXECUTION_DEVIATION_POINTS || 20),
      // Required by the backend's SYSTEM-ON staleness check and per-candle
      // execution claim (auto only — manual trades are exempt, see
      // backend/routes/mt5.js). Omitted entirely for manual trades.
      ...(source === "auto" && autoMeta ? {
        candleCloseTime: autoMeta.candleCloseTime,
        timeframe: autoMeta.timeframe
      } : {})
    };
    try {
      const res = await fetch(`${this.backendURL}/mt5/send-signal`, {
        method: "POST", headers: this.apiAuthHeaders(), body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || data.status !== "FILLED") throw new Error(data.message || data.details?.message || "MT5 order was not filled");
      if (guard) guard.recordTradeExecuted();
      this.updateRiskUI();
      if (source !== "auto") alert(`✅ معامله انجام شد\n${payload.signal} ${payload.symbol}\nLot: ${payload.volume}\nTicket: ${data.details?.order ?? "—"}`);
      return { ok: true, data };
    } catch (e) {
      console.error("Trade execution error:", e);
      if (source !== "auto") alert("❌ معامله اجرا نشد: " + e.message);
      return { ok: false, error: e };
    }
  },

  saveHistory(r) {
    const key = "goldai_history";
    let h = [];
    try { h = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) {}
    h.unshift({
      t: r.time, symbol: window.GoldAI_Config.SYMBOL || "XAU/USD",
      signal: r.signal, entry: r.entry, sl: r.stopLoss,
      tp1: r.tp1, tp2: r.tp2, tp3: r.tp3, conf: r.confidence,
      timestamp: r.timestamp, correct: null, engine: 'combined'
    });
    h = h.slice(0, 100);
    localStorage.setItem(key, JSON.stringify(h));
    this.signalHistory = h.slice(0, 50);
    this.updateRiskUI();
  },

  getDecimals() {
    const sym = (window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();
    if (sym.includes("JPY")) return 3;
    if (sym.includes("XAU") || sym.includes("GOLD")) return 2;
    return 5;
  },

  loadSettings() {
    try {
      const stored = localStorage.getItem('goldai_settings');
      if (stored) {
        const p = JSON.parse(stored);
        if (p.capital) window.GoldAI_Data.setCapital(p.capital);
        if (p.risk) window.GoldAI_Config.DEFAULT_RISK_PERCENT = p.risk;
        if (p.uid) this.currentUID = p.uid;
        if (p.tpCount) window.GoldAI_Config.TP_COUNT = p.tpCount;
        if (p.symbol) window.GoldAI_Config.SYMBOL = p.symbol;
        if (p.slMult) window.GoldAI_Config.ATR_SL_MULT = p.slMult;
        if (p.tp1Mult) window.GoldAI_Config.ATR_TP1_MULT = p.tp1Mult;
        if (p.tp2Mult) window.GoldAI_Config.ATR_TP2_MULT = p.tp2Mult;
        if (p.tp3Mult) window.GoldAI_Config.ATR_TP3_MULT = p.tp3Mult;
        if (p.userLot) window.GoldAI_Config.USER_LOT = p.userLot;
        if (p.activeTimeframe) window.GoldAI_Config.ACTIVE_TIMEFRAME = p.activeTimeframe;
         if (p.tradeMode) window.GoldAI_Config.TRADE_MODE = p.tradeMode;
         if (typeof p.autoTradingEnabled === 'boolean') window.GoldAI_Config.AUTO_TRADING_ENABLED = p.autoTradingEnabled;
        const el = (id) => document.getElementById(id);
        if (el('advCapital')) el('advCapital').value = p.capital || 10000;
         if (el('autoTradeToggle')) el('autoTradeToggle').checked = !!p.autoTradingEnabled;
        this.syncAutoTradeSignalVisibility();
        if (el('advRisk')) el('advRisk').value = p.risk || 1;
        if (el('userTpCount')) el('userTpCount').value = p.tpCount || 3;
        if (el('userSlMult')) el('userSlMult').value = p.slMult || 1.5;
        if (el('userTp1Mult')) el('userTp1Mult').value = p.tp1Mult || 2.0;
        if (el('userTp2Mult')) el('userTp2Mult').value = p.tp2Mult || 3.5;
        if (el('userTp3Mult')) el('userTp3Mult').value = p.tp3Mult || 5.0;
        if (el('userLot')) el('userLot').value = p.userLot || 0;
      }
      const symbolEl = document.getElementById("symbolSelect");
      if (symbolEl) {
        symbolEl.value = window.GoldAI_Config.SYMBOL || "XAU/USD";
        if (symbolEl.selectedIndex < 0) {
          // config holds the broker symbol (e.g. "XAUUSD.") — match it to the option "XAU/USD"
          const norm = (v) => String(v || "").toUpperCase().replace(/[^A-Z]/g, "");
          const want = norm(window.GoldAI_Config.SYMBOL);
          const opt = Array.from(symbolEl.options).find(o => norm(o.value) === want || norm(o.textContent) === want);
          symbolEl.selectedIndex = opt ? opt.index : 0;
        }
      }
      const activeTf = window.GoldAI_Config.ACTIVE_TIMEFRAME || "m5";
      window.GoldAI_Config.STRATEGY_MODE = ["h1", "h4"].includes(activeTf) ? "swing" : "scalp";
      const tfSel = document.getElementById("activeTimeframeSelect");
      if (tfSel) tfSel.value = activeTf;
      const btLabel = document.getElementById("btActiveTfLabel");
      if (btLabel) btLabel.value = activeTf;
      // Mobile-First patch: same sync as setActiveTimeframe(), for correct
      // button/label state on first paint before any click happens.
      document.querySelectorAll(".tf-touch-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.tf === activeTf);
      });
      const chartTfLabel = document.getElementById("chartTfLabel");
      if (chartTfLabel) chartTfLabel.textContent = activeTf.toUpperCase();
      this.updateRiskUI();
    } catch (e) { console.error(e); }
  },

  updatePriceUI() {
    const data = window.GoldAI_Data;
    const price = data.goldPrice;
    const el = document.getElementById("goldPrice");
    if (el) el.textContent = price ? price.toFixed(this.getDecimals()) : "—";

    const badge = document.getElementById("dataModeBadge");
    const badgeText = document.getElementById("dataModeBadgeText");
    if (badge) {
      const mode = (data.dataMode || "demo").toLowerCase();
      badge.className = "live-pill " + (mode === "live" ? "" : mode === "offline" ? "offline" : mode === "mixed" ? "mixed" : "demo");
      if (badgeText) badgeText.textContent = mode === "live" ? "LIVE" : mode === "offline" ? "OFFLINE" : mode === "mixed" ? "MIXED" : "DEMO";
    }

    // Cosmetic change indicator only (vs. this session's first known M5 close) — not used by any trading/signal logic.
    const changeEl = document.getElementById("priceChangeText");
    if (changeEl) {
      const series = data.closes && data.closes.m5;
      const base = series && series.length ? series[0] : null;
      if (price && base && base > 0) {
        const diff = price - base;
        const pct = (diff / base) * 100;
        const decs = this.getDecimals();
        const sign = diff > 0 ? "+" : "";
        changeEl.textContent = `${sign}${diff.toFixed(decs)} (${sign}${pct.toFixed(2)}%)`;
        changeEl.className = "price-change " + (diff > 0 ? "up" : diff < 0 ? "down" : "flat");
      } else {
        changeEl.textContent = "—";
        changeEl.className = "price-change flat";
      }
    }

    const sub = document.getElementById("symbolSub");
    if (sub) {
      const names = {
        "XAU/USD": "Gold / US Dollar", "EUR/USD": "Euro / US Dollar", "GBP/USD": "British Pound / US Dollar",
        "USD/JPY": "US Dollar / Japanese Yen", "AUD/USD": "Australian Dollar / US Dollar",
        "USD/CAD": "US Dollar / Canadian Dollar", "GBP/JPY": "British Pound / Japanese Yen", "EUR/JPY": "Euro / Japanese Yen"
      };
      sub.textContent = names[(window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase()] || "";
    }
  },

  toggleNotificationsPanel() {
    const box = document.getElementById("notifDropdown");
    if (box) box.classList.toggle("hidden");
    const dot = document.getElementById("notifDot");
    if (dot && box && !box.classList.contains("hidden")) dot.classList.add("hidden"); // mark as read on open
  },

  onBacktestRangeChange() {
    const sel = document.getElementById("btRangePreset");
    const wrap = document.getElementById("btCustomRangeWrap");
    if (wrap) wrap.classList.toggle("hidden", !sel || sel.value !== "custom");
    const err = document.getElementById("btRangeError");
    if (err) err.classList.add("hidden");
  },

  setActiveTimeframe(tf) {
    tf = String(tf || "m5").toLowerCase();
    if (!["m1", "m5", "m15", "m30", "h1", "h4"].includes(tf)) tf = "m5";
    window.GoldAI_Config.ACTIVE_TIMEFRAME = tf;
    window.GoldAI_Config.STRATEGY_MODE = ["h1", "h4"].includes(tf) ? "swing" : "scalp"; // derived, informational only
    try {
      const stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
      stored.activeTimeframe = tf;
      delete stored.scalpEntryTf; delete stored.strategy; // superseded by activeTimeframe
      localStorage.setItem("goldai_settings", JSON.stringify(stored));
    } catch (_) {}
    const sel = document.getElementById("activeTimeframeSelect");
    if (sel) sel.value = tf;
    const btLabel = document.getElementById("btActiveTfLabel");
    if (btLabel) btLabel.value = tf;
    // Mobile-First patch: sync the touch-friendly TF buttons + chart label.
    // Same tf value already used above — no new state introduced.
    document.querySelectorAll(".tf-touch-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.tf === tf);
    });
    const chartTfLabel = document.getElementById("chartTfLabel");
    if (chartTfLabel) chartTfLabel.textContent = tf.toUpperCase();
    // Server source of truth for Worker ACTIVE_TIMEFRAME (Auto Trading 24/7)
    fetch(`${this.backendURL}/mt5/trading-state`, {
      method: "POST",
      headers: this.apiAuthHeaders(),
      body: JSON.stringify({ activeTimeframe: tf.toUpperCase() })
    }).catch(e => console.warn("trading-state activeTimeframe sync failed:", e.message));
    this.analyze();
  },

  /**
   * NOTE on lot display: there is still only ONE computed lot value in the
   * app — GoldAI_Trade.createTradePlan()'s plan, stored on lastResult.lot,
   * which feeds the "اجرای معامله" execution panel's Lot field exactly as
   * before. The Dashboard's compact risk strip (below) now also *displays*
   * that same value read-only, via #dashSuggestedLot in render() — this is
   * the current reference layout's explicit 4th field (Capital/Risk/Max
   * Loss/Suggested Lot). It is a read of the existing plan, not a second
   * calculation, so it cannot drift from the execution panel's value.
   */
  /** Reads real MT5 account equity (read-only GET) and shows it in the risk card. */
  async refreshAccountFromServer() {
    try {
      const res = await fetch(`${this.backendURL}/mt5/account-info/dashboard`, { cache: "no-store" });
      if (!res.ok) return;
      const a = await res.json();
      const eq = Number(a && a.equity);
      if (Number.isFinite(eq) && eq > 0) {
        this._accountEquity = eq;
        this.updateRiskUI();
      }
    } catch (_) { /* keep last value */ }
  },

  updateRiskUI() {
    const real = Number(this._accountEquity) > 0;
    const cap = real ? Number(this._accountEquity.toFixed(2)) : window.GoldAI_Data.getCapital();
    const capLbl = document.getElementById("capitalLabel");
    if (capLbl) capLbl.textContent = real ? "موجودی حساب" : "سرمایه (تنظیمات)";
    const risk = window.GoldAI_Config.DEFAULT_RISK_PERCENT;
    const maxLoss = ((cap * risk) / 100).toFixed(2);
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('capitalText', cap);
    set('riskText', risk + "%");
    set('maxLossText', maxLoss);
    set('maxLossTextDash', maxLoss); // dashboard compact-strip mirror of the same value

    // Risk Guard status panel
    try {
      if (window.GoldAI_RiskGuard) {
        const st = window.GoldAI_RiskGuard.getStatus(window.GoldAI_Config);
        const maxT = st.maxTrades || 5;
        const trades = st.trades || 0;
        const dailyLimit = st.dailyLossLimitPct || 3;
        const realizedR = st.realizedR != null ? st.realizedR : 0;
        set('rgTrades', trades + ' / ' + maxT);
        set('rgDailyLimit', dailyLimit + 'R');
        set('rgRealizedRValue', realizedR);

        // Progress bar = how much of today's loss budget has been used (0–100%).
        const usedPct = Math.min(100, Math.max(0, (Math.abs(Math.min(0, realizedR)) / dailyLimit) * 100));
        const bar = document.getElementById('riskProgressBar');
        if (bar) {
          bar.style.width = usedPct + '%';
          bar.style.background = usedPct >= 100 ? 'var(--red)' : usedPct >= 70 ? 'var(--yellow)' : 'var(--green)';
        }

        const badge = document.getElementById('riskGuardBadge');
        const hintEl = document.getElementById('rgStatusHint');
        if (!st.allowed) {
          if (badge) { badge.className = 'rg-badge rg-blocked'; badge.textContent = '🔴 مسدود'; }
          if (hintEl) hintEl.title = 'مسدود: ' + (st.reason || 'Risk Guard');
        } else {
          if (badge) { badge.className = 'rg-badge rg-ok'; badge.textContent = '🛡️ ریسک فعال'; }
          if (hintEl) hintEl.title = 'Risk Guard فعال — آماده صدور سیگنال جدید';
        }
      }
    } catch (_) {}
  },

  resetRiskGuard() {
    if (!window.GoldAI_RiskGuard) return alert('Risk Guard لود نشده');
    if (!confirm('شمارنده معاملات و R امروز ریست شود؟')) return;
    window.GoldAI_RiskGuard.resetToday();
    this.updateRiskUI();
    alert('✅ Risk Guard امروز ریست شد');
  },

  updateMarketClock() {
    const now = new Date();
    const hour = now.getUTCHours();
    const open = this.isMarketOpen();
    let session = "Sydney";
    if (hour >= 7 && hour < 12) session = "Tokyo";
    else if (hour >= 12 && hour < 17) session = "London";
    else if (hour >= 17 || hour < 0) session = "New York";

    const ms = document.getElementById("marketStatus");
    if (ms) {
      ms.textContent = open ? "🟢 OPEN" : "🔴 CLOSED";
      ms.className = "market-status " + (open ? "open" : "closed");
    }
    const sess = document.getElementById("marketSession");
    if (sess) sess.textContent = session;

    const warning = document.getElementById("marketClosedWarning");
    if (warning) {
      if (open) warning.classList.add("hidden");
      else warning.classList.remove("hidden");
    }

    const dateEl = document.getElementById("persianDate");
    const timeEl = document.getElementById("persianTime");
    if (dateEl || timeEl) {
      try {
        // Tehran only — per UI spec, no London/New York/Tokyo clocks.
        const dateOpt = { timeZone: 'Asia/Tehran', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const timeOpt = { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
        if (dateEl) dateEl.textContent = new Intl.DateTimeFormat('fa-IR', dateOpt).format(now);
        if (timeEl) timeEl.textContent = new Intl.DateTimeFormat('fa-IR', timeOpt).format(now);
      } catch (e) {
        if (timeEl) timeEl.textContent = now.toUTCString();
      }
    }
    this.updateRiskUI();
  },

  setupSettingsPanel() {},

  showPanel(name) {
    if (name === "analysis") name = "chart"; // old tab merged into the chart tab (2026-10-07)
    document.querySelectorAll(".panel").forEach(p => p.classList.add("hidden"));
    document.getElementById("panel-" + name)?.classList.remove("hidden");
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelector(`[data-panel="${name}"]`)?.classList.add("active");
    if (name === "details" && this.lastResult) this.render(this.lastResult);
  },

  async sendToBackend(result) {
    if (!this.currentUID) return;
    try {
      await fetch(`${this.backendURL}/signals/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: this.currentUID,
          signal: result.signal.includes('BUY') ? 'BUY' : result.signal.includes('SELL') ? 'SELL' : 'WAIT',
          entry: result.entry, sl: result.stopLoss,
          tp1: result.tp1, tp2: result.tp2, tp3: result.tp3,
          confidence: result.confidence, quality: result.entryQuality,
          reason: result.reason, timestamp: result.timestamp
        })
      });
    } catch (e) { console.warn('Backend error:', e); }
  },

  buildSwiftSignalText(r) {
    const decs = this.getDecimals();
    const fmt = (n) => (n == null || isNaN(n) ? null : Number(n).toFixed(decs));
    const rawSym = (window.GoldAI_Config.SYMBOL || "XAU/USD").toUpperCase();
    const symbol = rawSym.replace("/", "").replace("GOLD", "XAUUSD");
    const side = (r.signal || "").toUpperCase().includes("SELL") ? "SELL"
               : (r.signal || "").toUpperCase().includes("BUY") ? "BUY" : null;
    if (!side) return null;

    const entry = fmt(r.entry);
    const sl = fmt(r.stopLoss);
    const tpCount = window.GoldAI_Config.TP_COUNT || 3;
    const lines = [];
    if (entry) lines.push(side + " " + symbol + " @ " + entry);
    else lines.push(side + " " + symbol);
    if (sl) lines.push("SL: " + sl);
    if (fmt(r.tp1)) lines.push("TP1: " + fmt(r.tp1));
    // TP2/TP3 are manual-only (see Settings) — the shared signal carries TP1 like the auto trade.
    return lines.join("\n");
  },

  shareSignal() {
    const r = this.lastResult;
    if (!r) return alert("ابتدا تحلیل کنید");
    if (r.signal && String(r.signal).includes("WAIT")) {
      return alert("سیگنال WAIT است — چیزی برای ارسال به Signal Swift نیست");
    }

    const swiftText = this.buildSwiftSignalText(r);
    if (!swiftText) return alert("سیگنال قابل تبدیل نیست");

    const pretty = "🥇 GoldAI → Signal Swift\n" + swiftText +
      "\nLot: " + (r.lot || "—") + " | RR: " + (r.riskReward || "—") +
      " | Conf: " + (r.confidence || 0) + "%";

    window._goldaiSwiftClipboard = swiftText;
    window._goldaiPrettyClipboard = pretty;

    document.getElementById("shareModal")?.remove();
    const html = `
      <div id="shareModal" class="modal" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;">
        <div class="modal-content" style="background:var(--card,#1a1a22);padding:16px;border-radius:12px;max-width:420px;width:92%;">
          <h3 style="margin:0 0 8px;">📤 اشتراک / Signal Swift</h3>
          <p style="font-size:12px;opacity:.7;margin:0 0 8px;">این متن را در Signal Swift پیست کنید:</p>
          <pre id="swiftPreview" style="margin:0;font-size:13px;white-space:pre-wrap;direction:ltr;text-align:left;background:rgba(0,0,0,.25);padding:10px;border-radius:8px;"></pre>
          <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;">
            <button class="btn-main" onclick="navigator.clipboard.writeText(window._goldaiSwiftClipboard||'').then(()=>alert('✅ کپی شد — داخل Signal Swift پیست کنید'))">📋 کپی برای Signal Swift</button>
            <button class="btn-ghost" onclick="navigator.clipboard.writeText(window._goldaiPrettyClipboard||'').then(()=>alert('✅ متن کامل کپی شد'))">کپی کامل</button>
            <button class="btn-ghost" onclick="document.getElementById('shareModal').remove()">❌ بستن</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML("beforeend", html);
    const pre = document.getElementById("swiftPreview");
    if (pre) pre.textContent = swiftText;
  }
};

document.addEventListener("DOMContentLoaded", () => window.GoldAI.init());
