// GoldAI — Share modal (Signal Card → Share)
// Platforms: Telegram, Instagram, Twitter/X, Rubika, Eitaa only.
// No credentials, API keys, tokens, or internal URLs in the message.
(function () {
  function ready() {
    if (!window.GoldAI) return setTimeout(ready, 40);
    var G = window.GoldAI;

    G.buildShareTexts = function (r) {
      if (!r) return null;
      var decs = 2;
      try { if (this.getDecimals) decs = this.getDecimals(); } catch (e) {}
      function fmt(n) {
        if (n == null || n === "" || (typeof n === "number" && isNaN(n))) return "—";
        if (typeof n === "number") return n.toFixed(decs);
        return String(n);
      }

      var cfg = window.GoldAI_Config || {};
      var rawSym = (cfg.SYMBOL || "XAUUSD.").toUpperCase();
      var symbol = rawSym.replace("/", "").replace("GOLD", "XAUUSD");
      if (!symbol) symbol = "XAUUSD";

      var sig = String(r.signal || "WAIT").toUpperCase();
      var side = "WAIT";
      if (sig.indexOf("SELL") >= 0) side = "SELL";
      else if (sig.indexOf("BUY") >= 0) side = "BUY";

      var tf = (cfg.ACTIVE_TIMEFRAME || r.timeframe || "M5").toString().toUpperCase();
      var conf = (r.confidence != null && r.confidence !== "") ? (Number(r.confidence) + "%") : "—";
      var when = r.timestamp ? new Date(r.timestamp) : new Date();
      var dateStr, timeStr;
      try {
        dateStr = when.toLocaleDateString("fa-IR");
        timeStr = when.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" });
      } catch (e) {
        dateStr = when.toISOString().slice(0, 10);
        timeStr = when.toISOString().slice(11, 16);
      }

      var lines = [];
      lines.push("🥇 GoldAI Signal");
      lines.push(symbol + "  ·  " + side);
      lines.push("TF: " + tf + "  ·  Conf: " + conf);
      lines.push("Entry: " + fmt(r.entry));
      lines.push("SL: " + fmt(r.stopLoss != null ? r.stopLoss : r.sl));
      lines.push("TP: " + fmt(r.tp1 != null ? r.tp1 : r.tp));
      if (r.tp2 != null && r.tp2 !== "" && !isNaN(Number(r.tp2))) lines.push("TP2: " + fmt(r.tp2));
      if (r.tp3 != null && r.tp3 !== "" && !isNaN(Number(r.tp3))) lines.push("TP3: " + fmt(r.tp3));
      lines.push(dateStr + "  " + timeStr);

      var full = lines.join("\n");
      // Compact one-liner for URL-length-sensitive share targets
      var compact = symbol + " " + side + " | TF " + tf + " | Conf " + conf +
        " | Entry " + fmt(r.entry) + " | SL " + fmt(r.stopLoss != null ? r.stopLoss : r.sl) +
        " | TP " + fmt(r.tp1 != null ? r.tp1 : r.tp);

      return { full: full, compact: compact };
    };

    G.copyText = function (text, msg) {
      navigator.clipboard.writeText(text || "").then(function () {
        alert(msg || "✅ کپی شد");
      }).catch(function () {
        prompt("متن را کپی کنید:", text || "");
      });
    };

    G.shareSignal = function () {
      var r = this.lastResult;
      if (!r) return alert("ابتدا تحلیل کنید");

      var texts = this.buildShareTexts(r);
      if (!texts) return alert("سیگنال قابل اشتراک نیست");

      window._goldaiShareFull = texts.full;
      window._goldaiShareCompact = texts.compact;

      var enc = encodeURIComponent(texts.full);
      var tg = "https://t.me/share/url?url=&text=" + enc;
      var xUrl = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(texts.compact);

      var old = document.getElementById("shareModal");
      if (old) old.remove();

      var html = "" +
        "<div id=\"shareModal\" class=\"modal-backdrop\" onclick=\"if(event.target.id==='shareModal')this.remove()\">" +
        "<div class=\"modal-sheet\" onclick=\"event.stopPropagation()\" style=\"max-width:400px\">" +
        "<div class=\"modal-head\"><h3>📤 اشتراک سیگنال</h3>" +
        "<button type=\"button\" class=\"btn-icon\" onclick=\"document.getElementById('shareModal').remove()\">✕</button></div>" +
        "<div class=\"share-preview\" id=\"sharePreviewBox\"></div>" +
        "<div class=\"share-grid share-grid-platforms\">" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"window.open('" + tg + "','_blank')\">✈️ Telegram</button>" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"GoldAI.copyText(window._goldaiShareFull,'✅ کپی شد — در اینستاگرام پیست کنید');window.open('https://www.instagram.com/','_blank')\">📸 Instagram</button>" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"window.open('" + xUrl + "','_blank')\">𝕏 Twitter / X</button>" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"GoldAI.copyText(window._goldaiShareFull,'✅ کپی شد — در روبیکا پیست کنید');window.open('https://rubika.ir/','_blank')\">🟣 Rubika</button>" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"GoldAI.copyText(window._goldaiShareFull,'✅ کپی شد — در ایتا پیست کنید');window.open('https://eitaa.com/','_blank')\">🟢 Eitaa</button>" +
        "<button type=\"button\" class=\"share-platform-btn\" onclick=\"GoldAI.copyText(window._goldaiShareFull,'✅ متن سیگنال کپی شد')\">📋 کپی متن</button>" +
        "</div>" +
        "<button type=\"button\" class=\"btn-ghost\" style=\"width:100%;margin-top:12px\" onclick=\"document.getElementById('shareModal').remove()\">بستن</button>" +
        "</div></div>";

      document.body.insertAdjacentHTML("beforeend", html);
      var pre = document.getElementById("sharePreviewBox");
      if (pre) pre.textContent = texts.full;
    };
  }
  ready();
})();
