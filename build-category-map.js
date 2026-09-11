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
    message: 'Update corrected full source category map',
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: 'main',
    ...(sha ? { sha } : {})
  };
  const r = await fetch(api, { method:'PUT', headers:{ ...GH, 'Content-Type':'application/json' }, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub write ${r.status}: ${await r.text()}`);
}

async function collectCategory(browser, category) {
  const ctx = await browser.newContext({ userAgent:UA, viewport:{ width:1365, height:900 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => ['image','font','media'].includes(r.request().resourceType()) ? r.abort() : r.continue());

  const found = new Set();
  let pagesScanned = 0;
  let emptyStreak = 0;

  for (let pageNo = 1; pageNo <= 300; pageNo++) {
    const requested = pageNo === 1
      ? new URL(`${category.path}/`, ROOT).href
      : new URL(`${category.path}/page/${pageNo}/`, ROOT).href;

    try {
      const resp = await page.goto(requested, { waitUntil:'domcontentloaded', timeout:45000 });
      const finalUrl = page.url();
      const expectedPathPrefix = `/${category.path}/`;
      const finalPath = new URL(finalUrl).pathname;

      if (!resp || resp.status() >= 400) {
        console.log(`CAT_STOP ${category.path} page=${pageNo} http=${resp?.status() || 0} requested=${requested} final=${finalUrl}`);
        break;
      }

      // Critical safety: never accept a redirect to homepage or another category.
      if (!finalPath.startsWith(expectedPathPrefix)) {
        console.log(`CAT_REDIRECT_STOP ${category.path} page=${pageNo} requested=${requested} final=${finalUrl}`);
        break;
      }

      await page.waitForTimeout(300);
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
        .map(a => a.href)
        .filter(h => /\/video\/[^/]+\/\d+\/?(?:[?#].*)?$/i.test(h)));

      const before = found.size;
      for (const u of links) found.add(normalizeUrl(u));
      const added = found.size - before;
      pagesScanned++;
      console.log(`CAT_PAGE ${category.path} page=${pageNo} links=${links.length} added=${added} total=${found.size} final=${finalUrl}`);

      if (!links.length || added === 0) emptyStreak++; else emptyStreak = 0;
      if (emptyStreak >= 2) break;
    } catch (e) {
      console.log(`CAT_ERR ${category.path} page=${pageNo} requested=${requested} error=${e.message}`);
      break;
    }
  }

  await ctx.close();
  console.log(`CAT_DONE ${category.name} pages=${pagesScanned} count=${found.size}`);
  return { page_urls:[...found], pages_scanned:pagesScanned };
}

(async () => {
  const browser = await chromium.launch({ headless:true });
  const output = { generated_at:new Date().toISOString(), source:ROOT, categories:[] };
  for (const category of CATEGORIES) {
    const result = await collectCategory(browser, category);
    output.categories.push({ ...category, pages_scanned:result.pages_scanned, page_urls:result.page_urls });
  }
  await browser.close();
  await writeJson(output);
  console.log(`CATEGORY_MAP_DONE categories=${output.categories.length} unique_movies=${new Set(output.categories.flatMap(c => c.page_urls)).size}`);
})().catch(e => { console.error('CATEGORY_MAP_FATAL', e); process.exit(1); });
