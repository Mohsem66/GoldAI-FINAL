// =====================================
// GoldAI Pro â€” Config (no frontend API key)
// =====================================

window.GoldAI_Config = {

  // API key lives only in backend/.env (never commit real keys)
  BACKEND_URL: "http://localhost:5000/api",

  // MT5 broker symbol â€” used for price + M1/M5/M15 candles (must match MarketWatch exactly)
  SYMBOL: "XAUUSD.",

  // Twelve Data symbol â€” only used for legacy H1/H4/Daily history (Twelve Data has no dot-suffix symbols)
  SYMBOL_TWELVEDATA: "XAU/USD",

  // Optional: filled from MT5 /api/mt5/symbol-info for accurate lots
  SYMBOL_SPECS: null,

  TF_SCALP: "1min",
  TF_ENTRY: "5min",
  TF_SWING: "15min",
  TF_TREND: "1h",
  TF_H4: "4h",
  TF_DAILY: "1day",

  CANDLE_COUNT: 120,

  DEFAULT_CAPITAL: 10000,
  DEFAULT_RISK_PERCENT: 1.0,
  MAX_TRADES_PER_DAY: 15,

  // Safety â€” Risk Guard
  DAILY_LOSS_LIMIT_PCT: 3,     // stop new signals after ~3R daily loss
  STRICT_DATA_MODE: true,      // DEMO â†’ force WAIT; MIXED â†’ heavy warning + lower conf

  STRATEGY_MODE: "scalp", // derived automatically from ACTIVE_TIMEFRAME (see app.js) — not user-set directly anymore
  TP_COUNT: 3,

  // CENTRAL ACTIVE TIMEFRAME — single source of truth for live analysis,
  // indicators, signal, entry/SL/TP, trade plan, AND Backtest (Backtest no
  // longer has its own timeframe selector; it inherits this value).
  // Selected from the header's single timeframe dropdown (M1/M5/M15/M30/H1/H4).
  ACTIVE_TIMEFRAME: "m5",

  ATR_SL_MULT: 1.5,
  ATR_TP1_MULT: 2.0,
  ATR_TP2_MULT: 3.5,
  ATR_TP3_MULT: 5.0,

  EMA_FAST: 20,
  EMA_MID: 50,
  EMA_SLOW: 200,

  RSI_PERIOD: 14,
  RSI_OB: 70,
  RSI_OS: 30,

  ATR_PERIOD: 14,

  ADX_PERIOD: 14,
  ADX_TREND_MIN: 25,

  SWING_LOOKBACK: 5,
  MIN_BREAK_STRENGTH: 0.15,

  MIN_CONFIDENCE: 68,
  STRICT_MODE: true,

  PRICE_REFRESH_MS: 5000,

  // Automatic Signal Monitor â€” evaluates on every NEW closed candle (M5 for
  // scalp, M15 for swing), using the exact same pipeline as the manual
  // "ØªØ­Ù„ÛŒÙ„ Ø³ÛŒÚ¯Ù†Ø§Ù„" button. Off by default; toggle from the UI.
  AUTO_SIGNAL_ENABLED: false,
  AUTO_SIGNAL_POLL_MS: 15000, // how often to check "did a new candle close" â€” NOT how often signals are generated

  // Auto ORDER execution (sending a real trade to MT5 without a person clicking
  // anything) is a separate, more dangerous capability from signal detection.
  // It stays OFF and unwired in this build â€” Automatic Signal only ever writes
  // to the signal journal, it never calls /api/mt5/send-signal.
  AUTO_TRADING_ENABLED: false,
  TRADE_MODE: "manual",
  AUTO_MIN_CONFIDENCE: 80,
  EXECUTION_DEVIATION_POINTS: 20,

  NTFY_TOPIC: "goldai_signals",

  // Mobile-First patch (additive, UI-only): no official URLs were found
  // anywhere in the project during audit, so these are intentionally left
  // empty rather than guessed. js/social.js shows a disabled/greyed button
  // for any entry left "" — fill in the real links here when you have them.
  SOCIAL_LINKS: {
    telegram: "",
    x: "",
    instagram: "",
    eitaa: "",
    rubika: "",
  },
};
