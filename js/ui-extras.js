// GoldAI UI extras — settings, price, history, backtest
(function () {
  function ready() {
    if (!window.GoldAI || !window.GoldAI_Data) return setTimeout(ready, 40);
    var G = window.GoldAI;
    var D = window.GoldAI_Data;

    G.applyManualPrice = function () {
      var el = document.getElementById("manualEntryInput");
      if (!el) return;
      var v = Number(el.value);
      if (!v || isNaN(v) || v <= 0) {
        alert("یک قیمت معتبر وارد کنید");
        return;
      }
      D.goldPrice = v;
      D.manualPriceLock = true;
      this.updatePriceUI && this.updatePriceUI();
    };

    G.refreshPrice = async function () {
      D.manualPriceLock = false;
      var el = document.getElementById("manualEntryInput");
      if (el) el.value = "";
      try {
        if (this.fetchPriceFromBackend) await this.fetchPriceFromBackend();
      } catch (e) {}
      this.updatePriceUI && this.updatePriceUI();
      var price = D.goldPrice;
      if (price > 0 && D.livePriceOk) alert("✅ قیمت آنلاین: " + price);
      else alert("⚠️ قیمت آنلاین نیست — بک‌اند را روشن کنید یا قیمت دستی بدهید.\n" + (this.backendURL || "http://localhost:5000/api"));
    };

    if (G.fetchPriceFromBackend && !G.__fetchWrapped) {
      G.__fetchWrapped = true;
      var _fetch = G.fetchPriceFromBackend.bind(G);
      // NOTE: livePriceOk / dataMode are now decided exclusively inside
      // GoldAI_Data.loadPrice() (MT5 success -> "live", failure -> "offline"/"demo").
      // This wrapper must NOT re-derive them from "price > 0", since a stale/offline
      // price is still > 0 and would otherwise get relabeled as live here.
      G.fetchPriceFromBackend = async function () {
        if (D.manualPriceLock && D.goldPrice > 0) return D.goldPrice;
        return _fetch();
      };
    }

    if (G.analyze && !G.__analyzeWrapped) {
      G.__analyzeWrapped = true;
      var _analyze = G.analyze.bind(G);
      G.analyze = async function () {
        var btn = document.getElementById("analyzeBtn");
        try {
          var el = document.getElementById("manualEntryInput");
          if (D.manualPriceLock && el) {
            var v = Number(el.value);
            if (v > 0) D.goldPrice = v;
          }
          if (!D.closes || !D.closes.m5 || !D.closes.m5.length) {
            if (typeof D.seedDemo === "function") D.seedDemo();
          }
          var out = await _analyze();
          try {
            var h = JSON.parse(localStorage.getItem("goldai_history") || "[]");
            this.signalHistory = h.slice(0, 50);
          } catch (e) {}
          this.updateRiskUI && this.updateRiskUI();
          return out;
        } catch (e) {
          console.error("analyze error:", e);
          alert("خطا در تحلیل: " + (e && e.message ? e.message : e));
          if (btn) btn.disabled = false;
        }
      };
    }

    // 2026-10-07: settings sheet redesigned (mobile bottom-sheet, grouped sections).
    // - TP2/TP3 live only here (manual mode); the dashboard card shows TP1 only.
    // - Trade mode is shown read-only: it is changed only by the MANUAL/AUTO buttons,
    //   which tell the server. (The old select changed it in this page only.)
    G.openSettingsModal = function () {
      var cfg = window.GoldAI_Config || {};
      var cap = (D.getCapital && D.getCapital()) || 10000;
      var old = document.getElementById("settingsModal");
      if (old) old.remove();
      var sel = function (cur, v) { return String(cur) === String(v) ? " selected" : ""; };
      var r = G.lastResult || {};
      var decs = (G.getDecimals && G.getDecimals()) || 2;
      var fmt = function (n) { return (n == null || n === "" || isNaN(Number(n))) ? "—" : Number(n).toFixed(decs); };
      var side = String(r.signal || "").toUpperCase();
      var hasSig = side.indexOf("BUY") >= 0 || side.indexOf("SELL") >= 0;
      var mode = (G._serverTradeMode || cfg.TRADE_MODE) === "auto" ? "auto" : "manual";
      var num = function (id, label, val, attrs, hint) {
        return '<label class="sm-field"><span class="sm-label">' + label + '</span>' +
          '<input type="number" inputmode="decimal" id="' + id + '" value="' + val + '" ' + attrs + '>' +
          (hint ? '<small class="sm-hint">' + hint + '</small>' : '') + '</label>';
      };
      var html =
        '<div id="settingsModal" class="modal-backdrop sm-backdrop" onclick="if(event.target.id===\'settingsModal\')GoldAI.closeSettingsModal()">' +
        '<div class="modal-sheet sm-sheet" role="dialog" aria-label="تنظیمات" onclick="event.stopPropagation()">' +
        '<div class="sm-grabber"></div>' +
        '<div class="sm-head"><div><h3>⚙️ تنظیمات</h3><p>سرمایه، ریسک و حد سودها</p></div>' +
        '<button type="button" class="sm-close" onclick="GoldAI.closeSettingsModal()" aria-label="بستن">✕</button></div>' +
        '<div class="sm-body">' +

        '<div class="sm-mode ' + mode + '"><span class="sm-mode-dot"></span>' +
        '<div><b>حالت فعلی: ' + (mode === "auto" ? "AUTO (خودکار)" : "MANUAL (دستی)") + '</b>' +
        '<small>برای عوض کردن، از دکمه‌های MANUAL / AUTO در داشبورد استفاده کنید.</small></div></div>' +

        '<section class="sm-section"><h4><span>💰</span>سرمایه و ریسک</h4><div class="sm-grid">' +
        num("modalCapital", "سرمایه ($)", cap, 'min="100"') +
        num("modalRisk", "ریسک هر معامله (%)", (cfg.DEFAULT_RISK_PERCENT || 1), 'min="0.1" max="10" step="0.1"') +
        num("modalLot", "حجم دستی", (cfg.USER_LOT || 0), 'step="0.01" min="0"', "صفر = حجم خودکار از روی ریسک") +
        '</div></section>' +

        '<section class="sm-section"><h4><span>🎯</span>حد ضرر و حد سود اول</h4><div class="sm-grid">' +
        num("modalSl", "ضریب حد ضرر (ATR)", (cfg.ATR_SL_MULT || 1.5), 'step="0.1"') +
        num("modalTp1", "ضریب حد سود ۱ (ATR)", (cfg.ATR_TP1_MULT || 2), 'step="0.1"') +
        '</div></section>' +

        '<section class="sm-section sm-manual"><h4><span>✋</span>حد سود دوم و سوم <em>فقط حالت دستی</em></h4>' +
        '<div class="sm-tp-now">' +
        '<div class="sm-tp-card"><span>TP2 سیگنال فعلی</span><b>' + (hasSig ? fmt(r.tp2) : "—") + '</b></div>' +
        '<div class="sm-tp-card"><span>TP3 سیگنال فعلی</span><b>' + (hasSig ? fmt(r.tp3) : "—") + '</b></div>' +
        '</div>' +
        '<div class="sm-grid">' +
        '<label class="sm-field sm-full"><span class="sm-label">تعداد حد سود (دستی)</span><select id="modalTpCount">' +
        '<option value="1"' + sel(cfg.TP_COUNT, 1) + '>۱ — فقط TP1</option>' +
        '<option value="2"' + sel(cfg.TP_COUNT, 2) + '>۲ — TP1 و TP2</option>' +
        '<option value="3"' + sel(cfg.TP_COUNT || 3, 3) + '>۳ — TP1 تا TP3</option></select></label>' +
        num("modalTp2", "ضریب حد سود ۲", (cfg.ATR_TP2_MULT || 3.5), 'step="0.1"') +
        num("modalTp3", "ضریب حد سود ۳", (cfg.ATR_TP3_MULT || 5), 'step="0.1"') +
        '</div><p class="sm-note">در حالت خودکار فقط TP1 به متاتریدر فرستاده می‌شود.</p></section>' +

        '<div class="sm-info">⏱ تایم‌فریم فعال: <b id="modalActiveTfDisplay">' + String(cfg.ACTIVE_TIMEFRAME || "m5").toUpperCase() + '</b> — از بالای داشبورد عوض می‌شود و بک‌تست هم همین را استفاده می‌کند.<br>' +
        'ℹ️ این تنظیمات روی محاسبات همین صفحه اثر دارد؛ معامله‌های خودکار سرور از تنظیمات خود سرور پیروی می‌کنند.</div>' +
        '</div>' +
        '<div class="modal-actions sm-actions">' +
        '<button type="button" class="btn-main" onclick="GoldAI.saveSettingsModal()">💾 ذخیره</button>' +
        '<button type="button" class="btn-ghost" onclick="GoldAI.closeSettingsModal()">بستن</button>' +
        '</div></div></div>';
      document.body.insertAdjacentHTML("beforeend", html);
      document.body.classList.add("sm-open");
    };

    G.closeSettingsModal = function () {
      var m = document.getElementById("settingsModal");
      if (m) m.remove();
      document.body.classList.remove("sm-open");
    };

    G.saveSettingsModal = function () {
      var g = function (id) { return document.getElementById(id); };
      var capital = parseFloat(g("modalCapital") && g("modalCapital").value) || 10000;
      var risk = parseFloat(g("modalRisk") && g("modalRisk").value) || 1;
      var tpCount = parseInt(g("modalTpCount") && g("modalTpCount").value, 10) || 3;
      var lot = parseFloat(g("modalLot") && g("modalLot").value) || 0;
      var sl = parseFloat(g("modalSl") && g("modalSl").value) || 1.5;
      var tp1 = parseFloat(g("modalTp1") && g("modalTp1").value) || 2;
      var tp2 = parseFloat(g("modalTp2") && g("modalTp2").value) || 3.5;
      var tp3 = parseFloat(g("modalTp3") && g("modalTp3").value) || 5;

      if (D.setCapital) D.setCapital(capital);
      var cfg = window.GoldAI_Config;
      cfg.DEFAULT_RISK_PERCENT = risk;
      cfg.TP_COUNT = tpCount;
      cfg.USER_LOT = lot;
      cfg.ATR_SL_MULT = sl;
      cfg.ATR_TP1_MULT = tp1;
      cfg.ATR_TP2_MULT = tp2;
      cfg.ATR_TP3_MULT = tp3;
      // trade mode is NOT changed here any more (see note above openSettingsModal)

      var sync = function (id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val;
      };
      sync("advCapital", capital); sync("advRisk", risk); sync("userTpCount", tpCount);
      sync("userLot", lot); sync("userSlMult", sl); sync("userTp1Mult", tp1);
      sync("userTp2Mult", tp2); sync("userTp3Mult", tp3);

      try {
        var stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
        Object.assign(stored, {
          capital: capital, risk: risk, tpCount: tpCount, userLot: lot,
           slMult: sl, tp1Mult: tp1, tp2Mult: tp2, tp3Mult: tp3
        });
        localStorage.setItem("goldai_settings", JSON.stringify(stored));
      } catch (e) {}

      this.updateRiskUI && this.updateRiskUI();
      this.closeSettingsModal();
      alert("✅ تنظیمات ذخیره شد");
    };

    G.getHistory = function () {
      try { return JSON.parse(localStorage.getItem("goldai_history") || "[]"); }
      catch (e) { return []; }
    };

    G.renderPerformance = function () {
      var list = this.getHistory();
      this.signalHistory = list.slice(0, 50);
      var total = list.length, buy = 0, sell = 0, wait = 0;
      list.forEach(function (x) {
        var s = String(x.signal || "");
        if (s.indexOf("BUY") >= 0) buy++;
        else if (s.indexOf("SELL") >= 0) sell++;
        else wait++;
      });
      var set = function (id, v) {
        var el = document.getElementById(id);
        if (el) el.textContent = v;
      };
      set("perfTotal", total); set("perfBuy", buy); set("perfSell", sell); set("perfWait", wait);

      var box = document.getElementById("historyList");
      if (!box) return;
      if (!list.length) {
        box.innerHTML = '<div class="history-meta" style="padding:12px;opacity:.7">هنوز سیگنالی ذخیره نشده. بعد از تحلیل اینجا نمایش داده می‌شود.</div>';
        return;
      }
      box.innerHTML = list.slice(0, 40).map(function (x) {
        var s = String(x.signal || "WAIT");
        var cls = s.indexOf("BUY") >= 0 ? "sig-buy" : s.indexOf("SELL") >= 0 ? "sig-sell" : "sig-wait";
        return (
          '<div class="history-item">' +
          '<div><b class="' + cls + '">' + s + '</b> · ' + (x.symbol || "") +
          '<div class="history-meta">Entry: ' + (x.entry != null ? x.entry : "—") +
          ' | SL: ' + (x.sl || "—") + ' | TP1: ' + (x.tp1 || "—") + '</div></div>' +
          '<div class="history-meta" style="text-align:left;direction:ltr">' + (x.t || "") +
          '<br>Conf: ' + (x.conf != null ? x.conf : (x.confidence != null ? x.confidence : "—")) + '%</div></div>'
        );
      }).join("");
    };

    G.clearPerformanceHistory = function () {
      if (!confirm("تاریخچه سیگنال‌ها پاک شود؟")) return;
      localStorage.removeItem("goldai_history");
      this.signalHistory = [];
      this.renderPerformance();
      var bt = document.getElementById("backtestSummary");
      if (bt) { bt.classList.add("hidden"); bt.innerHTML = ""; }
    };

    G.resetBacktest = function () {
      var box = document.getElementById('backtestSummary');
      var wrap = document.getElementById('backtestJournalWrap');
      var table = document.getElementById('backtestJournal');
      var err = document.getElementById('btRangeError');
      var empty = document.getElementById('backtestEmptyState');
      if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
      if (wrap) wrap.classList.add('hidden');
      if (table) table.innerHTML = '';
      if (err) { err.classList.add('hidden'); err.textContent = ''; }
      if (empty) empty.classList.remove('hidden');
      G._lastBacktestReport = null;
    };

    G.deleteBacktestResults = function () {
      if (!confirm('نتایج بک‌تست فعلی حذف شود؟')) return;
      G.resetBacktest();
    };

    // Existing buttons at the bottom of the Backtest panel — do not add new ones.
    document.getElementById('panel-backtest') && document.getElementById('panel-backtest').addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button') : e.target;
      if (!t) return;
      var label = String(t.textContent || '');
      if (label.indexOf('Reset Backtest') !== -1) {
        e.preventDefault();
        e.stopPropagation();
        G.resetBacktest();
      } else if (label.indexOf('Delete Results') !== -1) {
        e.preventDefault();
        e.stopPropagation();
        G.deleteBacktestResults();
      }
    }, true);

    G.runBacktest = async function (btnEl) {
      var box = document.getElementById("backtestSummary");
      var journalWrap = document.getElementById("backtestJournalWrap");
      var journalTable = document.getElementById("backtestJournal");
      var btn = btnEl || null;
      try {
        if (!window.GoldAI_Backtest || !window.GoldAI_Backtest.runRealMT5Backtest) {
          alert("موتور بک‌تست لود نشده");
          return;
        }
        if (btn) { btn.disabled = true; btn.textContent = "⏳ در حال اجرا روی داده واقعی MT5..."; }
        var empty = document.getElementById("backtestEmptyState");
        if (empty) empty.classList.add("hidden");
        if (box) { box.classList.remove("hidden"); box.innerHTML = "⏳ در حال دریافت تاریخچه واقعی از MT5 و اجرای Walk-Forward…"; }

        var val = function (id, dv) { var el = document.getElementById(id); var v = el ? el.value : null; return (v === null || v === "") ? dv : v; };

        var errBox = document.getElementById("btRangeError");
        if (errBox) { errBox.classList.add("hidden"); errBox.textContent = ""; }

        var rangePreset = val("btRangePreset", "1m");
        // CENTRAL TIMEFRAME: Backtest has no timeframe selector of its own —
        // it always inherits window.GoldAI_Config.ACTIVE_TIMEFRAME (set from
        // the Dashboard's single timeframe dropdown), so Dashboard and
        // Backtest can never disagree on which timeframe is being analyzed.
        var activeTF = String(window.GoldAI_Config.ACTIVE_TIMEFRAME || "m5").toUpperCase();
        var derivedMode = ["H1", "H4"].indexOf(activeTF) !== -1 ? "swing" : "scalp";
        var backtestOpts = {
          entryTF: activeTF,
          mode: derivedMode,
          capital: Number(val("btCapital", 10000)),
          riskPercent: Number(val("btRisk", 1)),
          minConfidence: Number(val("btMinConf", 68)),
          slippagePoints: Number(val("btSlippage", 2)),
          count: Number(val("btCount", 1500)),
          rangePreset: rangePreset
        };

        if (rangePreset === "custom") {
          var startVal = val("btCustomStart", "");
          var endVal = val("btCustomEnd", "");
          if (!startVal || !endVal) {
            if (errBox) { errBox.textContent = "برای Custom باید تاریخ شروع و پایان هر دو مشخص شوند."; errBox.classList.remove("hidden"); }
            if (btn) { btn.disabled = false; btn.textContent = "🎯 Real MT5 Backtest"; }
            return;
          }
          var startD = new Date(startVal), endD = new Date(endVal);
          if (isNaN(startD.getTime()) || isNaN(endD.getTime()) || startD.getTime() >= endD.getTime()) {
            if (errBox) { errBox.textContent = "بازه نامعتبر است: تاریخ شروع باید قبل از تاریخ پایان باشد."; errBox.classList.remove("hidden"); }
            if (btn) { btn.disabled = false; btn.textContent = "🎯 Real MT5 Backtest"; }
            return;
          }
          backtestOpts.customStart = startVal;
          backtestOpts.customEnd = endVal;
        }

        var report = await window.GoldAI_Backtest.runRealMT5Backtest(backtestOpts);

        if (report.errors && report.errors.length) {
          if (box) box.innerHTML = "❌ " + report.errors.join("<br>") +
            "<br><span style='opacity:.7;font-size:11px'>مطمئن شو MT5 روی VPS متصل است و mt5-bridge/backend روشن‌اند.</span>";
          if (journalWrap) journalWrap.classList.add("hidden");
          return;
        }

        var pf = report.profitFactor;
        var ddCls = report.maxDrawdownPct > 20 ? "color:var(--red)" : "";
        var rangeLine = "<span style='opacity:.7;font-size:11px'>" +
          "بازه: " + (report.testStart ? new Date(report.testStart).toLocaleString("fa-IR") : "—") +
          " → " + (report.testEnd ? new Date(report.testEnd).toLocaleString("fa-IR") : "—") +
          " &nbsp;|&nbsp; Test Candles: " + report.testCandles +
          "</span><br>";
        if (box) {
          box.innerHTML =
            "<b>🎯 نتیجه Real MT5 Backtest — " + report.symbol + " · " + report.entryTF + " · " + report.mode + "</b><br>" +
            rangeLine +
            "<span style='opacity:.7;font-size:11px'>" + report.barsUsed + " کندل واقعی MT5 دریافت‌شده (شامل warm-up)" + (report.m1BarsUsed ? " + " + report.m1BarsUsed + " کندل M1 (tie-break)" : "") + "</span><br><br>" +
            "کل سیگنال: <b>" + report.totalSignals + "</b> &nbsp;|&nbsp; قابل‌اجرا: <b>" + report.executableSignals + "</b> &nbsp;|&nbsp; BUY: <b>" + report.buySignals + "</b> &nbsp;|&nbsp; SELL: <b>" + report.sellSignals + "</b><br>" +
            "برد: <b style='color:var(--green)'>" + report.wins + "</b> &nbsp;|&nbsp; باخت: <b style='color:var(--red)'>" + report.losses + "</b> &nbsp;|&nbsp; Breakeven: <b>" + report.breakeven + "</b><br>" +
            "وین‌ریت: <b>" + report.winRate + "%</b> &nbsp;|&nbsp; Profit Factor: <b>" + pf + "</b> &nbsp;|&nbsp; Net P/L: <b>" + report.netPL + "$</b><br>" +
            "میانگین برد: <b>" + report.avgWin + "$</b> &nbsp;|&nbsp; میانگین باخت: <b>" + report.avgLoss + "$</b> &nbsp;|&nbsp; میانگین R: <b>" + report.avgR + "</b><br>" +
            "Expectancy: <b>" + report.expectancy + "$</b>/معامله &nbsp;|&nbsp; حداکثر باخت متوالی: <b>" + report.maxConsecLosses + "</b><br>" +
            "Max Drawdown: <b style='" + ddCls + "'>" + report.maxDrawdown + "$ (" + report.maxDrawdownPct + "%)</b> &nbsp;|&nbsp; هزینه‌های معاملاتی: <b>" + report.totalTradingCosts + "$</b><br>" +
            "سرمایه نهایی: <b>" + report.finalEquity + "$</b>" +
            "<div style='margin-top:8px'>" + (report.notes || []).map(function (n) {
              return "<span style='opacity:.6;font-size:11px'>• " + n + "</span>";
            }).join("<br>") + "</div>";
        }

        if (journalTable && journalWrap) {
          var executed = (report.journal || []).filter(function (r) { return r.executed; });
          var rows = executed.slice(-500);
          var head = "<tr style='position:sticky;top:0;background:#14141c'>" +
            ["Time", "Signal", "Conf", "Price", "Executed", "Entry", "SL", "TP", "Exit", "Reason", "P/L", "R", "Bars"]
              .map(function (h) { return "<th style='padding:4px 6px;text-align:left;border-bottom:1px solid #2a2a35'>" + h + "</th>"; }).join("") + "</tr>";
          var body = rows.map(function (r) {
            var col = r.profitLoss > 0 ? "color:var(--green)" : (r.profitLoss < 0 ? "color:var(--red)" : "");
            var td = function (v) { return "<td style='padding:3px 6px;border-bottom:1px solid #1c1c26'>" + (v == null ? "—" : v) + "</td>"; };
            return "<tr>" +
              td(r.timeISO ? r.timeISO.slice(0, 16).replace("T", " ") : "—") +
              td(r.signal) + td(r.confidence) + td(r.price != null ? r.price.toFixed(2) : "—") +
              td(r.executed ? "✅" : (r.skippedReason || "—")) +
              td(r.entry) + td(r.stopLoss) + td(r.takeProfit) + td(r.exit) + td(r.exitReason) +
              "<td style='padding:3px 6px;border-bottom:1px solid #1c1c26;" + col + "'>" + (r.profitLoss != null ? r.profitLoss : "—") + "</td>" +
              td(r.rMultiple) + td(r.duration) +
              "</tr>";
          }).join("");
          journalTable.innerHTML = head + body;
          journalWrap.classList.remove("hidden");
          if (executed.length === 0) {
            journalTable.innerHTML = head + "<tr><td colspan='13' style='padding:10px;opacity:.7'>هیچ معامله اجراشده‌ای در این بازه نبود.</td></tr>";
          }
        }
      } catch (e) {
        console.error(e);
        if (box) { box.classList.remove("hidden"); box.textContent = "خطا: " + e.message; }
        else alert("خطا در بک‌تست: " + e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = "🎯 Real MT5 Backtest"; }
      }
    };

    if (G.showPanel && !G.__showPanelWrapped) {
      G.__showPanelWrapped = true;
      var _show = G.showPanel.bind(G);
      G.showPanel = function (name) {
        _show(name);
        if (name === "signals") this.renderPerformance();
      };
    }

    if (!G.changeSymbol) {
      G.changeSymbol = async function () {
        var select = document.getElementById("symbolSelect");
        if (!select) return;
        window.GoldAI_Config.SYMBOL = select.value;
        D.manualPriceLock = false;
        try {
          if (D.resetData) D.resetData();
          if (D.loadAll) await D.loadAll();
          if (!D.closes.m5.length && D.seedDemo) D.seedDemo();
          if (this.fetchPriceFromBackend) await this.fetchPriceFromBackend();
          this.updatePriceUI && this.updatePriceUI();
        } catch (e) {
          if (D.seedDemo) D.seedDemo();
          this.updatePriceUI && this.updatePriceUI();
        }
      };
    }
  }
  ready();
})();
