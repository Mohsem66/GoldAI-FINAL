// Observation-only sink for Diagnostic Signal Attribution.
// - Output ONLY: backend/worker/data/attribution.jsonl (+ attribution.1.jsonl, attribution.2.jsonl archives).
// - Never touches signals.json.
// - enqueue() is synchronous-cheap (stringify + push); all file I/O runs asynchronously off the decision path.
// - Bounded queue; rotation at maxBytes (default 50 MB), max 2 archives.
// - Every failure (mkdir/stat/rotate/append) is swallowed and counted; nothing here can throw into the Worker.
const fs = require("fs");
const path = require("path");

const cfg = {
  dir: path.join(__dirname, "data"),
  maxBytes: 50 * 1024 * 1024,
  maxArchives: 2,
  maxQueue: 2000
};
let queue = [];
let running = false;
const counters = { written: 0, dropped: 0, errors: 0, rotations: 0 };

function configure(o) { Object.assign(cfg, o || {}); }
function stats() { return Object.assign({ queued: queue.length }, counters); }
function pathOf(n) { return path.join(cfg.dir, n === 0 ? "attribution.jsonl" : "attribution." + n + ".jsonl"); }

function enqueue(record) {
  try {
    const line = JSON.stringify(record) + "\n";
    if (queue.length >= cfg.maxQueue) { counters.dropped++; return false; }
    queue.push(line);
    if (!running) { running = true; setImmediate(drain); }
    return true;
  } catch (_) { counters.errors++; return false; }
}

async function rotate() {
  const max = cfg.maxArchives;
  try { await fs.promises.unlink(pathOf(max)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (let n = max - 1; n >= 1; n--) {
    try { await fs.promises.rename(pathOf(n), pathOf(n + 1)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  await fs.promises.rename(pathOf(0), pathOf(1));
  counters.rotations++;
}

async function drain() {
  try {
    await fs.promises.mkdir(cfg.dir, { recursive: true });
    while (queue.length) {
      const line = queue.shift();
      const len = Buffer.byteLength(line);
      const file = pathOf(0);
      let size = 0;
      try { size = (await fs.promises.stat(file)).size; } catch (_) { size = 0; }
      if (size > 0 && size + len > cfg.maxBytes) {
        try { await rotate(); } catch (_) { counters.errors++; }
        try { size = (await fs.promises.stat(file)).size; } catch (_) { size = 0; }
        if (size > 0 && size + len > cfg.maxBytes) { counters.dropped++; continue; } // rotation failed: stay bounded, drop
      }
      try { await fs.promises.appendFile(file, line, "utf8"); counters.written++; } catch (_) { counters.errors++; }
    }
  } catch (_) {
    counters.errors++;
    counters.dropped += queue.length; queue.length = 0;
  } finally {
    running = false;
    if (queue.length) { running = true; setImmediate(drain); }
  }
}

function flush() {
  return new Promise((resolve) => {
    const t = () => (!running && !queue.length) ? resolve() : setTimeout(t, 5);
    t();
  });
}

module.exports = { enqueue, flush, configure, stats, _pathOf: pathOf };
