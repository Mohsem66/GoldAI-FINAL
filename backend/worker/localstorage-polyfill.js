// js/engines/risk-guard.js calls the browser's localStorage. This gives the
// worker (a headless Node process, no browser) the same API, backed by a
// single JSON file, so RiskGuard's daily-loss/max-trades counters persist
// across worker restarts exactly like they would across browser reloads.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data", "localstorage-polyfill.json");

function load() {
  try {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
  } catch (_) {
    return {};
  }
}

function save(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, FILE);
  } catch (_) { /* never let this crash the worker */ }
}

let store = load();

module.exports = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
  setItem(key, value) { store[key] = String(value); save(store); },
  removeItem(key) { delete store[key]; save(store); },
  clear() { store = {}; save(store); },
};
