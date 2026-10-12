/**
 * 60-day Real MT5 walk-forward using CURRENT account equity (not the $10k default).
 */
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { loadEngines } = require("./engine-loader");

const BRIDGE = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const SYMBOL = process.env.MT5_SYMBOL || "XAUUSD.";
const OUT = path.join(__dirname, "..", "data", "backtest-2month.json");

async function fetchCandles(timeframe, count, start, end) {
  const params = { symbol: SYMBOL, timeframe, count: Math.max(10, Math.min(Number(count) || 4000, 5000)) };
  if (start != null && end != null) {
    params.start = start;
    params.end = end;
  }
  const res = await axios.get(BRIDGE + "/candles", { params, timeout: 90000 });
  return res.data;
}

async function main() {
  const acc = (await axios.get(BRIDGE + "/account-info", { timeout: 8000 })).data || {};
  const capital = Number(acc.equity) > 0 ? Number(acc.equity)
    : (Number(acc.balance) > 0 ? Number(acc.balance) : 9094.74);

  const engines = loadEngines();
  engines.GoldAI_Config.SYMBOL = SYMBOL;
  engines.GoldAI_Config.ACTIVE_TIMEFRAME = "m5";
  engines.GoldAI_Data.dataMode = "live";
  engines.GoldAI_Data.livePriceOk = true;
  engines.GoldAI_Data.fetchMT5History = (tf, count, start, end) => fetchCandles(tf, count, start, end);
  engines.GoldAI_Data.fetchMT5RangeChunked = async (tf, startEpoch, endEpoch, tfSeconds, maxBarsPerChunk) => {
    const perChunk = Math.max(200, Math.min(Number(maxBarsPerChunk) || 4000, 5000));
    const chunkSeconds = perChunk * (Number(tfSeconds) || 300);
    const all = [];
    let cur = Math.floor(startEpoch);
    const endI = Math.floor(endEpoch);
    let guard = 0;
    while (cur < endI && guard < 800) {
      guard++;
      const chunkEnd = Math.min(endI, cur + chunkSeconds);
      const res = await fetchCandles(tf, perChunk, cur, chunkEnd);
      if (res && res.status === "ok" && res.candles && res.candles.length) all.push(...res.candles);
      cur = chunkEnd;
    }
    const byTime = new Map();
    for (const c of all) byTime.set(c.time, c);
    const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    return { status: merged.length ? "ok" : "unavailable", symbol: SYMBOL, timeframe: tf, candles: merged };
  };
  engines.GoldAI_Data.fetchMT5SymbolSpecs = async () => {
    const res = await axios.get(BRIDGE + "/symbol-info", { params: { symbol: SYMBOL }, timeout: 8000 });
    return res.data;
  };

  const end = new Date();
  const start = new Date(end.getTime() - 60 * 24 * 3600 * 1000);

  console.error("CAPITAL=" + capital + " START=" + start.toISOString() + " END=" + end.toISOString());

  const report = await engines.GoldAI_Backtest.runRealMT5Backtest({
    entryTF: "M5",
    mode: "scalp",
    rangePreset: "custom",
    customStart: start.toISOString(),
    customEnd: end.toISOString(),
    capital,
    riskPercent: Number(engines.GoldAI_Config.DEFAULT_RISK_PERCENT) || 1,
    minConfidence: Number(engines.GoldAI_Config.MIN_CONFIDENCE) || 68,
    slippagePoints: 2,
    commissionPerLot: 7,
    tpTarget: "tp1"
  });

  report.accountSnapshot = {
    login: acc.login || null,
    balance: acc.balance,
    equity: acc.equity,
    freeMargin: acc.freeMargin,
    leverage: acc.leverage,
    currency: acc.currency,
    capitalUsed: capital
  };

  const slim = { ...report, journal: (report.journal || []).filter((r) => r.executed) };
  fs.writeFileSync(OUT, JSON.stringify(slim, null, 2));

  const j = slim.journal || [];
  console.log(JSON.stringify({
    capitalUsed: capital,
    accountEquity: acc.equity,
    accountBalance: acc.balance,
    testStart: report.testStart,
    testEnd: report.testEnd,
    testCandles: report.testCandles,
    barsUsed: report.barsUsed,
    m1BarsUsed: report.m1BarsUsed,
    totalSignals: report.totalSignals,
    executableSignals: report.executableSignals,
    buySignals: report.buySignals,
    sellSignals: report.sellSignals,
    executed: j.length,
    execBuy: j.filter((r) => String(r.signal).includes("BUY")).length,
    execSell: j.filter((r) => String(r.signal).includes("SELL")).length,
    wins: report.wins,
    losses: report.losses,
    breakeven: report.breakeven,
    winRate: report.winRate,
    profitFactor: report.profitFactor,
    netPL: report.netPL,
    avgWin: report.avgWin,
    avgLoss: report.avgLoss,
    avgR: report.avgR,
    expectancy: report.expectancy,
    maxDrawdown: report.maxDrawdown,
    maxDrawdownPct: report.maxDrawdownPct,
    maxConsecLosses: report.maxConsecLosses,
    totalTradingCosts: report.totalTradingCosts,
    finalEquity: report.finalEquity,
    errors: report.errors,
    notes: report.notes
  }, null, 2));
}

main().catch((e) => {
  console.error("BACKTEST_FAIL", e && e.stack ? e.stack : e);
  process.exit(1);
});
