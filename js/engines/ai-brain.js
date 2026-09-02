// =====================================
// GoldAI — AI Decision Brain (Meta v2)
// Meta-filter only — does NOT re-score tech layers
// =====================================

window.GoldAI_AIBrain = {
  analyze(layers) {
    // Aggregate technical direction WITHOUT feeding scores back into Score engine
    let techBuy = 0;
    let techSell = 0;
    let n = 0;

    const peek = (layer) => {
      if (!layer) return;
      techBuy += layer.buyScore || 0;
      techSell += layer.sellScore || 0;
      n++;
    };

    peek(layers.structure);
    peek(layers.ema);
    peek(layers.rsi);
    peek(layers.divergence);
    peek(layers.macd);
    peek(layers.adx);
    peek(layers.volume);
    peek(layers.sr);
    peek(layers.candles);
    peek(layers.liquidity);

    const techDiff = techBuy - techSell;

    const fund = layers.fundamental || { buyScore: 0, sellScore: 0, sentiment: "NEUTRAL" };
    const corr = layers.correlation || { buyScore: 0, sellScore: 0, sentiment: "NEUTRAL" };

    // Soft ensemble probabilities (meta bias only)
    const techScore = techDiff / 3;
    const fundScore = (fund.buyScore - fund.sellScore) / 4;
    const corrScore = (corr.buyScore - corr.sellScore) / 4;

    // Tech dominates; simulated macro is soft
    const integrated = techScore * 0.7 + fundScore * 0.18 + corrScore * 0.12;

    const expBuy = Math.exp(Math.max(0, integrated));
    const expSell = Math.exp(Math.max(0, -integrated));
    const expWait = Math.exp(1.4);
    const sum = expBuy + expSell + expWait;

    const probBuy = expBuy / sum;
    const probSell = expSell / sum;
    const probWait = expWait / sum;

    let aiSignal = "WAIT 🟡";
    let aiConfidence = Math.round(probWait * 100);

    // Higher bar for directional meta signal
    if (probBuy > 0.48 && probBuy > probSell + 0.08) {
      aiSignal = "BUY 🟢";
      aiConfidence = Math.round(probBuy * 100);
    } else if (probSell > 0.48 && probSell > probBuy + 0.08) {
      aiSignal = "SELL 🔴";
      aiConfidence = Math.round(probSell * 100);
    }

    const persianReasons = [];
    if (aiSignal.includes("BUY")) {
      persianReasons.push("هم‌راستایی نسبی لایه‌های تکنیکال به نفع خرید است.");
    } else if (aiSignal.includes("SELL")) {
      persianReasons.push("هم‌راستایی نسبی لایه‌های تکنیکال به نفع فروش است.");
    } else {
      persianReasons.push("هم‌راستایی کافی نیست؛ صبر منطقی‌تر است.");
    }

    if (Math.abs(techDiff) < 2) {
      persianReasons.push("تکنیکال جهت مشخصی ندارد.");
    } else if (techDiff > 3) {
      persianReasons.push("ساختار و مومنتوم تکنیکال متمایل به صعود است.");
    } else if (techDiff < -3) {
      persianReasons.push("ساختار و مومنتوم تکنیکال متمایل به نزول است.");
    }

    if (fund.sentiment === "BULLISH") persianReasons.push("بایاس بنیادی شبیه‌سازی‌شده صعودی است.");
    if (fund.sentiment === "BEARISH") persianReasons.push("بایاس بنیادی شبیه‌سازی‌شده نزولی است.");
    if (corr.sentiment === "BULLISH") persianReasons.push("همبستگی بین‌بازاری شبیه‌سازی‌شده حامی طلا است.");
    if (corr.sentiment === "BEARISH") persianReasons.push("همبستگی بین‌بازاری شبیه‌سازی‌شده علیه طلا است.");

    return {
      aiSignal,
      aiConfidence,
      probBuy,
      probSell,
      probWait,
      techWeight: 70,
      fundWeight: 18,
      corrWeight: 12,
      reasoning: persianReasons.join(" "),
      techDiff,
      // Explicitly zero so Score does not double-count tech
      buyScore: 0,
      sellScore: 0
    };
  }
};
