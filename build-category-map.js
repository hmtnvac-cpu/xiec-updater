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
  { name: 'XXX', path: 'xxx' },
  { name: 'Sex Mỹ - Châu Âu', path: 'chau-au' }
];

const GH = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-category-map'
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';
const normalizeUrl = (u) => { try { const x = new URL(u, ROOT); x.hash=''; x.search=''; return x.href; } catch { return u || ''; } };

async function writeJson(data) {
  const api = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  let sha;
  const existing = await fetch(api, { headers: GH });
  if (existing.ok) sha = (await existing.json()).sha;
  const body = {
    message: 'Update authoritative source category map',
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: 'main',
    ...(sha ? { sha } : {})
  };
  const r = await fetch(api, { method: 'PUT', headers: { ...GH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub write ${r.status}: ${await r.text()}`);
}

async function collectCategory(browser, category) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => ['image','font','media'].includes(r.request().resourceType()) ? r.abort() : r.continue());
  const found = new Set();
  let emptyStreak = 0;
  for (let n = 1; n <= 200; n++) {
    const url = n === 1 ? `${ROOT}${category.path}/` : `${ROOT}${category.path}/page/${n}/`;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || resp.status() >= 400) { console.log(`CAT_STOP ${category.path} page=${n} http=${resp?.status()||0}`); break; }
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/video/"]')].map(a => a.href));
      const before = found.size;
      for (const u of links) found.add(u);
      const added = found.size - before;
      console.log(`CAT_PAGE ${category.path} page=${n} links=${links.length} added=${added} total=${found.size}`);
      if (links.length === 0 || added === 0) emptyStreak++; else emptyStreak = 0;
      if (emptyStreak >= 2) break;
    } catch (e) {
      console.log(`CAT_ERR ${category.path} page=${n} ${e.message}`);
      break;
    }
  }
  await ctx.close();
  return [...found].map(normalizeUrl);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const output = { generated_at: new Date().toISOString(), source: ROOT, categories: [] };
  for (const category of CATEGORIES) {
    const page_urls = await collectCategory(browser, category);
    output.categories.push({ ...category, page_urls });
    console.log(`CAT_DONE ${category.name} count=${page_urls.length}`);
  }
  await browser.close();
  await writeJson(output);
  console.log(`CATEGORY_MAP_DONE categories=${output.categories.length} unique_movies=${new Set(output.categories.flatMap(c=>c.page_urls)).size}`);
})().catch(e => { console.error('CATEGORY_MAP_FATAL', e); process.exit(1); });
