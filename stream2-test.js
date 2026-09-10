const { chromium } = require('playwright');
const TARGET_REPO=process.env.TARGET_REPO||'hmtnvac-cpu/xiec', TARGET_PATH=process.env.TARGET_PATH||'data/ket_qua_1500_phim.json', TOKEN=process.env.XIEC_TOKEN;
const LIMIT=Number(process.env.STREAM2_LIMIT||10), CONCURRENCY=Number(process.env.STREAM2_CONCURRENCY||10);
const WAIT_LEVELS=(process.env.STREAM2_WAIT_LEVELS||'8000,5000,3000,1500').split(',').map(Number).filter(Boolean);
if(!TOKEN) throw new Error('Missing XIEC_TOKEN');
const H={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xiec-stream2-test'};
async function read(){const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{headers:H});if(!r.ok)throw new Error(`read ${r.status}`);const d=await r.json();let encoded=d.content||'';if(!encoded){const b=await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${d.sha}`,{headers:H});if(!b.ok)throw new Error(`blob ${b.status}`);encoded=(await b.json()).content||'';}return{sha:d.sha,movies:JSON.parse(Buffer.from(encoded.replace(/\n/g,''),'base64').toString('utf8'))}}
async function write(sha,movies){const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{method:'PUT',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({message:`Test #2 on ${LIMIT} newest movies`,content:Buffer.from(JSON.stringify(movies,null,2)).toString('base64'),sha,branch:'main'})});if(!r.ok)throw new Error(`write ${r.status} ${await r.text()}`)}
const media=u=>/manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)|\.mp4(?:\?|$)|videoplayback|googlevideo/i.test(u);
const score=u=>{u=u.toLowerCase();return (u.includes('manifest')?100:0)+(u.includes('.m3u8')?90:0)+(u.includes('.mpd')?80:0)+(u.includes('.vl')?70:0)+(u.includes('videoplayback')?60:0)+(u.includes('1080')?30:0)+(u.includes('.mp4')?10:0)};
async function snapshot(page){return await page.evaluate(()=>({iframes:[...document.querySelectorAll('iframe')].map(x=>x.src).filter(Boolean),videos:[...document.querySelectorAll('video,source')].map(x=>x.src||x.currentSrc).filter(Boolean)})).catch(()=>({iframes:[],videos:[]}));}
async function activate2(page){
  const frames=page.frames();
  for(const f of frames){
    const info=await f.evaluate(()=>{
      const clean=s=>(s||'').replace(/\s+/g,' ').trim();
      const out=[];
      for(const el of [...document.querySelectorAll('button,a,[role="button"],li,span,div,[onclick],[data-server],[data-id],[data-src]')]){
        if(clean(el.textContent)!=='#2') continue;
        const target=el.closest('button,a,[role="button"],[onclick],[data-server],[data-id],[data-src],li')||el;
        const attrs={}; for(const a of target.attributes||[]) attrs[a.name]=a.value;
        out.push({tag:target.tagName,text:clean(target.textContent),attrs});
      }
      return out.slice(0,10);
    }).catch(()=>[]);
    if(info.length) console.log('STREAM2_DOM '+JSON.stringify(info));
    const ok=await f.evaluate(()=>{
      const clean=s=>(s||'').replace(/\s+/g,' ').trim();
      const els=[...document.querySelectorAll('button,a,[role="button"],li,span,div,[onclick],[data-server],[data-id],[data-src]')].filter(el=>clean(el.textContent)==='#2');
      if(!els.length)return false;
      const el=els[0]; const target=el.closest('button,a,[role="button"],[onclick],[data-server],[data-id],[data-src],li')||el;
      try{target.scrollIntoView({block:'center'});}catch{}
      for(const type of ['pointerdown','mousedown','pointerup','mouseup','click']) target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
      try{target.click();}catch{}
      return true;
    }).catch(()=>false);
    if(ok)return true;
  }
  return false;
}
async function one(browser,m,index){
  const old=m.manifest_url||m.mp4_url||m.streams?.find(s=>s.name==='#1')?.url||'';
  for(const wait of WAIT_LEVELS){
    const ctx=await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',viewport:{width:1280,height:720}}); const p=await ctx.newPage();
    const bucket=new Set(), all=new Set(); const cap=u=>{all.add(u);if(media(u))bucket.add(u)}; p.on('request',r=>cap(r.url()));p.on('response',r=>cap(r.url()));
    try{
      await p.route('**/*',r=>['image','font'].includes(r.request().resourceType())?r.abort():r.continue());
      await p.goto(m.page_url,{waitUntil:'domcontentloaded',timeout:30000}); await p.waitForTimeout(800);
      bucket.clear(); all.clear(); const before=await snapshot(p);
      const clicked=await activate2(p); if(!clicked){console.log(`STREAM2_NO_BUTTON ${index+1}/${LIMIT} id=${m.id}`);await ctx.close();continue;}
      await p.waitForTimeout(wait); const after=await snapshot(p);
      for(const u of [...after.iframes,...after.videos]) if(media(u)) bucket.add(u);
      const candidates=[...bucket].filter(u=>u&&u!==old).sort((a,b)=>score(b)-score(a));
      if(candidates.length){const u=candidates[0];await ctx.close();console.log(`STREAM2_OK ${index+1}/${LIMIT} id=${m.id} wait=${wait}ms url=${u}`);const streams=[];if(old)streams.push({name:'#1',url:old});streams.push({name:'#2',url:u});return{...m,streams,stream2_status:'ok',stream2_wait_ms:wait};}
      const changed=JSON.stringify(before)!==JSON.stringify(after); console.log(`STREAM2_RETRY ${index+1}/${LIMIT} id=${m.id} wait=${wait}ms media=0 requests=${all.size} player_changed=${changed}`);
      if(all.size) console.log('STREAM2_REQUEST_SAMPLE '+JSON.stringify([...all].slice(0,8)));
      await ctx.close();
    }catch(e){await ctx.close();console.log(`STREAM2_RETRY ${index+1}/${LIMIT} id=${m.id} wait=${wait}ms error=${e.message}`)}
  }
  console.log(`STREAM2_MISS ${index+1}/${LIMIT} id=${m.id}`); return{...m,stream2_status:'test_no_media'};
}
(async()=>{let{sha,movies}=await read();const targets=movies.map((m,i)=>({m,i})).filter(x=>x.m.page_url).slice(0,LIMIT);const browser=await chromium.launch({headless:true});let cursor=0,ok=0,done=0;async function worker(){while(true){const n=cursor++;if(n>=targets.length)return;const t=targets[n],out=await one(browser,t.m,n);movies[t.i]=out;if(out.stream2_status==='ok')ok++;done++;console.log(`STREAM2_PROGRESS processed=${done}/${targets.length} found=${ok} missed=${done-ok}`)}}await Promise.all(Array.from({length:Math.min(CONCURRENCY,targets.length)},worker));await browser.close();await write(sha,movies);console.log(`STREAM2_TEST_DONE tested=${targets.length} found=${ok} failed=${targets.length-ok}`)})();