const TARGET_REPO = process.env.TARGET_REPO || 'hmtnvac-cpu/xiec';
const TARGET_PATH = process.env.TARGET_PATH || 'data/ket_qua_1500_phim.json';
const GH_TOKEN = process.env.XIEC_TOKEN;
const LIMIT = Number(process.env.DURATION_LIMIT || 20);
const CONCURRENCY = Number(process.env.DURATION_CONCURRENCY || 10);

if (!GH_TOKEN) throw new Error('Missing XIEC_TOKEN');

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'xiec-duration-probe'
};

async function readTarget() {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, { headers: ghHeaders });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  let encoded = data.content || '';
  if (!encoded) {
    const b = await fetch(`https://api.github.com/repos/${TARGET_REPO}/git/blobs/${data.sha}`, { headers: ghHeaders });
    if (!b.ok) throw new Error(`GitHub blob read failed: ${b.status} ${await b.text()}`);
    encoded = (await b.json()).content || '';
  }
  return { sha: data.sha, movies: JSON.parse(Buffer.from(encoded.replace(/\n/g, ''), 'base64').toString('utf8')) };
}

async function writeTarget(sha, movies) {
  const url = `https://api.github.com/repos/${TARGET_REPO}/contents/${TARGET_PATH}`;
  const res = await fetch(url, {
    method: 'PUT', headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Probe video duration for ${LIMIT} movies`,
      content: Buffer.from(JSON.stringify(movies, null, 2)).toString('base64'), sha, branch: 'main'
    })
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

function fmt(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2,'0')}m`;
  return `${m}m ${String(s).padStart(2,'0')}s`;
}

async function fetchText(url, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        'Accept': '*/*',
        'Referer': 'https://vlxx.phd/'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), finalUrl: res.url, type: res.headers.get('content-type') || '' };
  } finally { clearTimeout(timer); }
}

function parseExtInf(text) {
  const vals = [...text.matchAll(/#EXTINF:([0-9.]+)/gi)].map(m => Number(m[1])).filter(Number.isFinite);
  return vals.length ? vals.reduce((a,b) => a+b, 0) : 0;
}

function variantUrls(text, base) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const out = [];
  for (let i=0; i<lines.length; i++) {
    if (/^#EXT-X-STREAM-INF:/i.test(lines[i])) {
      for (let j=i+1; j<lines.length; j++) {
        if (lines[j].startsWith('#')) continue;
        try { out.push(new URL(lines[j], base).toString()); } catch {}
        break;
      }
    }
  }
  return [...new Set(out)];
}

async function durationFromUrl(url, depth = 0) {
  if (!url || depth > 2) return { seconds: 0, method: 'none' };
  const { text, finalUrl, type } = await fetchText(url);
  const direct = parseExtInf(text);
  if (direct > 0) return { seconds: direct, method: 'extinf', finalUrl };

  const variants = variantUrls(text, finalUrl || url);
  for (const v of variants.slice(0, 3)) {
    try {
      const d = await durationFromUrl(v, depth + 1);
      if (d.seconds > 0) return { ...d, method: `master>${d.method}` };
    } catch {}
  }

  return { seconds: 0, method: `unsupported:${type || 'unknown'}`, sample: text.slice(0, 80).replace(/\s+/g,' ') };
}

(async () => {
  const { sha, movies } = await readTarget();
  const targets = movies.map((m,i) => ({m,i})).filter(x => !x.m.runtime && (x.m.manifest_url || x.m.mp4_url || x.m.streams?.[0]?.url)).slice(0, LIMIT);
  let cursor = 0, found = 0, failed = 0;

  async function worker() {
    while (true) {
      const pos = cursor++;
      if (pos >= targets.length) return;
      const { m, i } = targets[pos];
      const url = m.manifest_url || m.mp4_url || m.streams?.[0]?.url;
      try {
        const d = await durationFromUrl(url);
        if (d.seconds > 0) {
          movies[i] = { ...m, runtime: fmt(d.seconds), runtime_seconds: Math.round(d.seconds), runtime_source: 'stream_#1', runtime_method: d.method };
          found++;
          console.log(`DURATION_OK ${pos+1}/${targets.length} id=${m.id} runtime=${movies[i].runtime} method=${d.method}`);
        } else {
          failed++;
          console.log(`DURATION_MISS ${pos+1}/${targets.length} id=${m.id} method=${d.method} sample=${d.sample || ''}`);
        }
      } catch (e) {
        failed++;
        console.log(`DURATION_ERR ${pos+1}/${targets.length} id=${m.id} error=${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
  console.log(`DURATION_RESULT tested=${targets.length} found=${found} failed=${failed}`);
  if (found > 0) {
    await writeTarget(sha, movies);
    console.log(`DURATION_COMMITTED found=${found}`);
  } else {
    console.log('DURATION_NOT_COMMITTED no durations found');
  }
})();
