const { chromium } = require('playwright');

const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || 4);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 100);
const BACKFILL_VERSION = 1;

if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-backfill'
};

async function readTarget() {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const movies = JSON.parse(Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  return { sha: data.sha, movies };
}

async function writeTarget(sha, movies, message) {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(movies, null, 2)).toString('base64'),
      sha,
      branch: 'main'
    })
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  const out = await res.json();
  return out.content.sha;
}

function clean(s = '') { return s.replace(/\s+/g, ' ').trim(); }
function isMediaUrl(url = '') { return /manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)|\.mp4(?:\?|$)/i.test(url); }
function mediaScore(url = '') {
  const s = url.toLowerCase(); let n = 0;
  if (s.includes('manifest')) n += 100;
  if (s.includes('.m3u8')) n += 90;
  if (s.includes('.mpd')) n += 80;
  if (s.includes('.vl')) n += 70;
  if (s.includes('2160') || s.includes('4k')) n += 50;
  if (s.includes('1080')) n += 30;
  if (s.includes('.mp4')) n += 10;
  return n;
}

async function collectMedia(page, bucket) {
  for (const frame of page.frames()) {
    try {
      const vals = await frame.locator('[src],[data-src],[data-url],[data-file],[data-video]').evaluateAll(els => {
        const out = [];
        for (const el of els) for (const k of ['src','data-src','data-url','data-file','data-video']) {
          const v = el.getAttribute(k); if (v) out.push(v);
        }
        return out;
      });
      for (const v of vals) {
        try {
          const abs = new URL(v, frame.url()).toString();
          if (isMediaUrl(abs)) bucket.add(abs);
        } catch {}
      }
      const html = await frame.content();
      const hits = html.match(/https?:[^"'<>\\\s]+(?:manifest[^"'<>\\\s]*|\.m3u8[^"'<>\\\s]*|\.mpd[^"'<>\\\s]*|\.vl(?:\?[^"'<>\\\s]*)?|\.mp4(?:\?[^"'<>\\\s]*)?)/gi) || [];
      for (const h of hits) bucket.add(h.replace(/&amp;/g, '&'));
    } catch {}
  }
}

async function clickExact(page, label) {
  for (const frame of page.frames()) {
    for (const sel of ['button','a','[role="button"]','li','span','div']) {
      const loc = frame.locator(sel).filter({ hasText: label });
      const count = Math.min(await loc.count().catch(() => 0), 40);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        try {
          const txt = clean(await el.innerText({ timeout: 250 }));
          if (txt !== label) continue;
          if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
          await el.click({ force: true, timeout: 1500 });
          return true;
        } catch {}
      }
    }
  }
  return false;
}

async function extractMeta(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const uniq = xs => [...new Set(xs.map(clean).filter(Boolean))];

    const descriptionSelectors = ['.description','.video-description','[itemprop="description"]','.entry-content','.post-content','.detail-content'];
    let description = '';
    for (const sel of descriptionSelectors) {
      const el = document.querySelector(sel);
      const t = clean(el?.innerText || el?.textContent || '');
      if (t.length > description.length) description = t;
    }
    if (!description) description = clean(document.querySelector('meta[name="description"]')?.content || '');

    const links = [...document.querySelectorAll('a[href]')].map(a => ({
      text: clean(a.innerText || a.textContent || ''),
      href: a.href || ''
    }));

    const genreLinks = links.filter(x => /(category|genre|the-loai|tag)\//i.test(x.href) && x.text && x.text.length <= 60);
    const actorLinks = links.filter(x => /(actor|actors|pornstar|star|dien-vien|model)\//i.test(x.href) && x.text && x.text.length <= 80);

    let code = '';
    const bodyText = clean(document.body?.innerText || '');
    const codeMatch = bodyText.match(/\b[A-Z]{2,10}[-_ ]?\d{2,6}\b/);
    if (codeMatch) code = codeMatch[0].replace(/[_ ]/g, '-');

    const info = {};
    const rows = [...document.querySelectorAll('tr,li,div,p')];
    for (const el of rows) {
      const t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 180) continue;
      const m = t.match(/^(Năm|Year|Thời lượng|Runtime|Quốc gia|Country|Studio|Hãng)\s*[:：]\s*(.+)$/i);
      if (m) info[m[1].toLowerCase()] = clean(m[2]);
    }

    return {
      description,
      genres: uniq(genreLinks.map(x => x.text)),
      actors: uniq(actorLinks.map(x => x.text)),
      code,
      info
    };
  });
}

async function scrapeOne(context, movie) {
  const page = await context.newPage();
  let bucket = new Set();
  const capture = u => { if (isMediaUrl(u)) bucket.add(u); };
  page.on('request', r => capture(r.url()));
  page.on('response', r => capture(r.url()));

  try {
    await page.goto(movie.page_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const meta = await extractMeta(page);

    await collectMedia(page, bucket);
    await page.locator('video').first().evaluate(v => { try { v.muted = true; void v.play(); } catch {} }).catch(() => {});
    await page.waitForTimeout(2200);
    await collectMedia(page, bucket);
    const oneCandidates = [...bucket].sort((a,b) => mediaScore(b) - mediaScore(a));
    const stream1 = oneCandidates[0] || movie.manifest_url || movie.mp4_url || '';

    bucket = new Set();
    const clicked2 = await clickExact(page, '#2');
    let stream2 = '';
    if (clicked2) {
      await page.waitForTimeout(1200);
      await page.locator('video').first().evaluate(v => { try { v.muted = true; void v.play(); } catch {} }).catch(() => {});
      await page.waitForTimeout(2600);
      await collectMedia(page, bucket);
      const twoCandidates = [...bucket].sort((a,b) => mediaScore(b) - mediaScore(a));
      stream2 = twoCandidates.find(u => u && u !== stream1) || '';
    }

    const streams = [];
    if (stream1) streams.push({ name: '#1', url: stream1 });
    if (stream2) streams.push({ name: '#2', url: stream2 });

    return {
      ...movie,
      description: meta.description && !meta.description.endsWith('...') ? meta.description : (meta.description || movie.description || ''),
      genres: meta.genres,
      actors: meta.actors,
      code: meta.code || movie.code || '',
      year: meta.info['năm'] || meta.info['year'] || movie.year || '',
      runtime: meta.info['thời lượng'] || meta.info['runtime'] || movie.runtime || '',
      country: meta.info['quốc gia'] || meta.info['country'] || movie.country || '',
      studio: meta.info['studio'] || meta.info['hãng'] || movie.studio || '',
      streams: streams.length ? streams : (movie.streams || []),
      backfill_version: BACKFILL_VERSION,
      backfill_status: 'ok'
    };
  } catch (e) {
    return { ...movie, backfill_status: `error:${e.message}` };
  } finally {
    await page.close();
  }
}

(async () => {
  let { sha, movies } = await readTarget();
  const pending = movies.map((m,i) => ({m,i})).filter(x => x.m.page_url && x.m.backfill_version !== BACKFILL_VERSION);
  console.log(`BACKFILL_START total=${movies.length} pending=${pending.length} concurrency=${CONCURRENCY}`);

  let cursor = 0;
  let processed = 0;
  let success = 0;
  let errors = 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1365, height: 900 }
  });

  async function worker() {
    while (true) {
      const pos = cursor++;
      if (pos >= pending.length) return;
      const { m, i } = pending[pos];
      const out = await scrapeOne(context, m);
      movies[i] = out;
      processed++;
      if (out.backfill_status === 'ok') success++; else errors++;
      if (processed % 25 === 0) console.log(`BACKFILL_PROGRESS processed=${processed}/${pending.length} success=${success} errors=${errors}`);

      if (processed % CHECKPOINT_EVERY === 0) {
        const fresh = await readTarget();
        const byId = new Map(movies.map(x => [x.id, x]));
        const merged = fresh.movies.map(x => byId.get(x.id) || x);
        sha = await writeTarget(fresh.sha, merged, `Backfill checkpoint ${processed}/${pending.length}`);
        movies = merged;
        console.log(`BACKFILL_CHECKPOINT ${processed}/${pending.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await browser.close();

  const fresh = await readTarget();
  const byId = new Map(movies.map(x => [x.id, x]));
  const merged = fresh.movies.map(x => byId.get(x.id) || x);
  await writeTarget(fresh.sha, merged, `Complete full catalog backfill ${new Date().toISOString().slice(0,10)}`);

  const fullDesc = merged.filter(x => x.description && !x.description.trim().endsWith('...')).length;
  const withGenres = merged.filter(x => Array.isArray(x.genres) && x.genres.length).length;
  const withActors = merged.filter(x => Array.isArray(x.actors) && x.actors.length).length;
  const withCode = merged.filter(x => x.code).length;
  const with2 = merged.filter(x => Array.isArray(x.streams) && x.streams.some(s => s.name === '#2')).length;
  const failed = merged.filter(x => String(x.backfill_status || '').startsWith('error:')).length;
  console.log(`BACKFILL_DONE total=${merged.length} full_description=${fullDesc} genres=${withGenres} actors=${withActors} code=${withCode} stream2=${with2} failed=${failed}`);
})();
