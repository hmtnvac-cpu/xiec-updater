const { chromium } = require('playwright');

const TEST_URL = process.env.TEST_MOVIE_URL || 'https://vlxx.phd/video/bi-tu-choi-tinh-cam-thanh-nien-du-luon-ca-2-me-con-crush/3221/';

function isMediaUrl(url = '') {
  return /manifest|\.m3u8(?:\?|$)|\.mpd(?:\?|$)|\.vl(?:\?|$)|\.mp4(?:\?|$)/i.test(url);
}

function score(url = '') {
  const s = url.toLowerCase();
  let n = 0;
  if (s.includes('manifest')) n += 100;
  if (s.includes('.m3u8')) n += 90;
  if (s.includes('.mpd')) n += 80;
  if (s.includes('.vl')) n += 70;
  if (s.includes('.mp4')) n += 10;
  return n;
}

async function harvest(page, bucket) {
  for (const frame of page.frames()) {
    try {
      const urls = await frame.locator('[src],[data-src],[data-url],[data-file]').evaluateAll(els => {
        const out = [];
        for (const el of els) {
          for (const k of ['src','data-src','data-url','data-file']) {
            const v = el.getAttribute(k);
            if (v) out.push(v);
          }
        }
        return out;
      });
      for (const u of urls) {
        try {
          const abs = new URL(u, frame.url()).toString();
          if (isMediaUrl(abs)) bucket.add(abs);
        } catch {}
      }
    } catch {}
  }
}

async function clickExact(page, label) {
  const frames = page.frames();
  for (const frame of frames) {
    const selectors = ['button','a','[role="button"]','li','span','div'];
    for (const sel of selectors) {
      const loc = frame.locator(sel).filter({ hasText: label });
      const count = Math.min(await loc.count().catch(() => 0), 30);
      for (let i = 0; i < count; i++) {
        const item = loc.nth(i);
        try {
          const txt = (await item.innerText({ timeout: 300 })).replace(/\s+/g, ' ').trim();
          if (txt !== label) continue;
          if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue;
          await item.click({ force: true, timeout: 1500 });
          return true;
        } catch {}
      }
    }
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    viewport: { width: 1365, height: 900 }
  });
  const page = await context.newPage();
  let active = new Set();
  const capture = u => { if (isMediaUrl(u)) active.add(u); };
  page.on('request', r => capture(r.url()));
  page.on('response', r => capture(r.url()));

  await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await harvest(page, active);
  await page.locator('video').first().evaluate(v => { try { v.muted = true; void v.play(); } catch {} }).catch(() => {});
  await page.waitForTimeout(4500);
  await harvest(page, active);

  const one = [...active].sort((a,b) => score(b)-score(a));
  console.log(`SERVER_BUTTONS ${JSON.stringify(await page.locator('button,a,[role="button"],li,span,div').allTextContents().then(xs => [...new Set(xs.map(x => x.replace(/\s+/g,' ').trim()).filter(x => /^#\d+$/.test(x)))].slice(0,20)).catch(() => []))}`);
  console.log(`SERVER #1 candidates=${one.length}`);
  for (const u of one.slice(0,10)) console.log(`SERVER #1 MEDIA | ${u}`);

  active = new Set();
  const clicked = await clickExact(page, '#2');
  console.log(`SERVER #2 clicked=${clicked}`);
  if (clicked) {
    await page.waitForTimeout(1500);
    await page.locator('video').first().evaluate(v => { try { v.muted = true; void v.play(); } catch {} }).catch(() => {});
    await page.waitForTimeout(5000);
    await harvest(page, active);
  }

  const two = [...active].sort((a,b) => score(b)-score(a));
  console.log(`SERVER #2 candidates=${two.length}`);
  for (const u of two.slice(0,10)) console.log(`SERVER #2 MEDIA | ${u}`);

  await browser.close();
})();
