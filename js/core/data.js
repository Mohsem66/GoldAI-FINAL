// =====================================
// GoldAI — Data Layer
// Prefers backend; free public fallback; demo seed near current gold
// =====================================

window.GoldAI_Data = {
  goldPrice: 0,
  capital: 10000,
  closes: { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] },
  highs: { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] },
  lows: { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] },
  volumes: { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] },
  candles: { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] },

  dataMode: "demo",
  manualPriceLock: false,
  livePriceOk: false,
  lastPriceFetchTime: 0,
  priceSource: "none",

  // Realistic 2026-era default when everything else fails (was 2650 — outdated)
  DEMO_BASE_PRICE: 4400,

  getCapital() { return this.capital || 10000; },
  setCapital(v) { this.capital = Number(v) || 10000; },

  isLiveReady() {
    return this.dataMode === "live" && this.livePriceOk;
  },

  /**
   * Raw MT5 candle fetch for the Real Backtest engine (js/engines/backtest.js).
   * Independent of the six-slot live cache above (closes/highs/lows/...) —
   * does NOT touch goldPrice, dataMode, livePriceOk, or priceSource, and is
   * never called from loadAll()/loadPrice()/seedDemo(). Pure additive helper.
   * Returns { status, symbol, timeframe, candles: [{time,open,high,low,close,tick_volume,spread,real_volume}] }
   */
  async fetchMT5History(timeframe, count) {
    const cfg = window.GoldAI_Config || {};
    const backend = (cfg.BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, "");
    const symbol = cfg.SYMBOL || "XAUUSD.";
    const n = Math.max(10, Math.min(Number(count) || 1000, 5000));
    try {
      const res = await fetch(
        `${backend}/mt5/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=${n}`,
        { cache: "no-store" }
      );
      const data = await res.json();
      return data; // { status, symbol, timeframe, count, candles } or { status:"unavailable"/"error", message }
    } catch (e) {
      return { status: "error", message: String(e), candles: [] };
    }
  },

  /** Real MT5 symbol specs (point/digits/tick size/value/volume limits) — for backtest lot & pip math. */
  async fetchMT5SymbolSpecs() {
    const cfg = window.GoldAI_Config || {};
    const backend = (cfg.BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, "");
    const symbol = cfg.SYMBOL || "XAUUSD.";
    try {
      const res = await fetch(`${backend}/mt5/symbol-info?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" });
      return await res.json();
    } catch (e) {
      return { status: "error", message: String(e) };
    }
  },

  async loadAll() {
    const cfg = window.GoldAI_Config || {};
    const backend = (cfg.BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, "");
    const mt5Symbol = cfg.SYMBOL || "XAUUSD.";

    // 1) Price FIRST — loadPrice() itself now sets dataMode (live/offline/demo),
    // so it must run before anything else reads/derives dataMode.
    await this.loadPrice(true);

    // 2) M1/M5/M15 candles — MT5 only. No Twelve Data / demo substitution here.
    const mt5Timeframes = [["m1", "M1"], ["m5", "M5"], ["m15", "M15"]];
    for (const [key, tf] of mt5Timeframes) {
      try {
        const res = await fetch(
          `${backend}/mt5/candles?symbol=${encodeURIComponent(mt5Symbol)}&timeframe=${tf}&count=${cfg.CANDLE_COUNT || 120}`,
          { cache: "no-store" }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.status === "ok" && Array.isArray(data.candles) && data.candles.length) {
            this._applyMT5Series(key, data.candles);
          }
        }
      } catch (_) {}
    }

    // 3) H1/H4/Daily — legacy Twelve Data history (MT5 bridge has no candles for these yet).
    try {
      const tdSymbol = encodeURIComponent(cfg.SYMBOL_TWELVEDATA || "XAU/USD");
      const intervals = [["h1", "1h"], ["h4", "4h"], ["daily", "1day"]];
      for (const [key, interval] of intervals) {
        try {
          const res = await fetch(`${backend}/historical?symbol=${tdSymbol}&interval=${interval}&outputsize=${cfg.CANDLE_COUNT || 120}`);
          if (!res.ok) continue;
          const data = await res.json();
          if (data.values && data.values.length) {
            this._applySeries(key, data.values);
          }
        } catch (_) {}
      }
    } catch (_) {}

    if (!this.goldPrice && this.closes.m5.length) {
      this.goldPrice = this.closes.m5[this.closes.m5.length - 1];
    }
  },

  /** Twelve Data historical rows (H1/H4/Daily only — descending, needs reverse). */
  _applySeries(key, values) {
    const rows = values.slice().reverse();
    this.closes[key] = rows.map(r => Number(r.close));
    this.highs[key] = rows.map(r => Number(r.high));
    this.lows[key] = rows.map(r => Number(r.low));
    this.volumes[key] = rows.map(r => Number(r.volume || 0));
    this.candles[key] = rows.map(r => ({
      open: Number(r.open), high: Number(r.high),
      low: Number(r.low), close: Number(r.close),
      volume: Number(r.volume || 0)
    }));
  },

  /** MT5 /candles rows (M1/M5/M15) — already chronological, uses tick_volume. */
  _applyMT5Series(key, candlesArr) {
    this.closes[key] = candlesArr.map(c => Number(c.close));
    this.highs[key] = candlesArr.map(c => Number(c.high));
    this.lows[key] = candlesArr.map(c => Number(c.low));
    this.volumes[key] = candlesArr.map(c => Number(c.tick_volume || 0));
    this.candles[key] = candlesArr.map(c => ({
      open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close),
      volume: Number(c.tick_volume || 0)
    }));
  },

  /**
   * Live price — MT5 ONLY. Twelve Data / public fallback are no longer used here
   * (per requirement: price must never be silently replaced by a non-MT5 source).
   * On success: dataMode = "live". On failure: dataMode = "offline" (if we still
   * have a previous real price to show) or "demo" (if we never had one) — but the
   * price value itself is NEVER fabricated here.
   */
  async loadPrice(force) {
    if (this.manualPriceLock && this.goldPrice > 0) return this.goldPrice;
    const now = Date.now();
    if (!force && this.goldPrice > 0 && (now - this.lastPriceFetchTime < 1500)) {
      return this.goldPrice;
    }
    const cfg = window.GoldAI_Config || {};
    const backend = (cfg.BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, "");
    const symbol = encodeURIComponent(cfg.SYMBOL || "XAUUSD.");

    try {
      const res = await fetch(`${backend}/mt5/current-price?symbol=${symbol}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.status === "ok" && data.price) {
          this.goldPrice = Number(data.price);
          this.livePriceOk = true;
          this.priceSource = "mt5";
          this.dataMode = "live";
          this.lastPriceFetchTime = now;
          return this.goldPrice;
        }
      }
    } catch (_) {}

    // MT5 unreachable / no price. Do NOT fabricate a number, do NOT call it live.
    this.livePriceOk = false;
    this.priceSource = "mt5_offline";
    this.dataMode = this.goldPrice > 0 ? "offline" : "demo";
    this.lastPriceFetchTime = now;
    return this.goldPrice;
  },

  /**
   * Fills ONLY the candle series that are genuinely empty (e.g. MT5 candles
   * endpoint failed, or Twelve Data key missing for H1/H4/Daily). Never
   * overwrites real MT5/backend candles, and never touches goldPrice,
   * dataMode, or priceSource when a real MT5 price is already live —
   * those belong to loadPrice() alone.
   */
  seedDemo() {
    const base = this.goldPrice > 1000 ? this.goldPrice : (this.DEMO_BASE_PRICE || 4400);
    const n = 120;
    const mk = () => {
      const closes = [], highs = [], lows = [], vols = [], candles = [];
      let price = base;
      const noise = Math.max(1.5, base * 0.0006);
      for (let i = 0; i < n; i++) {
        const drift = (Math.random() - 0.48) * noise * 2;
        const open = price;
        const close = price + drift;
        const high = Math.max(open, close) + Math.random() * noise;
        const low = Math.min(open, close) - Math.random() * noise;
        closes.push(close); highs.push(high); lows.push(low);
        vols.push(100 + Math.random() * 50);
        candles.push({ open, high, low, close, volume: vols[vols.length - 1] });
        price = close;
      }
      return { closes, highs, lows, vols, candles };
    };

    for (const k of ["m1", "m5", "m15", "h1", "h4", "daily"]) {
      if (this.closes[k] && this.closes[k].length) continue; // real data already present — leave it alone
      const s = mk();
      this.closes[k] = s.closes;
      this.highs[k] = s.highs;
      this.lows[k] = s.lows;
      this.volumes[k] = s.vols;
      this.candles[k] = s.candles;
    }

    // Only seed a price if we've genuinely never received one — never overwrite a live MT5 price.
    if (!this.livePriceOk && !this.goldPrice) {
      this.goldPrice = base;
    }
  }
};
