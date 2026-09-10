// Loads js/engines/*.js (written as `window.GoldAI_X = ...` browser globals)
// into a Node process by giving them a fake `window`. This is the ONLY way
// the worker and the frontend/backtest share one analysis implementation
// instead of a second, hand-ported copy drifting out of sync over time.
//
// Deliberately does NOT load js/core/data.js (browser fetch()-based, talks to
// the Express /api layer) or js/app.js (full of DOM calls) — the worker talks
// to the MT5 bridge directly (see mt5-client.js) and builds signals via
// js/engines/backtest.js's exported buildSignal()/resample() helpers, the
// exact same functions the Real MT5 Backtest already uses for every bar.
const fs = require("fs");
const path = require("path");

const JS_ROOT = path.join(__dirname, "..", "..", "js");

const FILES = [
  "config.js",
  "core/ema.js",
  "engines/rsi.js",
  "engines/divergence.js",
  "engines/market-structure.js",
  "engines/macd.js",
  "engines/adx.js",
  "engines/atr.js",
  "engines/volume.js",
  "engines/support-resistance.js",
  "engines/candles.js",
  "engines/liquidity.js",
  "engines/score.js",
  "engines/conflict-filter.js",
  "engines/risk-guard.js",
  "engines/trade-management.js",
  "engines/backtest.js",
];

function loadEngines() {
  const fakeWindow = {};
  fakeWindow.localStorage = require("./localstorage-polyfill");
  // conflict-filter.js reads window.GoldAI_Data.dataMode directly — the worker
  // updates this object's fields before every buildSignal() call.
  fakeWindow.GoldAI_Data = { dataMode: "offline", livePriceOk: false };

  const sandbox = { window: fakeWindow, console, require, module: { exports: {} } };

  for (const rel of FILES) {
    const full = path.join(JS_ROOT, rel);
    const code = fs.readFileSync(full, "utf8");
    // eslint-disable-next-line no-new-func
    const fn = new Function("window", "console", code);
    fn(fakeWindow, console);
  }

  return fakeWindow;
}

module.exports = { loadEngines, JS_ROOT };
