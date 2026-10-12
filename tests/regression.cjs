const {spawnSync}=require('child_process'), fs=require('fs');
const CSV=process.argv[2]||'/home/claude/v53/XAUUSD_M5_MT5.csv', N0=process.argv[3]||'300', N1=process.argv[4]||'3300';
const scenarios=[
 {name:'S1 production cfg, live',        cfg:{},                   dataMode:'live'},
 {name:'S2 STRICT_MODE off (test-only)', cfg:{STRICT_MODE:false},  dataMode:'live'},
 {name:'S3 mixed data mode',             cfg:{},                   dataMode:'mixed'},
 {name:'S4 STRICT off + mixed',          cfg:{STRICT_MODE:false},  dataMode:'mixed'},
];
const fields=['signal','confidence','buyScore','sellScore','directionalEdge','primaryReject','rejectReasons','waitStage','entryQuality','full','atr'];
let allOk=true;
for(const sc of scenarios){
  const r={};
  for(const m of ['O','A','B','BX']){
    try{fs.unlinkSync('/home/claude/work/backend/worker/data/localstorage-polyfill.json')}catch(_){}
    try{fs.unlinkSync('/home/claude/orig/backend/worker/data/localstorage-polyfill.json')}catch(_){}
    const f=`/tmp/reg_${m}.json`;
    const p=spawnSync(process.execPath,[__dirname+'/run-one.cjs',m,JSON.stringify(sc),f,CSV,N0,N1],{encoding:'utf8',maxBuffer:1<<28});
    if(p.status!==0){console.log('RUN FAIL',m,p.stderr.slice(0,400));process.exit(1)}
    r[m]=JSON.parse(fs.readFileSync(f,'utf8'));
  }
  const n=r.A.out.length; const cmp=(X,Y)=>{const d={};for(const fl of fields)d[fl]=0;for(let k=0;k<n;k++)for(const fl of fields)if(JSON.stringify(X.out[k][fl])!==JSON.stringify(Y.out[k][fl]))d[fl]++;return d};
  const sig=x=>{const c={};x.out.forEach(o=>{const k=String(o.signal).split(' ')[0];c[k]=(c[k]||0)+1});return c};
  const qNon=r.B.out.filter(o=>JSON.parse(o.full).diagnostics && JSON.parse(o.full).diagnostics.signalAfterQuality && !String(JSON.parse(o.full).diagnostics.signalAfterQuality).includes('WAIT')).length;
  const dOA=cmp(r.O,r.A), dAB=cmp(r.A,r.B), dABX=cmp(r.A,r.BX);
  const sum=d=>Object.values(d).reduce((a,b)=>a+b,0);
  const cntEq=JSON.stringify(r.A.cnt)===JSON.stringify(r.B.cnt)&&JSON.stringify(r.A.cnt)===JSON.stringify(r.BX.cnt)&&JSON.stringify(r.O.cnt)===JSON.stringify(r.A.cnt);
  const keyOff=r.A.out.every(o=>!o.hasStepsKey)&&r.O.out.every(o=>!o.hasStepsKey), keyOn=r.B.out.every(o=>o.hasStepsKey);
  const ok= sum(dOA)===0&&sum(dAB)===0&&sum(dABX)===0&&cntEq&&keyOff&&keyOn&&r.B.stat.layersMutated===0&&r.B.stat.mutatedFinal===0&&r.BX.stat.attrBuilt===0&&r.BX.stat.attrNull===n;
  allOk=allOk&&ok;
  console.log(`\n== ${sc.name}  (evals=${n})`);
  console.log(' final signals:',JSON.stringify(sig(r.A)),' | after-quality non-WAIT:',qNon);
  console.log(' Original vs Patched(off) diffs :',JSON.stringify(dOA));
  console.log(' Patched(off) vs Patched(on) diffs:',JSON.stringify(dAB));
  console.log(' Patched(off) vs attribution-throws diffs:',sum(dABX));
  console.log(' engine call counts O/A/B/BX equal:',cntEq,JSON.stringify(r.B.cnt));
  console.log(' confidenceSteps key absent when off:',keyOff,' present when on:',keyOn);
  console.log(' B stats:',JSON.stringify(r.B.stat));
  console.log(' BX stats (attribution forced to fail):',JSON.stringify(r.BX.stat));
  console.log(' RESULT:',ok?'PASS':'FAIL');
}
console.log('\nOVERALL:',allOk?'PASS':'FAIL'); process.exit(allOk?0:2);
