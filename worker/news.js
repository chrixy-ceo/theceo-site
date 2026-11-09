// Hourly news collector (Google News + Bing News), ranked by priority. One run = every category, fetched in parallel with
// timeouts, retries and backoff. A failing category keeps its last good items, so the
// listing never goes empty. A KV lock stops overlapping runs. Results and a run log live in KV.
const KEY_DATA = 'news:data';
const KEY_CONFIG = 'news:config';
const KEY_RUNS = 'news:runs';
const KEY_LOCK = 'news:lock';

export const DEFAULT_CONFIG = {
  enabled: true,
  sources: ['google', 'bing'], // news sources to combine
  hl: 'en-NG', gl: 'NG', ceid: 'NG:en', // Google News edition
  window: '1d',          // only stories from the last N (h/d)
  perCategory: 20,       // items kept per category
  maxAgeDays: 7,         // older items are dropped
  // Search terms per category (editable in the admin). Categories not listed use their own name.
  queries: {
    AI: 'artificial intelligence',
    Automation: 'automation AI workflow',
    Courses: 'free online course certificate',
    Grants: 'grant applications open Africa',
    Jobs: 'jobs hiring Nigeria',
    Scholarships: 'scholarship Nigerian students',
    Fellowships: 'fellowship programme Africa applications',
    Tech: 'technology Africa startups',
  },
  extra: [],             // extra categories to track besides the site's own
  disabled: ['Other'],   // category names to skip
};

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getConfig(env) {
  const saved = env.NEWS ? await env.NEWS.get(KEY_CONFIG, 'json') : null;
  return { ...DEFAULT_CONFIG, ...(saved || {}) };
}

export async function saveConfig(env, cfg) {
  const clean = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG)) if (cfg[k] !== undefined) clean[k] = cfg[k];
  clean.sources = (Array.isArray(clean.sources) ? clean.sources : []).filter((x) => ['google', 'bing'].includes(x)); if (!clean.sources.length) clean.sources = ['google', 'bing'];
  clean.perCategory = Math.min(50, Math.max(1, Number(clean.perCategory) || 20));
  clean.maxAgeDays = Math.min(60, Math.max(1, Number(clean.maxAgeDays) || 7));
  clean.extra = (Array.isArray(clean.extra) ? clean.extra : String(clean.extra).split(',')).map((s) => String(s).trim()).filter(Boolean);
  clean.disabled = (Array.isArray(clean.disabled) ? clean.disabled : String(clean.disabled).split(',')).map((s) => String(s).trim()).filter(Boolean);
  await env.NEWS.put(KEY_CONFIG, JSON.stringify(clean));
  return clean;
}

// Site categories come from /categories.json, which the Astro build generates from posts and opportunities.
async function siteCategories(env) {
  try {
    const res = await env.ASSETS.fetch('https://assets.local/categories.json');
    if (res.ok) return (await res.json()).all || [];
  } catch {}
  return [];
}

async function fetchWithRetry(url, { tries = 3, timeout = 10000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheCEONewsBot/1.0; +https://theceo.dev)', Accept: 'application/rss+xml, application/xml;q=0.9' }, cf: { cacheTtl: 300 } });
      if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { fatal: true });
      const text = await res.text();
      if (!text.includes('<rss') && !text.includes('<feed')) throw new Error('Not an RSS response');
      return text;
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error('Timed out') : e;
      if (e.fatal) break;
      await sleep(2 ** i * 800 + Math.random() * 400); // exponential backoff with jitter
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

const decode = (s) => String(s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&');
const strip = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : ''; };

// Well-known publishers get a ranking boost (editable later if needed).
const TRUSTED = ['reuters', 'bbc', 'associated press', 'ap news', 'bloomberg', 'financial times', 'the guardian', 'techcrunch', 'the verge', 'wired', 'cnn', 'al jazeera', 'punch', 'premium times', 'channels', 'businessday', 'techcabal', 'nairametrics', 'the cable', 'vanguard', 'guardian nigeria', 'forbes', 'cnbc', 'nature', 'mit technology review'];

function bingParse(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let link = strip(tag(it, 'link'));
    try { const u = new URL(link); if (u.searchParams.get('url')) link = u.searchParams.get('url'); } catch {}
    const title = strip(tag(it, 'title'));
    const date = new Date(strip(tag(it, 'pubDate')));
    const source = strip(tag(it, 'News:Source')) || (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } })();
    const img = (it.match(/<News:Image>([\s\S]*?)<\/News:Image>/) || [])[1];
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, source, summary: strip(tag(it, 'description')).slice(0, 240), image: img ? decode(img) : '', published: isNaN(date) ? new Date().toISOString() : date.toISOString(), via: ['bing'] });
  }
  return items;
}

// Priority score: coverage across sources/outlets, freshness, topic relevance and publisher trust.
function score(item, terms) {
  const ageH = Math.max(0, (Date.now() - new Date(item.published)) / 36e5);
  const fresh = 40 * Math.exp(-ageH / 18);
  const coverage = 15 * Math.min(4, (item.outlets || 1) - 1) + (item.via.length > 1 ? 15 : 0);
  const t = item.title.toLowerCase();
  const rel = terms.length ? 25 * terms.filter((w) => t.includes(w)).length / terms.length : 0;
  const trust = TRUSTED.some((n) => (item.source || '').toLowerCase().includes(n)) ? 12 : 0;
  return Math.round(fresh + coverage + rel + trust);
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const srcM = it.match(/<source[^>]*url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    const source = srcM ? strip(srcM[2]) : '';
    let title = strip(tag(it, 'title'));
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const link = strip(tag(it, 'link'));
    const date = new Date(strip(tag(it, 'pubDate')));
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, source, sourceUrl: srcM ? decode(srcM[1]) : '', published: isNaN(date) ? new Date().toISOString() : date.toISOString(), via: ['google'] });
  }
  return items;
}

const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

async function collect(cat, cfg, previous) {
  const terms = (cfg.queries[cat] || DEFAULT_CONFIG.queries[cat] || cat);
  const gq = terms + (cfg.window ? ` when:${cfg.window}` : '');
  const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(gq)}&hl=${cfg.hl}&gl=${cfg.gl}&ceid=${encodeURIComponent(cfg.ceid)}`;
  const bUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(terms)}&format=rss&qft=sortbydate%3d%221%22&cc=${encodeURIComponent(cfg.gl)}`;
  const sources = cfg.sources || DEFAULT_CONFIG.sources;
  // Both sources in parallel; the category only fails if every source fails.
  const settled = await Promise.allSettled([
    sources.includes('google') ? fetchWithRetry(gUrl).then(parseRss) : Promise.resolve([]),
    sources.includes('bing') ? fetchWithRetry(bUrl).then(bingParse) : Promise.resolve([]),
  ]);
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  const fresh = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const sourceErrors = settled.map((r, i) => (r.status === 'rejected' ? ['google', 'bing'][i] + ': ' + (r.reason?.message || r.reason) : null)).filter(Boolean);

  const cutoff = Date.now() - cfg.maxAgeDays * 864e5;
  const words = terms.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  // Group the same story across Google, Bing and earlier runs; keep the earliest copy and count outlets.
  const groups = new Map();
  for (const x of [...fresh, ...(previous || [])]) {
    if (new Date(x.published).getTime() < cutoff) continue;
    const k = key(x.title);
    const g = groups.get(k);
    if (!g) { groups.set(k, { ...x, via: [...(x.via || ['google'])], outletSet: new Set([x.source]) }); continue; }
    for (const v of x.via || []) if (!g.via.includes(v)) g.via.push(v);
    g.outletSet.add(x.source);
    if (!g.summary && x.summary) g.summary = x.summary;
    if (!g.image && x.image) g.image = x.image;
  }
  const items = [...groups.values()].map(({ outletSet, ...g }) => { g.outlets = Math.max(g.outlets || 1, outletSet.size); g.score = score(g, words); g.priority = g.score >= 60 ? 'high' : g.score >= 35 ? 'medium' : 'low'; return g; })
    .sort((a, b) => b.score - a.score || new Date(b.published) - new Date(a.published))
    .slice(0, cfg.perCategory);
  return { items, sourceErrors };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const n = i++; out[n] = await fn(items[n]).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); } }));
  return out;
}

export async function runNews(env, { trigger = 'cron', force = false } = {}) {
  if (!env.NEWS) return { ok: false, error: 'NEWS KV binding is missing.' };
  const cfg = await getConfig(env);
  if (!cfg.enabled && !force) return { ok: true, skipped: 'disabled' };

  const lock = await env.NEWS.get(KEY_LOCK);
  if (lock && !force) return { ok: true, skipped: 'another run in progress' };
  const runId = crypto.randomUUID();
  await env.NEWS.put(KEY_LOCK, runId, { expirationTtl: 300 });

  const started = Date.now();
  try {
    const names = [...new Set([...(await siteCategories(env)), ...cfg.extra])].filter((c) => !cfg.disabled.includes(c));
    const prev = (await env.NEWS.get(KEY_DATA, 'json')) || { categories: {} };
    const results = await pool(names, 4, (name) => collect(name, cfg, prev.categories[slugify(name)]?.items));

    const categories = {};
    const report = [];
    names.forEach((name, i) => {
      const slug = slugify(name);
      const old = prev.categories[slug];
      const r = results[i];
      if (r.ok) {
        categories[slug] = { name, slug, items: r.v.items, updated: new Date().toISOString(), failures: 0, error: r.v.sourceErrors.join('; ') || null };
        report.push({ name, ok: true, count: r.v.items.length, warnings: r.v.sourceErrors });
      } else {
        // Keep the last good items and count consecutive failures.
        categories[slug] = { name, slug, items: old?.items || [], updated: old?.updated || null, failures: (old?.failures || 0) + 1, error: String(r.e?.message || r.e) };
        report.push({ name, ok: false, error: categories[slug].error });
      }
    });

    const data = { generated: new Date().toISOString(), categories };
    await env.NEWS.put(KEY_DATA, JSON.stringify(data));

    const run = { id: runId, trigger, at: new Date(started).toISOString(), ms: Date.now() - started, ok: report.every((r) => r.ok), total: report.length, failed: report.filter((r) => !r.ok).length, report };
    const runs = ((await env.NEWS.get(KEY_RUNS, 'json')) || []).slice(0, 47);
    await env.NEWS.put(KEY_RUNS, JSON.stringify([run, ...runs]));
    console.log(JSON.stringify({ event: 'news_run', ...run, report: undefined }));
    return { ok: true, run };
  } catch (e) {
    console.error('news_run_failed', e?.stack || e);
    const runs = ((await env.NEWS.get(KEY_RUNS, 'json')) || []).slice(0, 47);
    await env.NEWS.put(KEY_RUNS, JSON.stringify([{ id: runId, trigger, at: new Date(started).toISOString(), ms: Date.now() - started, ok: false, fatal: String(e?.message || e) }, ...runs]));
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if ((await env.NEWS.get(KEY_LOCK)) === runId) await env.NEWS.delete(KEY_LOCK);
  }
}

export async function publicNews(env, category) {
  const data = env.NEWS ? await env.NEWS.get(KEY_DATA, 'json') : null;
  if (!data) return { generated: null, categories: [] };
  const cats = Object.values(data.categories).filter((c) => c.items.length);
  const pick = category ? cats.filter((c) => c.slug === category) : cats;
  return { generated: data.generated, categories: pick.map(({ name, slug, items, updated }) => ({ name, slug, updated, items })) };
}

export async function newsStatus(env) {
  if (!env.NEWS) return { kv: false };
  const [data, runs, config, lock] = await Promise.all([env.NEWS.get(KEY_DATA, 'json'), env.NEWS.get(KEY_RUNS, 'json'), getConfig(env), env.NEWS.get(KEY_LOCK)]);
  return {
    kv: true, running: Boolean(lock), config, runs: runs || [], generated: data?.generated || null,
    categories: Object.values(data?.categories || {}).map(({ name, slug, items, updated, failures, error }) => ({ name, slug, count: items.length, updated, failures, error })),
  };
}
