const path = require("path");
process.chdir(path.join(__dirname));
const { loadEngines } = require("./engine-loader");
const mt5 = require("./mt5-client");

(async () => {
  const engines = loadEngines();
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  const startEpoch = Math.floor(start.getTime() / 1000);
  const endEpoch = Math.floor(end.getTime() / 1000);

  const [m5, m1, specs] = await Promise.all([
    mt5.candles("M5", 2500),
    mt5.candles("M1", 5000),
    mt5.symbolInfo()
  ]);
  if (!m5 || m5.status !== "ok" || !m5.candles) {
    console.log(JSON.stringify({ error: "no M5", m5 }));
    process.exit(1);
  }

  engines.GoldAI_Data.dataMode = "live";
  engines.GoldAI_Data.livePriceOk = true;
  engines.GoldAI_Data.fetchMT5History = async (tf) => {
    if (String(tf).toUpperCase() === "M1") return m1 && m1.status === "ok" ? m1 : { status: "error", candles: [] };
    return m5;
  };
  engines.GoldAI_Data.fetchMT5RangeChunked = async (tf) => engines.GoldAI_Data.fetchMT5History(tf);
  engines.GoldAI_Data.fetchMT5SymbolSpecs = async () => (specs && specs.status === "ok" ? specs : { status: "ok", point: 0.01 });

  const report = await engines.GoldAI_Backtest.runRealMT5Backtest({
    entryTF: "M5",
    mode: "scalp",
    capital: 10000,
    riskPercent: 1,
    minConfidence: 68,
    slippagePoints: 2,
    rangePreset: "custom",
    customStart: start.toISOString(),
    customEnd: end.toISOString(),
    count: 2500
  });

  const executed = (report.journal || []).filter((r) => r.executed);
  const out = {
    range: { start: start.toISOString(), end: end.toISOString() },
    errors: report.errors,
    notes: report.notes,
    barsUsed: report.barsUsed,
    testCandles: report.testCandles,
    testStart: report.testStart,
    testEnd: report.testEnd,
    totalSignals: report.totalSignals,
    executableSignals: report.executableSignals,
    buySignals: report.buySignals,
    sellSignals: report.sellSignals,
    executed: executed.length,
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
    trades: executed.map((r) => ({
      time: r.timeISO,
      signal: r.signal,
      conf: r.confidence,
      entry: r.entry,
      sl: r.stopLoss,
      tp: r.takeProfit,
      exit: r.exit,
      reason: r.exitReason,
      pl: r.profitLoss,
      r: r.rMultiple,
      bars: r.duration,
      skip: r.skippedReason
    }))
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error("FATAL", e && e.stack ? e.stack : e);
  process.exit(1);
});
