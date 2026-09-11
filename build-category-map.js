const { chromium } = require('playwright');

const ROOT = process.env.SOURCE_URL || 'https://vlxx.phd/';
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.CATEGORY_PATH || 'data/site-categories.json';
const TOKEN = process.env.XIEC_TOKEN;
if (!TOKEN) throw new Error('Missing XIEC_TOKEN');

const CATEGORIES = [
  { name: 'Phim sex hay', path: 'phim-sex-hay' },
  { name: 'Phim sex Vietsub', path: 'vietsub' },
  { name: 'Phim sex không che', path: 'khong-che' },
  { name: 'Sex học sinh', path: 'hoc-sinh' },
  { name: 'Vụng trộm - Ngoại tình', path: 'vung-trom' },
  { name: 'Phim cấp 3', path: 'cap-3' },
  { name: 'Sex Mỹ - Châu Âu', path: 'chau-au' }
];
const GH={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'xiec-category-map'};
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const norm=u=>{try{const x=new URL(u,ROOT);x.hash='';return x.href}catch{return u||''}};

async function writeJson(data){
 const api=`https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`; let sha;
 const old=await fetch(api,{headers:GH}); if(old.ok) sha=(await old.json()).sha;
 const r=await fetch(api,{method:'PUT',headers:{...GH,'Content-Type':'application/json'},body:JSON.stringify({message:'Update categories from real site pager',content:Buffer.from(JSON.stringify(data,null,2)).toString('base64'),branch:'main',...(sha?{sha}:{})})});
 if(!r.ok) throw new Error(`GitHub write ${r.status}: ${await r.text()}`);
}

async function extractVideos(page){
 return [...new Set(await page.evaluate(()=>[...document.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/\/video\/[^/]+\/\d+\/?(?:[?#].*)?$/i.test(h))))];
}

async function clickNextReal(page,pageNo){
 // Prefer a visible numeric pager for the exact next page. Do not guess its URL.
 const candidates=[
   `a:visible:text-is("${pageNo+1}")`,
   `.pagination a:visible:text-is("${pageNo+1}")`,
   `.page-numbers:visible:text-is("${pageNo+1}")`,
   `a[rel="next"]:visible`,
   `.pagination a.next:visible`,
   `a.next:visible`
 ];
 for(const sel of candidates){
   const loc=page.locator(sel).first();
   if(await loc.count().catch(()=>0)){
     const href=await loc.getAttribute('href').catch(()=>null);
     console.log(`PAGER_FOUND page=${pageNo} selector=${sel} href=${href||''}`);
     const before=page.url();
     try{
       await Promise.all([
         page.waitForLoadState('domcontentloaded',{timeout:15000}).catch(()=>{}),
         loc.click({timeout:10000})
       ]);
       await page.waitForTimeout(800);
       console.log(`PAGER_CLICK page=${pageNo} before=${before} after=${page.url()}`);
       return true;
     }catch(e){ console.log(`PAGER_CLICK_ERR page=${pageNo} selector=${sel} error=${e.message}`); }
   }
 }
 return false;
}

async function collectCategory(browser,cat){
 const ctx=await browser.newContext({userAgent:UA,viewport:{width:1365,height:900}});
 const page=await ctx.newPage();
 await page.route('**/*',r=>['image','font','media'].includes(r.request().resourceType())?r.abort():r.continue());
 const start=new URL(`${cat.path}/`,ROOT).href;
 await page.goto(start,{waitUntil:'domcontentloaded',timeout:45000});
 const found=new Set(), fingerprints=new Set(), visited=[];
 for(let pageNo=1;pageNo<=300;pageNo++){
   await page.waitForTimeout(500);
   const links=await extractVideos(page);
   const fp=links.map(norm).sort().join('|');
   if(!links.length){console.log(`CAT_STOP_EMPTY ${cat.path} page=${pageNo} url=${page.url()}`);break;}
   if(fingerprints.has(fp)){console.log(`CAT_STOP_REPEAT ${cat.path} page=${pageNo} url=${page.url()}`);break;}
   fingerprints.add(fp); visited.push(page.url());
   const before=found.size; links.forEach(u=>found.add(norm(u)));
   console.log(`CAT_PAGE ${cat.path} page=${pageNo} links=${links.length} added=${found.size-before} total=${found.size} url=${page.url()}`);
   if(!(await clickNextReal(page,pageNo))){console.log(`CAT_NO_NEXT ${cat.path} page=${pageNo}`);break;}
 }
 await ctx.close();
 console.log(`CAT_DONE ${cat.name} pages=${visited.length} count=${found.size}`);
 return {page_urls:[...found],pages_scanned:visited.length,page_locations:visited};
}

(async()=>{
 const browser=await chromium.launch({headless:true});
 const output={generated_at:new Date().toISOString(),source:ROOT,categories:[]};
 for(const cat of CATEGORIES){const r=await collectCategory(browser,cat);output.categories.push({...cat,...r});}
 await browser.close(); await writeJson(output);
 console.log(`CATEGORY_MAP_DONE categories=${output.categories.length} unique_movies=${new Set(output.categories.flatMap(c=>c.page_urls)).size}`);
})().catch(e=>{console.error('CATEGORY_MAP_FATAL',e);process.exit(1)});
