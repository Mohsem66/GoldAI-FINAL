// Prove reconciledWithScoreEngine actually catches a real disagreement: force a weight mismatch
// between the attribution module's copy and score.js's real weight, and show it is detected.
const path=require('path'), fs=require('fs'), assert=require('assert');
const {loadEngines}=require('../backend/worker/engine-loader.js');
const w=loadEngines(); const B=w.GoldAI_Backtest, cfg=w.GoldAI_Config;
cfg.ATTRIBUTION_ENABLED=true; cfg.STRICT_MODE=false; w.GoldAI_Data.dataMode='live';
const rows=fs.readFileSync('/home/claude/v53/XAUUSD_M5_MT5.csv','utf8').trim().split(/\r?\n/).slice(1).map(l=>l.split(','));
const bars=rows.map(c=>({time:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]||0,spread:0}));
const H=B.resample(bars,300,3600);
function evalAt(i){
  const sl=bars.slice(i-399,i+1), S=B.seriesOf(sl), hb=H.filter(h=>h.time+3600<=bars[i].time+300).slice(-100), Hs=B.seriesOf(hb);
  return B.buildSignal({closes:S.closes,highs:S.highs,lows:S.lows,volumes:S.volumes,candles:S.candles},{closes:Hs.closes,highs:Hs.highs,lows:Hs.lows},{closes:S.closes},cfg,S.closes[S.closes.length-1]);
}
let baselineOk=0, i=1010;
const built=evalAt(i);
let attr=w.GoldAI_Attribution.safeBuild(built.final, built.layers, cfg);
assert(attr.edge.reconciliation.reconciledWithScoreEngine===true, 'baseline must reconcile');
assert(attr.edge.reconciliation.maxAbsDiff===0);
console.log('PASS  baseline reconciles (maxAbsDiff=0)');

// Inject a deliberate mismatch: corrupt the module's copy of the RSI weight (1.1 -> 2.0).
const modPath = require.resolve('../js/engines/signal-attribution.js');
delete require.cache[modPath];
let src = fs.readFileSync(modPath,'utf8');
assert(src.includes('["rsi", 1.1]'));
const corrupted = src.replace('["rsi", 1.1]', '["rsi", 2.0]');
const tmpMod = modPath + '.corrupted.js';
fs.writeFileSync(tmpMod, corrupted);
// Load the corrupted module in isolation (does not touch the real file used by the Worker/tests).
const vm=require('vm');
const sandboxWindow={};
vm.runInNewContext(corrupted, {window: sandboxWindow, Number, Object, Math, Array, JSON, Proxy}, {filename:tmpMod});
const badAttr = sandboxWindow.GoldAI_Attribution.safeBuild(built.final, built.layers, cfg);
console.log('corrupted-weight result:', JSON.stringify(badAttr.edge.reconciliation));
assert(badAttr.edge.reconciliation.reconciledWithScoreEngine===false, 'must detect mismatch');
assert(badAttr.edge.reconciliation.maxAbsDiff>0, 'maxAbsDiff must be >0 when weights disagree');
fs.unlinkSync(tmpMod);
console.log('PASS  corrupted weight (rsi 1.1->2.0) is detected: reconciledWithScoreEngine=false, maxAbsDiff='+badAttr.edge.reconciliation.maxAbsDiff);
console.log('MISMATCH TEST: PASS');
