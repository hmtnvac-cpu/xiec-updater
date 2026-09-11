const { chromium } = require('playwright');
const ROOT=process.env.SOURCE_URL||'https://vlxx.phd/';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const norm=s=>(s||'').replace(/\s+/g,' ').trim();
(async()=>{
 const browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({userAgent:UA}); const p=await ctx.newPage();
 await p.goto(ROOT,{waitUntil:'domcontentloaded',timeout:30000});
 const data=await p.evaluate(()=>{
   const clean=s=>(s||'').replace(/\s+/g,' ').trim();
   const links=[...document.querySelectorAll('a[href]')].map(a=>({text:clean(a.textContent),href:a.href})).filter(x=>x.text&&x.href);
   const nav=[...document.querySelectorAll('nav a[href],header a[href],.menu a[href],.navbar a[href],.main-menu a[href],#menu a[href]')].map(a=>({text:clean(a.textContent),href:a.href})).filter(x=>x.text);
   return {title:document.title,links,nav};
 });
 const uniq=a=>[...new Map(a.map(x=>[`${x.text}|${x.href}`,x])).values()];
 const candidates=uniq([...data.nav,...data.links.filter(x=>/(the-loai|category|genre|quoc-gia|country|dien-vien|actor|pornstar)/i.test(x.href))]);
 console.log(`TAXONOMY_PAGE title=${data.title}`);
 console.log(`TAXONOMY_NAV count=${uniq(data.nav).length}`);
 for(const x of uniq(data.nav)) console.log(`NAV\t${x.text}\t${x.href}`);
 console.log(`TAXONOMY_CANDIDATES count=${candidates.length}`);
 for(const x of candidates) console.log(`TAX\t${x.text}\t${x.href}`);
 await browser.close();
})().catch(e=>{console.error('TAXONOMY_FATAL',e);process.exit(1)});