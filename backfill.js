const { chromium } = require('playwright');

const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;
const META_CONCURRENCY = Number(process.env.META_CONCURRENCY || 12);
const STREAM_CONCURRENCY = Number(process.env.STREAM_CONCURRENCY || 6);
const CHECKPOINT_EVERY = Number(process.env.CHECKPOINT_EVERY || 100);
const BACKFILL_VERSION = 2;

if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-backfill-fast'
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

async function extractMeta(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const uniq = xs => [...new Set(xs.map(clean).filter(Boolean))];
    const selectors = ['.description','.video-description','[itemprop="description"]','.entry-content','.post-content','.detail-content'];
    let description = '';
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const t = clean(el?.innerText || el?.textContent || '');
      if (t.length > description.length) description = t;
    }
    if (!description) description = clean(document.querySelector('meta[name="description"]')?.content || '');

    const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: clean(a.innerText || a.textContent || ''), href: a.href || '' }));
    const genres = uniq(links.filter(x => /(category|genre|the-loai|tag)\//i.test(x.href) && x.text && x.text.length <= 60).map(x => x.text));
    const actors = uniq(links.filter(x => /(actor|actors|pornstar|star|dien-vien|model)\//i.test(x.href) && x.text && x.text.length <= 80).map(x => x.text));

    const bodyText = clean(document.body?.innerText || '');
    const codeMatch = bodyText.match(/\b[A-Z]{2,10}[-_ ]?\d{2,6}\b/);
    const code = codeMatch ? codeMatch[0].replace(/[_ ]/g, '-') : '';

    const info = {};
    for (const el of [...document.querySelectorAll('tr,li,div,p')]) {
      const t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 180) continue;
      const m = t.match(/^(Năm|Year|Thời lượng|Runtime|Quốc gia|Country|Studio|Hãng)\s*[:：]\s*(.+)$/i);
      if (m) info[m[1].toLowerCase()] = clean(m[2]);
    }

    const serverLabels = uniq([...document.querySelectorAll('button,a,[role="button"],li,span,div')]
      .map(el => clean(el.innerText || el.textContent || ''))
      .filter(x => /^#\d+$/.test(x)));

    return { description, genres, actors, code, info, serverLabels };
  });
}

async function clickExact(page, label) {
  for (const frame of page.frames()) {
    for (const sel of ['button','a','[role="button"]','li','span','div']) {
      const loc = frame.locator(sel).filter({ hasText: label });
      const count = Math.min(await loc.count().catch(() => 0), 30);
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        try {
          const txt = clean(await el.innerText({ timeout: 150 }));
          if (txt !== label) continue;
          if (!(await el.isVisible({ timeout: 150 }).catch(() => false))) continue;
          await el.click({ force: true, timeout: 800 });
          return true;
        } catch {}
      }
    }
  }
  return false;
}

async function metadataOne(context, movie) {
  const page = await context.newPage();
  try {
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image','font','stylesheet','media'].includes(t)) return route.abort();
      return route.continue();
    });
    await page.goto(movie.page_url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await page.waitForTimeout(250);
    const meta = await extractMeta(page);
    return {
      ...movie,
      description: meta.description || movie.description || '',
      genres: meta.genres,
      actors: meta.actors,
      code: meta.code || movie.code || '',
      year: meta.info['năm'] || meta.info['year'] || movie.year || '',
      runtime: meta.info['thời lượng'] || meta.info['runtime'] || movie.runtime || '',
      country: meta.info['quốc gia'] || meta.info['country'] || movie.country || '',
      studio: meta.info['studio'] || meta.info['hãng'] || movie.studio || '',
      server_labels: meta.serverLabels,
      metadata_backfill_version: BACKFILL_VERSION,
      metadata_backfill_status: 'ok'
    };
  } catch (e) {
    return { ...movie, metadata_backfill_status: `error:${e.message}` };
  } finally {
    await page.close();
  }
}

async function stream2One(context, movie) {
  if (!Array.isArray(movie.server_labels) || !movie.server_labels.includes('#2')) {
    return { ...movie, stream_backfill_version: BACKFILL_VERSION, stream2_status: 'no_#2_button' };
  }

  const page = await context.newPage();
  let bucket = new Set();
  const capture = u => { if (isMediaUrl(u)) bucket.add(u); };
  page.on('request', r => capture(r.url()));
  page.on('response', r => capture(r.url()));

  try {
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image','font','stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });
    await page.goto(movie.page_url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await page.waitForTimeout(350);
    bucket = new Set();
    const clicked = await clickExact(page, '#2');
    if (!clicked) return { ...movie, stream_backfill_version: BACKFILL_VERSION, stream2_status: 'button_not_clickable' };

    await page.waitForTimeout(900);
    const candidates = [...bucket].sort((a,b) => mediaScore(b) - mediaScore(a));
    const existing1 = movie.manifest_url || movie.mp4_url || movie.streams?.find(s => s.name === '#1')?.url || '';
    const stream2 = candidates.find(u => u && u !== existing1) || '';

    const streams = [];
    if (existing1) streams.push({ name: '#1', url: existing1 });
    if (stream2) streams.push({ name: '#2', url: stream2 });

    return {
      ...movie,
      streams: streams.length ? streams : (movie.streams || []),
      stream_backfill_version: BACKFILL_VERSION,
      stream2_status: stream2 ? 'ok' : 'no_media_after_#2'
    };
  } catch (e) {
    return { ...movie, stream_backfill_status: `error:${e.message}` };
  } finally {
    await page.close();
  }
}

async function runPhase({ name, items, concurrency, worker, movies, checkpointTag }) {
  let cursor = 0, processed = 0, success = 0, errors = 0;
  const context = worker.context;
  async function task() {
    while (true) {
      const pos = cursor++;
      if (pos >= items.length) return;
      const { m, i } = items[pos];
      const out = await worker.fn(context, m);
      movies[i] = out;
      processed++;
      if (String(out.metadata_backfill_status || out.stream_backfill_status || 'ok').startsWith('error:')) errors++; else success++;
      if (processed % 25 === 0) console.log(`${name}_PROGRESS processed=${processed}/${items.length} success=${success} errors=${errors}`);
      if (processed % CHECKPOINT_EVERY === 0) console.log(`${checkpointTag}_READY processed=${processed}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => task()));
  return { processed, success, errors };
}

(async () => {
  let { movies } = await readTarget();
  const browser = await chromium.launch({ headless: true });

  const metaContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
  const metaPending = movies.map((m,i) => ({m,i})).filter(x => x.m.page_url && x.m.metadata_backfill_version !== BACKFILL_VERSION);
  console.log(`META_START total=${movies.length} pending=${metaPending.length} concurrency=${META_CONCURRENCY}`);
  await runPhase({ name:'META', items:metaPending, concurrency:META_CONCURRENCY, worker:{context:metaContext, fn:metadataOne}, movies, checkpointTag:'META' });
  await metaContext.close();

  let fresh = await readTarget();
  let byId = new Map(movies.map(x => [x.id, x]));
  movies = fresh.movies.map(x => byId.get(x.id) || x);
  await writeTarget(fresh.sha, movies, `Fast metadata backfill ${new Date().toISOString().slice(0,10)}`);
  console.log('META_COMMITTED');

  const streamContext = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1280, height: 720 }
  });
  const streamPending = movies.map((m,i) => ({m,i})).filter(x => x.m.page_url && x.m.stream_backfill_version !== BACKFILL_VERSION && Array.isArray(x.m.server_labels) && x.m.server_labels.includes('#2'));
  console.log(`STREAM2_START candidates=${streamPending.length} concurrency=${STREAM_CONCURRENCY}`);
  await runPhase({ name:'STREAM2', items:streamPending, concurrency:STREAM_CONCURRENCY, worker:{context:streamContext, fn:stream2One}, movies, checkpointTag:'STREAM2' });
  await streamContext.close();
  await browser.close();

  fresh = await readTarget();
  byId = new Map(movies.map(x => [x.id, x]));
  movies = fresh.movies.map(x => byId.get(x.id) || x);
  await writeTarget(fresh.sha, movies, `Complete fast full catalog backfill ${new Date().toISOString().slice(0,10)}`);

  const fullDesc = movies.filter(x => x.description && !x.description.trim().endsWith('...')).length;
  const withGenres = movies.filter(x => Array.isArray(x.genres) && x.genres.length).length;
  const withActors = movies.filter(x => Array.isArray(x.actors) && x.actors.length).length;
  const withCode = movies.filter(x => x.code).length;
  const with2 = movies.filter(x => Array.isArray(x.streams) && x.streams.some(s => s.name === '#2')).length;
  const metaFailed = movies.filter(x => String(x.metadata_backfill_status || '').startsWith('error:')).length;
  console.log(`BACKFILL_DONE total=${movies.length} full_description=${fullDesc} genres=${withGenres} actors=${withActors} code=${withCode} stream2=${with2} meta_failed=${metaFailed}`);
})();
