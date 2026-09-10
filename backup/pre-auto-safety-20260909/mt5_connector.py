#!/usr/bin/env python3
"""GoldAI MT5 Bridge — Flask on :5001. DEMO only until validated."""

import os
import time
from datetime import datetime
from flask import Flask, request, jsonify
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

MT5_LOGIN = os.getenv("MT5_LOGIN")
MT5_PASSWORD = os.getenv("MT5_PASSWORD")
MT5_SERVER = os.getenv("MT5_SERVER", "ICMarkets-Demo")
MT5_PATH = os.getenv("MT5_PATH") or None
PORT = int(os.getenv("BRIDGE_PORT", "5001"))

# Central default + resolution order for this broker's gold symbol. XAUUSD. and
# XAUUSD are NOT the same MT5 symbol for this broker (the trailing dot matters) —
# see MT5-CONNECTION-NOTES.md. Every endpoint below resolves through the same
# two helpers so the mapping only has to be right in one place.
DEFAULT_SYMBOL = os.getenv("MT5_SYMBOL", "XAUUSD.")


def _symbol_candidates(requested):
    req = requested or DEFAULT_SYMBOL
    raw = [req, req.replace("/", ""), "XAUUSD.", "XAUUSD", "GOLD"]
    seen, out = set(), []
    for c in raw:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def resolve_symbol_tick(mt5, requested):
    """Returns (used_symbol, tick) — tick is None if no candidate resolved."""
    for s in _symbol_candidates(requested):
        tick = mt5.symbol_info_tick(s)
        if tick is not None:
            return s, tick
    return requested or DEFAULT_SYMBOL, None


def resolve_symbol_info(mt5, requested):
    """Returns (used_symbol, symbol_info) — info is None if no candidate resolved."""
    for s in _symbol_candidates(requested):
        info = mt5.symbol_info(s)
        if info is not None:
            return s, info
    return requested or DEFAULT_SYMBOL, None


_mt5 = None
_connected = False
_EXECUTION_CACHE = {}  # clientOrderId -> recent result, prevents duplicate HTTP retries
_EXECUTION_CACHE_TTL = 300


def try_import_mt5():
    global _mt5
    if _mt5 is not None:
        return _mt5
    try:
        import MetaTrader5 as mt5
        _mt5 = mt5
        return mt5
    except ImportError:
        return None


def ensure_connected():
    global _connected
    mt5 = try_import_mt5()
    if mt5 is None:
        return False, "MetaTrader5 package not installed (pip install MetaTrader5)"

    if _connected:
        info = mt5.terminal_info()
        if info is not None:
            return True, "already connected"

    init_kwargs = {}
    if MT5_PATH:
        init_kwargs["path"] = MT5_PATH
    if not mt5.initialize(**init_kwargs):
        return False, f"initialize failed: {mt5.last_error()}"

    # The terminal may already be logged into the correct account (this is the
    # normal case when a person has MT5 open and signed in themselves). Check
    # the ALREADY-ACTIVE session via account_info() before ever calling
    # mt5.login() again — re-authorizing an already-correct session is what
    # was producing "(-6, 'Terminal: Authorization failed')".
    acc = mt5.account_info()
    already_correct = (
        acc is not None
        and MT5_LOGIN
        and acc.login == int(MT5_LOGIN)
        and str(acc.server).strip().casefold() == str(MT5_SERVER).strip().casefold()
    )

    if not already_correct and MT5_LOGIN and MT5_PASSWORD:
        authorized = mt5.login(int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
        if not authorized:
            err = mt5.last_error()
            mt5.shutdown()
            return False, f"login failed: {err}"

    _connected = True
    return True, "connected"


@app.get("/health")
def health():
    mt5 = try_import_mt5()
    if mt5 is None:
        return jsonify({
            "status": "degraded", "connected": False,
            "executionState": "DISCONNECTED",
            "message": "MetaTrader5 Python package missing"
        })
    ok, msg = ensure_connected()
    login = None
    server = MT5_SERVER
    if ok:
        try:
            acc = mt5.account_info()
            if acc is not None:
                login = acc.login
                server = acc.server
        except Exception:
            pass
    return jsonify({
        "status": "online" if ok else "degraded",
        "connected": ok,
        "executionState": "READY" if ok else "DISCONNECTED",
        "message": msg,
        "login": login,
        "server": server,
        "symbol": DEFAULT_SYMBOL
    })


@app.get("/account-info")
def account_info():
    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"balance": 0, "equity": 0, "freeMargin": 0, "status": "unavailable", "message": msg})
    mt5 = try_import_mt5()
    acc = mt5.account_info()
    if acc is None:
        return jsonify({"balance": 0, "equity": 0, "freeMargin": 0, "status": "unavailable"})
    return jsonify({
        "balance": acc.balance, "equity": acc.equity, "freeMargin": acc.margin_free,
        "currency": acc.currency, "leverage": acc.leverage, "status": "ok"
    })


@app.get("/current-price")
def current_price():
    symbol = request.args.get("symbol", DEFAULT_SYMBOL)
    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"price": 0, "bid": 0, "ask": 0, "status": "unavailable", "message": msg})
    mt5 = try_import_mt5()
    used, tick = resolve_symbol_tick(mt5, symbol)
    if tick is None:
        return jsonify({"price": 0, "status": "unavailable", "message": "symbol tick not found"})
    mid = (tick.bid + tick.ask) / 2
    return jsonify({
        "symbol": used, "price": mid, "bid": tick.bid, "ask": tick.ask,
        "spread": round(tick.ask - tick.bid, 5), "status": "ok"
    })


@app.get("/symbol-info")
def symbol_info():
    symbol = request.args.get("symbol", DEFAULT_SYMBOL)
    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"status": "unavailable", "message": msg})
    mt5 = try_import_mt5()
    used, info = resolve_symbol_info(mt5, symbol)
    if info is None:
        return jsonify({"status": "unavailable", "message": "symbol not found"})
    return jsonify({
        "status": "ok", "symbol": used, "digits": info.digits, "point": info.point,
        "trade_contract_size": info.trade_contract_size,
        "volume_min": info.volume_min, "volume_max": info.volume_max, "volume_step": info.volume_step,
        "trade_tick_value": info.trade_tick_value, "trade_tick_size": info.trade_tick_size,
        "currency_profit": info.currency_profit
    })


TIMEFRAME_MAP = {
    "M1": "TIMEFRAME_M1",
    "M5": "TIMEFRAME_M5",
    "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H4": "TIMEFRAME_H4",
    "D1": "TIMEFRAME_D1",
}

# Seconds per bar, keyed the same as TIMEFRAME_MAP's values — used only to
# detect and drop the still-forming (not yet closed) bar in /candles.
TF_SECONDS_BY_ATTR = {
    "TIMEFRAME_M1": 60, "TIMEFRAME_M5": 300, "TIMEFRAME_M15": 900,
    "TIMEFRAME_M30": 1800, "TIMEFRAME_H1": 3600, "TIMEFRAME_H4": 14400, "TIMEFRAME_D1": 86400,
}


def _parse_dt(value):
    """Parse an optional 'start'/'end' query param into a naive UTC datetime
    for mt5.copy_rates_range(). Accepts epoch seconds, 'YYYY-MM-DD',
    'YYYY-MM-DD HH:MM[:SS]', or ISO 'YYYY-MM-DDTHH:MM[:SS][Z]'.
    Returns None if missing/unparseable (caller then falls back to the
    existing count-based copy_rates_from_pos path — fully backward compatible)."""
    if value is None or str(value).strip() == "":
        return None
    s = str(value).strip()
    try:
        return datetime.utcfromtimestamp(float(s))
    except (TypeError, ValueError):
        pass
    s2 = s.replace("Z", "").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s2, fmt)
        except ValueError:
            continue
    return None


@app.get("/candles")
def candles():
    symbol = request.args.get("symbol", DEFAULT_SYMBOL)
    timeframe = (request.args.get("timeframe") or "M5").upper()

    try:
        count = int(request.args.get("count", 120))
    except (TypeError, ValueError):
        count = 120
    count = max(10, min(count, 5000))

    # Optional real date-range mode (NEW, additive) — only activates when BOTH
    # start and end are present and valid; otherwise behaves exactly as before
    # (copy_rates_from_pos with `count`). Nothing about the existing
    # count-based request shape changed.
    date_from = _parse_dt(request.args.get("start"))
    date_to = _parse_dt(request.args.get("end"))
    use_range = date_from is not None and date_to is not None
    if use_range and date_from >= date_to:
        return jsonify({"status": "error", "message": "start must be before end", "candles": []})

    tf_attr = TIMEFRAME_MAP.get(timeframe)
    if tf_attr is None:
        return jsonify({"status": "error", "message": f"unsupported timeframe {timeframe}", "candles": []})

    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"status": "unavailable", "message": msg, "candles": []})

    mt5 = try_import_mt5()
    tf_value = getattr(mt5, tf_attr, None)
    if tf_value is None:
        return jsonify({"status": "error", "message": f"MT5 module missing {tf_attr}", "candles": []})

    used, info = resolve_symbol_info(mt5, symbol)
    if info is None:
        return jsonify({"status": "unavailable", "message": f"symbol {symbol} not found in MT5", "candles": []})
    if not info.visible:
        mt5.symbol_select(used, True)

    if use_range:
        rates = mt5.copy_rates_range(used, tf_value, date_from, date_to)
    else:
        rates = mt5.copy_rates_from_pos(used, tf_value, 0, count)
    if rates is None or len(rates) == 0:
        return jsonify({
            "status": "unavailable",
            "message": f"no rates for {used}/{timeframe}: {mt5.last_error()}",
            "candles": []
        })

    # copy_rates_from_pos(..., 0, count) always includes the CURRENTLY-FORMING
    # bar at index 0 (pos=0 is "now"). That bar's OHLC is still changing, so it
    # must never be treated as a closed candle by the analysis/backtest engines.
    # Drop it here — every caller gets only fully-closed candles.
    now_epoch = None
    try:
        tick = mt5.symbol_info_tick(used)
        if tick is not None:
            now_epoch = int(tick.time)
    except Exception:
        now_epoch = None
    tf_seconds = TF_SECONDS_BY_ATTR.get(tf_attr)
    if tf_seconds and rates is not None and len(rates) > 0:
        last = rates[-1]
        is_forming = (now_epoch is not None and int(last["time"]) + tf_seconds > now_epoch)
        if is_forming:
            rates = rates[:-1]

    if rates is None or len(rates) == 0:
        return jsonify({"status": "unavailable", "message": "no CLOSED candles available yet", "candles": []})

    out = []
    prev_time = None
    for r in rates:
        t = int(r["time"])
        if prev_time is not None and t <= prev_time:
            continue  # guards against any duplicate/out-of-order bar from MT5
        prev_time = t
        out.append({
            "time": t,
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "tick_volume": int(r["tick_volume"]),
            "spread": int(r["spread"]),
            "real_volume": int(r["real_volume"]),
        })

    return jsonify({"status": "ok", "symbol": used, "timeframe": timeframe, "count": len(out), "candles": out, "rangeMode": use_range})


@app.post("/execute-trade")
def execute_trade():
    data = request.get_json(force=True, silent=True) or {}
    signal = (data.get("signal") or "").upper()
    volume = float(data.get("volume") or 0.01)
    sl = data.get("stopLoss") or data.get("sl")
    tp1 = data.get("tp1")
    symbol_req = data.get("symbol") or DEFAULT_SYMBOL
    mode = str(data.get("mode") or "manual").lower()
    client_id = str(data.get("clientOrderId") or "").strip()
    deviation = int(data.get("deviation") or 20)

    if "BUY" not in signal and "SELL" not in signal:
        return jsonify({"status": "ERROR", "message": "signal must be BUY or SELL"})
    if mode not in ("manual", "auto"):
        return jsonify({"status": "ERROR", "message": "mode must be manual or auto"})

    # Idempotency for browser/network retries. A retry with the same client id
    # returns the original result instead of placing a second market order.
    now = time.time()
    for k, v in list(_EXECUTION_CACHE.items()):
        if now - v.get("_ts", 0) > _EXECUTION_CACHE_TTL:
            _EXECUTION_CACHE.pop(k, None)
    if client_id and client_id in _EXECUTION_CACHE:
        cached = dict(_EXECUTION_CACHE[client_id])
        cached.pop("_ts", None)
        cached["duplicateRequest"] = True
        return jsonify(cached)

    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"status": "DISCONNECTED", "message": msg})

    mt5 = try_import_mt5()
    symbol, info = resolve_symbol_info(mt5, symbol_req)
    if info is None:
        return jsonify({"status": "ERROR", "message": f"symbol {symbol_req} not found in MT5"})

    if not info.visible:
        if not mt5.symbol_select(symbol, True):
            return jsonify({"status": "ERROR", "message": f"could not select symbol {symbol}"})

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return jsonify({"status": "ERROR", "message": "no tick"})

    side_buy = "BUY" in signal
    order_type = mt5.ORDER_TYPE_BUY if side_buy else mt5.ORDER_TYPE_SELL
    price = tick.ask if side_buy else tick.bid

    # Market execution uses the live MT5 ask/bid. The AI/user Entry is retained
    # as a reference but is never substituted for the broker's live execution price.
    try:
        volume = max(float(info.volume_min), min(float(volume), float(info.volume_max)))
        step = float(info.volume_step or 0.01)
        volume = round(round(volume / step) * step, 8)
    except Exception:
        return jsonify({"status": "ERROR", "message": "invalid volume"})

    # Validate SL/TP direction and broker minimum stop distance.
    try:
        sl_f = float(sl) if sl not in (None, "") else None
        tp_f = float(tp1) if tp1 not in (None, "") else None
        point = float(info.point or 0)
        stops_level = float(getattr(info, "trade_stops_level", 0) or 0)
        min_dist = stops_level * point
        if sl_f is not None:
            if (side_buy and sl_f >= price) or ((not side_buy) and sl_f <= price):
                return jsonify({"status": "ERROR", "message": "invalid SL side for live execution price"})
            if min_dist and abs(price - sl_f) < min_dist:
                return jsonify({"status": "ERROR", "message": f"SL is closer than broker minimum stop distance ({min_dist})"})
        if tp_f is not None:
            if (side_buy and tp_f <= price) or ((not side_buy) and tp_f >= price):
                return jsonify({"status": "ERROR", "message": "invalid TP side for live execution price"})
            if min_dist and abs(tp_f - price) < min_dist:
                return jsonify({"status": "ERROR", "message": f"TP is closer than broker minimum stop distance ({min_dist})"})
    except (TypeError, ValueError):
        return jsonify({"status": "ERROR", "message": "invalid SL/TP"})

    # Use a filling mode accepted by this symbol instead of assuming IOC.
    filling = getattr(info, "filling_mode", None)
    if filling in (getattr(mt5, "ORDER_FILLING_FOK", -1), getattr(mt5, "ORDER_FILLING_IOC", -2), getattr(mt5, "ORDER_FILLING_RETURN", -3)):
        type_filling = filling
    else:
        type_filling = getattr(mt5, "ORDER_FILLING_IOC", 1)

    request_order = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "deviation": max(0, min(deviation, 100)),
        "magic": 20250817,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": type_filling,
    }
    if sl_f is not None:
        request_order["sl"] = sl_f
    if tp_f is not None:
        request_order["tp"] = tp_f

    result = mt5.order_send(request_order)
    if result is None:
        out = {"status": "ERROR", "message": str(mt5.last_error()), "executionState": "ERROR"}
    elif result.retcode != mt5.TRADE_RETCODE_DONE:
        out = {"status": "ERROR", "retcode": result.retcode, "message": result.comment, "executionState": "ERROR"}
    else:
        out = {
            "status": "FILLED", "executionState": "FILLED",
            "order": result.order, "deal": getattr(result, "deal", None),
            "volume": volume, "price": result.price, "symbol": symbol,
            "mode": mode
        }

    if client_id:
        cached = dict(out)
        cached["_ts"] = now
        _EXECUTION_CACHE[client_id] = cached
    return jsonify(out)


@app.get("/positions")
def positions():
    ok, msg = ensure_connected()
    if not ok:
        return jsonify({"positions": [], "count": 0, "status": "unavailable", "message": msg})
    mt5 = try_import_mt5()
    pos = mt5.positions_get()
    if pos is None:
        return jsonify({"positions": [], "count": 0, "status": "ok"})
    out = []
    for p in pos:
        out.append({
            "ticket": p.ticket, "symbol": p.symbol,
            "type": "BUY" if p.type == 0 else "SELL",
            "volume": p.volume, "price_open": p.price_open,
            "sl": p.sl, "tp": p.tp, "profit": p.profit
        })
    return jsonify({"positions": out, "count": len(out), "status": "ok"})


if __name__ == "__main__":
    print(f"GoldAI MT5 Bridge on http://0.0.0.0:{PORT}")
    print("Use DEMO account only until fully validated.")
    app.run(host="0.0.0.0", port=PORT, debug=False)
