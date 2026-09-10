const TOKEN=process.env.XIEC_TOKEN;
const REPO=process.env.TARGET_REPO||'hmtnvac-cpu/xiec';
const PATH=process.env.TARGET_PATH||'data/ket_qua_1500_phim.json';
if(!TOKEN) throw new Error('Missing XIEC_TOKEN');
const H={Authorization:`Bearer ${TOKEN}`,Accept:'application/vnd.github+json','User-Agent':'xiec-audit'};
async function load(){const r=await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`,{headers:H});if(!r.ok)throw new Error(`contents ${r.status}`);const d=await r.json();let c=d.content||'';if(!c){const b=await fetch(`https://api.github.com/repos/${REPO}/git/blobs/${d.sha}`,{headers:H});if(!b.ok)throw new Error(`blob ${b.status}`);c=(await b.json()).content||'';}return JSON.parse(Buffer.from(c.replace(/\n/g,''),'base64').toString('utf8'));}
const srcId=m=>Number((String(m.page_url||'').match(/\/(\d+)\/?$/)||[])[1]||0);
(async()=>{const movies=await load();const web=movies.filter(m=>String(m.id||'').startsWith('movie_web_'));const s2=movies.filter(m=>Array.isArray(m.streams)&&m.streams.some(s=>s?.name==='#2'&&s?.url));const s1=movies.filter(m=>Array.isArray(m.streams)&&m.streams.some(s=>s?.name==='#1'&&s?.url));console.log(`AUDIT total=${movies.length} movie_web=${web.length} s1=${s1.length} s2=${s2.length}`);
const candidates=web.filter(m=>srcId(m)>0).sort((a,b)=>srcId(b)-srcId(a));for(const m of candidates.slice(0,8)){const streams=(m.streams||[]).map(s=>s.name).join(',');console.log(`SAMPLE id=${m.id} src=${srcId(m)} title=${JSON.stringify(m.title)} streams=${streams} page=${m.page_url}`)}
})();