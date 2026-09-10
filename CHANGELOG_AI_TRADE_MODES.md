# GoldAI — Two Trade Modes

Implemented from the uploaded project.

## MANUAL
- AI calculates the initial Entry/SL/TP1/Lot.
- User can edit those values in the execution panel.
- Explicit button sends the order.
- Broker/MT5 validation remains authoritative.

## AUTO
- Requires TRADE_MODE=auto AND AUTO_TRADING_ENABLED=true.
- Runs only on newly closed M5/M15 candle through the existing auto-signal monitor.
- Requires AUTO_MIN_CONFIDENCE (default 80) and Risk Guard permission.
- Only FILLED orders increment the daily trade counter.
- Duplicate HTTP retries are protected with clientOrderId.

## MT5 bridge
- Uses live bid/ask for market execution.
- Validates SL/TP direction and broker minimum stop distance.
- Attempts to use a symbol-supported filling mode.
- Adds AUTO/MANUAL order comments for transparent identification.
- No attempt is made to bypass broker/MT5 controls or disguise automation.

## Important
The original project had a Risk Guard bug: every BUY/SELL analysis incremented the trade counter even though no order was sent. That behavior was removed; only a successful FILLED order increments the counter.
