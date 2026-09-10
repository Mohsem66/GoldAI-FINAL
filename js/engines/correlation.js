// =====================================
// GoldAI — Inter-market Correlation Engine
// =====================================

window.GoldAI_Correlation = {
  analyzeCorrelation(prices, currentPrice) {
    // SIMULATED ONLY — not live inter-market data.
    // Deterministic seed based on day for stable dynamic calculations.

    const date = new Date();
    const seed = (date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()) % 5;

    let dxyTrend = "BEARISH";
    let us10yTrend = "BEARISH";
    let silverTrend = "BULLISH";
    let spxTrend = "BULLISH";

    if (seed === 0) {
      dxyTrend = "BULLISH";
      us10yTrend = "BULLISH";
      silverTrend = "BEARISH";
      spxTrend = "BEARISH";
    } else if (seed === 1) {
      dxyTrend = "BULLISH";
      us10yTrend = "BEARISH";
      silverTrend = "BULLISH";
      spxTrend = "BULLISH";
    } else if (seed === 2) {
      dxyTrend = "BEARISH";
      us10yTrend = "BULLISH";
      silverTrend = "BEARISH";
      spxTrend = "BEARISH";
    } else if (seed === 3) {
      dxyTrend = "BEARISH";
      us10yTrend = "BEARISH";
      silverTrend = "BULLISH";
      spxTrend = "BULLISH";
    } else if (seed === 4) {
      dxyTrend = "RANGE";
      us10yTrend = "RANGE";
      silverTrend = "RANGE";
      spxTrend = "RANGE";
    }

    let buy = 0;
    let sell = 0;
    const reasons = [];
    const details = {
      dxy: dxyTrend,
      us10y: us10yTrend,
      silver: silverTrend,
      spx: spxTrend
    };

    if (dxyTrend === "BEARISH") {
      buy += 4;
      reasons.push("روند نزولی شاخص دلار (DXY) → محرک قوی صعود طلا");
    } else if (dxyTrend === "BULLISH") {
      sell += 4;
      reasons.push("روند صعودی شاخص دلار (DXY) → عامل کاهش قیمت طلا");
    } else {
      reasons.push("شاخص دلار (DXY) در محدوده رنج");
    }

    if (us10yTrend === "BEARISH") {
      buy += 3;
      reasons.push("نزول بازدهی اوراق ۱۰ ساله آمریکا → کاهش هزینه فرصت خرید طلا");
    } else if (us10yTrend === "BULLISH") {
      sell += 3;
      reasons.push("صعود بازدهی اوراق ۱۰ ساله آمریکا → جذاب‌تر شدن اوراق قرضه نسبت به طلا");
    } else {
      reasons.push("بازدهی اوراق ۱۰ ساله در وضعیت خنثی");
    }

    if (silverTrend === "BULLISH") {
      buy += 2;
      reasons.push("همبستگی صعودی نقره (XAG/USD) با طلا");
    } else if (silverTrend === "BEARISH") {
      sell += 2;
      reasons.push("همبستگی نزولی نقره با طلا");
    }

    if (spxTrend === "BEARISH") {
      buy += 1;
      reasons.push("کاهش بازار سهام (ریسک‌گریزی) → ورود سرمایه به طلا به عنوان دارایی امن");
    } else if (spxTrend === "BULLISH") {
      sell += 0.5;
      reasons.push("رشد بازار سهام (ریسک‌پذیری) → خروج موقت سرمایه از طلا");
    }

    const buyScore = Number(buy.toFixed(1));
    const sellScore = Number(sell.toFixed(1));
    const diff = buyScore - sellScore;

    let sentiment = "NEUTRAL";
    if (diff > 1.5) sentiment = "BULLISH";
    else if (diff < -1.5) sentiment = "BEARISH";

    return {
      buyScore,
      sellScore,
      confidence: Math.min(Math.round(Math.abs(diff) * 10), 20),
      sentiment,
      reasons,
      details,
      simulated: true,
      warnings: ["Correlation is simulated (not live data)"],
      summary: `تحلیل همبستگی (شبیه‌سازی): ${sentiment === "BULLISH" ? "صعودی 🟢" : sentiment === "BEARISH" ? "نزولی 🔴" : "خنثی 🟡"}`
    };
  }
};
