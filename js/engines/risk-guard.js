// =====================================
// GoldAI — Risk Guard / Circuit Breaker
// Daily loss limit + max trades (localStorage)
// Non-breaking: only forces WAIT when limits hit
// =====================================

window.GoldAI_RiskGuard = {
  STORAGE_KEY: "goldai_risk_guard_v1",

  _todayKey() {
    const d = new Date();
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  },

  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return this._fresh();
      const data = JSON.parse(raw);
      if (data.date !== this._todayKey()) return this._fresh();
      return data;
    } catch (_) {
      return this._fresh();
    }
  },

  _fresh() {
    return {
      date: this._todayKey(),
      trades: 0,
      realizedR: 0,       // sum of closed R multiples (user can mark later)
      openRiskMoney: 0,
      blocked: false,
      blockReason: null
    };
  },

  _save(data) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  },

  /**
   * Check whether a new directional signal is allowed.
   * Returns { allowed: boolean, reason?: string, state }
   */
  check(cfg) {
    const state = this._load();
    const maxTrades = (cfg && cfg.MAX_TRADES_PER_DAY) != null ? cfg.MAX_TRADES_PER_DAY : 5;
    const dailyLossPct = (cfg && cfg.DAILY_LOSS_LIMIT_PCT) != null ? cfg.DAILY_LOSS_LIMIT_PCT : 3;

    // Max trades per day
    if (state.trades >= maxTrades) {
      state.blocked = true;
      state.blockReason = "MAX_TRADES_PER_DAY (" + maxTrades + ")";
      this._save(state);
      return { allowed: false, reason: state.blockReason, state };
    }

    // Daily loss limit (based on realized R if available)
    // Negative realizedR means loss. Limit is in % of capital approximated via R.
    if (state.realizedR <= -dailyLossPct) {
      state.blocked = true;
      state.blockReason = "DAILY_LOSS_LIMIT (" + dailyLossPct + "% R)";
      this._save(state);
      return { allowed: false, reason: state.blockReason, state };
    }

    // Manual block flag
    if (state.blocked && state.blockReason) {
      return { allowed: false, reason: state.blockReason, state };
    }

    return { allowed: true, state };
  },

  /** Check whether a real trade may be submitted. */
  canExecute(cfg) {
    return this.check(cfg || window.GoldAI_Config || {});
  },

  recordTradeExecuted() {
    const state = this._load();
    state.trades = (state.trades || 0) + 1;
    this._save(state);
    return state;
  },

  recordSignalAccepted() {
    return this.recordTradeExecuted();
  },

  /**
   * Record a closed trade result in R multiples.
   * positive = win, negative = loss.
   * Call this when user marks a trade as closed (future UI) or from history.
   */
  recordClosedTrade(rMultiple) {
    const state = this._load();
    const r = Number(rMultiple) || 0;
    state.realizedR = Number(((state.realizedR || 0) + r).toFixed(2));
    this._save(state);
    return state;
  },

  /** Force unblock (e.g. next day or manual reset) */
  resetToday() {
    const fresh = this._fresh();
    this._save(fresh);
    return fresh;
  },

  getStatus(cfg) {
    const check = this.check(cfg || window.GoldAI_Config || {});
    return {
      ...check.state,
      allowed: check.allowed,
      reason: check.reason || null,
      maxTrades: (cfg && cfg.MAX_TRADES_PER_DAY) || 5,
      dailyLossLimitPct: (cfg && cfg.DAILY_LOSS_LIMIT_PCT) || 3
    };
  }
};
