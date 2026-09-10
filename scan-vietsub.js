const { chromium } = require('playwright');

const SOURCE_URL = process.env.SOURCE_URL || 'https://vlxx.phd/';
const MAX_LIST_PAGES = Number(process.env.MAX_LIST_PAGES || 3);

function normalize(url) {
  try {
    const u = new URL(url, SOURCE_URL);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
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
        let best = null;
        for (let depth = 0; depth < 7 && node; depth++, node = node.parentElement) {
          const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
          const html = node.outerHTML || '';
          const hasVietsub = /viet\s*sub|vsub|việt\s*sub/i.test(`${text} ${html}`);
          if (hasVietsub) {
            best = { text, html: html.slice(0, 1200), depth };
            break;
          }
          if (!best && text && text.length < 500) best = { text, html: html.slice(0, 1200), depth };
        }
        const containerText = best?.text || '';
        const containerHtml = best?.html || '';
        return {
          url: a.href,
          title: (a.getAttribute('title') || a.innerText || '').replace(/\s+/g, ' ').trim(),
          vietsub: /viet\s*sub|vsub|việt\s*sub/i.test(`${containerText} ${containerHtml}`),
          evidence: /viet\s*sub|vsub|việt\s*sub/i.test(containerText) ? containerText : (containerHtml.match(/.{0,80}(?:viet\s*sub|vsub|việt\s*sub).{0,80}/i)?.[0] || '')
        };
      });
    });

    for (const card of cards) {
      const url = normalize(card.url);
      if (!all.has(url) || card.vietsub) all.set(url, { ...card, url });
    }
  }

  const items = [...all.values()];
  const vs = items.filter(x => x.vietsub);
  const no = items.filter(x => !x.vietsub);

  console.log(`VIETSUB_SCAN total=${items.length} vietsub=${vs.length} no_badge=${no.length}`);
  for (const x of vs.slice(0, 20)) {
    console.log(`VIETSUB YES | ${x.url} | ${x.title || '(no title)'} | ${x.evidence.slice(0, 180)}`);
  }
  for (const x of no.slice(0, 10)) {
    console.log(`VIETSUB NO? | ${x.url} | ${x.title || '(no title)'}`);
  }

  await browser.close();
})();
