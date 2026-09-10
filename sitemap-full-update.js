const { chromium } = require('playwright');

const SOURCE_URL=process.env.SOURCE_URL||'https://vlxx.phd/';
const TARGET_REPO=process.env.TARGET_REPO||'hmtnvac-cpu/xiec';
const TARGET_PATH=process.env.TARGET_PATH||'data/ket_qua_1500_phim.json';
const TOKEN=process.env.XIEC_TOKEN;
const CONCURRENCY=Number(process.env.FULL_CONCURRENCY||8);
const BATCH=Number(process.env.CHECKPOINT_EVERY||10);
if(!TOKEN) throw new Error('Missing XIEC_TOKEN');

const GH={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xiec-sitemap-full'};
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const norm=u=>{try{const x=new URL(u,SOURCE_URL);x.hash='';x.search='';return x.href}catch{return u||''}};
const pageId=u=>(String(u).match(/\/(\d+)\/?(?:\?.*)?$/)||[])[1]||'';

async function readTarget(){
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{headers:GH});
  if(!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
  const d=await r.json(); let enc=d.content||'';
  if(!enc){const b=await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${d.sha}`,{headers:GH});if(!b.ok)throw new Error(`blob ${b.status}`);enc=(await b.json()).content||'';}
  return {sha:d.sha,movies:JSON.parse(Buffer.from(enc.replace(/\n/g,''),'base64').toString('utf8'))};
}
async function writeTarget(sha,movies,message){
  const body={message,content:Buffer.from(JSON.stringify(movies,null,2)).toString('base64'),sha,branch:'main'};
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{method:'PUT',headers:{...GH,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`write ${r.status} ${await r.text()}`);
  const d=await r.json(); return d.content?.sha||'';
}
async function getSitemapUrls(){
  const r=await fetch(new URL('sitemap.xml',SOURCE_URL),{headers:{'User-Agent':UA},redirect:'follow'});
  if(!r.ok) throw new Error(`sitemap ${r.status}`);
  const xml=await r.text();
  const urls=[...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/ig)].map(m=>m[1].replace(/&amp;/g,'&').trim()).filter(u=>/\/video\//i.test(u));
  const unique=[...new Set(urls.map(norm))];
  unique.sort((a,b)=>Number(pageId(b))-Number(pageId(a)));
  return unique;
}
function extractFile(html){
  const src=html.match(/window\.__SRC\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if(src){try{const arr=JSON.parse(src[1]);const f=arr?.find(x=>x&&typeof x.file==='string')?.file;if(f)return f}catch{}}
  const m=html.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+)["']/i)||html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  return m?m[1].replace(/\\\//g,'/').replace(/&amp;/g,'&'):'';
}
async function embedFile(embed){
  if(!embed)return'';
  try{const r=await fetch(embed,{headers:{'User-Agent':UA,'Referer':SOURCE_URL},redirect:'follow'});if(!r.ok)return'';return extractFile(await r.text())}catch{return''}
}
async function extractMovie(browser,url,index,total){
  const ctx=await browser.newContext({userAgent:UA,viewport:{width:1280,height:720}});
  const p=await ctx.newPage(); let s1='',s2='';
  const cap=u=>{if(/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))s1=u;if(/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))s2=u};
  p.on('request',r=>cap(r.url()));p.on('response',r=>cap(r.url()));
  try{
    await p.route('**/*',r=>['image','font','stylesheet'].includes(r.request().resourceType())?r.abort():r.continue());
    const resp=await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    if(!resp||resp.status()>=400)throw new Error(`page_http_${resp?.status()||0}`);
    await p.waitForTimeout(500);
    if(!s1)s1=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))||'';
    const meta=await p.evaluate(()=>{
      const txt=s=>(s||'').replace(/\s+/g,' ').trim();
      const title=txt(document.querySelector('h1')?.textContent)||txt(document.title);
      const poster=document.querySelector('meta[property="og:image"]')?.content||document.querySelector('video')?.poster||'';
      const description=txt(document.querySelector('[itemprop="description"],.description,.video-description,.entry-content,.post-content')?.textContent||document.querySelector('meta[name="description"]')?.content||'');
      const links=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:txt(a.textContent)})).filter(x=>x.text);
      const genres=[...new Set(links.filter(x=>/(the-loai|category|genre|tag)/i.test(x.href)).map(x=>x.text).filter(x=>x.length<60))];
      const actors=[...new Set(links.filter(x=>/(dien-vien|actor|pornstar)/i.test(x.href)).map(x=>x.text).filter(x=>x.length<60))];
      const body=txt(document.body?.innerText||'');
      const code=(body.match(/(?:Mã phim|Code)\s*[:：]?\s*([A-Z]{2,10}-?\d{2,8})/i)||[])[1]||'';
      const country=(body.match(/(?:Quốc gia|Country)\s*[:：]?\s*([^|•\n]{2,40})/i)||[])[1]||'';
      return{title,poster,description,genres,actors,code,country};
    }).catch(()=>({}));
    for(const f of p.frames()){
      const ok=await f.evaluate(()=>{const c=s=>(s||'').replace(/\s+/g,' ').trim();const e=[...document.querySelectorAll('[onclick],button,a,li,[role="button"]')].find(x=>c(x.textContent)==='#2');if(!e)return false;e.click();return true}).catch(()=>false);
      if(ok)break;
    }
    for(let i=0;i<18&&!s2;i++){await p.waitForTimeout(180);s2=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))||s2;}
    const [file1,file2]=await Promise.all([embedFile(s1),embedFile(s2)]);
    const valid1=/\/manifest-s1\//i.test(file1),valid2=/\/manifest-s2\//i.test(file2);
    const id=pageId(url);
    console.log(`FULL_MOVIE ${index+1}/${total} id=${id} s1=${valid1?'ok':'miss'} s2=${valid2?'ok':'miss'}`);
    if(!valid1&&!valid2)return{ok:false,url,id,error:'no_stream'};
    const streams=[];if(valid1)streams.push({name:'#1',url:file1});if(valid2)streams.push({name:'#2',url:file2});
    return{ok:true,movie:{id:`movie_${id}`,title:meta.title||`movie_${id}`,poster:meta.poster||'',description:meta.description||'',page_url:url,manifest_url:valid1?file1:'',manifest_detected_by:valid1?'direct_s1':'',mp4_url:'',status:valid1?'manifest_found':'stream2_only',...(meta.genres?.length?{genres:meta.genres}:{}),...(meta.actors?.length?{actors:meta.actors}:{}),...(meta.code?{code:meta.code}:{}),...(meta.country?{country:meta.country}:{}),streams,stream2_status:valid2?'ok':'missing'}};
  }catch(e){console.log(`FULL_ERR ${index+1}/${total} id=${pageId(url)} error=${e.message}`);return{ok:false,url,id:pageId(url),error:e.message}}
  finally{await ctx.close().catch(()=>{})}
}

(async()=>{
  let{sha,movies}=await readTarget();
  const sitemap=await getSitemapUrls();
  const existing=new Set(movies.map(m=>norm(m.page_url)).filter(Boolean));
  const missing=sitemap.filter(u=>!existing.has(u));
  console.log(`FULL_START sitemap=${sitemap.length} existing=${movies.length} missing=${missing.length} concurrency=${CONCURRENCY} checkpoint=${BATCH}`);
  if(!missing.length){console.log('FULL_DONE nothing_missing');return}
  const browser=await chromium.launch({headless:true});
  let processed=0,success=0,failed=0;
  for(let start=0;start<missing.length;start+=BATCH){
    const batchUrls=missing.slice(start,start+BATCH);let cursor=0;const results=[];
    async function worker(){while(true){const i=cursor++;if(i>=batchUrls.length)return;results[i]=await extractMovie(browser,batchUrls[i],start+i,missing.length)}}
    await Promise.all(Array.from({length:Math.min(CONCURRENCY,batchUrls.length)},worker));
    const good=results.filter(r=>r?.ok).map(r=>r.movie);
    const bad=results.filter(r=>r&&!r.ok);
    if(good.length){
      const knownIds=new Set(movies.map(m=>m.id));
      const uniqueGood=good.filter(m=>!knownIds.has(m.id));
      movies=[...uniqueGood,...movies];
      movies.sort((a,b)=>Number(pageId(b.page_url))-Number(pageId(a.page_url)));
      sha=await writeTarget(sha,movies,`Full sitemap checkpoint: ${start+1}-${start+batchUrls.length}, +${uniqueGood.length}`);
    }
    processed+=batchUrls.length;success+=good.length;failed+=bad.length;
    console.log(`FULL_CHECKPOINT processed=${processed}/${missing.length} success=${success} failed=${failed} added_now=${good.length} total=${movies.length}`);
    for(const r of bad)console.log(`FULL_RETRY id=${r.id} error=${r.error}`);
  }
  await browser.close();
  console.log(`FULL_DONE processed=${processed} success=${success} failed=${failed} total=${movies.length}`);
})().catch(e=>{console.error('FULL_FATAL',e);process.exit(1)});