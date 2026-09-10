const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';

const normalize = (s='') => s.replace(/\s+/g,' ').trim();
const decode = (s='') => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');

(async () => {
  const res = await fetch(SOURCE_URL, { redirect:'follow', headers:{ 'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'Accept':'text/html,*/*' } });
  if (!res.ok) throw new Error(`SOURCE HTTP ${res.status}`);
  const html = await res.text();
  const links = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[1];
    const text = normalize(decode(m[2].replace(/<[^>]+>/g,' ')));
    if (!text || text.length > 80) continue;
    if (/(the-loai|category|tag|genre|phim-sex|vietsub|jav|chau-au)/i.test(href)) links.push({ text, href });
  }
  const unique = [...new Map(links.map(x => [`${x.text}|${x.href}`,x])).values()];
  console.log(`CATEGORY_SCAN source=${res.url} candidates=${unique.length}`);
  for (const x of unique) console.log(`CATEGORY_FOUND ${x.text} -> ${x.href}`);
  if (!unique.length) {
    console.log('CATEGORY_HTML_HINTS');
    for (const line of html.split(/\n/).filter(x => /(thể loại|the-loai|category|genre)/i.test(x)).slice(0,20)) console.log(normalize(line).slice(0,500));
  }
})();
