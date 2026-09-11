const { chromium } = require('playwright');

const ROOT = process.env.SOURCE_URL || 'https://vlxx.phd/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1365, height: 900 } });
  const page = await ctx.newPage();
  await page.route('**/*', r => ['image','font','media'].includes(r.request().resourceType()) ? r.abort() : r.continue());
  const resp = await page.goto(ROOT, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log(`MENU_HOME status=${resp?.status() || 0} url=${page.url()}`);
  await page.waitForTimeout(1500);
  const items = await page.evaluate(() => {
    const tidy = s => String(s || '').replace(/\s+/g, ' ').trim();
    const selectors = [
      'nav a[href]', 'header a[href]', '.menu a[href]', '.navbar a[href]',
      '[class*="menu"] a[href]', '[class*="nav"] a[href]'
    ];
    const out = [];
    const seen = new Set();
    for (const sel of selectors) {
      for (const a of document.querySelectorAll(sel)) {
        const text = tidy(a.textContent || a.getAttribute('title') || '');
        const href = a.href || '';
        if (!text || !href) continue;
        const key = text + '|' + href;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, href });
      }
    }
    return out;
  });
  for (const item of items) console.log(`MENU_ITEM text=${JSON.stringify(item.text)} href=${item.href}`);
  console.log(`MENU_DONE count=${items.length}`);
  await browser.close();
})().catch(e => { console.error('MENU_FATAL', e); process.exit(1); });