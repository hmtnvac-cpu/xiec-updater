const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const TOKEN = process.env.XIEC_TOKEN;
const START_PAGE = Number(process.env.START_PAGE || 51);
const MAX_PAGE = Number(process.env.MAX_PAGE || 1000);
const CONCURRENCY = Number(process.env.FAST_CONCURRENCY || 8);
const STOP_EMPTY = Number(process.env.STOP_EMPTY || 2);
if (!TOKEN) throw new Error('Missing XIEC_TOKEN');

const H = { Authorization:`Bearer ${TOKEN}`, Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'xiec-fast-full-scan' };
async function readTarget(){
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{headers:H});
  if(!r.ok) throw new Error(`read ${r.status} ${await r.text()}`);
  const d=await r.json(); let e=d.content||'';
  if(!e){ const b=await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${d.sha}`,{headers:H}); if(!b.ok)throw new Error(`blob ${b.status}`); e=(await b.json()).content||''; }
  return {sha:d.sha,movies:JSON.parse(Buffer.from(e.replace(/\n/g,''),'base64').toString('utf8'))};
}
async function writeTarget(sha,movies,message){
  const r=await fetch(`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`,{method:'PUT',headers:{...H,'Content-Type':'application/json'},body:JSON.stringify({message,content:Buffer.from(JSON.stringify(movies,null,2)).toString('base64'),sha,branch:'main'})});
  if(!r.ok) throw new Error(`write ${r.status} ${await r.text()}`);
  const d=await r.json(); return d.content?.sha || d.commit?.sha || '';
}
const norm=u=>{try{const x=new URL(u,SOURCE_URL);x.hash='';return x.toString()}catch{return u}};
const isMovie=u=>{try{return new URL(u).pathname.includes('/video/')}catch{return false}};
const pageId=u=>(u.match(/\/(\d+)\/?(?:\?.*)?$/)||[])[1]||'';
function extractFile(html){
  const src=html.match(/window\.__SRC\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if(src){try{const arr=JSON.parse(src[1]);const f=arr?.find(x=>x&&typeof x.file==='string')?.file;if(f)return f}catch{}}
  const m=html.match(/["']file["']\s*:\s*["'](https?:\/\/[^"']+)["']/i)||html.match(/file\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  return m?m[1].replace(/\\\//g,'/').replace(/&amp;/g,'&'):'';
}
async function embedFile(embed){
  if(!embed) return '';
  const r=await fetch(embed,{headers:{'User-Agent':'Mozilla/5.0','Referer':SOURCE_URL},redirect:'follow'});
  if(!r.ok) return '';
  return extractFile(await r.text());
}
async function listing(page,p){
  const base=SOURCE_URL.replace(/\/$/,'');
  const url=`${base}/page/${p}/`;
  try{
    const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    if(!r || !r.ok()) return [];
    await page.waitForTimeout(350);
    const links=await page.$$eval('a[href]',els=>els.map(a=>a.href));
    return [...new Set(links.filter(isMovie).map(norm))];
  }catch{return []}
}
async function extractMovie(browser,url,index,total){
  const ctx=await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',viewport:{width:1280,height:720}});
  const p=await ctx.newPage(); let s1='',s2='';
  const cap=u=>{ if(/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))s1=u; if(/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))s2=u; };
  p.on('request',r=>cap(r.url())); p.on('response',r=>cap(r.url()));
  try{
    await p.route('**/*',r=>['image','font','stylesheet'].includes(r.request().resourceType())?r.abort():r.continue());
    await p.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    await p.waitForTimeout(450);
    if(!s1) s1=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s1/i.test(u))||'';
    const meta=await p.evaluate(()=>{
      const txt=s=>(s||'').replace(/\s+/g,' ').trim();
      const title=txt(document.querySelector('h1')?.textContent)||txt(document.title);
      const poster=document.querySelector('meta[property="og:image"]')?.content||document.querySelector('video')?.poster||'';
      const desc=document.querySelector('[itemprop="description"],.description,.video-description,.entry-content,.post-content')?.textContent||document.querySelector('meta[name="description"]')?.content||'';
      const links=[...document.querySelectorAll('a[href]')].map(a=>({href:a.href,text:txt(a.textContent)})).filter(x=>x.text);
      const genres=[...new Set(links.filter(x=>/(the-loai|category|genre|tag)/i.test(x.href)).map(x=>x.text).filter(x=>x.length<60))];
      const actors=[...new Set(links.filter(x=>/(dien-vien|actor|pornstar)/i.test(x.href)).map(x=>x.text).filter(x=>x.length<60))];
      const body=txt(document.body?.innerText||'');
      const code=(body.match(/(?:Mã phim|Code)\s*[:：]?\s*([A-Z]{2,10}-?\d{2,8})/i)||[])[1]||'';
      const country=(body.match(/(?:Quốc gia|Country)\s*[:：]?\s*([^|•\n]{2,40})/i)||[])[1]||'';
      return {title,poster,description:txt(desc),genres,actors,code,country};
    }).catch(()=>({}));
    for(const f of p.frames()){
      const ok=await f.evaluate(()=>{const c=s=>(s||'').replace(/\s+/g,' ').trim();const e=[...document.querySelectorAll('[onclick],button,a,li,[role=button]')].find(x=>c(x.textContent)==='#2');if(!e)return false;e.click();return true}).catch(()=>false);
      if(ok) break;
    }
    for(let i=0;i<12&&!s2;i++){await p.waitForTimeout(180);s2=p.frames().map(f=>f.url()).find(u=>/play\.vlstream\.net\/embed\/.*\/s2/i.test(u))||s2;}
    const [file1,file2]=await Promise.all([embedFile(s1),embedFile(s2)]);
    const id=pageId(url);
    const streams=[]; if(file1&&/\/manifest-s1\//i.test(file1))streams.push({name:'#1',url:file1}); if(file2&&/\/manifest-s2\//i.test(file2))streams.push({name:'#2',url:file2});
    console.log(`FAST_MOVIE ${index+1}/${total} id=${id} s1=${streams.some(x=>x.name==='#1')?'ok':'miss'} s2=${streams.some(x=>x.name==='#2')?'ok':'miss'}`);
    if(!streams.length) return null;
    return {id:`movie_${id}`,title:meta.title||`movie_${id}`,poster:meta.poster||'',description:meta.description||'',page_url:url,manifest_url:file1||'',manifest_detected_by:file1?'direct_s1':'',mp4_url:'',status:file1?'manifest_found':'stream2_only',...(meta.genres?.length?{genres:meta.genres}:{}),...(meta.actors?.length?{actors:meta.actors}:{}),...(meta.code?{code:meta.code}:{}),...(meta.country?{country:meta.country}:{}),streams};
  }catch(e){console.log(`FAST_ERR ${index+1}/${total} url=${url} ${e.message}`);return null}
  finally{await ctx.close().catch(()=>{})}
}
(async()=>{
  let {sha,movies}=await readTarget();
  const existing=new Set(movies.map(m=>norm(m.page_url)).filter(Boolean));
  console.log(`FAST_START existing=${movies.length} start_page=${START_PAGE} concurrency=${CONCURRENCY}`);
  const browser=await chromium.launch({headless:true}); const lp=await browser.newPage();
  const newUrls=[]; let empty=0,lastPage=START_PAGE-1;
  for(let p=START_PAGE;p<=MAX_PAGE;p++){
    const links=await listing(lp,p); const fresh=links.filter(u=>!existing.has(u)&&!newUrls.includes(u));
    console.log(`FAST_PAGE page=${p} links=${links.length} new=${fresh.length}`);
    lastPage=p;
    if(!links.length){empty++; if(empty>=STOP_EMPTY)break; continue;} else empty=0;
    newUrls.push(...fresh);
  }
  await lp.close();
  console.log(`FAST_DISCOVERY pages=${START_PAGE}-${lastPage} new_movies=${newUrls.length}`);
  if(!newUrls.length){await browser.close();console.log('FAST_DONE no_new_movies');return;}
  let cursor=0,done=0,ok=0; const added=[];
  async function worker(){while(true){const n=cursor++;if(n>=newUrls.length)return;const item=await extractMovie(browser,newUrls[n],n,newUrls.length);done++;if(item){added.push(item);ok++;}if(done%10===0||done===newUrls.length)console.log(`FAST_PROGRESS processed=${done}/${newUrls.length} success=${ok} failed=${done-ok}`)}}
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,newUrls.length)},worker));
  await browser.close();
  if(!added.length){console.log('FAST_DONE no_valid_new_movies');return;}
  added.sort((a,b)=>Number(pageId(b.page_url))-Number(pageId(a.page_url)));
  const merged=[...added,...movies];
  await writeTarget(sha,merged,`Fast full-site update: +${added.length} movies from page ${START_PAGE}+`);
  console.log(`FAST_DONE added=${added.length} total=${merged.length}`);
})();