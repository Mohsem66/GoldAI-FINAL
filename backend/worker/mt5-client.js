// The worker talks DIRECTLY to the MT5 bridge (default :5001) — not through
// the Express backend (:5000). This means the worker keeps monitoring MT5
// and generating signals even if the Express backend/frontend process is
// down entirely; the Express backend is only a read-only viewer of what the
// worker already wrote to backend/data/signals.json.
const axios = require("axios");

const BRIDGE_URL = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const DEFAULT_SYMBOL = process.env.MT5_SYMBOL || "XAUUSD.";

async function health() {
  const res = await axios.get(`${BRIDGE_URL}/health`, { timeout: 4000 });
  return res.data;
}

async function currentPrice(symbol) {
  const res = await axios.get(`${BRIDGE_URL}/current-price`, {
    params: { symbol: symbol || DEFAULT_SYMBOL },
    timeout: 5000,
  });
  return res.data;
}

async function candles(timeframe, count, symbol) {
  const res = await axios.get(`${BRIDGE_URL}/candles`, {
    params: { symbol: symbol || DEFAULT_SYMBOL, timeframe, count },
    timeout: 15000,
  });
  return res.data;
}

async function symbolInfo(symbol) {
  const res = await axios.get(`${BRIDGE_URL}/symbol-info`, {
    params: { symbol: symbol || DEFAULT_SYMBOL },
    timeout: 5000,
  });
  return res.data;
}

module.exports = { BRIDGE_URL, DEFAULT_SYMBOL, health, currentPrice, candles, symbolInfo };
