# GoldAI Trade Execution Update — AI Handoff

This package is based on the uploaded GoldAI-AI-DEV.zip.

## Required behavior

GoldAI now has two supported execution modes:

1. MANUAL (default)
   - GoldAI calculates signal, entry reference, SL, TP1 and lot.
   - The user can edit Entry/SL/TP1/Lot before sending.
   - The user explicitly clicks “تأیید و ارسال به MT5”.
   - Broker/MT5 constraints remain authoritative; invalid stop distances or directions must be rejected.

2. AUTO (opt-in)
   - AUTO requires BOTH:
     - `TRADE_MODE === "auto"`
     - `AUTO_TRADING_ENABLED === true`
   - Auto Signal Monitor evaluates only a newly closed candle.
   - Auto execution additionally requires confidence >= `AUTO_MIN_CONFIDENCE` and Risk Guard permission.
   - Only successful MT5 fills increment the daily trade counter.
   - Failed/rejected orders do not increment the counter.
   - Client order IDs prevent duplicate HTTP retries from placing a second order.

## Safety / execution rules

- Do not attempt to disguise automated activity or bypass broker/MT5 controls.
- Market orders execute at the live MT5 bid/ask. The displayed Entry is a reference; it is not substituted for the live market execution price.
- SL/TP direction and broker minimum stop distance are validated.
- The bridge uses a symbol-supported filling mode when possible.
- Auto mode is OFF by default.

## Important existing correction

The old `app.js` incremented Risk Guard trade count merely when an analysis produced BUY/SELL. That was incorrect. The count is now incremented only after a real order returns `FILLED`.

## Files changed

- `index.html`
- `js/config.js`
- `js/app.js`
- `js/engines/risk-guard.js`
- `js/engines/auto-signal.js`
- `js/ui-extras.js`
- `routes/mt5.js`
- `mt5_connector.py`

No `.env` or credentials are included.
