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

    G.openSettingsModal = function () {
      var cfg = window.GoldAI_Config || {};
      var cap = (D.getCapital && D.getCapital()) || 10000;
      var old = document.getElementById("settingsModal");
      if (old) old.remove();
      var sel = function (cur, v) { return String(cur) === String(v) ? " selected" : ""; };
      var html =
        '<div id="settingsModal" class="modal-backdrop" onclick="if(event.target.id===\'settingsModal\')GoldAI.closeSettingsModal()">' +
        '<div class="modal-sheet" onclick="event.stopPropagation()">' +
        '<div class="modal-head"><h3>⚙️ تنظیمات پروژه</h3>' +
        '<button type="button" class="btn-icon" onclick="GoldAI.closeSettingsModal()">✕</button></div>' +
        '<div class="settings-modal-grid">' +
        '<div class="field"><label>سرمایه ($)</label><input type="number" id="modalCapital" value="' + cap + '" min="100"></div>' +
        '<div class="field"><label>ریسک (%)</label><input type="number" id="modalRisk" value="' + (cfg.DEFAULT_RISK_PERCENT || 1) + '" min="0.1" max="10" step="0.1"></div>' +
        '<div class="field"><label>تعداد TP</label><select id="modalTpCount">' +
        '<option value="1"' + sel(cfg.TP_COUNT, 1) + '>۱</option>' +
        '<option value="2"' + sel(cfg.TP_COUNT, 2) + '>۲</option>' +
        '<option value="3"' + sel(cfg.TP_COUNT || 3, 3) + '>۳</option></select></div>' +
        '<div class="field"><label>لات دستی (۰=خودکار)</label><input type="number" id="modalLot" value="' + (cfg.USER_LOT || 0) + '" step="0.01" min="0"></div>' +
        '<div class="field"><label>ضریب SL (ATR)</label><input type="number" id="modalSl" value="' + (cfg.ATR_SL_MULT || 1.5) + '" step="0.1"></div>' +
        '<div class="field"><label>ضریب TP1</label><input type="number" id="modalTp1" value="' + (cfg.ATR_TP1_MULT || 2) + '" step="0.1"></div>' +
        '<div class="field"><label>ضریب TP2</label><input type="number" id="modalTp2" value="' + (cfg.ATR_TP2_MULT || 3.5) + '" step="0.1"></div>' +
        '<div class="field"><label>ضریب TP3</label><input type="number" id="modalTp3" value="' + (cfg.ATR_TP3_MULT || 5) + '" step="0.1"></div>' +
        '<div class="field"><label>روش معامله</label><select id="modalTradeMode">' +
        '<option value="manual">MANUAL — تأیید کاربر</option>' +
        '<option value="auto">AUTO — اجرای خودکار</option></select></div>' +
        '<div class="field full"><label>استراتژی</label><select id="modalStrategy">' +
        '<option value="scalp"' + (cfg.STRATEGY_MODE !== "swing" ? " selected" : "") + '>اسکالپ</option>' +
        '<option value="swing"' + (cfg.STRATEGY_MODE === "swing" ? " selected" : "") + '>سوئینگ</option></select></div>' +
        '</div><div class="modal-actions">' +
        '<button type="button" class="btn-main" onclick="GoldAI.saveSettingsModal()">💾 ذخیره</button>' +
        '<button type="button" class="btn-ghost" onclick="GoldAI.closeSettingsModal()">بستن</button>' +
        '</div></div></div>';
      document.body.insertAdjacentHTML("beforeend", html);
      var modeEl = document.getElementById("modalTradeMode");
      if (modeEl) modeEl.value = cfg.TRADE_MODE === "auto" ? "auto" : "manual";
    };

    G.closeSettingsModal = function () {
      var m = document.getElementById("settingsModal");
      if (m) m.remove();
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
      var strategy = (g("modalStrategy") && g("modalStrategy").value) || "scalp";
      var tradeMode = (g("modalTradeMode") && g("modalTradeMode").value) || "manual";

      if (D.setCapital) D.setCapital(capital);
      var cfg = window.GoldAI_Config;
      cfg.DEFAULT_RISK_PERCENT = risk;
      cfg.TP_COUNT = tpCount;
      cfg.USER_LOT = lot;
      cfg.ATR_SL_MULT = sl;
      cfg.ATR_TP1_MULT = tp1;
      cfg.ATR_TP2_MULT = tp2;
      cfg.ATR_TP3_MULT = tp3;
      cfg.STRATEGY_MODE = strategy;
      cfg.TRADE_MODE = tradeMode;

      var sync = function (id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val;
      };
      sync("advCapital", capital); sync("advRisk", risk); sync("userTpCount", tpCount);
      sync("userLot", lot); sync("userSlMult", sl); sync("userTp1Mult", tp1);
      sync("userTp2Mult", tp2); sync("userTp3Mult", tp3); sync("strategySelect", strategy);

      try {
        var stored = JSON.parse(localStorage.getItem("goldai_settings") || "{}");
        Object.assign(stored, {
          capital: capital, risk: risk, tpCount: tpCount, userLot: lot,
           slMult: sl, tp1Mult: tp1, tp2Mult: tp2, tp3Mult: tp3, strategy: strategy, tradeMode: tradeMode
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
        if (box) { box.classList.remove("hidden"); box.innerHTML = "⏳ در حال دریافت تاریخچه واقعی از MT5 و اجرای Walk-Forward…"; }

        var val = function (id, dv) { var el = document.getElementById(id); var v = el ? el.value : null; return (v === null || v === "") ? dv : v; };

        var report = await window.GoldAI_Backtest.runRealMT5Backtest({
          entryTF: val("btEntryTF", "M5"),
          mode: val("btMode", "scalp"),
          capital: Number(val("btCapital", 10000)),
          riskPercent: Number(val("btRisk", 1)),
          minConfidence: Number(val("btMinConf", 68)),
          slippagePoints: Number(val("btSlippage", 2)),
          count: Number(val("btCount", 1500))
        });

        if (report.errors && report.errors.length) {
          if (box) box.innerHTML = "❌ " + report.errors.join("<br>") +
            "<br><span style='opacity:.7;font-size:11px'>مطمئن شو MT5 روی VPS متصل است و mt5-bridge/backend روشن‌اند.</span>";
          if (journalWrap) journalWrap.classList.add("hidden");
          return;
        }

        var pf = report.profitFactor;
        var ddCls = report.maxDrawdownPct > 20 ? "color:var(--red)" : "";
        if (box) {
          box.innerHTML =
            "<b>🎯 نتیجه Real MT5 Backtest — " + report.symbol + " · " + report.entryTF + " · " + report.mode + "</b><br>" +
            "<span style='opacity:.7;font-size:11px'>" + report.barsUsed + " کندل واقعی MT5" + (report.m1BarsUsed ? " + " + report.m1BarsUsed + " کندل M1 (tie-break)" : "") + "</span><br><br>" +
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
          var rows = report.journal.slice(-500); // most recent 500 rows for browser perf
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
        if (name === "signals") {
          this.renderPerformance();
          this.renderChart(this.__chartTF || "m5");
        }
      };
    }

    // ---- Lightweight price chart (Signals tab) ----------------------------
    // UI-only: reads existing GoldAI_Data.candles[tf] (already loaded by the
    // current data layer for m1/m5/m15). No new data flow, no external
    // charting library — plain <canvas> candlesticks.
    G.__chartTF = "m5";

    G.setChartTF = function (tf) {
      this.__chartTF = tf;
      document.querySelectorAll(".tf-btn").forEach(function (b) {
        b.classList.toggle("active", b.getAttribute("data-tf") === tf);
      });
      this.renderChart(tf);
    };

    G.renderChart = function (tf) {
      var canvas = document.getElementById("priceChartCanvas");
      if (!canvas) return;
      var candles = (D.candles && D.candles[tf]) || [];
      var wrap = canvas.parentElement;
      var cssW = (wrap && wrap.clientWidth) || 640;
      var cssH = 220;
      var ratio = window.devicePixelRatio || 1;
      canvas.width = cssW * ratio;
      canvas.height = cssH * ratio;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      var ctx = canvas.getContext("2d");
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      var sample = candles.slice(-90);
      if (!sample.length) {
        ctx.fillStyle = "#6c6d78";
        ctx.font = "12px Vazirmatn, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("داده کندل موجود نیست", cssW / 2, cssH / 2);
        return;
      }

      var pad = 8;
      var highs = sample.map(function (c) { return c.high != null ? c.high : c.close; });
      var lows = sample.map(function (c) { return c.low != null ? c.low : c.close; });
      var max = Math.max.apply(null, highs);
      var min = Math.min.apply(null, lows);
      if (max === min) { max += 1; min -= 1; }
      var innerH = cssH - pad * 2;
      var toY = function (v) { return pad + (max - v) / (max - min) * innerH; };

      var slot = cssW / sample.length;
      var bodyW = Math.max(2, Math.min(8, slot * 0.6));

      sample.forEach(function (c, i) {
        var x = i * slot + slot / 2;
        var open = c.open, close = c.close, hi = c.high != null ? c.high : Math.max(open, close), lo = c.low != null ? c.low : Math.min(open, close);
        var up = close >= open;
        ctx.strokeStyle = up ? "#3dce7a" : "#ff6b6b";
        ctx.fillStyle = up ? "#3dce7a" : "#ff6b6b";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, toY(hi));
        ctx.lineTo(x, toY(lo));
        ctx.stroke();
        var yOpen = toY(open), yClose = toY(close);
        var top = Math.min(yOpen, yClose), h = Math.max(1, Math.abs(yClose - yOpen));
        ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      });
    };

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
