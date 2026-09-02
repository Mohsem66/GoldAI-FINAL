# GoldAI Pro

Professional multi-engine signal system for **XAUUSD.** (real MT5 broker symbol), with a real Walk-Forward Backtest and an Automatic Signal Monitor.

## Engines

| Engine | What it does |
|--------|----------------|
| Market Structure | HH/HL, LH/LL, BOS, CHoCH, Swings, Trend/Range (per-series memory) |
| EMA | 20 / 50 / 200 — stack, slope, cross (graceful if EMA200 missing) |
| RSI | Wilder RSI + zones |
| Divergence | Regular + Hidden (aligned price/RSI series) |
| MACD | Line, signal, histogram, cross |
| ADX | Trend strength vs range |
| ATR | Dynamic SL / TP / volatility |
| Volume | Spike + expansion |
| Support / Resistance | Clustered pivots |
| Candles | Hammer, engulfing, pin, doji |
| Liquidity | Equal H/L, stop sweeps (SMC) |
| Score + Conflict Filter | Final decision gate |
| Risk Guard | Daily loss limit + max trades (circuit breaker) |
| Trade Management | Lot, multi-TP, R:R |
| **Backtest** | Real MT5 Walk-Forward, look-ahead safe, virtual trades (`js/engines/backtest.js`) |
| **Auto Signal Monitor** | Same pipeline, triggered on each new closed M5/M15 candle (`js/engines/auto-signal.js`) |

> **Note:** Fundamental & Correlation engines are **simulated** (not live data). Their weight in the Score engine is **zero**. They only emit warnings for transparency.

## Price & candle source of truth — MT5, always

```
Frontend (js/core/data.js)
  → Backend   GET /api/mt5/current-price?symbol=XAUUSD.
    → Bridge  GET /current-price?symbol=XAUUSD.
      → MetaTrader5 → Bid / Ask / Mid
```

**Twelve Data / any public fallback is never used for price or for M1/M5/M15 candles when MT5 is reachable.** If MT5 is down, the UI shows `MT5 OFFLINE` (last real price kept, never a fabricated one) and the Conflict Filter forces `WAIT` — see `MT5-CONNECTION-NOTES.md` for the full story on the symbol (`XAUUSD.` vs `XAUUSD`), the `-6 Authorization failed` fix, and how the still-forming candle is excluded.

Only H1/H4/Daily (used solely as higher-timeframe bias context, not for M1/M5/M15 signals or backtest) still come from Twelve Data today. The MT5 bridge's `/candles` endpoint already supports H1/H4/D1 too — migrating those three is just a matter of pointing `js/core/data.js → loadAll()` at `/api/mt5/candles` for them as well, the same way M1/M5/M15 already are.

## Safety layer

| Feature | Behavior |
|---------|----------|
| **DEMO / OFFLINE mode** | All directional signals forced to **WAIT** |
| **MIXED mode** | Confidence reduced + clear warning |
| **Risk Guard** | Blocks new signals after `MAX_TRADES_PER_DAY` or `DAILY_LOSS_LIMIT_PCT` |
| **Confidence** | Technical score 0–100 — **not** a win probability |
| **Auto Trading** | `AUTO_TRADING_ENABLED` exists in config but is **not wired to any execution endpoint** in this build — Automatic Signal only ever writes to its journal |

## Setup

### 1. MT5 Bridge (Windows, real MT5 terminal required)

```bash
cd mt5-bridge
cp .env.example .env
# fill MT5_LOGIN / MT5_PASSWORD / MT5_SERVER / MT5_PATH
pip install -r requirements.txt --break-system-packages
python mt5_connector.py
```

### 2. Backend

```bash
cd backend
cp .env.example .env
# TWELVE_DATA_API_KEY only needed for the H1/H4/Daily bias context
npm install
npm start
```

### 3. Frontend

Open `index.html` from a static server (or directly). Without a reachable MT5 bridge, the app clearly shows **MT5 OFFLINE** / **DEMO** and never presents a fabricated price as live.

> **Security:** Never commit real credentials. `backend/.env` and `mt5-bridge/.env` are in `.gitignore`. Only `.env.example` files are meant to be shared.

## Signal pipeline (manual button AND Auto Monitor — identical)

```
Real MT5 M1/M5/M15 (+ H1/H4/Daily bias)
  → Structure + EMA + RSI + Div + MACD + ADX
  → Volume + S/R + Candles + Liquidity
  → Score Engine (simulated macro weight = 0)
  → Conflict Filter  (WAIT if conflict / low confidence / Demo-Offline / Risk Guard)
  → ATR Trade Plan (SL / TP1-3 / Lot)
```

`GoldAI.analyze()` is this entire pipeline. Both the manual "▶ شروع تحلیل AI" button and the Auto Signal Monitor (`js/engines/auto-signal.js`) call this exact same function — there is no separate/duplicate analysis path for automatic signals.

## Backtest

`js/engines/backtest.js → runRealMT5Backtest()` — a look-ahead-safe Walk-Forward backtest that:
- Fetches real MT5 M1/M5/M15 history (`/api/mt5/candles`, up to 5000 bars)
- Reuses the exact same engines as live signals
- Fills at the OPEN of the bar *after* the signal bar, with real spread/slippage/commission
- Uses real M1 data to resolve same-bar SL/TP ambiguity
- Produces Win Rate, Profit Factor, Expectancy, Max Drawdown, Equity Curve, and a full Signal Journal

Run it from the "🎯 Real MT5 Backtest" button in the Performance panel.

## Automatic Signal — two layers

1. **Browser Auto Signal Monitor** (`js/engines/auto-signal.js`) — for when the dashboard is open; UI toggle, journal in `localStorage`.
2. **24/7 Backend Signal Worker** (`backend/worker/signal-worker.js`) — a plain Node process, fully independent of the browser/Firefox/`index.html`. Talks directly to the MT5 bridge, detects newly-closed M5 (scalp) and M15 (swing) candles, runs the exact same `buildSignal()` used by the Real MT5 Backtest, and persists every signal to `backend/data/signals.json`. Closing the browser, or even stopping the Express backend, does not stop it. Full setup (including the Windows Task Scheduler config for true 24/7 operation) is in **`24H-AUTO-SIGNAL.md`**.

Toggle in the UI ("🔄 Auto Signal Monitor"). Polls lightly (`AUTO_SIGNAL_POLL_MS`, default 15s) just to detect whether a new M5/M15 candle has closed; only when one has, it runs one full `analyze()` call — never more than once per candle (dedup key: `symbol|timeframe|candle_close_time`). Only runs when `dataMode === "live"` (real MT5 tick) — never on demo/offline data. Results go to a Signal Journal (localStorage) viewable via "📒 Signal Journal" — it does **not** send any order to MT5. This is a *convenience* mirror of the same pipeline for when the dashboard is open; the 24/7 worker above is what actually needs to run to never miss a candle.

## Settings (UI)

All main controls are in one card:

- Capital ($)
- Risk (%)
- TP count
- Manual lot (0 = auto)
- SL / TP ATR multipliers
- Strategy (scalp / swing)

## Disclaimer

Educational use only. Not financial advice.
**Confidence is a technical score (0–100), not a real win-probability.**
Trade at your own risk. Auto Trading (real order execution) is intentionally left unimplemented/disabled in this build.

