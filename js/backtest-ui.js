// =====================================================================
// GoldAI — Backtest panel (rebuilt 2026-10-07, phone-first)
// - timeframe chips (M1 … D1), independent of the dashboard timeframe
// - period chips (1 day … 1 year) + from/to dates
// - run / stop / reset / delete history / export file
// - traded vs. NOT-traded signals (engine "shadow" option), grouped by reason
// - check of the worker's REAL signals (executed and not executed) on real candles
// The engine itself is js/engines/backtest.js (runRealMT5Backtest / auditSignals).
// =====================================================================
(function () {
  function ready() {
    if (!window.GoldAI || !window.GoldAI_Data || !window.GoldAI_Backtest || !document.getElementById("btTfSelect") ||
        !window.GoldAI.__showPanelWrapped) { // wait until ui-extras.js has finished (we replace its backtest functions)
      return setTimeout(ready, 50);
    }
    var G = window.GoldAI, D = window.GoldAI_Data, B = window.GoldAI_Backtest;
    var HKEY = "goldai_bt_history", MAX_HIST = 20, MAX_TEST_BARS = 120000;
    var PERIOD_DAYS = { "1d": 1, "1w": 7, "1m": 30, "3m": 91, "6m": 182, "1y": 365 };
    var st = { tf: null, period: "1m", running: false, stop: false, report: null, audit: null, view: "traded", minConf: null };

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    var num = function (v, d) { var n = Number(v); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: d == null ? 2 : d, minimumFractionDigits: 0 }) : "—"; };
    var backend = function () { return String((window.GoldAI_Config || {}).BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, ""); };
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var ymd = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var faDate = function (iso) { if (!iso) return "—"; var d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleDateString("fa-IR"); };
    var faShort = function (sec) {
      var d = new Date(sec * 1000); if (isNaN(d)) return "—";
      return d.toLocaleDateString("fa-IR", { month: "2-digit", day: "2-digit" }) + " " + d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
    };

    var LABEL = {
      SIGNAL_DEDUP: "تکراری (کمتر از ۴ کندل بعد از سیگنال قبلی)",
      SIGNAL_CLUSTER: "تکراری",
      LOW_CONFIDENCE: "اطمینان کمتر از حد موتور",
      AUTO_MIN_CONFIDENCE: "اطمینان کمتر از حد ارسال خودکار",
      HTF_AGAINST: "خلاف روند تایم‌فریم بالاتر",
      REGIME_RANGE: "بازار بدون روند (رنج)",
      LOW_EDGE: "برتری خرید/فروش کم",
      RR_BELOW_MIN: "سود به ضرر کمتر از ۱ به ۱",
      POSITION_OPEN: "معامله‌ی قبلی هنوز باز بود",
      DATA_MODE: "داده‌ی زنده نبود",
      RISK_GUARD: "حد ضرر روزانه",
      FILTERED: "فیلتر کیفیت",
      permission: "مجوز معامله",
      EXECUTED: "اجرا شد",
      SKIPPED_MODE_NOT_AUTO: "حالت دستی بود",
      SKIPPED_SYSTEM_OFF: "سیستم خاموش بود",
      SKIPPED_AUTO_TRADING_OFF: "ارسال خودکار خاموش بود",
      SKIPPED_CONFIDENCE_LOW: "اطمینان کمتر از حد ارسال خودکار",
      SKIPPED_RR_BELOW_MIN: "سود به ضرر کمتر از ۱ به ۱",
      SKIPPED_NO_LIVE_PRICE: "قیمت زنده دریافت نشد",
      SKIPPED_WAIT_OR_INVALID: "رد شده",
      SKIPPED_NOT_ELIGIBLE: "شرایط اجرا نداشت",
      SKIPPED_NO_PLAN: "حد ضرر/سود ساخته نشد",
      REJECTED_OR_UNKNOWN: "کارگزار نپذیرفت / نامشخص",
      REQUEST_ERROR: "خطای ارسال سفارش",
      AUTH_FAILED: "خطای دسترسی",
      NOT_EXECUTED: "اجرا نشده"
    };
    var EXIT = { TP: "حد سود", SL: "حد ضرر", TIME: "پایان زمان", BREAKEVEN: "سربه‌سر", TRAIL: "حد ضرر متحرک", UNRESOLVED: "باز", OPEN: "باز", NO_LEVELS: "بی‌سطح" };
    var label = function (k) { return LABEL[k] || k || "—"; };

    // ---------- form ----------
    // ---- Persian (Jalali) calendar math (standard jalaali algorithm) ----
    var J = (function () {
      function div(a, b) { return ~~(a / b); }
      function mod(a, b) { return a - ~~(a / b) * b; }
      function jalCal(jy) {
        var breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];
        var gy = jy + 621, leapJ = -14, jp = breaks[0], jm, jump = 0, leap, leapG, march, n, i;
        for (i = 1; i < breaks.length; i++) { jm = breaks[i]; jump = jm - jp; if (jy < jm) break; leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4); jp = jm; }
        n = jy - jp;
        leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
        if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
        leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
        march = 20 + leapJ - leapG;
        if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
        leap = mod(mod(n + 1, 33) - 1, 4); if (leap === -1) leap = 4;
        return { leap: leap, gy: gy, march: march };
      }
      function g2d(gy, gm, gd) {
        var d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4) + div(153 * mod(gm + 9, 12) + 2, 5) + gd - 34840408;
        return d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
      }
      function d2g(jdn) {
        var j = 4 * jdn + 139361631; j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
        var i = div(mod(j, 1461), 4) * 5 + 308, gd = div(mod(i, 153), 5) + 1, gm = mod(div(i, 153), 12) + 1;
        return { gy: div(j, 1461) - 100100 + div(8 - gm, 6), gm: gm, gd: gd };
      }
      function j2d(jy, jm, jd) { var r = jalCal(jy); return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1; }
      function d2j(jdn) {
        var gy = d2g(jdn).gy, jy = gy - 621, r = jalCal(jy), k = jdn - g2d(gy, 3, r.march);
        if (k >= 0) { if (k <= 185) return { jy: jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 }; k -= 186; }
        else { jy -= 1; k += 179; if (r.leap === 1) k += 1; }
        return { jy: jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
      }
      return {
        fromDate: function (d) { return d2j(g2d(d.getFullYear(), d.getMonth() + 1, d.getDate())); },
        toDate: function (jy, jm, jd) { var g = d2g(j2d(jy, jm, jd)); return new Date(g.gy, g.gm - 1, g.gd); },
        monthLen: function (jy, jm) { return jm <= 6 ? 31 : jm <= 11 ? 30 : (jalCal(jy).leap === 0 ? 30 : 29); }
      };
    })();
    var FA_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
    var faNum = function (n) { return Number(n).toLocaleString("fa-IR", { useGrouping: false }); };
    var faDateText = function (d) { var j = J.fromDate(d); return faNum(j.jd) + " " + FA_MONTHS[j.jm - 1] + " " + faNum(j.jy); };

    function getPicked(id) {           // the Gregorian date stored on a date box (or null)
      var el = $(id), v = el && el.getAttribute("data-g");
      if (!v) return null; var a = v.split("-").map(Number); return new Date(a[0], a[1] - 1, a[2]);
    }
    function setPicked(id, d) {
      var el = $(id); if (!el) return;
      el.setAttribute("data-g", d ? ymd(d) : "");
      el.textContent = d ? faDateText(d) : "انتخاب تاریخ";
      el.classList.toggle("empty", !d);
    }
    function setPeriod(p) {
      st.period = p;
      var sel = $("btPeriodSelect"); if (sel && sel.value !== p) sel.value = p;
      if (p !== "custom") { setPicked("btCustomStart", null); setPicked("btCustomEnd", null); }
      showError("");
    }
    function setTf(tf) { st.tf = tf; var sel = $("btTfSelect"); if (sel && sel.value !== tf) sel.value = tf; updateInfo(); }
    function showError(msg) {
      var e = $("btRangeError"); if (!e) return;
      e.textContent = msg || ""; e.classList.toggle("hidden", !msg);
    }
    function readRange() {
      var now = new Date();
      if (st.period !== "custom" && PERIOD_DAYS[st.period]) {
        return { start: new Date(now.getTime() - PERIOD_DAYS[st.period] * 86400000), end: now };
      }
      var s = getPicked("btCustomStart"), e = getPicked("btCustomEnd");
      if (!s || !e) return { error: "تاریخ شروع و پایان را انتخاب کنید." };
      var start = new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0);
      var end = new Date(e.getFullYear(), e.getMonth(), e.getDate(), 23, 59, 59);
      if (end > now) end = now;
      if (start >= end) return { error: "تاریخ شروع باید قبل از تاریخ پایان باشد." };
      return { start: start, end: end };
    }

    // ---- Persian calendar sheet ----
    var cal = { which: null, jy: 0, jm: 0 };
    function openCalendar(which) {
      if (st.running) return;
      cal.which = which;
      var cur = getPicked(which === "start" ? "btCustomStart" : "btCustomEnd") || new Date();
      var j = J.fromDate(cur); cal.jy = j.jy; cal.jm = j.jm;
      var old = $("btCalSheet"); if (old) old.remove();
      document.body.insertAdjacentHTML("beforeend",
        "<div id='btCalSheet' class='modal-backdrop sm-backdrop bt2-cal-backdrop'><div class='modal-sheet sm-sheet bt2-cal' role='dialog' aria-label='انتخاب تاریخ'>" +
        "<div class='sm-grabber'></div>" +
        "<div class='bt2-cal-head'><b>" + (which === "start" ? "از تاریخ" : "تا تاریخ") + "</b><button type='button' class='sm-close' data-act='close' aria-label='بستن'>✕</button></div>" +
        "<div class='bt2-cal-nav'><button type='button' data-act='prev' aria-label='ماه قبل'>›</button><span id='btCalTitle'></span><button type='button' data-act='next' aria-label='ماه بعد'>‹</button></div>" +
        "<div class='bt2-cal-week'><span>ش</span><span>ی</span><span>د</span><span>س</span><span>چ</span><span>پ</span><span>ج</span></div>" +
        "<div class='bt2-cal-grid' id='btCalGrid'></div>" +
        "<div class='bt2-cal-actions'><button type='button' class='btn-ghost' data-act='today'>امروز</button><button type='button' class='btn-ghost' data-act='clear'>پاک کردن</button></div>" +
        "</div></div>");
      var sheet = $("btCalSheet");
      sheet.addEventListener("click", function (ev) {
        if (ev.target === sheet) return closeCalendar();
        var t = ev.target.closest ? ev.target.closest("button") : null; if (!t) return;
        var act = t.getAttribute("data-act");
        if (act === "close") closeCalendar();
        else if (act === "prev") { cal.jm--; if (cal.jm < 1) { cal.jm = 12; cal.jy--; } drawCalendar(); }
        else if (act === "next") { cal.jm++; if (cal.jm > 12) { cal.jm = 1; cal.jy++; } drawCalendar(); }
        else if (act === "today") pickDate(new Date());
        else if (act === "clear") { setPicked(cal.which === "start" ? "btCustomStart" : "btCustomEnd", null); closeCalendar(); }
        else if (t.hasAttribute("data-d")) pickDate(J.toDate(cal.jy, cal.jm, Number(t.getAttribute("data-d"))));
      });
      document.body.classList.add("sm-open");
      drawCalendar();
    }
    function closeCalendar() { var s = $("btCalSheet"); if (s) s.remove(); if (!$("settingsModal")) document.body.classList.remove("sm-open"); }
    function drawCalendar() {
      var title = $("btCalTitle"), grid = $("btCalGrid"); if (!grid) return;
      title.textContent = FA_MONTHS[cal.jm - 1] + " " + faNum(cal.jy);
      var first = J.toDate(cal.jy, cal.jm, 1), lead = (first.getDay() + 1) % 7; // Saturday = first column
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var picked = getPicked(cal.which === "start" ? "btCustomStart" : "btCustomEnd");
      var pickedKey = picked ? ymd(picked) : "";
      var html = "";
      for (var k = 0; k < lead; k++) html += "<span></span>";
      var n = J.monthLen(cal.jy, cal.jm);
      for (var d = 1; d <= n; d++) {
        var g = J.toDate(cal.jy, cal.jm, d), key = ymd(g);
        var cls = (key === ymd(today) ? " today" : "") + (key === pickedKey ? " sel" : "");
        html += "<button type='button' data-d='" + d + "' class='" + cls + "'" + (g > today ? " disabled" : "") + ">" + faNum(d) + "</button>";
      }
      grid.innerHTML = html;
      var nextBtn = $("btCalSheet").querySelector("[data-act='next']");
      var tj = J.fromDate(new Date());
      if (nextBtn) nextBtn.disabled = (cal.jy > tj.jy) || (cal.jy === tj.jy && cal.jm >= tj.jm);
    }
    function pickDate(d) {
      var id = cal.which === "start" ? "btCustomStart" : "btCustomEnd";
      setPicked(id, d);
      st.period = "custom"; var sel = $("btPeriodSelect"); if (sel) sel.value = "custom";
      showError("");
      closeCalendar();
    }
    async function loadMinConf() {
      try {
        var r = await fetch(backend() + "/mt5/trading-state", { cache: "no-store" });
        var j = await r.json();
        var v = Number(j && j.autoMinConfidence);
        if (Number.isFinite(v) && v > 0) st.minConf = v;
      } catch (_) {}
      if (!st.minConf) st.minConf = Number((window.GoldAI_Config || {}).AUTO_MIN_CONFIDENCE) || 80;
      updateInfo();
    }
    function capital() { return (D.getCapital && D.getCapital()) || 10000; }
    function riskPct() { return Number((window.GoldAI_Config || {}).DEFAULT_RISK_PERCENT) || 1; }
    function updateInfo() {
      var el = $("btInfoLine"); if (!el) return;
      el.innerHTML = "سرمایه <b>" + num(capital(), 0) + "$</b> و ریسک <b>" + num(riskPct(), 2) + "٪</b> از تنظیمات · حداقل اطمینان <b>" +
        (st.minConf || "…") + "</b> مثل ارسال خودکار";
    }

    // ---------- run ----------
    G.stopBacktest = function () { st.stop = true; var b = $("btStopBtn"); if (b) b.textContent = "⏳ در حال توقف…"; };

    function setRunning(on, btn, text) {
      st.running = on;
      ["btRunBtn", "btAuditBtn", "btResetBtn", "btDeleteBtn", "btCsvBtn", "btTfSelect", "btPeriodSelect", "btCustomStart", "btCustomEnd"].forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
      if (btn && text) btn.textContent = text;
      var stop = $("btStopBtn"); if (stop) { stop.classList.toggle("hidden", !on); stop.textContent = "⏹ توقف"; }
      var pr = $("btProgress"); if (pr) pr.classList.toggle("hidden", !on);
      progress(0);
    }
    function progress(f) {
      var bar = $("btProgressBar"), t = $("btProgressText");
      var p = Math.max(0, Math.min(100, Math.round((f || 0) * 100)));
      if (bar) bar.style.width = p + "%";
      if (t) t.textContent = p.toLocaleString("fa-IR") + "٪";
    }

    G.runBacktest = async function (btnEl) {
      if (st.running) return;
      var range = readRange();
      if (range.error) { showError(range.error); return; }
      showError("");
      var btn = btnEl || $("btRunBtn");
      st.stop = false;
      setRunning(true, btn, "⏳ در حال دریافت کندل‌ها…");
      var box = $("backtestSummary"), empty = $("backtestEmptyState"), jw = $("backtestJournalWrap");
      if (empty) empty.classList.add("hidden");
      if (jw) { jw.classList.add("hidden"); jw.innerHTML = ""; }
      if (box) { box.classList.remove("hidden"); box.innerHTML = "<div class='bt2-wait'>⏳ دریافت کندل‌های واقعی از متاتریدر و اجرای آزمون…</div>"; }
      try {
        if (!st.minConf) await loadMinConf();
        var tf = st.tf || "M5";
        var report = await B.runRealMT5Backtest({
          entryTF: tf,
          mode: ["H1", "H4", "D1"].indexOf(tf) >= 0 ? "swing" : "scalp",  // same rule as the live worker
          capital: capital(), riskPercent: riskPct(),
          minConfidence: st.minConf,                                       // same floor as live auto orders
          slippagePoints: 2, commissionPerLot: 7, tpTarget: "tp1",
          rangePreset: "custom", customStart: range.start.toISOString(), customEnd: range.end.toISOString(),
          count: 4000, maxTestBars: MAX_TEST_BARS,
          liveWindow: true, shadow: true,
          onProgress: function (f) { progress(f); if (btn) btn.textContent = "⏳ در حال آزمون…"; },
          shouldStop: function () { return st.stop; }
        });
        if (report.errors && report.errors.length) {
          if (box) box.innerHTML = "<div class='bt2-err'>❌ " + report.errors.map(esc).join("<br>") +
            "<br><small>مطمئن شوید متاتریدر، پل اتصال (۵۰۰۱) و بک‌اند (۵۰۰۰) روشن‌اند.</small></div>";
          return;
        }
        report.rangeStartLocal = range.start.toISOString(); report.rangeEndLocal = range.end.toISOString();
        st.report = report; st.audit = null; st.view = "traded";
        renderReport(report, true);
        saveHistory(compactReport(report));
        renderHistory();
      } catch (e) {
        console.error(e);
        if (box) box.innerHTML = "<div class='bt2-err'>❌ خطا: " + esc(e && e.message) + "</div>";
      } finally {
        setRunning(false, btn, "▶️ اجرای بک‌تست");
      }
    };

    // ---------- render: backtest ----------
    function tile(label, value, cls) { return "<div class='bt2-tile " + (cls || "") + "'><span>" + label + "</span><b>" + value + "</b></div>"; }
    function verdict(g) {
      if (!g || g.n - g.open < 5) return "<em class='v-few'>نمونه کم</em>";
      if (g.avgR <= 0) return "<em class='v-good'>رد کردنش درست بود</em>";
      if (g.avgR < 0.15) return "<em class='v-mid'>تقریباً بی‌اثر</em>";
      return "<em class='v-bad'>سود از دست رفته</em>";
    }
    function groupTile(title, g, cls) {
      return "<div class='bt2-cmp " + cls + "'><div class='bt2-cmp-title'>" + title + "</div>" +
        "<div class='bt2-cmp-n'>" + num(g.n, 0) + " <small>مورد</small></div>" +
        "<div class='bt2-cmp-row'><span>درصد برد</span><b>" + num(g.winRate, 1) + "٪</b></div>" +
        "<div class='bt2-cmp-row'><span>میانگین R</span><b class='" + (g.avgR > 0 ? "pos" : g.avgR < 0 ? "neg" : "") + "'>" + num(g.avgR, 2) + "</b></div>" +
        "<div class='bt2-cmp-row'><span>جمع R</span><b class='" + (g.sumR > 0 ? "pos" : g.sumR < 0 ? "neg" : "") + "'>" + num(g.sumR, 1) + "</b></div></div>";
    }
    function compactReport(r) {
      return {
        kind: "bt", at: Date.now(), tf: r.entryTF, start: r.rangeStartLocal || r.testStart, end: r.rangeEndLocal || r.testEnd,
        testCandles: r.testCandles, minConfidence: r.minConfidence, capital: r.capital, riskPercent: r.riskPercent,
        wins: r.wins, losses: r.losses, breakeven: r.breakeven, winRate: r.winRate, profitFactor: r.profitFactor, netPL: r.netPL,
        avgR: r.avgR, maxDrawdownPct: r.maxDrawdownPct, maxConsecLosses: r.maxConsecLosses, finalEquity: r.finalEquity,
        groups: r.groups || null, stopped: !!r.stopped
      };
    }
    function renderReport(r, withJournal) {
      var box = $("backtestSummary"); if (!box) return;
      var trades = (r.wins || 0) + (r.losses || 0) + (r.breakeven || 0);
      var pnlCls = r.netPL > 0 ? "pos" : r.netPL < 0 ? "neg" : "";
      var html = "<div class='bt2-meta'><b>" + esc(r.tf || r.entryTF) + "</b> · " + faDate(r.start || r.rangeStartLocal || r.testStart) + " تا " + faDate(r.end || r.rangeEndLocal || r.testEnd) +
        (r.testCandles ? " · " + num(r.testCandles, 0) + " کندل" : "") + " · حداقل اطمینان " + esc(r.minConfidence) +
        (r.stopped ? " · <span class='neg'>نیمه‌کاره متوقف شد</span>" : "") + "</div>";
      html += "<div class='bt2-tiles'>" +
        tile("تعداد معامله", num(trades, 0)) +
        tile("درصد برد", num(r.winRate, 1) + "٪") +
        tile("سود / زیان خالص", num(r.netPL, 0) + "$", pnlCls) +
        tile("ضریب سود", num(r.profitFactor, 2)) +
        tile("میانگین R", num(r.avgR, 2), r.avgR > 0 ? "pos" : r.avgR < 0 ? "neg" : "") +
        tile("بیشترین افت", num(r.maxDrawdownPct, 1) + "٪", r.maxDrawdownPct > 20 ? "neg" : "") +
        tile("باخت پشت‌سرهم", num(r.maxConsecLosses, 0)) +
        tile("سرمایه‌ی پایانی", num(r.finalEquity, 0) + "$") +
        "</div>";
      var g = r.groups;
      if (g) {
        html += "<div class='bt2-section-title'>معامله‌شده‌ها در برابر معامله‌نشده‌ها</div>" +
          "<div class='bt2-cmp-wrap'>" + groupTile("✅ معامله شد", g.traded, "ok") + groupTile("⛔ معامله نشد (روی کاغذ)", g.notTraded, "no") + "</div>" +
          "<p class='bt2-note'>سیگنال‌هایی که معامله نشدند با همان حد ضرر و حد سود «روی کاغذ» آزمایش شدند تا معلوم شود رد شدنشان درست بوده یا نه. هر فکر فقط یک بار شمرده می‌شود.</p>";
        var keys = Object.keys(g.byReason || {}).sort(function (a, b) { return g.byReason[b].n - g.byReason[a].n; });
        if (keys.length) {
          html += "<div class='bt2-section-title'>دلیل معامله نشدن</div><div class='bt2-reasons'>" + keys.map(function (k) {
            var x = g.byReason[k];
            return "<div class='bt2-reason'><div class='bt2-reason-top'><span>" + esc(label(k)) + "</span>" + verdict(x) + "</div>" +
              "<div class='bt2-reason-nums'><span>" + num(x.n, 0) + " مورد</span><span>برد " + num(x.winRate, 1) + "٪</span><span class='" + (x.avgR > 0 ? "pos" : x.avgR < 0 ? "neg" : "") + "'>میانگین R " + num(x.avgR, 2) + "</span></div></div>";
          }).join("") + "</div>";
        }
      }
      if (!withJournal) html += "<p class='bt2-note'>جزئیات تک‌تک معامله‌ها فقط برای آخرین اجرا نگه داشته می‌شود.</p>";
      box.innerHTML = html; box.classList.remove("hidden");
      var empty = $("backtestEmptyState"); if (empty) empty.classList.add("hidden");
      var jw = $("backtestJournalWrap");
      if (jw) { if (withJournal && st.report) renderJournal(); else { jw.classList.add("hidden"); jw.innerHTML = ""; } }
    }
    function renderJournal() {
      var jw = $("backtestJournalWrap"), r = st.report; if (!jw || !r) return;
      var traded = (r.journal || []).filter(function (j) { return j.executed; });
      var paper = (r.journal || []).filter(function (j) { return j.shadow; });
      var rows = (st.view === "traded" ? traded : paper).slice(-150).reverse();
      var tabs = "<div class='bt2-tabs'><button type='button' data-v='traded' class='" + (st.view === "traded" ? "active" : "") + "'>معامله‌ها (" + num(traded.length, 0) + ")</button>" +
        "<button type='button' data-v='paper' class='" + (st.view === "paper" ? "active" : "") + "'>معامله‌نشده‌ها (" + num(paper.length, 0) + ")</button></div>";
      var body;
      if (!rows.length) body = "<div class='bt2-empty-rows'>موردی نیست.</div>";
      else body = "<div class='bt2-rows'>" + rows.map(function (j) {
        var t = st.view === "traded" ? j : j.shadow;
        var dir = st.view === "traded" ? (String(j.signal).indexOf("BUY") >= 0 ? "BUY" : "SELL") : t.dir;
        var res = t.exitReason, R = t.rMultiple;
        var cls = R > 0 ? "pos" : R < 0 ? "neg" : "";
        return "<div class='bt2-row'><span class='d " + (dir === "BUY" ? "buy" : "sell") + "'>" + (dir === "BUY" ? "خرید" : "فروش") + "</span>" +
          "<span class='t'>" + faShort(j.time) + "</span>" +
          "<span class='c'>" + esc(j.confidence) + "٪</span>" +
          "<span class='x'>" + esc(EXIT[res] || res || "—") + "</span>" +
          "<span class='r " + cls + "'>" + (R == null ? "—" : num(R, 2) + "R") + "</span>" +
          (st.view === "paper" ? "<span class='why'>" + esc(label(t.reason)) + "</span>" : "") + "</div>";
      }).join("") + "</div>" + (Math.max(traded.length, paper.length) > 150 ? "<p class='bt2-note'>۱۵۰ مورد آخر نشان داده شده؛ همه در «خروجی فایل» هست.</p>" : "");
      jw.innerHTML = "<div class='bt2-section-title'>ریز نتایج</div>" + tabs + body;
      jw.classList.remove("hidden");
      [].forEach.call(jw.querySelectorAll(".bt2-tabs button"), function (b) {
        b.onclick = function () { st.view = b.getAttribute("data-v"); renderJournal(); };
      });
    }

    // ---------- real worker signals ----------
    G.runSignalAudit = async function (btnEl) {
      if (st.running) return;
      var range = readRange();
      if (range.error) { showError(range.error); return; }
      showError("");
      var btn = btnEl || $("btAuditBtn");
      setRunning(true, btn, "⏳ در حال بررسی…");
      var box = $("backtestSummary"), empty = $("backtestEmptyState"), jw = $("backtestJournalWrap");
      if (empty) empty.classList.add("hidden");
      if (jw) { jw.classList.add("hidden"); jw.innerHTML = ""; }
      if (box) { box.classList.remove("hidden"); box.innerHTML = "<div class='bt2-wait'>⏳ خواندن سیگنال‌های ورکر و کندل‌های واقعی…</div>"; }
      try {
        var res = await fetch(backend() + "/worker/journal?limit=2000", { cache: "no-store" });
        var list = await res.json();
        if (!Array.isArray(list)) list = (list && list.signals) || [];
        var s0 = range.start.getTime() / 1000, s1 = range.end.getTime() / 1000;
        var tfF = st.tf;
        var picked = list.filter(function (e) {
          var t = Number(e.candleTimestamp), sig = String(e.signal || "").toUpperCase();
          return t >= s0 && t <= s1 && (sig.indexOf("BUY") >= 0 || sig.indexOf("SELL") >= 0) &&
            (!tfF || String(e.timeframe || "").toUpperCase() === tfF);
        });
        if (!picked.length) {
          box.innerHTML = "<div class='bt2-err'>در این بازه و تایم‌فریم " + esc(tfF || "") + " هیچ سیگنال خرید/فروشی در دفترچه‌ی ورکر نیست." +
            "<br><small>دفترچه حداکثر ۲۰۰۰ سیگنال آخر را می‌دهد.</small></div>";
          return;
        }
        progress(0.2);
        var tMin = Math.min.apply(null, picked.map(function (e) { return Number(e.candleTimestamp); }));
        var tMax = Math.max.apply(null, picked.map(function (e) { return Number(e.candleTimestamp); }));
        var tfSec = (B.TF_SECONDS && B.TF_SECONDS[tfF]) || 300;
        var endEpoch = Math.min(Math.floor(Date.now() / 1000), tMax + 101 * tfSec);
        if (endEpoch - tMin > 60 * 86400) { tMin = endEpoch - 60 * 86400; }
        var m1 = await D.fetchMT5RangeChunked("M1", tMin, endEpoch, 60, 4000);
        progress(0.7);
        if (!m1 || m1.status !== "ok" || !m1.candles || !m1.candles.length) {
          box.innerHTML = "<div class='bt2-err'>❌ کندل‌های یک‌دقیقه‌ای از متاتریدر دریافت نشد.</div>";
          return;
        }
        var specs = {}; try { var sp = await D.fetchMT5SymbolSpecs(); if (sp && sp.status === "ok") specs = sp; } catch (_) {}
        var audit = B.auditSignals(picked.filter(function (e) { return Number(e.candleTimestamp) >= tMin; }), B.toBars(m1.candles),
          { specs: specs, symbol: (window.GoldAI_Config || {}).SYMBOL, maxHoldBars: 100 });
        audit.tf = tfF; audit.start = range.start.toISOString(); audit.end = range.end.toISOString();
        st.audit = audit; st.report = null;
        renderAudit(audit, true);
        saveHistory({ kind: "audit", at: Date.now(), tf: tfF, start: audit.start, end: audit.end, summary: audit.summary, count: audit.rows.length });
        renderHistory();
      } catch (e) {
        console.error(e);
        if (box) box.innerHTML = "<div class='bt2-err'>❌ خطا: " + esc(e && e.message) + "</div>";
      } finally {
        setRunning(false, btn, "🔎 سیگنال‌های واقعی");
      }
    };
    function auditTile(title, g, cls) {
      return "<div class='bt2-cmp " + cls + "'><div class='bt2-cmp-title'>" + title + "</div>" +
        "<div class='bt2-cmp-n'>" + num(g.n, 0) + " <small>سیگنال</small></div>" +
        "<div class='bt2-cmp-row'><span>به حد سود رسید</span><b class='pos'>" + num(g.tp, 0) + "</b></div>" +
        "<div class='bt2-cmp-row'><span>به حد ضرر رسید</span><b class='neg'>" + num(g.sl, 0) + "</b></div>" +
        "<div class='bt2-cmp-row'><span>درصد برد</span><b>" + num(g.winRate, 1) + "٪</b></div>" +
        "<div class='bt2-cmp-row'><span>جمع R</span><b class='" + (g.sumR > 0 ? "pos" : g.sumR < 0 ? "neg" : "") + "'>" + num(g.sumR, 1) + "</b></div></div>";
    }
    function renderAudit(a, withRows) {
      var box = $("backtestSummary"); if (!box) return;
      var s = a.summary;
      var html = "<div class='bt2-meta'>🔎 سیگنال‌های واقعی ورکر · <b>" + esc(a.tf || "") + "</b> · " + faDate(a.start) + " تا " + faDate(a.end) + "</div>" +
        "<div class='bt2-cmp-wrap'>" + auditTile("✅ اجرا شد", s.executed, "ok") + auditTile("⛔ اجرا نشد", s.notExecuted, "no") + "</div>" +
        "<p class='bt2-note'>با کندل‌های یک‌دقیقه‌ای واقعی بررسی شد که قیمت اول به حد سود رسید یا حد ضرر (حداکثر ۱۰۰ کندل). اگر هر دو در یک دقیقه لمس شوند ضرر حساب می‌شود. سود/زیان دقیق معامله‌های اجراشده در تاریخچه‌ی خود متاتریدر است.</p>";
      var keys = Object.keys(s.byStatus || {}).sort(function (x, y) { return s.byStatus[y].n - s.byStatus[x].n; });
      if (keys.length) {
        html += "<div class='bt2-section-title'>بر اساس وضعیت</div><div class='bt2-reasons'>" + keys.map(function (k) {
          var x = s.byStatus[k];
          var v = k === "EXECUTED" ? "" : ((x.tp + x.sl) < 5 ? "<em class='v-few'>نمونه کم</em>" : x.sumR <= 0 ? "<em class='v-good'>اجرا نشدنش ضرری نداشت</em>" : "<em class='v-bad'>سود از دست رفته</em>");
          return "<div class='bt2-reason'><div class='bt2-reason-top'><span>" + esc(label(k)) + "</span>" + v + "</div>" +
            "<div class='bt2-reason-nums'><span>" + num(x.n, 0) + " سیگنال</span><span>سود " + num(x.tp, 0) + " / ضرر " + num(x.sl, 0) + "</span><span class='" + (x.sumR > 0 ? "pos" : x.sumR < 0 ? "neg" : "") + "'>جمع R " + num(x.sumR, 1) + "</span></div></div>";
        }).join("") + "</div>";
      }
      box.innerHTML = html; box.classList.remove("hidden");
      var empty = $("backtestEmptyState"); if (empty) empty.classList.add("hidden");
      var jw = $("backtestJournalWrap"); if (!jw) return;
      if (!withRows) { jw.classList.add("hidden"); jw.innerHTML = ""; return; }
      var rows = a.rows.slice(-150).reverse();
      jw.innerHTML = "<div class='bt2-section-title'>ریز سیگنال‌ها</div><div class='bt2-rows'>" + rows.map(function (r) {
        var cls = r.rMultiple > 0 ? "pos" : r.rMultiple < 0 ? "neg" : "";
        return "<div class='bt2-row'><span class='d " + (r.signal === "BUY" ? "buy" : "sell") + "'>" + (r.signal === "BUY" ? "خرید" : "فروش") + "</span>" +
          "<span class='t'>" + faShort(r.time) + "</span><span class='c'>" + esc(r.confidence) + "٪</span>" +
          "<span class='x'>" + esc(EXIT[r.result] || r.result) + "</span>" +
          "<span class='r " + cls + "'>" + (r.rMultiple == null ? "—" : num(r.rMultiple, 2) + "R") + "</span>" +
          "<span class='why'>" + esc(r.executed ? "اجرا شد" : label(r.status === "SKIPPED_WAIT_OR_INVALID" && r.reason ? r.reason : r.status)) + "</span></div>";
      }).join("") + "</div>";
      jw.classList.remove("hidden");
    }

    // ---------- reset / history / export ----------
    G.resetBacktest = function () {
      if (st.running) return;
      st.report = null; st.audit = null; st.view = "traded";
      var box = $("backtestSummary"), jw = $("backtestJournalWrap"), empty = $("backtestEmptyState");
      if (box) { box.classList.add("hidden"); box.innerHTML = ""; }
      if (jw) { jw.classList.add("hidden"); jw.innerHTML = ""; }
      if (empty) empty.classList.remove("hidden");
      setTf(String((window.GoldAI_Config || {}).ACTIVE_TIMEFRAME || "m5").toUpperCase());
      setPeriod("1m");
      setPicked("btCustomStart", null); setPicked("btCustomEnd", null);
      G._lastBacktestReport = null;
    };
    function loadHistory() { try { var h = JSON.parse(localStorage.getItem(HKEY) || "[]"); return Array.isArray(h) ? h : []; } catch (_) { return []; } }
    function saveHistory(item) {
      try {
        var h = loadHistory(); h.unshift(item); if (h.length > MAX_HIST) h = h.slice(0, MAX_HIST);
        localStorage.setItem(HKEY, JSON.stringify(h));
      } catch (_) {}
    }
    function renderHistory() {
      var el = $("btHistoryList"); if (!el) return;
      var h = loadHistory();
      if (!h.length) { el.innerHTML = "<div class='bt2-empty-rows'>تاریخچه خالی است.</div>"; return; }
      el.innerHTML = h.map(function (x, i) {
        var when = new Date(x.at).toLocaleString("fa-IR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        var line = x.kind === "audit"
          ? "🔎 سیگنال واقعی · " + num(x.count, 0) + " سیگنال · برد اجراشده‌ها " + num(x.summary && x.summary.executed.winRate, 1) + "٪"
          : "🎯 " + num((x.wins || 0) + (x.losses || 0) + (x.breakeven || 0), 0) + " معامله · برد " + num(x.winRate, 1) + "٪ · " +
            "<span class='" + (x.netPL > 0 ? "pos" : x.netPL < 0 ? "neg" : "") + "'>" + num(x.netPL, 0) + "$</span>";
        return "<button type='button' class='bt2-hist' data-i='" + i + "'><div><b>" + esc(x.tf || "") + "</b> · " + faDate(x.start) + " تا " + faDate(x.end) + "</div>" +
          "<div class='bt2-hist-sub'>" + line + "</div><div class='bt2-hist-when'>" + when + "</div></button>";
      }).join("");
      [].forEach.call(el.querySelectorAll(".bt2-hist"), function (b) {
        b.onclick = function () {
          var x = loadHistory()[Number(b.getAttribute("data-i"))]; if (!x) return;
          if (x.kind === "audit") renderAudit({ tf: x.tf, start: x.start, end: x.end, summary: x.summary, rows: [] }, false);
          else renderReport(x, false);
          var box = $("backtestSummary"); if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "start" });
        };
      });
    }
    G.deleteBacktestResults = function () {
      if (st.running) return;
      if (!confirm("کل تاریخچه‌ی بک‌تست‌ها و نتیجه‌ی فعلی پاک شود؟")) return;
      try { localStorage.removeItem(HKEY); } catch (_) {}
      G.resetBacktest();
      renderHistory();
    };
    G.exportBacktestCsv = function () {
      var lines, name;
      var q = function (v) { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      if (st.report) {
        var r = st.report;
        lines = [["time", "group", "reason", "direction", "confidence", "entry", "stop_loss", "take_profit", "exit", "result", "R", "profit_usd", "bars"].join(",")];
        (r.journal || []).forEach(function (j) {
          if (j.executed) lines.push([j.timeISO, "traded", "", String(j.signal).indexOf("BUY") >= 0 ? "BUY" : "SELL", j.confidence, j.entry, j.stopLoss, j.takeProfit, j.exit, j.exitReason, j.rMultiple, j.profitLoss, j.duration].map(q).join(","));
          else if (j.shadow) { var s = j.shadow; lines.push([j.timeISO, "not_traded", s.reason, s.dir, j.confidence, s.entry, s.stopLoss, s.takeProfit, s.exit, s.exitReason, s.rMultiple, s.profitLoss, s.duration].map(q).join(",")); }
        });
        name = "goldai-backtest-" + r.entryTF + "-" + ymd(new Date()) + ".csv";
      } else if (st.audit) {
        lines = [["time", "timeframe", "direction", "confidence", "executed", "status", "reason", "entry", "stop_loss", "take_profit", "result", "R", "minutes"].join(",")];
        st.audit.rows.forEach(function (x) { lines.push([x.timeISO, x.timeframe, x.signal, x.confidence, x.executed, x.status, x.reason, x.entry, x.stopLoss, x.takeProfit, x.result, x.rMultiple, x.minutes].map(q).join(",")); });
        name = "goldai-real-signals-" + ymd(new Date()) + ".csv";
      } else { alert("اول یک بک‌تست یا بررسی سیگنال اجرا کنید."); return; }
      var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    };

    // ---------- wire up ----------
    $("btTfSelect").addEventListener("change", function () { setTf(this.value); });
    $("btPeriodSelect").addEventListener("change", function () {
      setPeriod(this.value);
      if (this.value === "custom" && !getPicked("btCustomStart")) openCalendar("start");
    });
    ["btCustomStart", "btCustomEnd"].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener("click", function () { openCalendar(el.getAttribute("data-which")); });
    });
    setPicked("btCustomStart", null); setPicked("btCustomEnd", null);
    setTf(String((window.GoldAI_Config || {}).ACTIVE_TIMEFRAME || "m5").toUpperCase());
    setPeriod("1m");
    renderHistory();
    loadMinConf();
    if (G.showPanel && !G.__btPanelWrapped) {
      G.__btPanelWrapped = true;
      var _sp = G.showPanel.bind(G);
      G.showPanel = function (name) { _sp(name); if (name === "backtest") { updateInfo(); loadMinConf(); } };
    }
  }
  ready();
})();
