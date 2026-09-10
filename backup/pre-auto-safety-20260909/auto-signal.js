// =====================================================================
// GoldAI — Automatic Signal Monitor
// -----------------------------------------------------------------------
// Detects a NEWLY CLOSED candle (M5 for scalp, M15 for swing) and, only
// then, runs exactly one evaluation through the SAME pipeline as the
// manual "▶ شروع تحلیل AI" button (window.GoldAI.analyze() — not a
// parallel/duplicate analysis implementation).
//
// Hard rules enforced here:
//   - Never evaluates unless window.GoldAI_Data.dataMode === "live" AND
//     livePriceOk is true (real MT5 tick). Demo/offline data NEVER
//     produces an automatic signal.
//   - At most one evaluation per closed candle: dedup key is
//     symbol + timeframe + candle-close-timestamp.
//   - Results go to the signal journal (localStorage).
//   - If window.GoldAI_Config.TRADE_MODE === "auto", it will also call
//     window.GoldAI.executeCurrentTrade("auto") for valid signals.
// =====================================================================

window.GoldAI_AutoSignal = (function () {
  const JOURNAL_KEY = "goldai_auto_signal_journal";
  const JOURNAL_CAP = 300;
  let timer = null;
  let lastCandleKey = null;
  let busy = false;

  function tfForMode(cfg) {
    // CENTRAL TIMEFRAME: the auto-signal candle-close watcher must poll the
    // SAME timeframe the user selected on the Dashboard — never a separate
    // hardcoded M5/M15 choice of its own.
    return String(cfg.ACTIVE_TIMEFRAME || "m5").toUpperCase();
  }

  function setStatus(text) {
    const el = document.getElementById("autoSignalStatus");
    if (el) el.textContent = text;
  }

  function readJournal() {
    try { return JSON.parse(localStorage.getItem(JOURNAL_KEY) || "[]"); } catch (_) { return []; }
  }
  function writeJournal(arr) {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(arr.slice(-JOURNAL_CAP))); } catch (_) {}
  }
  function logEntry(entry) {
    const j = readJournal();
    j.push(entry);
    writeJournal(j);
  }

  async function tick() {
    const cfg = window.GoldAI_Config || {};
    const data = window.GoldAI_Data;
    if (!cfg.AUTO_SIGNAL_ENABLED || busy) return;

    // Signal must come from valid LIVE MT5 data only — never demo/offline.
    if (!data || data.dataMode !== "live" || !data.livePriceOk) {
      setStatus("⏸ غیرفعال — قیمت زنده از MT5 در دسترس نیست (Signal Trading = Disabled)");
      return;
    }

    const tf = tfForMode(cfg);
    const symbol = cfg.SYMBOL || "XAUUSD.";
    let res;
    try {
      res = await data.fetchMT5History(tf, 2); // cheap peek — just the latest closed bar(s)
    } catch (e) {
      setStatus("خطا در بررسی کندل جدید: " + e.message);
      return;
    }
    if (!res || res.status !== "ok" || !res.candles || !res.candles.length) {
      setStatus("⏸ کندل واقعی MT5 در دسترس نیست (" + tf + ")");
      return;
    }

    const lastClosed = res.candles[res.candles.length - 1]; // bridge already excludes the still-forming bar
    const key = symbol + "|" + tf + "|" + lastClosed.time;
    if (key === lastCandleKey) {
      setStatus("👁 در حال پایش — منتظر بسته‌شدن کندل بعدی " + tf);
      return; // same candle already evaluated — never duplicate a signal for it
    }

    busy = true;
    lastCandleKey = key;
    setStatus("⏳ کندل جدید " + tf + " بسته شد — در حال ارزیابی...");
    try {
      await window.GoldAI.analyze(); // exact same Decision Pipeline as the manual button
      const result = window.GoldAI_V1_Result;
      if (result) {
        let execution = null;
        const autoEnabled = cfg.TRADE_MODE === "auto" && cfg.AUTO_TRADING_ENABLED === true;
        const minConf = Number(cfg.AUTO_MIN_CONFIDENCE || 80);
        const actionable = result.signal && !String(result.signal).includes("WAIT");
        if (autoEnabled && actionable && Number(result.confidence || 0) >= minConf) {
          execution = await window.GoldAI.executeCurrentTrade("auto");
        }
        logEntry({
          source: "auto", candleKey: key, symbol, timeframe: tf,
          timestamp: result.timestamp, signal: result.signal,
          confidence: result.confidence, entry: result.entry,
          stopLoss: result.stopLoss, tp1: result.tp1, tp2: result.tp2, tp3: result.tp3,
          reason: result.reason, warnings: result.warnings,
          executionEligible: autoEnabled && actionable && Number(result.confidence || 0) >= minConf,
          executionStatus: execution ? (execution.ok ? "FILLED" : "REJECTED") : "NOT_SENT"
        });
        if (autoEnabled && actionable && Number(result.confidence || 0) >= minConf) {
          setStatus(execution && execution.ok
            ? "✅ سیگنال خودکار اجرا شد — " + new Date().toLocaleTimeString("fa-IR")
            : "⚠️ سیگنال ایجاد شد ولی معامله اجرا نشد");
        } else if (autoEnabled && actionable) {
          setStatus("👁 سیگنال زیر حداقل اطمینان AUTO بود — معامله ارسال نشد");
        }
      }
      setStatus(document.getElementById("autoSignalStatus")?.textContent || ("آخرین ارزیابی: " + new Date().toLocaleTimeString("fa-IR")));
    } catch (e) {
      setStatus("خطا در تحلیل خودکار: " + e.message);
    } finally {
      busy = false;
    }
  }

  function start() {
    const cfg = window.GoldAI_Config || {};
    cfg.AUTO_SIGNAL_ENABLED = true;
    if (timer) clearInterval(timer);
    tick();
    timer = setInterval(tick, cfg.AUTO_SIGNAL_POLL_MS || 15000);
  }

  function stop() {
    const cfg = window.GoldAI_Config || {};
    cfg.AUTO_SIGNAL_ENABLED = false;
    if (timer) { clearInterval(timer); timer = null; }
    setStatus("خاموش");
  }

  function toggle(on) { if (on) start(); else stop(); }

  function showJournal() {
    const wrap = document.getElementById("autoSignalJournalWrap");
    const table = document.getElementById("autoSignalJournalTable");
    if (!wrap || !table) return;
    const rows = readJournal().slice(-100).reverse();
    const head = "<tr>" + ["Time", "TF", "Signal", "Conf", "Entry", "SL", "TP1", "Reason"]
      .map(h => "<th style='padding:4px 6px;border-bottom:1px solid #2a2a35;text-align:left'>" + h + "</th>").join("") + "</tr>";
    const body = rows.map(r => {
      const td = v => "<td style='padding:3px 6px;border-bottom:1px solid #1c1c26'>" + (v == null ? "—" : v) + "</td>";
      const t = r.timestamp ? new Date(r.timestamp).toLocaleString("fa-IR") : "—";
      return "<tr>" + td(t) + td(r.timeframe) + td(r.signal) + td(r.confidence) + td(r.entry) + td(r.stopLoss) + td(r.tp1) + td((r.reason || "").slice(0, 60)) + "</tr>";
    }).join("");
    table.innerHTML = head + body;
    wrap.classList.toggle("hidden");
  }

  function clearJournal() {
    writeJournal([]);
    const table = document.getElementById("autoSignalJournalTable");
    if (table) table.innerHTML = "";
  }

  function getJournal() { return readJournal(); }

  return { start, stop, toggle, tick, showJournal, clearJournal, getJournal };
})();
