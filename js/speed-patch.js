// =====================================
// GoldAI — Speed patch (safe)
// =====================================
(function () {
  function apply() {
    if (!window.GoldAI || !window.GoldAI_Data) return false;
    var G = window.GoldAI;
    var D = window.GoldAI_Data;
    if (G.__speedPatched) return true;
    G.__speedPatched = true;

    if (typeof D.loadEssential !== "function") {
      D.loadEssential = async function () {
        try {
          if (typeof this.loadAll === "function") await this.loadAll();
          else if (typeof this.loadPrice === "function") await this.loadPrice(true);
        } catch (e) { console.warn("loadEssential fallback:", e); }
        return this;
      };
    }
    if (typeof D.resetData !== "function") {
      D.resetData = function () {
        this.closes = { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] };
        this.highs = { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] };
        this.lows = { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] };
        this.volumes = { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] };
        this.candles = { m1: [], m5: [], m15: [], h1: [], h4: [], daily: [] };
        this.livePriceOk = false;
        if (!this.manualPriceLock) this.goldPrice = 0;
        this.dataMode = "demo";
      };
    }
    return true;
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply);
  else apply();
  setTimeout(apply, 0);
  setTimeout(apply, 100);
})();
