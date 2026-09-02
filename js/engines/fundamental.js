// =====================================
// GoldAI — Fundamental & Sentiment Engine
// Prefers backend /api/fundamental; falls back to local simulation
// =====================================

window.GoldAI_Fundamental = {
  _cache: null,
  _cacheAt: 0,

  async fetchFromBackend() {
    const cfg = window.GoldAI_Config || {};
    const base = (cfg.BACKEND_URL || "http://localhost:5000/api").replace(/\/$/, "");
    try {
      const res = await fetch(base + "/fundamental");
      if (!res.ok) return null;
      const data = await res.json();
      this._cache = data;
      this._cacheAt = Date.now();
      return data;
    } catch (e) {
      return null;
    }
  },

  analyzeFundamentals(cfg) {
    const cached = (this._cache && Date.now() - this._cacheAt < 300000) ? this._cache : null;
    if (cached && cached.details) return this._fromPayload(cached);
    return this._localSimulated();
  },

  _fromPayload(data) {
    const d = data.details || {};
    let buy = 0, sell = 0;
    const reasons = [];
    const details = { cpi: d.cpi || "—", nfp: d.nfp || "—", fed: d.fed || "—", geoRisk: d.geoRisk };
    const cpi = String(d.cpi || "").toUpperCase();
    const nfp = String(d.nfp || "").toUpperCase();
    const fed = String(d.fed || "").toUpperCase();

    if (cpi.includes("COOL") || cpi.includes("STAG")) { buy += 3; reasons.push("CPI supportive for gold"); }
    else if (cpi.includes("HOT")) { sell += 3; reasons.push("Hot CPI — USD pressure"); }
    if (nfp.includes("WEAK")) { buy += 2; reasons.push("Soft labor"); }
    else if (nfp.includes("STRONG")) { sell += 2; reasons.push("Strong NFP"); }
    if (fed.includes("DOV")) { buy += 3; reasons.push("Dovish Fed bias"); }
    else if (fed.includes("HAWK")) { sell += 3; reasons.push("Hawkish Fed bias"); }
    if ((d.geoRisk || 0) >= 8) { buy += 2; reasons.push("Elevated geo risk"); }

    const buyScore = Number(buy.toFixed(1));
    const sellScore = Number(sell.toFixed(1));
    const diff = buyScore - sellScore;
    let sentiment = "NEUTRAL";
    if (diff > 2) sentiment = "BULLISH";
    else if (diff < -2) sentiment = "BEARISH";

    const simulated = data.source !== "live";
    return {
      buyScore, sellScore,
      confidence: Math.min(Math.round(Math.abs(diff) * 10), 30),
      sentiment, reasons, details, simulated,
      source: data.source || "simulated",
      warnings: simulated ? ["Fundamental is simulated (not live data)"] : ["Fundamental from backend feed"],
      summary: `Fundamental (${data.source || "sim"}): ${sentiment}`
    };
  },

  _localSimulated() {
    const date = new Date();
    const seed = (date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()) % 7;
    const profiles = [
      { cpi: "HOT", nfp: "STRONG", fed: "HAWKISH", geoRisk: 5.1 },
      { cpi: "COOLING", nfp: "WEAK_GROWTH", fed: "DOVISH", geoRisk: 7.5 },
      { cpi: "IN_LINE", nfp: "IN_LINE", fed: "NEUTRAL", geoRisk: 6.8 },
      { cpi: "COOLING", nfp: "WEAK_GROWTH", fed: "DOVISH", geoRisk: 8.2 },
      { cpi: "STAGFLATION", nfp: "WEAK_GROWTH", fed: "NEUTRAL", geoRisk: 9.0 },
      { cpi: "HOT", nfp: "IN_LINE", fed: "HAWKISH", geoRisk: 4.5 },
      { cpi: "IN_LINE", nfp: "STRONG", fed: "NEUTRAL", geoRisk: 6.0 }
    ];
    return this._fromPayload({ source: "simulated", details: profiles[seed] });
  }
};
