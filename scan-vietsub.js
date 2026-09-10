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

async function readTarget() {
  if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xiec-updater-vietsub'
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
      'User-Agent': 'xiec-updater-vietsub'
    },
    body: JSON.stringify({
      message: `Update Vietsub flags ${new Date().toISOString().slice(0, 10)}`,
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
      const anchors = [...document.querySelectorAll('a[href*="/video/"]')];
      return anchors.map(a => {
        let node = a;
        let chosen = null;
        for (let depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
          const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          const html = node.outerHTML || '';
          const hasVietsub = /viet\s*sub|vsub|việt\s*sub/i.test(`${text} ${html}`);
          if (hasVietsub) {
            chosen = { text, html: html.slice(0, 1200), depth };
            break;
          }
          if (!chosen && text && text.length < 500) chosen = { text, html: html.slice(0, 1200), depth };
        }
        const containerText = chosen?.text || '';
        const containerHtml = chosen?.html || '';
        return {
          url: a.href,
          title: (a.getAttribute('title') || a.innerText || '').replace(/\s+/g, ' ').trim(),
          vietsub: /viet\s*sub|vsub|việt\s*sub/i.test(`${containerText} ${containerHtml}`),
          evidence: /viet\s*sub|vsub|việt\s*sub/i.test(containerText)
            ? containerText
            : (containerHtml.match(/.{0,80}(?:viet\s*sub|vsub|việt\s*sub).{0,80}/i)?.[0] || '')
        };
      });
    });

    for (const card of cards) {
      const url = normalize(card.url);
      if (!all.has(url) || card.vietsub) all.set(url, { ...card, url });
    }
  }

  await browser.close();

  const items = [...all.values()];
  const vs = items.filter(x => x.vietsub);
  const no = items.filter(x => !x.vietsub);
  console.log(`VIETSUB_SCAN total=${items.length} vietsub=${vs.length} no_badge=${no.length}`);

  for (const x of vs.slice(0, 20)) {
    console.log(`VIETSUB YES | ${x.url} | ${x.title || '(no title)'} | ${x.evidence.slice(0, 180)}`);
  }
  for (const x of no.slice(0, 10)) {
    console.log(`VIETSUB NO | ${x.url} | ${x.title || '(no title)'}`);
  }

  const badgeByUrl = new Map(items.map(x => [normalize(x.url), !!x.vietsub]));
  const { sha, movies } = await readTarget();
  let changed = 0;

  const updated = movies.map(movie => {
    const key = normalize(movie.page_url || '');
    if (!badgeByUrl.has(key)) return movie;
    const next = badgeByUrl.get(key);
    if (movie.vietsub === next) return movie;
    changed++;
    return { ...movie, vietsub: next };
  });

  if (!changed) {
    console.log('VIETSUB_FLAGS no changes needed');
    return;
  }

  await writeTarget(sha, updated);
  console.log(`VIETSUB_FLAGS updated=${changed}`);
})();
