const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 3);
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

async function readTarget() {
  if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xiec-updater-badges'
    }
  });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return {
    sha: data.sha,
    movies: JSON.parse(Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'))
  };
}

async function writeTarget(sha, movies) {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'xiec-updater-badges'
    },
    body: JSON.stringify({
      message: `Update movie badges ${new Date().toISOString().slice(0, 10)}`,
      content: Buffer.from(JSON.stringify(movies, null, 2)).toString('base64'),
      sha,
      branch: 'main'
    })
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();
  const all = new Map();

  for (let p = 1; p <= MAX_LIST_PAGES; p++) {
    const urls = [
      p === 1 ? SOURCE_URL : `${SOURCE_URL.replace(/\/$/, '')}/page/${p}/`,
      p === 1 ? SOURCE_URL : `${SOURCE_URL.replace(/\/$/, '')}/page/${p}`
    ];

    let loaded = false;
    for (const url of urls) {
      try {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (r && r.ok()) { loaded = true; break; }
      } catch {}
    }
    if (!loaded) continue;
    await page.waitForTimeout(1500);

    const cards = await page.evaluate(() => {
      const clean = s => (s || '').replace(/\s+/g, ' ').trim();
      const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
      const seen = new Set();
      const results = [];

      for (const a of anchors) {
        const href = a.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);

        // Find the smallest ancestor that belongs to this movie only.
        let card = a;
        for (let depth = 0; depth < 8 && card.parentElement; depth++) {
          const parent = card.parentElement;
          const movieLinks = [...parent.querySelectorAll('a[href*="/video/"]')]
            .map(x => x.href)
            .filter(Boolean);
          const uniqueMovieLinks = [...new Set(movieLinks)];
          if (uniqueMovieLinks.length > 1) break;
          card = parent;
        }

        const title = clean(a.getAttribute('title') || a.innerText || '');
        const candidates = [];
        const nodes = [...card.querySelectorAll('*')];

        for (const el of nodes) {
          if (el.closest('a[href*="/video/"]') === a && el !== a) {
            // still allow overlay children; only exclude long title-like text below
          }
          const text = clean(el.innerText || el.textContent || '');
          if (!text || text.length > 32) continue;
          if (title && text === title) continue;

          const cls = `${el.className || ''} ${el.id || ''}`.toLowerCase();
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const semantic = /(badge|label|tag|status|quality|sub|uncen|episode|ep|hd|type|icon)/i.test(cls);
          const overlay = style.position === 'absolute' || style.position === 'fixed';
          const visuallySmall = rect.width > 0 && rect.height > 0 && rect.height <= 45 && rect.width <= 180;

          if (semantic || overlay || visuallySmall) candidates.push(text);
        }

        // Preserve every distinct short label exactly as shown by the site.
        const badges = [...new Set(candidates)]
          .filter(x => x && x !== title)
          .slice(0, 20);

        results.push({
          url: href,
          title,
          badges,
          cardText: clean(card.innerText || card.textContent || '').slice(0, 300)
        });
      }
      return results;
    });

    for (const card of cards) {
      const url = normalize(card.url);
      if (!all.has(url)) all.set(url, { ...card, url });
    }
  }

  await browser.close();

  const items = [...all.values()];
  for (const item of items) {
    item.vietsub = item.badges.some(isVietsubBadge);
  }

  const vs = items.filter(x => x.vietsub);
  console.log(`BADGE_SCAN total=${items.length} vietsub=${vs.length} non_vietsub=${items.length - vs.length}`);
  for (const x of items.slice(0, 30)) {
    console.log(`BADGES | ${x.url} | ${JSON.stringify(x.badges)} | vietsub=${x.vietsub}`);
  }

  const byUrl = new Map(items.map(x => [normalize(x.url), x]));
  const { sha, movies } = await readTarget();
  let changed = 0;

  const updated = movies.map(movie => {
    const hit = byUrl.get(normalize(movie.page_url || ''));
    if (!hit) return movie;

    const nextBadges = hit.badges;
    const nextVietsub = hit.vietsub;
    const sameBadges = JSON.stringify(movie.badges || []) === JSON.stringify(nextBadges);
    if (movie.vietsub === nextVietsub && sameBadges) return movie;

    changed++;
    return { ...movie, badges: nextBadges, vietsub: nextVietsub };
  });

  if (!changed) {
    console.log('BADGE_FLAGS no changes needed');
    return;
  }

  await writeTarget(sha, updated);
  console.log(`BADGE_FLAGS updated=${changed}`);
})();
