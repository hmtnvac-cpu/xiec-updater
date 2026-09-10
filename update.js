const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 3);
const MAX_NEW_MOVIES = Number(process.env.MAX_NEW_MOVIES || 50);
const MAX_REPAIR_MOVIES = Number(process.env.MAX_REPAIR_MOVIES || 10);

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

function pageNumericId(url = '') {
  const m = url.match(/\/(\d+)\/?(?:\?.*)?$/);
  return m ? m[1] : '';
}

function extractIdFromUrl(url) {
  const id = pageNumericId(url);
  return id ? `movie_${id}` : `movie_${Date.now()}`;
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

function isMediaUrl(url = '') {
  return /manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)|\.mp4(?:\?|$)/i.test(url);
}

function scoreManifest(url) {
  let score = 0;
  const s = url.toLowerCase();
  if (s.includes('manifest')) score += 100;
  if (s.includes('.m3u8')) score += 90;
  if (s.includes('.mpd')) score += 80;
  if (s.includes('.vl')) score += 70;
  if (s.includes('2160') || s.includes('4k')) score += 60;
  if (s.includes('1080')) score += 40;
  if (s.includes('720')) score += 20;
  if (s.includes('.mp4')) score += 10;
  return score;
}

function buildManifestTemplates(existing) {
  const templates = new Map();
  for (const movie of existing) {
    const pageId = pageNumericId(movie.page_url);
    const manifest = movie.manifest_url || '';
    if (!pageId || !manifest) continue;

    const padded = pageId.padStart(5, '0');
    const variants = [padded, pageId];
    for (const token of variants) {
      const at = manifest.lastIndexOf(token);
      if (at < 0) continue;
      const key = `${manifest.slice(0, at)}{ID:${token.length}}${manifest.slice(at + token.length)}`;
      templates.set(key, {
        prefix: manifest.slice(0, at),
        suffix: manifest.slice(at + token.length),
        width: token.length
      });
      break;
    }
  }
  return [...templates.values()];
}

async function probeFallbackManifest(page, movieUrl, templates) {
  const id = pageNumericId(movieUrl);
  if (!id) return '';

  for (const t of templates.slice(0, 12)) {
    const token = id.padStart(t.width, '0');
    const candidate = `${t.prefix}${token}${t.suffix}`;
    try {
      const res = await page.request.get(candidate, {
        timeout: 10000,
        headers: {
          Referer: movieUrl,
          Range: 'bytes=0-2047'
        }
      });
      if (res.status() >= 200 && res.status() < 400) {
        console.log(`Validated fallback manifest: ${candidate}`);
        return candidate;
      }
    } catch {}
  }
  return '';
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

async function harvestDomMedia(page, media) {
  for (const frame of page.frames()) {
    try {
      const urls = await frame.locator('[src], [data-src], [data-url], [data-video], [data-file]').evaluateAll(els => {
        const out = [];
        for (const el of els) {
          for (const name of ['src', 'data-src', 'data-url', 'data-video', 'data-file']) {
            const value = el.getAttribute(name);
            if (value) out.push(value);
          }
        }
        return out;
      });
      for (const u of urls) {
        try {
          const absolute = new URL(u, frame.url()).toString();
          if (isMediaUrl(absolute)) media.add(absolute);
        } catch {}
      }

      const html = await frame.content();
      const matches = html.match(/https?:[^"'<>\\\s]+(?:manifest[^"'<>\\\s]*|\.m3u8[^"'<>\\\s]*|\.mpd[^"'<>\\\s]*|\.vl(?:\?[^"'<>\\\s]*)?|\.mp4(?:\?[^"'<>\\\s]*)?)/gi) || [];
      for (const raw of matches) media.add(raw.replace(/&amp;/g, '&'));
    } catch {}
  }
}

async function tryStartPlayback(page) {
  const selectors = [
    'video',
    'button[aria-label*="play" i]',
    '[title*="play" i]',
    '.vjs-big-play-button',
    '.jw-icon-playback',
    '.plyr__control--overlaid',
    '.play-button',
    '.play',
    '[class*="play"]'
  ];

  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const loc = frame.locator(sel).first();
      try {
        if (!(await loc.count())) continue;
        if (sel === 'video') {
          await loc.evaluate(v => {
            try { v.muted = true; v.volume = 0; void v.play(); } catch {}
          });
        } else if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          await loc.click({ timeout: 1500, force: true }).catch(() => {});
        }
        await page.waitForTimeout(500);
      } catch {}
    }
  }
}

async function scrapeMovie(context, url, templates) {
  const page = await context.newPage();
  const media = new Set();
  const capture = u => { if (isMediaUrl(u)) media.add(u); };

  page.on('request', req => capture(req.url()));
  page.on('response', res => capture(res.url()));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);

    await harvestDomMedia(page, media);
    await tryStartPlayback(page);
    await page.waitForTimeout(5000);
    await harvestDomMedia(page, media);

    // Some players appear after the first interaction/ad layer.
    await tryStartPlayback(page);
    await page.waitForTimeout(5000);
    await harvestDomMedia(page, media);

    const title = (
      await page.locator('h1').first().innerText().catch(() => '') ||
      await page.title().catch(() => '')
    ).trim();
    const poster = (
      await page.locator('meta[property="og:image"]').getAttribute('content').catch(() => '') ||
      await page.locator('video').first().getAttribute('poster').catch(() => '') || ''
    ).trim();
    const description = await getFullDescription(page);

    let candidates = [...media].sort((a, b) => scoreManifest(b) - scoreManifest(a));
    let manifest = candidates.find(u => /manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)/i.test(u)) || '';
    const mp4 = candidates.find(u => /\.mp4(?:\?|$)/i.test(u)) || '';
    let detectedBy = manifest ? 'request_or_dom' : '';

    if (!manifest && !mp4) {
      manifest = await probeFallbackManifest(page, url, templates);
      if (manifest) detectedBy = 'validated_template';
    }

    candidates = [...media].sort((a, b) => scoreManifest(b) - scoreManifest(a));
    console.log(`Media candidates for ${pageNumericId(url)}: ${candidates.length}`);

    return {
      id: extractIdFromUrl(url),
      title,
      poster,
      description,
      page_url: url,
      manifest_url: manifest,
      manifest_detected_by: detectedBy,
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
  const templates = buildManifestTemplates(existing);
  console.log(`Existing movies: ${existing.length}; learned manifest templates: ${templates.length}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();

  const links = await collectListingLinks(page);
  const newLinks = links.filter(x => !existingUrls.has(x)).slice(0, MAX_NEW_MOVIES);
  const repairIndexes = existing
    .map((movie, index) => ({ movie, index }))
    .filter(({ movie }) => movie.page_url && !movie.manifest_url && !movie.mp4_url)
    .slice(0, MAX_REPAIR_MOVIES);

  console.log(`Listing links: ${links.length}; new: ${newLinks.length}; repair: ${repairIndexes.length}`);

  let changed = false;
  const repairedExisting = [...existing];

  for (const { movie, index } of repairIndexes) {
    try {
      const item = await scrapeMovie(context, normalizeUrl(movie.page_url), templates);
      if (item.manifest_url || item.mp4_url) {
        repairedExisting[index] = { ...movie, ...item, id: movie.id || item.id };
        changed = true;
        console.log(`REPAIRED ${movie.id}: ${item.manifest_detected_by}`);
      } else {
        console.log(`REPAIR_PENDING ${movie.id}: no stream`);
      }
    } catch (e) {
      console.error(`Repair failed ${movie.page_url}: ${e.message}`);
    }
  }

  const added = [];
  for (const link of newLinks) {
    try {
      const item = await scrapeMovie(context, link, templates);
      if (item.manifest_url || item.mp4_url) {
        console.log(`ADD ${item.id}: ${item.title} | ${item.manifest_detected_by}`);
        added.push(item);
      } else {
        console.log(`SKIP_NO_STREAM ${item.id}: will retry next run`);
      }
    } catch (e) {
      console.error(`Failed ${link}: ${e.message}`);
    }
  }

  await page.close();
  await browser.close();

  if (!added.length && !changed) {
    console.log('No validated stream updates; target data unchanged.');
    return;
  }

  const merged = [...added, ...repairedExisting];
  await ghUpdateFile(sha, merged);
  console.log(`Updated ${TARGET_REPO}/${TARGET_PATH}: +${added.length}, repaired=${changed ? 'yes' : 'no'}, total ${merged.length}`);
})();
