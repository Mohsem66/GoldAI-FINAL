const {spawnSync}=require('child_process'), fs=require('fs');
const CSV=process.argv[2]||'/home/claude/v53/XAUUSD_M5_MT5.csv';
const SC=[
 {name:'M1 prod cfg / live            (=old S1)', n0:300,n1:3300, cfg:{},                 dataMode:'live'},
 {name:'M2 STRICT off (test-only)     (=old S2)', n0:300,n1:3300, cfg:{STRICT_MODE:false},dataMode:'live'},
 {name:'M3 mixed data                 (=old S3)', n0:300,n1:3300, cfg:{},                 dataMode:'mixed'},
 {name:'M4 STRICT off + mixed         (=old S4)', n0:300,n1:3300, cfg:{STRICT_MODE:false},dataMode:'mixed'},
 {name:'M5 offline data -> DATA_MODE',            n0:300,n1:3300, cfg:{STRICT_MODE:false},dataMode:'offline'},
 {name:'M6 RiskGuard blocks (test override)',     n0:300,n1:3300, cfg:{STRICT_MODE:false},dataMode:'live', riskBlock:true},
 {name:'M7 ACTIVE_TIMEFRAME=m1 (m1.independent=false)', n0:300,n1:3300, cfg:{STRICT_MODE:false,ACTIVE_TIMEFRAME:'m1'},dataMode:'live'},
 {name:'M8 wide coverage 3300-9900 STRICT off',  n0:3300,n1:9900, cfg:{STRICT_MODE:false},dataMode:'live'},
];
const F=['signal','confidence','buyScore','sellScore','directionalEdge','primaryReject','rejectReasons','waitStage','entryQuality','atr','full'];
const cov={BUY:0,SELL:0,WAIT_LOW_EDGE:0,QUALITY_REJECT:0,PERMISSION_REJECT:0,DEDUP:0,CHOCH:0,HTF_BULL:0,HTF_BEAR:0,M1_INDEPENDENT_TRUE:0,M1_INDEPENDENT_FALSE:0,REGIME_RANGE:0};
const rej={}; let allOk=true; const res=[];
for(const sc of SC){
  const r={};
  for(const m of ['O','A','B','BX']){
    for(const d of ['/home/claude/work','/home/claude/orig']) try{fs.unlinkSync(d+'/backend/worker/data/localstorage-polyfill.json')}catch(_){}
    const f=`/tmp/mx_${m}.json`;
    const p=spawnSync(process.execPath,[__dirname+'/run-matrix-one.cjs',m,JSON.stringify(sc),f,CSV],{encoding:'utf8',maxBuffer:1<<29});
    if(p.status!==0){console.log('RUN FAIL',sc.name,m,(p.stderr||'').slice(0,500));process.exit(1)}
    r[m]=JSON.parse(fs.readFileSync(f,'utf8'));
  }
  const n=r.A.out.length;
  const diff=(X,Y)=>{const d={};F.forEach(k=>d[k]=0);for(let k=0;k<n;k++)F.forEach(fl=>{if(JSON.stringify(X.out[k][fl])!==JSON.stringify(Y.out[k][fl]))d[fl]++});const covd=X.out.filter((o,k)=>JSON.stringify(o.cov)!==JSON.stringify(Y.out[k].cov)).length;d.structure_choch_htf_m1=covd;return d};
  const sum=d=>Object.values(d).reduce((a,b)=>a+b,0);
  const dOA=diff(r.O,r.A), dAB=diff(r.A,r.B), dABX=diff(r.A,r.BX);
  const cntEq=[r.A,r.B,r.BX].every(x=>JSON.stringify(x.cnt)===JSON.stringify(r.O.cnt));
  const keyOff=[r.O,r.A].every(x=>x.out.every(o=>!o.hasStepsKey)), keyOn=r.B.out.every(o=>o.hasStepsKey);
  // confidenceSteps is written by runSignalQuality (real-engine instrumentation) whenever
  // ATTRIBUTION_ENABLED===true, independently of whether Attribution.safeBuild later succeeds (B) or
  // fails (BX). So BX must show the SAME own-property presence as B, even though attribution itself is null.
  const keyOnBX=r.BX.out.every(o=>o.hasStepsKey);
  const s=r.B.stat, sx=r.BX.stat;
  const okNone = (s.noneMissingPipeline===0 && s.noneMissingStage===0 && (s.noneCount===0 || s.noneReasonAvailable===s.noneCount));
  const okB = s.attrBuilt===n && s.reconciled===n && s.maxAbsDiff===0 && s.chainOk===n && s.layersMutated===0 && s.finalMutated===0 && s.cfgMutated===0 && s.forbiddenKeys===0 && okNone;
  const okBX= sx.attrBuilt===0 && sx.attrNull===n && sx.layersMutated===0 && sx.finalMutated===0;
  const ok= sum(dOA)===0&&sum(dAB)===0&&sum(dABX)===0&&cntEq&&keyOff&&keyOn&&keyOnBX&&okB&&okBX;
  allOk=allOk&&ok;
  r.A.out.forEach(o=>{const sg=String(o.signal);if(sg.includes('BUY'))cov.BUY++;if(sg.includes('SELL'))cov.SELL++;const pr=o.primaryReject;if(pr){rej[pr]=(rej[pr]||0)+1;}
    if(pr==='LOW_EDGE')cov.WAIT_LOW_EDGE++; if(['REGIME_RANGE','HTF_AGAINST','HTF_WEAK','LOW_EDGE'].includes(pr))cov.QUALITY_REJECT++; if(['DATA_MODE','RISK_GUARD','SIGNAL_DEDUP','LOW_CONFIDENCE'].includes(pr))cov.PERMISSION_REJECT++; if(pr==='SIGNAL_DEDUP')cov.DEDUP++; if(pr==='REGIME_RANGE')cov.REGIME_RANGE++;
    if(o.cov.choch)cov.CHOCH++; if(o.cov.htf==='BULLISH')cov.HTF_BULL++; if(o.cov.htf==='BEARISH')cov.HTF_BEAR++; if(o.cov.m1ind===true)cov.M1_INDEPENDENT_TRUE++; if(o.cov.m1ind===false)cov.M1_INDEPENDENT_FALSE++;});
  const sig={};r.A.out.forEach(o=>{const k=String(o.signal).split(' ')[0];sig[k]=(sig[k]||0)+1});
  console.log(`\n== ${sc.name} (evals=${n}) final=${JSON.stringify(sig)}  ${ok?'PASS':'FAIL'}`);
  console.log('   Original vs Patched(OFF) diff-count:',sum(dOA),'| OFF vs ON:',sum(dAB),'| OFF vs ON+exception:',sum(dABX),'| engine-call-counts identical O/A/B/BX:',cntEq,JSON.stringify(r.B.cnt));
  console.log('   key confidenceSteps absent(OFF):',keyOff,'present(ON):',keyOn,'present(ON+exception/BX, own-property):',keyOnBX);
  console.log('   ON: built',s.attrBuilt,'/',n,'reconciled',s.reconciled,'maxAbsDiff',s.maxAbsDiff,'chainOk',s.chainOk,'layersMutated',s.layersMutated,'finalMutated',s.finalMutated,'cfgMutated',s.cfgMutated,'perIndicatorConfKeys',s.forbiddenKeys);
  console.log('   ON direction-none: count',s.noneCount,'reasonAvailable',s.noneReasonAvailable,'missingPipeline',s.noneMissingPipeline,'missingStage',s.noneMissingStage,'okNone',okNone);
  console.log('   ON+exception: built',sx.attrBuilt,'nulled',sx.attrNull,'/',n);
  res.push({sc:sc.name,ok});
}
console.log('\nCOVERAGE (across all scenarios, Attribution-OFF outputs):',JSON.stringify(cov));
console.log('primaryReject values seen:',JSON.stringify(rej));
const missing=Object.entries(cov).filter(([k,v])=>v===0).map(([k])=>k);
console.log('coverage categories with ZERO occurrences:',JSON.stringify(missing));
const okAll=allOk&&missing.length===0; console.log('\nOVERALL MATRIX:',okAll?'PASS':'FAIL'); process.exit(okAll?0:2);
