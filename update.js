const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 3);
const MAX_NEW_MOVIES = Number(process.env.MAX_NEW_MOVIES || 50);

if (!GH_TOKEN) {
  console.error('Missing XIEC_TOKEN secret');
  process.exit(1);
}

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-updater'
};

async function ghGetFile() {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { sha: data.sha, json: JSON.parse(text) };
}

async function ghUpdateFile(sha, movies) {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const body = {
    message: `Auto update movies ${new Date().toISOString().slice(0, 10)}`,
    content: Buffer.from(JSON.stringify(movies, null, 2)).toString('base64'),
    sha,
    branch: 'main'
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function isMovieUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.includes('/video/');
  } catch {
    return false;
  }
}

function extractIdFromUrl(url) {
  const m = url.match(/\/(\d+)\/?$/);
  return m ? `movie_${m[1]}` : `movie_${Date.now()}`;
}

function normalizeUrl(url) {
  try {
    const u = new URL(url, SOURCE_URL);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

async function collectListingLinks(page) {
  const out = [];
  for (let p = 1; p <= MAX_LIST_PAGES; p++) {
    const candidates = [
      p === 1 ? SOURCE_URL : `${SOURCE_URL.replace(/\/$/, '')}/page/${p}/`,
      p === 1 ? SOURCE_URL : `${SOURCE_URL.replace(/\/$/, '')}/page/${p}`
    ];
    let loaded = false;
    for (const url of candidates) {
      try {
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (r && r.ok()) { loaded = true; break; }
      } catch {}
    }
    if (!loaded) continue;
    await page.waitForTimeout(1500);
    const links = await page.$$eval('a[href]', els => els.map(a => a.href));
    for (const link of links) if (isMovieUrl(link)) out.push(normalizeUrl(link));
  }
  return [...new Set(out)];
}

async function getFullDescription(page) {
  const selectors = [
    '.description', '.content', '.entry-content', '.video-description',
    '[itemprop="description"]', '.post-content', '.detail-content'
  ];
  for (const sel of selectors) {
    try {
      const txt = await page.locator(sel).first().innerText({ timeout: 1000 });
      if (txt && txt.trim().length > 40) return txt.trim();
    } catch {}
  }
  const jsonLd = await page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []);
  for (const raw of jsonLd) {
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const x of arr) if (x && typeof x.description === 'string' && x.description.trim()) return x.description.trim();
    } catch {}
  }
  const meta = await page.locator('meta[name="description"]').getAttribute('content').catch(() => '');
  return (meta || '').trim();
}

function scoreManifest(url) {
  let score = 0;
  const s = url.toLowerCase();
  if (s.includes('manifest')) score += 100;
  if (s.includes('.m3u8')) score += 90;
  if (s.includes('.mpd')) score += 80;
  if (s.includes('1080')) score += 40;
  if (s.includes('2160') || s.includes('4k')) score += 60;
  if (s.includes('720')) score += 20;
  return score;
}

async function scrapeMovie(context, url) {
  const page = await context.newPage();
  const media = new Set();
  page.on('request', req => {
    const u = req.url();
    if (/manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)|\.mp4(?:\?|$)/i.test(u)) media.add(u);
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    const video = page.locator('video').first();
    if (await video.count().catch(() => 0)) {
      await video.evaluate(v => { try { v.muted = true; v.play(); } catch {} }).catch(() => {});
    }
    await page.waitForTimeout(6000);

    const title = (
      await page.locator('h1').first().innerText().catch(() => '') ||
      await page.title().catch(() => '')
    ).trim();
    const poster = (
      await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => '') ||
      await page.locator('video').first().getAttribute('poster').catch(() => '') || ''
    ).trim();
    const description = await getFullDescription(page);
    const candidates = [...media].sort((a, b) => scoreManifest(b) - scoreManifest(a));
    const manifest = candidates.find(u => /manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)/i.test(u)) || '';
    const mp4 = candidates.find(u => /\.mp4(?:\?|$)/i.test(u)) || '';

    return {
      id: extractIdFromUrl(url),
      title,
      poster,
      description,
      page_url: url,
      manifest_url: manifest,
      manifest_detected_by: manifest ? 'request' : '',
      mp4_url: mp4,
      status: manifest || mp4 ? 'manifest_found' : 'no_manifest'
    };
  } finally {
    await page.close();
  }
}

(async () => {
  const { sha, json: existing } = await ghGetFile();
  const existingUrls = new Set(existing.map(x => normalizeUrl(x.page_url)).filter(Boolean));
  console.log(`Existing movies: ${existing.length}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36'
  });
  const page = await context.newPage();

  const links = await collectListingLinks(page);
  const newLinks = links.filter(x => !existingUrls.has(x)).slice(0, MAX_NEW_MOVIES);
  console.log(`Listing links: ${links.length}; new: ${newLinks.length}`);

  const added = [];
  for (const link of newLinks) {
    try {
      const item = await scrapeMovie(context, link);
      console.log(`Scraped ${item.id}: ${item.title} | ${item.status}`);
      added.push(item);
    } catch (e) {
      console.error(`Failed ${link}: ${e.message}`);
    }
  }

  await page.close();
  await browser.close();

  if (!added.length) {
    console.log('No new movies; nothing to update.');
    return;
  }

  const merged = [...added, ...existing];
  await ghUpdateFile(sha, merged);
  console.log(`Updated ${TARGET_REPO}/${TARGET_PATH}: +${added.length}, total ${merged.length}`);
})();
