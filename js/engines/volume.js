// =====================================
// GoldAI — Volume Engine
// =====================================

function analyzeVolume(volumes, closes) {
  const result = {
    avg: 0, last: 0, ratio: 1,
    spike: false, trend: "FLAT",
    buyScore: 0, sellScore: 0,
    reason: "Volume N/A"
  };
  if (!volumes || volumes.length < 20) return result;

  const last20 = volumes.slice(-20);
  const avg = last20.reduce((a, b) => a + b, 0) / last20.length;
  const last = volumes[volumes.length - 1];
  const ratio = avg > 0 ? last / avg : 1;

  result.avg = Number(avg.toFixed(0));
  result.last = Number(last.toFixed(0));
  result.ratio = Number(ratio.toFixed(2));

  const reasons = [];
  if (ratio >= 1.8) {
    result.spike = true;
    reasons.push("Volume spike");
  }

  // Price direction on volume
  if (closes && closes.length >= 2) {
    const up = closes[closes.length - 1] > closes[closes.length - 2];
    if (result.spike && up) {
      result.buyScore += 2;
      result.trend = "BULLISH";
      reasons.push("High vol + up close");
    } else if (result.spike && !up) {
      result.sellScore += 2;
      result.trend = "BEARISH";
      reasons.push("High vol + down close");
    }
  }

  // Rising volume average
  const first10 = volumes.slice(-20, -10).reduce((a, b) => a + b, 0) / 10;
  const second10 = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
  if (second10 > first10 * 1.2) reasons.push("Volume expanding");

  result.reason = reasons.join(" · ") || "Volume normal";
  return result;
}

window.GoldAI_Volume = { analyzeVolume };
