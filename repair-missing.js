const { chromium } = require('playwright');

const TARGET_REPO=process.env.TARGET_REPO||'hmtnvac-cpu/xiec';
const TARGET_PATH=process.env.TARGET_PATH||'data/ket_qua_1500_phim.json';
const TOKEN=process.env.XIEC_TOKEN;
const BATCH=Number(process.env.CHECKPOINT_EVERY||10);
const CONCURRENCY=Number(process.env.REPAIR_CONCURRENCY||8);
if(!TOKEN) throw new Error('Missing XIEC_TOKEN');
const GH={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xiec-repair-missing'};
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';

async function readTarget(){
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{headers:GH});
  if(!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
  const d=await r.json(); let enc=d.content||'';
  if(!enc){const b=await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${d.sha}`,{headers:GH});if(!b.ok)throw new Error(`blob ${b.status}`);enc=(await b.json()).content||'';}
  return {sha:d.sha,movies:JSON.parse(Buffer.from(enc.replace(/\n/g,''),'base64').toString('utf8'))};
}
async function writeTarget(sha,movies,message){
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{method:'PUT',headers:{...GH,'Content-Type':'application/json'},body:JSON.stringify({message,content:Buffer.from(JSON.stringify(movies,null,2)).toString('base64'),sha,branch:'main'})});
  if(!r.ok) throw new Error(`write ${r.status} ${await r.text()}`);
  return (await r.json()).content.sha;
}
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const hasS1=m=>(m.streams||[]).some(s=>/\/manifest-s1\//i.test(String(s?.url||'')))||/\/manifest-s1\//i.test(String(m.manifest_url||''));
const hasS2=m=>(m.streams||[]).some(s=>/\/manifest-s2\//i.test(String(s?.url||'')));
function extractFile(html){
  const src=html.match(/window\.__SRC\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if(src){try{const a=JSON.parse(src[1]);const f=a?.find(x=>x&&typeof x.file==='string')?.file;if(f)return f}catch{}}
  const m=html.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+)["']/i)||html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  return m?m[1].replace(/\\\//g,'/').replace(/&amp;/g,'&'):'';
}
async function embedFile(url){if(!url)return'';try{const r=await fetch(url,{headers:{'User-Agent':UA,'Referer':'https://vlxx.phd/'},redirect:'follow'});if(!r.ok)return'';return extractFile(await r.text())}catch{return''}}
async function fetchText(url,timeout=12000){const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);try{const r=await fetch(url,{signal:c.signal,redirect:'follow',headers:{'User-Agent':UA,'Referer':'https://vlxx.phd/','Accept':'*/*'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return {text:await r.text(),url:r.url}}finally{clearTimeout(t)}}
function extinf(text){const a=[...text.matchAll(/#EXTINF:([0-9.]+)/gi)].map(m=>Number(m[1])).filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0):0}
function variants(text,base){const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),out=[];for(let i=0;i<lines.length;i++){if(!/^#EXT-X-STREAM-INF:/i.test(lines[i]))continue;for(let j=i+1;j<lines.length;j++){if(lines[j].startsWith('#'))continue;try{out.push(new URL(lines[j],base).href)}catch{}break}}return [...new Set(out)]}
async function duration(url,depth=0){if(!url||depth>2)return 0;try{const r=await fetchText(url);const d=extinf(r.text);if(d>0)return d;for(const v of variants(r.text,r.url||url).slice(0,3)){const x=await duration(v,depth+1);if(x>0)return x}}catch{}return 0}
function fmt(sec){sec=Math.round(sec);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;return h?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m ${String(s).padStart(2,'0')}s`}
async function repairOne(browser,m,index,total){
  const needMeta=!(Array.isArray(m.genres)&&m.genres.length)||!(Array.isArray(m.actors)&&m.actors.length)||!m.code||!m.country;
  const needRuntime=!m.runtime;
  const need1=!hasS1(m),need2=!hasS2(m);
  let out={...m};
  if(needMeta||need1||need2){
    const ctx=await browser.newContext({userAgent:UA,viewport:{width:1280,height:720}}),p=await ctx.newPage();let e1='',e2='';
    const cap=u=>{if(/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))e1=u;if(/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))e2=u};
    p.on('request',r=>cap(r.url()));p.on('response',r=>cap(r.url()));
    try{
      await p.route('**/*',r=>['image','font','stylesheet'].includes(r.request().resourceType())?r.abort():r.continue());
      await p.goto(m.page_url,{waitUntil:'domcontentloaded',timeout:30000});await p.waitForTimeout(400);
      if(!e1)e1=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))||'';
      if(needMeta){
        const meta=await p.evaluate(()=>{const c=s=>String(s||'').replace(/\s+/g,' ').trim(),uniq=a=>[...new Set(a.map(c).filter(Boolean))];const links=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:c(a.textContent)}));const genres=uniq(links.filter(x=>/(the-loai|category|genre|tag)\//i.test(x.href)&&x.text&&x.text.length<60).map(x=>x.text));const actors=uniq(links.filter(x=>/(dien-vien|actor|actors|pornstar|star|model)\//i.test(x.href)&&x.text&&x.text.length<80).map(x=>x.text));const body=c(document.body?.innerText||'');const code=(body.match(/(?:Mã phim|Code)\s*[:：]?\s*([A-Z]{2,10}[-_ ]?\d{2,8})/i)||body.match(/\b[A-Z]{2,10}[-_ ]?\d{2,8}\b/)||[])[1]||'';const country=(body.match(/(?:Quốc gia|Country)\s*[:：]\s*([^|•\n]{2,40})/i)||[])[1]||'';return{genres,actors,code:code.replace(/[_ ]/g,'-'),country:c(country)}}).catch(()=>({}));
        if(!(Array.isArray(out.genres)&&out.genres.length)&&meta.genres?.length)out.genres=meta.genres;
        if(!(Array.isArray(out.actors)&&out.actors.length)&&meta.actors?.length)out.actors=meta.actors;
        if(!out.code&&meta.code)out.code=meta.code;
        if(!out.country&&meta.country)out.country=meta.country;
      }
      if(need2){for(const f of p.frames()){const ok=await f.evaluate(()=>{const c=s=>String(s||'').replace(/\s+/g,' ').trim();const el=[...document.querySelectorAll('[onclick],button,a,li,[role="button"]')].find(x=>c(x.textContent)==='#2');if(!el)return false;el.click();return true}).catch(()=>false);if(ok)break}for(let i=0;i<18&&!e2;i++){await p.waitForTimeout(180);e2=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))||e2}}
      const [f1,f2]=await Promise.all([need1?embedFile(e1):'',need2?embedFile(e2):'']);
      const streams=Array.isArray(out.streams)?[...out.streams]:[];
      if(need1&&/\/manifest-s1\//i.test(f1)){out.manifest_url=f1;if(!streams.some(s=>s?.url===f1))streams.unshift({name:'#1',url:f1})}
      if(need2&&/\/manifest-s2\//i.test(f2)){if(!streams.some(s=>s?.url===f2))streams.push({name:'#2',url:f2});out.stream2_status='ok'}
      if(streams.length)out.streams=streams;
    }catch(e){out.repair_error=e.message}
    finally{await ctx.close().catch(()=>{})}
  }
  if(needRuntime){const u=out.manifest_url||(out.streams||[]).find(s=>/#1/i.test(String(s?.name||'')))?.url||(out.streams||[])[0]?.url;const sec=await duration(u);if(sec>0){out.runtime=fmt(sec);out.runtime_seconds=Math.round(sec);out.runtime_source='stream_#1'}}
  console.log(`REPAIR_MOVIE ${index+1}/${total} id=${m.id} s1=${hasS1(out)?'ok':'miss'} s2=${hasS2(out)?'ok':'miss'} runtime=${out.runtime?'ok':'miss'} genres=${out.genres?.length?'ok':'miss'} code=${out.code?'ok':'miss'} actors=${out.actors?.length?'ok':'miss'}`);
  return out;
}
(async()=>{
  let{sha,movies}=await readTarget();
  const targets=movies.filter(m=>m.page_url&&(!hasS1(m)||!hasS2(m)||!m.runtime||!(Array.isArray(m.genres)&&m.genres.length)||!(Array.isArray(m.actors)&&m.actors.length)||!m.code));
  console.log(`REPAIR_START total=${movies.length} targets=${targets.length} concurrency=${CONCURRENCY} checkpoint=${BATCH}`);
  const browser=await chromium.launch({headless:true});
  for(let start=0;start<targets.length;start+=BATCH){const group=targets.slice(start,start+BATCH),results=new Array(group.length);let cursor=0;async function worker(){while(true){const i=cursor++;if(i>=group.length)return;results[i]=await repairOne(browser,group[i],start+i,targets.length)}}await Promise.all(Array.from({length:Math.min(CONCURRENCY,group.length)},worker));
    const latest=await readTarget();const byId=new Map(results.map(x=>[x.id,x]));movies=latest.movies.map(x=>byId.get(x.id)||x);sha=await writeTarget(latest.sha,movies,`Repair missing fields ${start+1}-${start+group.length}`);const s1=movies.filter(hasS1).length,s2=movies.filter(hasS2).length,rt=movies.filter(x=>x.runtime).length,g=movies.filter(x=>x.genres?.length).length,c=movies.filter(x=>x.code).length,a=movies.filter(x=>x.actors?.length).length;console.log(`REPAIR_CHECKPOINT processed=${start+group.length}/${targets.length} s1=${s1} s2=${s2} runtime=${rt} genres=${g} code=${c} actors=${a}`)}
  await browser.close();console.log('REPAIR_DONE');
})().catch(e=>{console.error('REPAIR_FATAL',e);process.exit(1)});
