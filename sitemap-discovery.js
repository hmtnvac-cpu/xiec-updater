const ROOT=process.env.SOURCE_URL||'https://vlxx.phd/';
const CANDIDATES=['sitemap.xml','sitemap_index.xml','wp-sitemap.xml','post-sitemap.xml','video-sitemap.xml'];
const seen=new Set(), videos=new Set();
const UA={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36'};
const abs=u=>new URL(u,ROOT).href;
async function fetchText(url){try{const r=await fetch(url,{headers:UA,redirect:'follow'});const t=await r.text();console.log(`SITEMAP_FETCH status=${r.status} bytes=${t.length} url=${url}`);return r.ok?t:''}catch(e){console.log(`SITEMAP_ERR url=${url} error=${e.message}`);return''}}
function locs(xml){return[...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/ig)].map(m=>m[1].replace(/&amp;/g,'&').trim())}
async function walk(url,depth=0){if(seen.has(url)||depth>4)return;seen.add(url);const xml=await fetchText(url);if(!xml)return;for(const loc of locs(xml)){if(/\/video\//i.test(loc)){videos.add(loc);continue}if(/sitemap/i.test(loc)&&/\.xml(?:\?|$)/i.test(loc))await walk(loc,depth+1)}}
(async()=>{for(const c of CANDIDATES)await walk(abs(c));const arr=[...videos];console.log(`SITEMAP_DONE sitemap_files=${seen.size} video_urls=${arr.length}`);for(const u of arr.slice(0,5))console.log(`SITEMAP_SAMPLE ${u}`);for(const u of arr.slice(-5))console.log(`SITEMAP_SAMPLE_LAST ${u}`);})();