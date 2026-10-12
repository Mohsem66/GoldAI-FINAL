// attribution-writer: rotation (50MB rule tested with a small limit), archives cap, I/O failure isolation.
const fs=require('fs'), path=require('path'), os=require('os'), assert=require('assert');
const W=require('../backend/worker/attribution-writer.js');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'attr-'));
const res=[]; const t=(n,fn)=>Promise.resolve().then(fn).then(()=>{res.push([n,'PASS'])},e=>{res.push([n,'FAIL: '+e.message])});
(async()=>{
 await t('default limits are 50MB / 2 archives',()=>{ const src=fs.readFileSync(__dirname+'/../backend/worker/attribution-writer.js','utf8'); assert(/maxBytes: 50 \* 1024 \* 1024/.test(src)); assert(/maxArchives: 2/.test(src)); });
 await t('rotation: active + .1 + .2, never .3, every file <= max',async()=>{
   const dir=path.join(tmp,'rot'); W.configure({dir,maxBytes:2000,maxArchives:2,maxQueue:5000});
   for(let i=0;i<200;i++) W.enqueue({i,pad:'x'.repeat(100)});
   await W.flush();
   const files=fs.readdirSync(dir).sort(); assert.deepStrictEqual(files,['attribution.1.jsonl','attribution.2.jsonl','attribution.jsonl']);
   for(const f of files) assert(fs.statSync(path.join(dir,f)).size<=2000,f+' too big');
   assert(W.stats().rotations>=2);
   const lines=files.flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n')).map(l=>JSON.parse(l).i);
   assert(lines.length>0 && Math.max(...lines)===199, 'newest record must be kept');
 });
 await t('enqueue returns immediately and never throws (circular / BigInt)',()=>{ const c={}; c.c=c; assert.doesNotThrow(()=>W.enqueue(c)); assert.doesNotThrow(()=>W.enqueue({b:10n})); });
 await t('I/O failure: dir cannot be created -> no throw, worker unaffected, later recovery',async()=>{
   const blocker=path.join(tmp,'file'); fs.writeFileSync(blocker,'x');
   W.configure({dir:path.join(blocker,'sub'),maxBytes:2000}); const before=W.stats().errors;
   assert.doesNotThrow(()=>{ for(let i=0;i<10;i++) W.enqueue({i}); }); await W.flush();
   assert(W.stats().errors>before,'error must be counted');
   const good=path.join(tmp,'good'); W.configure({dir:good}); W.enqueue({ok:1}); await W.flush();
   assert(fs.readFileSync(path.join(good,'attribution.jsonl'),'utf8').includes('"ok":1'));
 });
 await t('rotation failure (archive slot is a non-empty directory): no throw, file stays bounded',async()=>{
   const dir=path.join(tmp,'rotfail'); fs.mkdirSync(path.join(dir,'attribution.1.jsonl'),{recursive:true}); fs.writeFileSync(path.join(dir,'attribution.1.jsonl','keep'),'x');
   W.configure({dir,maxBytes:1500,maxArchives:2});
   for(let i=0;i<100;i++) W.enqueue({i,pad:'y'.repeat(100)}); await W.flush();
   assert(fs.statSync(path.join(dir,'attribution.jsonl')).size<=1500,'active file must stay bounded when rotation fails');
   assert(W.stats().errors>0);
 });
 await t('queue bound: overflow is dropped, not blocking',()=>{ W.configure({dir:path.join(tmp,'q'),maxQueue:3}); let dropped=0; const b=W.stats().dropped; for(let i=0;i<50;i++) W.enqueue({i}); assert(W.stats().dropped>b); });
 await W.flush();
 let bad=0; for(const [n,r] of res){ console.log((r==='PASS'?'PASS  ':'FAIL  ')+n+(r==='PASS'?'':' -> '+r)); if(r!=='PASS')bad++; }
 console.log('WRITER TESTS:',bad?'FAIL':'PASS'); process.exit(bad?1:0);
})();
