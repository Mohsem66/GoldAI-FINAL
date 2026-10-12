// usage: node run-one.cjs <O|A|B|BX> <scenarioJSON> <out.json> <csv> <n0> <n1>
// O = pristine original engines; A = patched, default cfg (attribution off); B = patched, attribution ON; BX = B but attribution.build throws
const fs=require('fs'), path=require('path');
const [,, MODE, SCEN, OUT, CSV, N0, N1] = process.argv;
const scen=JSON.parse(SCEN);
const root = MODE==='O' ? '/home/claude/orig' : '/home/claude/work';
const {loadEngines}=require(path.join(root,'backend/worker/engine-loader.js'));
const w=loadEngines(); const B=w.GoldAI_Backtest; const cfg=w.GoldAI_Config;
Object.assign(cfg, scen.cfg||{});                       // identical test-only cfg in every mode
w.GoldAI_Data.dataMode=scen.dataMode||'live';
if(MODE==='B'||MODE==='BX') cfg.ATTRIBUTION_ENABLED=true;
// call counters (must be identical across modes)
const cnt={analyzeMarketStructure:0,runTradePermission:0,riskCheck:0,runScoreEngine:0,runSignalQuality:0};
const M=w.GoldAI_MarketStructure, TP=w.GoldAI_TradePermission, RG=w.GoldAI_RiskGuard, SC=w.GoldAI_Score, CF=w.GoldAI_Conflict;
const o1=M.analyzeMarketStructure; M.analyzeMarketStructure=function(){cnt.analyzeMarketStructure++;return o1.apply(this,arguments)};
const o2=TP.runTradePermission; TP.runTradePermission=function(){cnt.runTradePermission++;return o2.apply(this,arguments)};
const o3=RG.check; RG.check=function(){cnt.riskCheck++;return o3.apply(this,arguments)};
const o4=SC.runScoreEngine; SC.runScoreEngine=function(){cnt.runScoreEngine++;return o4.apply(this,arguments)};
const rows=fs.readFileSync(CSV,'utf8').trim().split(/\r?\n/).slice(1).map(l=>l.split(','));
const bars=rows.map(c=>({time:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]||0,spread:+c[6]||0}));
const htfAll=B.resample(bars,300,3600);
const realNow=Date.now; const base=bars[0].time*1000; let htfPtr=0;
const out=[]; const stat={attrBuilt:0,attrNull:0,reconciled:0,chainOk:0,layersMutated:0,mutatedFinal:0};
const clone=x=>JSON.parse(JSON.stringify(x));
for(let i=+N0;i<+N1;i++){
  Date.now=()=>base+i*300000;                         // deterministic clock, identical in all modes
  const known=bars[i].time+300; while(htfPtr<htfAll.length && htfAll[htfPtr].time+3600<=known) htfPtr++;
  const sl=bars.slice(Math.max(0,i-399),i+1), S=B.seriesOf(sl), H=B.seriesOf(htfAll.slice(Math.max(0,htfPtr-100),htfPtr)), Mi=B.seriesOf(sl);
  const built=B.buildSignal({closes:S.closes,highs:S.highs,lows:S.lows,volumes:S.volumes,candles:S.candles},{closes:H.closes,highs:H.highs,lows:H.lows},{closes:Mi.closes},cfg,S.closes[S.closes.length-1]);
  const f=built.final;
  let attr=null;
  if(MODE==='B'||MODE==='BX'){
    const lb=JSON.stringify(built.layers), fb=JSON.stringify(f);       // snapshots BEFORE attribution
    attr=w.GoldAI_Attribution.safeBuild(f, MODE==='BX' ? new Proxy({}, {get(){ throw new Error('injected'); }}) : built.layers, cfg);
    if(JSON.stringify(built.layers)!==lb) stat.layersMutated++;
    if(JSON.stringify(f)!==fb) stat.mutatedFinal++;
    if(attr){ stat.attrBuilt++; if(attr.edge.reconciledWithScoreEngine) stat.reconciled++;
      const cs=attr.confidence; if(cs.qualityStageChainConsistent===true && cs.qualityStageSteps[cs.qualityStageSteps.length-1].after===cs.afterQuality) stat.chainOk++; }
    else stat.attrNull++;
  }
  const fc=clone(f); delete fc.confidenceSteps;                          // full object minus the only allowed new key
  out.push({i, signal:f.signal, confidence:f.confidence, buyScore:f.buyScore, sellScore:f.sellScore, directionalEdge:f.directionalEdge,
    primaryReject:f.primaryReject, rejectReasons:f.rejectReasons, waitStage:f.waitStage, entryQuality:f.entryQuality,
    hasStepsKey:Object.prototype.hasOwnProperty.call(f,'confidenceSteps'), full:JSON.stringify(fc), atr:built.atr});
}
Date.now=realNow;
cnt.riskCheck=cnt.riskCheck; fs.writeFileSync(OUT, JSON.stringify({MODE,scen,cnt,stat,out}));
