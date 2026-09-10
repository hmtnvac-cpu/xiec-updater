const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 170);
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;

function normalize(url) {
  try {
    const u = new URL(url, SOURCE_URL);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function normalizeBadge(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function isVietsubBadge(value = '') {
  const s = normalizeBadge(value).toLowerCase();
  return s === 'vietsub' || s === 'viet sub' || s === 'việt sub' || s === 'vsub';
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-updater-badges'
};

async function readTarget() {
  if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  let encoded = data.content || '';
  if (!encoded) {
    const blobRes = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${data.sha}`, { headers: ghHeaders });
    if (!blobRes.ok) throw new Error(`GitHub blob read failed: ${blobRes.status} ${await blobRes.text()}`);
    const blob = await blobRes.json();
    encoded = blob.content || '';
  }

  const text = Buffer.from(encoded.replace(/\n/g, ''), 'base64').toString('utf8');
  return { sha: data.sha, movies: JSON.parse(text) };
}

async function writeTarget(sha, movies) {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update movie badges ${new Date().toISOString().slice(0, 10)}`,
      content: Buffer.from(JSON.stringify(movies, null, 2)).toString('base64'),
      sha,
      branch: 'main'
    })
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

async function extractCardsAndNext(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
    const seen = new Set();
    const results = [];

    for (const a of anchors) {
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);

      let card = a;
      for (let depth = 0; depth < 8 && card.parentElement; depth++) {
        const parent = card.parentElement;
        const movieLinks = [...parent.querySelectorAll('a[href*="/video/"]')]
          .map(x => x.href)
          .filter(Boolean);
        if ([...new Set(movieLinks)].length > 1) break;
        card = parent;
      }

      const title = clean(a.getAttribute('title') || a.innerText || '');
      const candidates = [];
      for (const el of [...card.querySelectorAll('*')]) {
        const text = clean(el.innerText || el.textContent || '');
        if (!text || text.length > 32 || (title && text === title)) continue;
        const cls = `${el.className || ''} ${el.id || ''}`.toLowerCase();
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const semantic = /(badge|label|tag|status|quality|sub|uncen|episode|ep|hd|type|icon)/i.test(cls);
        const overlay = style.position === 'absolute' || style.position === 'fixed';
        const visuallySmall = rect.width > 0 && rect.height > 0 && rect.height <= 45 && rect.width <= 180;
        if (semantic || overlay || visuallySmall) candidates.push(text);
      }

      const badges = [...new Set(candidates)].filter(x => x && x !== title).slice(0, 20);
      results.push({ url: href, title, badges });
    }

    const allLinks = [...document.querySelectorAll('a[href]')];
    const relNext = document.querySelector('a[rel="next"]')?.href || '';
    const namedNext = allLinks.find(a => /^(next|tiếp|sau|›|»|→)$/i.test(clean(a.innerText || a.textContent || '')))?.href || '';
    const classNext = document.querySelector('.next a, a.next, .pagination-next a, .page-numbers.next, .pagination .next')?.href || '';

    let next = relNext || classNext || namedNext;
    if (!next) {
      const current = allLinks.find(a => /(^|\s)(current|active)(\s|$)/i.test(`${a.className || ''}`));
      const currentNum = Number.parseInt(clean(current?.innerText || ''), 10);
      if (Number.isFinite(currentNum)) {
        const candidate = allLinks.find(a => Number.parseInt(clean(a.innerText || ''), 10) === currentNum + 1);
        next = candidate?.href || '';
      }
    }

    return { cards: results, next };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();
  const all = new Map();
  const visitedPages = new Set();

  let nextUrl = normalize(SOURCE_URL);
  let pageNo = 0;

  while (nextUrl && pageNo < MAX_LIST_PAGES && !visitedPages.has(nextUrl)) {
    visitedPages.add(nextUrl);
    pageNo++;

    const r = await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!r || !r.ok()) {
      console.log(`PAGE_SCAN stop page=${pageNo} url=${nextUrl} status=${r?.status?.() || 'load_failed'}`);
      break;
    }
    await page.waitForTimeout(900);

    const { cards, next } = await extractCardsAndNext(page);
    const before = all.size;
    for (const card of cards) {
      const url = normalize(card.url);
      if (!all.has(url)) all.set(url, { ...card, url });
    }
    console.log(`PAGE_SCAN page=${pageNo} cards=${cards.length} new=${all.size - before} total=${all.size} next=${next || 'none'}`);

    if (!next) break;
    const normalizedNext = normalize(next);
    if (!normalizedNext || visitedPages.has(normalizedNext)) break;
    nextUrl = normalizedNext;
  }

  await browser.close();

  const items = [...all.values()].map(item => ({
    ...item,
    vietsub: item.badges.some(isVietsubBadge)
  }));

  const vs = items.filter(x => x.vietsub);
  console.log(`BADGE_SCAN pages=${visitedPages.size} total=${items.length} vietsub=${vs.length} non_vietsub=${items.length - vs.length}`);

  const byUrl = new Map(items.map(x => [normalize(x.url), x]));
  const { sha, movies } = await readTarget();
  let changed = 0;
  let matched = 0;

  const updated = movies.map(movie => {
    const hit = byUrl.get(normalize(movie.page_url || ''));
    if (!hit) return movie;
    matched++;

    const nextBadges = hit.badges;
    const nextVietsub = hit.vietsub;
    const sameBadges = JSON.stringify(movie.badges || []) === JSON.stringify(nextBadges);
    if (movie.vietsub === nextVietsub && sameBadges) return movie;

    changed++;
    return { ...movie, badges: nextBadges, vietsub: nextVietsub };
  });

  console.log(`BADGE_MATCH matched=${matched}/${movies.length} changed=${changed}`);
  if (!changed) {
    console.log('BADGE_FLAGS no changes needed');
    return;
  }

  await writeTarget(sha, updated);
  console.log(`BADGE_FLAGS updated=${changed}`);
})();
