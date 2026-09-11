const { chromium } = require('playwright');

const ROOT = process.env.SOURCE_URL || 'https://vlxx.phd/';
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.CATEGORY_PATH || 'data/site-categories.json';
const TOKEN = process.env.XIEC_TOKEN;
if (!TOKEN) throw new Error('Missing XIEC_TOKEN');

// Exact categories approved for the addon. JAV / XVIDEOS / XNXX / XXX are excluded.
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
    message: 'Update full authoritative source category map',
    content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'),
    branch: 'main',
    ...(sha ? { sha } : {})
  };
  const r = await fetch(api, { method: 'PUT', headers: { ...GH, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub write ${r.status}: ${await r.text()}`);
}

async function collectCategory(browser, category) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1365, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => ['image','font','media'].includes(r.request().resourceType()) ? r.abort() : r.continue());

  const found = new Set();
  const visitedPages = new Set();
  let current = normalizeUrl(`${ROOT}${category.path}/`);
  let pageNo = 1;

  while (current && pageNo <= 300 && !visitedPages.has(current)) {
    visitedPages.add(current);
    try {
      const resp = await page.goto(current, { waitUntil:'domcontentloaded', timeout:45000 });
      if (!resp || resp.status() >= 400) {
        console.log(`CAT_STOP ${category.path} page=${pageNo} http=${resp?.status() || 0} url=${current}`);
        break;
      }
      await page.waitForTimeout(400);

      const scan = await page.evaluate(() => {
        const videoUrls = [...document.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(h => /\/video\/[^/]+\/\d+\/?(?:[?#].*)?$/i.test(h));

        const anchors = [...document.querySelectorAll('a[href]')];
        const explicitNext = document.querySelector('a[rel="next"], .next a, a.next, .pagination .next a, .page-numbers.next');
        let next = explicitNext?.href || '';
        if (!next) {
          const pageLinks = anchors
            .map(a => ({ href:a.href, text:(a.textContent || '').trim() }))
            .filter(x => /\/page\/\d+\/?(?:[?#].*)?$/i.test(x.href));
          const currentNo = Number((location.pathname.match(/\/page\/(\d+)\/?$/) || [])[1] || 1);
          const wanted = pageLinks.find(x => Number((x.href.match(/\/page\/(\d+)\/?/) || [])[1]) === currentNo + 1);
          next = wanted?.href || '';
        }
        return { videoUrls, next };
      });

      const before = found.size;
      for (const u of scan.videoUrls) found.add(normalizeUrl(u));
      const added = found.size - before;
      console.log(`CAT_PAGE ${category.path} page=${pageNo} links=${scan.videoUrls.length} added=${added} total=${found.size} url=${current}`);

      if (!scan.videoUrls.length) break;

      let next = normalizeUrl(scan.next || '');
      if (!next || visitedPages.has(next)) {
        // Fallback to predictable /page/N/ only after the real pager could not provide a next URL.
        const fallback = normalizeUrl(`${ROOT}${category.path}/page/${pageNo + 1}/`);
        if (visitedPages.has(fallback)) break;
        next = fallback;
      }

      // If this page yielded no new movie URLs, probe only one next page; if that also repeats, loop will stop there.
      if (added === 0 && pageNo > 1) {
        const probeResp = await page.request.get(next, { timeout:30000 }).catch(() => null);
        if (!probeResp || !probeResp.ok()) break;
      }

      current = next;
      pageNo++;
    } catch (e) {
      console.log(`CAT_ERR ${category.path} page=${pageNo} url=${current} error=${e.message}`);
      break;
    }
  }

  await ctx.close();
  console.log(`CAT_DONE ${category.name} pages=${visitedPages.size} count=${found.size}`);
  return { page_urls:[...found], pages_scanned:visitedPages.size };
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
