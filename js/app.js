// =====================================
// GoldAI Pro — Main Orchestrator
// =====================================

window.GoldAI = {

  lastResult: null,
  backendURL: 'http://localhost:5000/api',
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
    this.setupSettingsPanel();
    this.setupNotificationPermission();
    setInterval(() => this.updateMarketClock(), 1000);
    setInterval(async () => {
      await this.fetchPriceFromBackend();
      this.updatePriceUI();
    }, window.GoldAI_Config.PRICE_REFRESH_MS);
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
    const strategyEl = document.getElementById('strategySelect');
    const strategy = strategyEl ? strategyEl.value : window.GoldAI_Config.STRATEGY_MODE;
    window.GoldAI_Config.TP_COUNT = tpCount;
    window.GoldAI_Config.ATR_SL_MULT = slMult;
    window.GoldAI_Config.ATR_TP1_MULT = tp1Mult;
    window.GoldAI_Config.ATR_TP2_MULT = tp2Mult;
    window.GoldAI_Config.ATR_TP3_MULT = tp3Mult;
    window.GoldAI_Config.USER_LOT = userLot;
    if (strategyEl) window.GoldAI_Config.STRATEGY_MODE = strategy;
    const stored = JSON.parse(localStorage.getItem('goldai_settings') || '{}');
    stored.tpCount = tpCount; stored.slMult = slMult; stored.tp1Mult = tp1Mult;
    stored.tp2Mult = tp2Mult; stored.tp3Mult = tp3Mult; stored.userLot = userLot;
    if (strategyEl) stored.strategy = strategy;
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

      let entryTF = "m5", biasTF = "h1", scalpTF = "m1";
      if (cfg.STRATEGY_MODE === "swing") { entryTF = "h1"; biasTF = "daily"; scalpTF = "m15"; }

      const closes = data.closes[entryTF];
      const highs = data.highs[entryTF];
      const lows = data.lows[entryTF];
      const vols = data.volumes[entryTF];
      const candles = data.candles[entryTF];

      let price = data.goldPrice || closes[closes.length - 1];
      const manualInput = document.getElementById("manualEntryInput");
      if (manualInput && manualInput.value.trim() !== "") {
        const parsed = Number(manualInput.value);
        if (!isNaN(parsed) && parsed > 0) price = parsed;
      }

      const htfCloses = data.closes[biasTF];
      const htfHighs = data.highs[biasTF];
      const htfLows = data.lows[biasTF];
      const m1Closes = data.closes[scalpTF] || [];

      const ema = window.GoldAI_EMA.analyzeEMA(closes, price, cfg);
      const rsi = window.GoldAI_RSI.analyzeRSI(closes, cfg);
      const div = window.GoldAI_Divergence.analyzeDivergence(closes, rsi.history || []);
      const structure = window.GoldAI_MarketStructure.analyzeMarketStructure(highs, lows, closes, cfg);
      const macd = window.GoldAI_MACD.analyzeMACD(closes);
      const adx = window.GoldAI_ADX.analyzeADX(highs, lows, closes, cfg.ADX_PERIOD || 14);
      const atrL = window.GoldAI_ATR.analyzeATR(highs, lows, closes, cfg);
      const volume = window.GoldAI_Volume.analyzeVolume(vols, closes);
      const sr = window.GoldAI_SR.analyzeSR(highs, lows, price, cfg);
      const candleP = window.GoldAI_Candles.analyzeCandles(candles);
      const liq = window.GoldAI_Liquidity.analyzeLiquidity(highs, lows, closes);
      const reversal = this.detectReversal(closes, rsi.history || []);

      const htfEma = window.GoldAI_EMA.analyzeEMA(htfCloses, htfCloses[htfCloses.length - 1], cfg);
      const htfStr = window.GoldAI_MarketStructure.analyzeMarketStructure(htfHighs, htfLows, htfCloses, cfg);
      const htf = { trend: htfStr.trend !== "UNKNOWN" ? htfStr.trend : htfEma.trend, strength: htfEma.confidence > 70 ? "STRONG" : "WEAK" };

      let m1 = null;
      if (m1Closes.length > 5) {
        const m1Ema = window.GoldAI_EMA.analyzeEMA(m1Closes, m1Closes[m1Closes.length - 1], cfg);
        m1 = { microstructure: m1Ema.trend };
      }

      const fundamental = window.GoldAI_Fundamental.analyzeFundamentals(cfg);
      const correlation = window.GoldAI_Correlation.analyzeCorrelation(closes, price);
      const dynamicWeights = this.updateDynamicWeights();

      const layers = {
        ema, rsi, divergence: div, structure, macd, adx,
        atr: atrL, volume, sr, candles: candleP, liquidity: liq,
        htf, m1, fundamental, correlation, reversal, dynamicWeights
      };

      const aiBrain = window.GoldAI_AIBrain.analyze(layers);
      layers.aiBrain = aiBrain;

      const raw = window.GoldAI_Score.runScoreEngine(layers);
      let final = window.GoldAI_Conflict.runConflictFilter(raw, layers, cfg);

      const dModeEarly = (data.dataMode || "demo").toLowerCase();
      if (dModeEarly !== "demo" && reversal.signal !== 'NONE' && reversal.strength > 60) {
        if (reversal.signal === 'BUY' && final.signal && final.signal.includes('WAIT')) {
          final.signal = 'BUY (Reversal)';
          final.confidence = Math.min(85, final.confidence + 15);
          final.reason = (final.reason || '') + ' | 🔄 Reversal: ' + reversal.type;
        }
        if (reversal.signal === 'SELL' && final.signal && final.signal.includes('WAIT')) {
          final.signal = 'SELL (Reversal)';
          final.confidence = Math.min(85, final.confidence + 15);
          final.reason = (final.reason || '') + ' | 🔄 Reversal: ' + reversal.type;
        }
      }

      if (dModeEarly === "demo" && final.signal && !final.signal.includes("WAIT")) {
        final.signal = "WAIT 🟡";
        final.confidence = Math.min(final.confidence || 0, 35);
        final.warnings = (final.warnings || []).concat(["DEMO data → forced WAIT"]);
      }

      const userLot = cfg.USER_LOT || 0;
      const plan = window.GoldAI_Trade.createTradePlan(
        final.signal, price, atrL.atr, data.getCapital(),
        cfg.DEFAULT_RISK_PERCENT, cfg, cfg.SYMBOL_SPECS
      );
      if (userLot > 0) plan.lot = userLot;

      const now = new Date();
      const result = {
        ...final, ...plan, price, layers,
        time: now.toLocaleString("fa-IR"),
        timestamp: now.toISOString(),
        tf: cfg.STRATEGY_MODE === "scalp" ? "M1/M5" : "H1/H4",
        reversal: reversal.signal
      };

      result.warnings = result.warnings || [];
      if (!open && result.signal && !result.signal.includes('WAIT')) {
        result.warnings.push("⛔ بازار بسته است - این سیگنال فقط جنبه آموزشی دارد");
      }
      const dMode = (data.dataMode || "demo").toLowerCase();
      if (dMode === "demo") {
        result.warnings.push("⚠️ داده Demo (ساختگی) — سیگنال قابل معامله نیست");
        if (result.signal && !result.signal.includes("WAIT")) {
          result.signal = "WAIT 🟡";
          result.confidence = Math.min(result.confidence || 0, 40);
          result.reason = (result.reason || "") + " | Demo data → forced WAIT";
        }
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

  render(r) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const decs = this.getDecimals();
    const fmt = (num) => (num == null || isNaN(num) ? "—" : num.toFixed(decs));
    set("signal", r.signal);
    set("confidence", (r.confidence || 0) + "%");
    set("entry", fmt(r.entry));
    set("sl", fmt(r.stopLoss));
    set("signalTime", r.time || "—");
    set("signalTF", r.tf || "—");

    const tpCount = window.GoldAI_Config.TP_COUNT || 3;
    let detailsHtml = `<div class="detail-item"><span>ورود</span><b>${fmt(r.entry)}</b></div><div class="detail-item"><span>SL</span><b>${fmt(r.stopLoss)}</b></div><div class="detail-item"><span>TP1</span><b>${fmt(r.tp1)}</b></div>`;
    if (tpCount >= 2) detailsHtml += `<div class="detail-item"><span>TP2</span><b>${fmt(r.tp2)}</b></div>`;
    if (tpCount >= 3) detailsHtml += `<div class="detail-item"><span>TP3</span><b>${fmt(r.tp3)}</b></div>`;
    detailsHtml += `<div class="detail-item"><span>R:R</span><b>${r.riskReward || "—"}</b></div>`;
    const sd = document.getElementById('signalDetails');
    if (sd) sd.innerHTML = detailsHtml;

    const strength = Math.min(100, Math.max(0, r.confidence || 0));
    const bar = document.getElementById("signalStrengthBar");
    const text = document.getElementById("signalStrengthText");
    if (bar) {
      bar.style.width = strength + "%";
      bar.style.background = strength >= 75 ? "var(--green)" : strength >= 55 ? "var(--gold)" : "var(--red)";
    }
    if (text) text.textContent = strength + "%";

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

    const warnBox = document.getElementById("warnings");
    if (warnBox) {
      const c = (r.confirms || []).map(x => `✅ ${x}`).join("<br>");
      const w = (r.warnings || []).map(x => `⚠️ ${x}`).join("<br>");
      warnBox.innerHTML = (c ? c + "<br>" : "") + (w || "");
    }

    document.getElementById("resultCard")?.classList.remove("hidden");
  },

  updateExecutionPanel(r) {
    const panel = document.getElementById("tradeExecutionPanel");
    if (!panel) return;
    const actionable = r && r.signal && !String(r.signal).includes("WAIT");
    panel.classList.toggle("hidden", !actionable);
    if (!actionable) return;
    const decs = this.getDecimals();
    const fmt = n => (n == null || isNaN(n) ? "" : Number(n).toFixed(decs));
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal("execEntry", fmt(r.entry)); setVal("execSL", fmt(r.stopLoss));
    setVal("execTP", fmt(r.tp1)); setVal("execLot", r.lot || "");
    const mode = (window.GoldAI_Config.TRADE_MODE || "manual").toLowerCase();
    const modeEl = document.getElementById("tradeModeSelect");
    if (modeEl) modeEl.value = mode;
    const note = document.getElementById("executionModeNote");
    if (note) note.textContent = mode === "auto"
      ? "حالت AUTO: مقادیر AI بدون ویرایش کاربر، پس از کنترل‌های ایمنی ارسال می‌شوند."
      : "حالت MANUAL: مقادیر توسط AI محاسبه شده‌اند و قبل از ارسال قابل ویرایش هستند.";
  },

  setAutoTradingEnabled(on) {
    window.GoldAI_Config.AUTO_TRADING_ENABLED = Boolean(on);
    const stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
    stored.autoTradingEnabled = Boolean(on);
    localStorage.setItem("goldai_settings", JSON.stringify(stored));
  },

  setTradeMode(mode) {
    mode = String(mode || "manual").toLowerCase() === "auto" ? "auto" : "manual";
    window.GoldAI_Config.TRADE_MODE = mode;
    const stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
    stored.tradeMode = mode;
    localStorage.setItem("goldai_settings", JSON.stringify(stored));
    this.updateExecutionPanel(this.lastResult);
  },

  async executeCurrentTrade(source) {
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
      deviation: Number(cfg.EXECUTION_DEVIATION_POINTS || 20)
    };
    try {
      const res = await fetch(`${this.backendURL}/mt5/send-signal`, {
        method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload)
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
        if (p.strategy) window.GoldAI_Config.STRATEGY_MODE = p.strategy;
        if (p.tpCount) window.GoldAI_Config.TP_COUNT = p.tpCount;
        if (p.symbol) window.GoldAI_Config.SYMBOL = p.symbol;
        if (p.slMult) window.GoldAI_Config.ATR_SL_MULT = p.slMult;
        if (p.tp1Mult) window.GoldAI_Config.ATR_TP1_MULT = p.tp1Mult;
        if (p.tp2Mult) window.GoldAI_Config.ATR_TP2_MULT = p.tp2Mult;
        if (p.tp3Mult) window.GoldAI_Config.ATR_TP3_MULT = p.tp3Mult;
        if (p.userLot) window.GoldAI_Config.USER_LOT = p.userLot;
         if (p.tradeMode) window.GoldAI_Config.TRADE_MODE = p.tradeMode;
         if (typeof p.autoTradingEnabled === 'boolean') window.GoldAI_Config.AUTO_TRADING_ENABLED = p.autoTradingEnabled;
        const el = (id) => document.getElementById(id);
        if (el('advCapital')) el('advCapital').value = p.capital || 10000;
         if (el('autoTradeToggle')) el('autoTradeToggle').checked = !!p.autoTradingEnabled;
        if (el('advRisk')) el('advRisk').value = p.risk || 1;
        if (el('strategySelect')) el('strategySelect').value = p.strategy || 'scalp';
        if (el('userTpCount')) el('userTpCount').value = p.tpCount || 3;
        if (el('userSlMult')) el('userSlMult').value = p.slMult || 1.5;
        if (el('userTp1Mult')) el('userTp1Mult').value = p.tp1Mult || 2.0;
        if (el('userTp2Mult')) el('userTp2Mult').value = p.tp2Mult || 3.5;
        if (el('userTp3Mult')) el('userTp3Mult').value = p.tp3Mult || 5.0;
        if (el('userLot')) el('userLot').value = p.userLot || 0;
      }
      const symbolEl = document.getElementById("symbolSelect");
      if (symbolEl) symbolEl.value = window.GoldAI_Config.SYMBOL || "XAU/USD";
      this.updateRiskUI();
    } catch (e) { console.error(e); }
  },

  updatePriceUI() {
    const el = document.getElementById("goldPrice");
    if (el) el.textContent = window.GoldAI_Data.goldPrice
      ? window.GoldAI_Data.goldPrice.toFixed(this.getDecimals())
      : "—";
    const badge = document.getElementById("dataModeBadge");
    if (badge) {
      const mode = (window.GoldAI_Data.dataMode || "demo").toLowerCase();
      badge.className = "data-mode " + mode;
      if (mode === "live") badge.textContent = "LIVE";
      else if (mode === "offline") badge.textContent = "MT5 OFFLINE";
      else if (mode === "mixed") badge.textContent = "MIXED";
      else badge.textContent = "DEMO";
    }
  },

  updateRiskUI() {
    const cap = window.GoldAI_Data.getCapital();
    const risk = window.GoldAI_Config.DEFAULT_RISK_PERCENT;
    const maxLoss = ((cap * risk) / 100).toFixed(2);
    const lot = Math.max(0.01, Number((cap / 10000).toFixed(2)));
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('capitalText', cap);
    set('riskText', risk + "%");
    set('maxLossText', maxLoss);
    set('lotText', lot);

    // Risk Guard status panel
    try {
      if (window.GoldAI_RiskGuard) {
        const st = window.GoldAI_RiskGuard.getStatus(window.GoldAI_Config);
        const maxT = st.maxTrades || 5;
        const trades = st.trades || 0;
        set('rgTrades', trades + ' / ' + maxT);
        set('rgRealizedR', (st.realizedR != null ? st.realizedR : 0) + 'R');
        set('rgDailyLimit', (st.dailyLossLimitPct || 3) + 'R');
        const badge = document.getElementById('riskGuardBadge');
        const statusEl = document.getElementById('rgStatus');
        if (!st.allowed) {
          if (badge) { badge.className = 'rg-badge rg-blocked'; badge.textContent = '🔴 مسدود'; }
          if (statusEl) statusEl.textContent = st.reason || 'مسدود';
        } else {
          if (badge) { badge.className = 'rg-badge rg-ok'; badge.textContent = '🟢 فعال'; }
          if (statusEl) statusEl.textContent = 'آماده';
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

    const td = document.getElementById("timeDisplay");
    if (td) {
      try {
        const zones = [
          { name: "تهران", tz: "Asia/Tehran" },
          { name: "لندن", tz: "Europe/London" },
          { name: "نیویورک", tz: "America/New_York" },
          { name: "توکیو", tz: "Asia/Tokyo" }
        ];
        const clocksHTML = zones.map(z => {
          const opt = { timeZone: z.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
          const f = new Intl.DateTimeFormat('fa-IR', opt).format(now);
          return `<span><b>${z.name}</b> ${f}</span>`;
        }).join('');
        const dateOpt = { timeZone: 'Asia/Tehran', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        const persianDate = new Intl.DateTimeFormat('fa-IR', dateOpt).format(now);
        td.innerHTML = `<div class="date-row">${persianDate}</div><div class="clocks">${clocksHTML}</div>`;
      } catch (e) {
        td.textContent = now.toUTCString();
      }
    }
    this.updateRiskUI();
  },

  setupSettingsPanel() {},

  showPanel(name) {
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
    if (tpCount >= 2 && fmt(r.tp2)) lines.push("TP2: " + fmt(r.tp2));
    if (tpCount >= 3 && fmt(r.tp3)) lines.push("TP3: " + fmt(r.tp3));
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
