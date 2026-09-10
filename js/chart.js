// =====================================================
// GoldAI Pro — Live Chart (Mobile-First patch, NEW file)
// =====================================================
// Pure UI/display module. Reads candles that js/core/data.js and js/app.js
// already fetch from MT5 (window.GoldAI_Data.candles[timeframe]) — this file
// does not call MT5, the backend, or any engine, and never writes to
// window.GoldAI_Config or window.GoldAI_Data. It only draws.
//
// No external chart library is used (none existed in the project — confirmed
// during audit), so this is a small dependency-free <canvas> renderer to
// avoid pulling in a new CDN/runtime dependency for a UI-only feature.

window.GoldAI_Chart = (function () {

  // Optional client-side date filter set by the Date Range card. This only
  // narrows which of the ALREADY-LOADED candles are drawn — it does not
  // fetch a different/larger history from MT5 (backend/routes/mt5.js was
  // intentionally left untouched this round; see audit report for the
  // "real historical range" dependency this would need).
  let dateFilter = null; // { fromEpoch, toEpoch } in seconds, or null

  function getCanvas() {
    return document.getElementById("liveChartCanvas");
  }

  function resolveCandles(tf, candlesArg) {
    const cfg = window.GoldAI_Config || {};
    const data = window.GoldAI_Data || {};
    const timeframe = tf || (cfg.ACTIVE_TIMEFRAME || "m5");
    let candles = candlesArg || (data.candles && data.candles[timeframe]) || [];
    if (dateFilter && Array.isArray(candles)) {
      candles = candles.filter(c => {
        if (!c.time) return true; // no timestamp on this bar — don't hide it
        return c.time >= dateFilter.fromEpoch && c.time <= dateFilter.toEpoch;
      });
    }
    return { timeframe, candles };
  }

  function render(tf, candlesArg) {
    const canvas = getCanvas();
    if (!canvas) return;
    const { timeframe, candles } = resolveCandles(tf, candlesArg);

    const label = document.getElementById("chartTfLabel");
    if (label) label.textContent = timeframe.toUpperCase();

    const emptyNote = document.getElementById("chartEmptyNote");
    const ctx = canvas.getContext("2d");

    if (!candles || candles.length < 2) {
      if (emptyNote) emptyNote.classList.remove("hidden");
      canvas.classList.add("hidden");
      return;
    }
    if (emptyNote) emptyNote.classList.add("hidden");
    canvas.classList.remove("hidden");

    // Size canvas to its CSS box, respecting devicePixelRatio for crisp lines.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 320;
    const cssHeight = canvas.clientHeight || 260;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const padding = { top: 10, right: 8, bottom: 10, left: 8 };
    const plotW = cssWidth - padding.left - padding.right;
    const plotH = cssHeight - padding.top - padding.bottom;

    const visible = candles.slice(-160); // keep bars readable on small screens
    let lo = Infinity, hi = -Infinity;
    for (const c of visible) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi === lo) { hi = lo + 1; }
    const range = hi - lo;
    const yPad = range * 0.08;
    lo -= yPad; hi += yPad;

    const n = visible.length;
    const slot = plotW / n;
    const bodyW = Math.max(1.5, Math.min(9, slot * 0.62));

    const style = getComputedStyle(document.documentElement);
    const upColor = (style.getPropertyValue("--green") || "#3dce7a").trim();
    const downColor = (style.getPropertyValue("--red") || "#ff6b6b").trim();
    const gridColor = (style.getPropertyValue("--line") || "#26262f").trim();

    const yFor = v => padding.top + (1 - (v - lo) / (hi - lo)) * plotH;

    // light horizontal grid
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    for (let i = 0; i <= 3; i++) {
      const y = padding.top + (plotH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(cssWidth - padding.right, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    visible.forEach((c, i) => {
      const x = padding.left + i * slot + slot / 2;
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? upColor : downColor;
      ctx.fillStyle = up ? upColor : downColor;

      // wick
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yFor(c.high));
      ctx.lineTo(x, yFor(c.low));
      ctx.stroke();

      // body
      const yOpen = yFor(c.open);
      const yClose = yFor(c.close);
      const top = Math.min(yOpen, yClose);
      const h = Math.max(1, Math.abs(yClose - yOpen));
      ctx.fillRect(x - bodyW / 2, top, bodyW, h);
    });
  }

  function applyDateRange() {
    const fromEl = document.getElementById("dateRangeFrom");
    const toEl = document.getElementById("dateRangeTo");
    if (!fromEl || !toEl || !fromEl.value || !toEl.value) return;
    const fromEpoch = Math.floor(new Date(fromEl.value + "T00:00:00").getTime() / 1000);
    const toEpoch = Math.floor(new Date(toEl.value + "T23:59:59").getTime() / 1000);
    if (isNaN(fromEpoch) || isNaN(toEpoch) || fromEpoch > toEpoch) return;
    dateFilter = { fromEpoch, toEpoch };
    render();
  }

  function clearDateRange() {
    dateFilter = null;
    const fromEl = document.getElementById("dateRangeFrom");
    const toEl = document.getElementById("dateRangeTo");
    if (fromEl) fromEl.value = "";
    if (toEl) toEl.value = "";
    render();
  }

  // Redraw on resize/orientation-change so nothing overflows horizontally.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => render(), 150);
  });

  return { render, applyDateRange, clearDateRange };
})();

// Wire the Date Range buttons (index.html calls these two names).
window.GoldAI = window.GoldAI || {};
window.GoldAI.applyDateRange = () => window.GoldAI_Chart.applyDateRange();
window.GoldAI.clearDateRange = () => window.GoldAI_Chart.clearDateRange();
