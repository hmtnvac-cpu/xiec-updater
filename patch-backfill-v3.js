const fs = require('fs');
const file = 'backfill.js';
let s = fs.readFileSync(file, 'utf8');

s = s.replace('const BACKFILL_VERSION = 2;', 'const BACKFILL_VERSION = 3;');

s = s.replace(/async function extractMeta\(page\) \{[\s\S]*?\n\}\n\nasync function clickExact/, `async function extractMeta(page) {
  return page.evaluate(() => {
    const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
    const uniq = xs => [...new Set(xs.map(clean).filter(Boolean))];

    // Real VLXX selectors confirmed from live DOM.
    const actressBox = document.querySelector('.actress-tag');
    const categoryBox = document.querySelector('.category-tag');
    const code = clean(document.querySelector('.video-code')?.textContent || '');

    const actors = actressBox
      ? uniq([...actressBox.querySelectorAll('a')].map(a => a.textContent).concat(
          actressBox.querySelectorAll('a').length ? [] : [actressBox.textContent]
        ))
      : [];

    const genres = categoryBox
      ? uniq([...categoryBox.querySelectorAll('a')].map(a => a.textContent).concat(
          categoryBox.querySelectorAll('a').length ? [] : [categoryBox.textContent]
        ))
      : [];

    // Description is the text block between the movie code area and actress/category tags.
    // Prefer dedicated content nodes, then choose the longest clean paragraph before related videos.
    const descCandidates = [];
    for (const sel of ['.video-description','.description','.detail-content','.post-content','.entry-content','[itemprop="description"]']) {
      const el = document.querySelector(sel);
      const t = clean(el?.innerText || el?.textContent || '');
      if (t.length >= 40) descCandidates.push(t);
    }
    for (const el of [...document.querySelectorAll('p, .video-info, .video-detail, .content')]) {
      if (el.closest('.video-item, .related, footer, nav')) continue;
      const t = clean(el.innerText || el.textContent || '');
      if (t.length >= 80 && t.length <= 4000) descCandidates.push(t);
    }
    let description = descCandidates.sort((a,b) => b.length - a.length)[0] || '';
    if (!description) description = clean(document.querySelector('meta[name="description"]')?.content || '');

    const info = {};
    for (const el of [...document.querySelectorAll('tr,li,div,p,span')]) {
      const t = clean(el.innerText || el.textContent || '');
      if (!t || t.length > 180) continue;
      const m = t.match(/^(Năm|Year|Thời lượng|Runtime|Quốc gia|Country|Studio|Hãng)\\s*[:：]\\s*(.+)$/i);
      if (m) info[m[1].toLowerCase()] = clean(m[2]);
    }

    const serverLabels = uniq([...document.querySelectorAll('button,a,[role="button"],li,span,div')]
      .map(el => clean(el.innerText || el.textContent || ''))
      .filter(x => /^#\\d+$/.test(x)));

    return { description, genres, actors, code, info, serverLabels };
  });
}

async function clickExact`);

s = s.replace("await page.waitForTimeout(250);", "await page.waitForTimeout(700);");
s = s.replace("await page.waitForTimeout(350);", "await page.waitForTimeout(900);");
s = s.replace("await page.waitForTimeout(900);\n    const candidates", "await page.waitForTimeout(2500);\n    for (const frame of page.frames()) {\n      await frame.locator('video').first().evaluate(v => { try { v.muted = true; void v.play(); } catch {} }).catch(() => {});\n    }\n    await page.waitForTimeout(2500);\n    const candidates");

fs.writeFileSync(file, s);
console.log('BACKFILL_V3_PATCHED');
