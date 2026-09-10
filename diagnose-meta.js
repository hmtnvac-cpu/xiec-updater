const { chromium } = require('playwright');

const URL = process.env.TEST_MOVIE_URL || 'https://vlxx.phd/video/bi-tu-choi-tinh-cam-thanh-nien-du-luon-ca-2-me-con-crush/3221/';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    const clean = s => (s || '').replace(/\s+/g, ' ').trim();
    const anchors = [...document.querySelectorAll('a[href]')].map(a => ({
      text: clean(a.innerText || a.textContent || ''),
      href: a.href || '',
      cls: `${a.className || ''}`
    })).filter(x => x.text || x.href);

    const interestingAnchors = anchors.filter(x =>
      /(category|genre|tag|actor|star|model|pornstar|dien-vien|the-loai|jav|uncen|vietsub)/i.test(`${x.href} ${x.text} ${x.cls}`)
    ).slice(0, 300);

    const shortText = [...document.querySelectorAll('body *')]
      .map(el => ({
        tag: el.tagName,
        text: clean(el.innerText || el.textContent || ''),
        cls: `${el.className || ''}`,
        id: el.id || ''
      }))
      .filter(x => x.text && x.text.length <= 120 && /(thể loại|diễn viên|actor|genre|tag|mã phim|code|studio|quốc gia|thời lượng|vietsub|uncen)/i.test(`${x.text} ${x.cls} ${x.id}`))
      .slice(0, 300);

    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => s.textContent || '')
      .filter(Boolean)
      .slice(0, 20);

    return {
      title: document.title,
      bodySample: clean(document.body?.innerText || '').slice(0, 5000),
      interestingAnchors,
      shortText,
      scripts
    };
  });

  console.log('DIAG_META ' + JSON.stringify(data));
  await browser.close();
})();
