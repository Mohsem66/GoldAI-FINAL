// node run-matrix-one.cjs <O|A|B|BX> <scenarioJSON> <out.json> <csv>
// O=pristine original | A=patched, attribution OFF (default) | B=patched, ON | BX=patched, ON but attribution input explodes
const fs=require('fs'), path=require('path');
const [,, MODE, SCEN, OUT, CSV] = process.argv;
const scen=JSON.parse(SCEN);
const root = MODE==='O' ? '/home/claude/orig' : '/home/claude/work';
const {loadEngines}=require(path.join(root,'backend/worker/engine-loader.js'));
const w=loadEngines(); const B=w.GoldAI_Backtest; const cfg=w.GoldAI_Config;
if(MODE!=='O' && cfg.ATTRIBUTION_ENABLED!==undefined) throw new Error('default cfg must not define ATTRIBUTION_ENABLED');
Object.assign(cfg, scen.cfg||{});
w.GoldAI_Data.dataMode=scen.dataMode||'live';
if(MODE==='B'||MODE==='BX') cfg.ATTRIBUTION_ENABLED=true;
const cnt={analyzeMarketStructure:0,runTradePermission:0,riskCheck:0,runScoreEngine:0,runSignalQuality:0,analyzeEMA:0,analyzeADX:0};
const wrap=(obj,fn,key)=>{const o=obj[fn];obj[fn]=function(){cnt[key]++;return o.apply(this,arguments)}};
wrap(w.GoldAI_MarketStructure,'analyzeMarketStructure','analyzeMarketStructure');
wrap(w.GoldAI_TradePermission,'runTradePermission','runTradePermission');
wrap(w.GoldAI_Score,'runScoreEngine','runScoreEngine');
wrap(w.GoldAI_Conflict,'runSignalQuality','runSignalQuality');
wrap(w.GoldAI_EMA,'analyzeEMA','analyzeEMA'); wrap(w.GoldAI_ADX,'analyzeADX','analyzeADX');
const RG=w.GoldAI_RiskGuard, rgOrig=RG.check;
RG.check=function(){cnt.riskCheck++; return scen.riskBlock ? {allowed:false,reason:'TEST_BLOCK'} : rgOrig.apply(this,arguments)};
const rows=fs.readFileSync(CSV,'utf8').trim().split(/\r?\n/).slice(1).map(l=>l.split(','));
const bars=rows.map(c=>({time:+c[0],open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5]||0,spread:+c[6]||0}));
const htfAll=B.resample(bars,300,3600);
const realNow=Date.now; const base=bars[0].time*1000; let htfPtr=0;
const out=[]; const stat={attrBuilt:0,attrNull:0,reconciled:0,maxAbsDiff:0,chainOk:0,layersMutated:0,finalMutated:0,cfgMutated:0,forbiddenKeys:0,noneCount:0,noneReasonAvailable:0,noneMissingPipeline:0,noneMissingStage:0};
const clone=x=>JSON.parse(JSON.stringify(x));
const INDIC=/^(structure|ema|rsi|divergence|macd|adx|volume|sr|candles|liquidity|atr)$/i;
function scanKeys(o,acc){ if(o&&typeof o==='object'){ for(const k of Object.keys(o)){ if(INDIC.test(k)) acc.push(k); scanKeys(o[k],acc);} } return acc; }
const N0=scen.n0, N1=scen.n1;
for(let i=0;i<N0;i++){ const known=bars[i].time+300; while(htfPtr<htfAll.length && htfAll[htfPtr].time+3600<=known) htfPtr++; }
for(let i=N0;i<N1;i++){
  Date.now=()=>base+i*300000;
  const known=bars[i].time+300; while(htfPtr<htfAll.length && htfAll[htfPtr].time+3600<=known) htfPtr++;
  const sl=bars.slice(Math.max(0,i-399),i+1), S=B.seriesOf(sl), H=B.seriesOf(htfAll.slice(Math.max(0,htfPtr-100),htfPtr)), Mi=B.seriesOf(sl);
  const built=B.buildSignal({closes:S.closes,highs:S.highs,lows:S.lows,volumes:S.volumes,candles:S.candles},{closes:H.closes,highs:H.highs,lows:H.lows},{closes:Mi.closes},cfg,S.closes[S.closes.length-1]);
  const f=built.final; const L=built.layers;
  if(MODE==='B'||MODE==='BX'){
    const lb=JSON.stringify(L), fb=JSON.stringify(f), cb=JSON.stringify(cfg);
    const attr=w.GoldAI_Attribution.safeBuild(f, MODE==='BX' ? new Proxy({}, {get(){ throw new Error('injected'); }}) : L, cfg);
    if(JSON.stringify(L)!==lb) stat.layersMutated++;
    if(JSON.stringify(f)!==fb) stat.finalMutated++;
    if(JSON.stringify(cfg)!==cb) stat.cfgMutated++;
    if(attr){
      stat.attrBuilt++;
      const r=attr.edge.reconciliation; if(r.reconciledWithScoreEngine) stat.reconciled++; stat.maxAbsDiff=Math.max(stat.maxAbsDiff,r.maxAbsDiff);
      const c=attr.confidence; if(c.chain.consistent===true && c.chain.lastStepAfterEqualsAfterQuality===true) stat.chainOk++;
      stat.forbiddenKeys+=scanKeys(attr.confidence,[]).length;           // no per-indicator confidence keys anywhere in confidence block
      JSON.stringify(attr);                                              // must be serialisable
      // Direction-none transparency: every non-directional final must carry directionTrace with pipeline snapshot
      const dt=attr.decision && attr.decision.directionTrace;
      const nonDir = dt && dt.finalIsNonDirectional === true;
      if(nonDir){
        stat.noneCount++;
        if(dt.reasonAvailable === true) stat.noneReasonAvailable++;
        if(!dt.pipeline || typeof dt.pipeline !== 'object') stat.noneMissingPipeline++;
        if(!dt.stage) stat.noneMissingStage++;
      } else if (String(f.signal||'').toUpperCase().includes('WAIT')) {
        // WAIT without directionTrace.finalIsNonDirectional is a contract failure when attr built
        if(!dt || dt.finalIsNonDirectional !== true) stat.noneMissingStage++;
      }
    } else stat.attrNull++;
  }
  const fc=clone(f); delete fc.confidenceSteps;
  out.push({i, signal:f.signal, confidence:f.confidence, buyScore:f.buyScore, sellScore:f.sellScore, directionalEdge:f.directionalEdge,
    primaryReject:f.primaryReject, rejectReasons:f.rejectReasons, waitStage:f.waitStage, entryQuality:f.entryQuality, atr:built.atr,
    hasStepsKey:Object.prototype.hasOwnProperty.call(f,'confidenceSteps'), full:JSON.stringify(fc),
    cov:{choch:!!(L.structure&&L.structure.choch), bos:!!(L.structure&&L.structure.bos), structTrend:L.structure&&L.structure.trend, htf:L.htf&&L.htf.trend, m1ind:L.m1?L.m1.independent:null, m1micro:L.m1?L.m1.microstructure:null, regime:L.regime}});
}
Date.now=realNow;
fs.writeFileSync(OUT, JSON.stringify({MODE,scen,cnt,stat,out}));
