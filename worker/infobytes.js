// Auto-posts Infobytes opportunities (scholarships, jobs, grants, fellowships, tech programmes).
//
// For each opportunity category, the highest-priority fresh story is checked like this:
//   1. Meaning-based de-duplication against existing opportunities (any wording).
//   2. The source page itself is fetched and read: details come from the page, never from the
//      headline alone. Google News redirect links cannot be read, so stories with a direct link
//      (Bing) are used.
//   3. Workers AI decides whether it is a real opportunity people can still apply for (not news
//      about winners, not a closed call) and extracts only facts stated on the page.
//   4. Grounding checks in code: the organisation must appear in the page, the apply link must be
//      a link that exists on the page, the deadline must be a real future date.
//   5. The post is written in the site's exact Infobytes template (same headings and order as the
//      hand-written ones). Drafts unless auto-publish is on. Each story is used at most once.
import { writeFile } from './db.js';
import { store } from './store.js';

const WRITER = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const EMBED = '@cf/baai/bge-base-en-v1.5';
const KEY_USED = 'autopost:used';
const KEY_FP = 'autopost:fp:ops';
const SAME = 0.86;           // similarity at or above this = already listed
const MAX_COPIED = 0.25;     // share of the draft's 8-word phrases allowed to match the source
const DIR = 'src/content/opportunities';
export const OPPORTUNITY_TYPES = { Scholarships: 'Scholarship', Jobs: 'Job', Grants: 'Grant', Fellowships: 'Fellowship', Tech: 'Programme', Other: 'Opportunity' };

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const key = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
const yaml = (v) => JSON.stringify(String(v ?? ''));
const plain = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const fmOf = (body) => { const fm = (body.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''; const f = {}; for (const m of fm.matchAll(/^([A-Za-z0-9_]+):\s?(.*)$/gm)) f[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); return f; };
const decode = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

function cosine(a, b) { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); }
const embed = async (env, texts) => (await env.AI.run(EMBED, { text: texts.map((t) => plain(t).slice(0, 2000)) })).data;
const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4);

// Share of the draft's 8-word phrases that appear word-for-word in the source page.
function copiedShare(source, draft) {
  const words = (t) => plain(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean);
  const src = new Set(); const s = words(source); for (let i = 0; i + 8 <= s.length; i++) src.add(s.slice(i, i + 8).join(' '));
  const d = words(draft); let n = 0, hit = 0; for (let i = 0; i + 8 <= d.length; i++) { n++; if (src.has(d.slice(i, i + 8).join(' '))) hit++; }
  return n ? hit / n : 0;
}

// Google News links hide the publisher's address. Decode them (two small requests to Google)
// so the writer can read the real page. Returns null if Google refuses.
async function resolveGoogle(link) {
  const id = new URL(link).pathname.split('/').pop();
  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
  const page = await (await fetch(`https://news.google.com/rss/articles/${id}`, { headers: ua })).text();
  const sig = (page.match(/data-n-a-sg="([^"]+)"/) || [])[1], ts = (page.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!sig || !ts) return null;
  const req = [[['Fbv4je', JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sig])]]];
  const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', headers: { ...ua, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: 'f.req=' + encodeURIComponent(JSON.stringify(req)) });
  const url = ((await r.text()).match(/\\"garturlres\\",\\"(https?:[^\\]+)\\"/) || [])[1];
  return url || null;
}

// Fetch the source page: readable text, links and share image.
async function readPage(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InfobytesBot/1.0; +https://theceo.dev)', Accept: 'text/html,application/xhtml+xml' } });
    if (!res.ok) throw new Error('page returned HTTP ' + res.status);
    if (!/html/i.test(res.headers.get('Content-Type') || '')) throw new Error('not an HTML page');
    const html = (await res.text()).slice(0, 600000);
    const base = res.url || url;
    const meta = (name) => decode((html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i')) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i')) || [])[1] || '');
    const abs = (u) => { try { return new URL(decode(u), base).href; } catch { return ''; } };
    const links = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = abs(m[1]); const text = plain(decode(m[2].replace(/<[^>]+>/g, ' ')));
      if (/^https?:/.test(href)) links.push({ href, text: text.slice(0, 80) });
    }
    const clean = (h) => plain(decode(h.replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|li|h[1-6]|div|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')));
    // Use the fullest content block: article, main, entry content or the whole body.
    const blocks = [...html.matchAll(/<(article|main)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const entry = html.match(/<div[^>]+class=["'][^"']*(entry-content|post-content|article-body|td-post-content|content-inner)[^"']*["'][\s\S]*$/i);
    if (entry) blocks.push(entry[0].slice(0, 200000));
    blocks.push((html.match(/<body[\s\S]*<\/body>/i) || [html])[0]);
    const texts = blocks.map(clean).sort((x, y) => y.length - x.length);
    const text = texts.find((t) => t.length >= 400 && t.length < 60000) || texts[0] || '';
    if (text.length < 400) throw new Error('page has too little text');
    return { url: base, text: text.slice(0, 9000), links, image: abs(meta('og:image') || meta('twitter:image') || ''), siteName: meta('og:site_name') };
  } finally { clearTimeout(t); }
}

async function extract(env, { page, category, story, retryNote }) {
  const today = new Date().toISOString().slice(0, 10);
  const applyish = page.links.filter((l) => /apply|application|register|registration|portal|submit|form|career|job|official/i.test(l.text + ' ' + l.href)).slice(0, 25);
  const prompt = `You prepare listings for "Infobytes", a Nigerian site that lists opportunities people can apply for. Today is ${today}. Category: "${category}".

SOURCE PAGE (${page.url}):
"""
${page.text}
"""
Links on the page that may be application links:
${applyish.map((l) => `- ${l.text} -> ${l.href}`).join('\n') || '(none)'}

Decide first: is this page about ONE specific ${category.toLowerCase()} opportunity that people can still apply for now (applications open or opening, with a way to apply)? It is NOT if it is news about winners, people who already received awards, a closed call, an event recap, a general article, or a list of many opportunities.
If not, return {"ok": false, "reason": "short reason"}.

If yes, return JSON with ONLY facts stated on the page (use "" or [] when not stated; never guess):
{"ok": true,
 "title": "clear listing title, e.g. 'XYZ Scholarship 2027' or 'Data Analyst at Company'",
 "organization": "the organisation offering it, exactly as written on the page",
 "deadline": "YYYY-MM-DD only if an application deadline date is stated, else \\"\\"",
 "location": "where it is open to or based, e.g. Nigeria, Africa, Remote, Global",
 "type": "short type, e.g. ${OPPORTUNITY_TYPES[category] || 'Opportunity'}, Full Time, Remote, Training",
 "apply_url": "the official application link, copied exactly from the links list or the page, else \\"\\"",
 "about": ["2 or 3 short paragraphs in your own words: what it is, key facts and dates stated, who it suits"],
 "who_can_apply": ["eligibility points as stated"],
 "what_you_get": ["benefits as stated"],
 "how_to_apply": ["steps as stated, in order"],
 "tip": "one practical tip for applicants, based on the page"}
Write in plain, warm British English, in your own words (do not copy sentences). No hype.${retryNote ? '\nIMPORTANT: ' + retryNote : ''}
Return JSON only.`;
  const res = await env.AI.run(WRITER, { messages: [{ role: 'user', content: prompt }], max_tokens: 1800, temperature: 0.3 });
  return JSON.parse((String(res?.response ?? '').match(/\{[\s\S]*\}/) || [])[0]);
}

// Build the body in the exact Infobytes template used by the hand-written listings.
function buildBody(o, { officialApply }) {
  const list = (a) => a.map((x) => `* ${plain(x).replace(/^[-*•]\s*/, '')}`).join('\n');
  const steps = (a) => a.map((x, i) => `${i + 1}. ${plain(x).replace(/^\d+[.)]\s*/, '')}`).join('\n\n');
  const parts = ['**About the opportunity:**', o.about.map(plain).join('\n\n')];
  if (o.who_can_apply.length) parts.push('**Who can apply:**', list(o.who_can_apply));
  if (o.what_you_get.length) parts.push('**What you get:**', list(o.what_you_get));
  if (o.how_to_apply.length) parts.push('**How to apply:**', steps(o.how_to_apply));
  parts.push(officialApply
    ? `**Official link:** Use the Apply button on this page to go straight to the official application. Always confirm the latest details and requirements on ${o.organization}'s official page before applying.`
    : `**Official link:** Use the Apply button on this page to read the full announcement and find the official application. Always confirm the latest details with ${o.organization} before applying.`);
  if (o.tip) parts.push(`**Tip:** ${plain(o.tip).replace(/^tip:\s*/i, '')}`);
  if (o.deadline) parts.push(`**Reminder:** Use the "Never miss this deadline" box at the top of this page to add the deadline to your Google Calendar or Apple / Outlook calendar, so you don't miss it.`);
  return parts.join('\n\n') + '\n';
}

function validDeadline(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return '';
  const t = new Date(d + 'T23:59:59Z').getTime();
  if (isNaN(t)) return '';
  return d;
}

export async function opportunityCategories(env) {
  const { results } = await env.DB.prepare(`SELECT body FROM content WHERE path LIKE '${DIR}/%.md'`).all();
  return [...new Set(results.map((r) => fmOf(r.body).category).filter(Boolean))];
}

export async function autoOpportunities(env, cfg, categories) {
  const out = [];
  if (!env.AI) return [{ skipped: 'Workers AI is not connected, so no opportunities were written' }];
  const { results } = await env.DB.prepare(`SELECT path, body, updated_by, updated_at FROM content WHERE path LIKE '${DIR}/%.md'`).all();
  const existing = results.map((r) => ({ ...r, fm: fmOf(r.body) }));
  const opCats = new Set(existing.map((r) => r.fm.category).filter(Boolean));
  const used = new Set((await store(env).get(KEY_USED, 'json')) || []);
  const knownUrls = new Set(existing.flatMap((r) => [r.fm.apply_url, r.fm.source_url]).filter(Boolean));

  // Fingerprints of existing listings (built once, then kept up to date).
  let fps = (await store(env).get(KEY_FP, 'json')) || [];
  const have = new Set(fps.map((f) => f.path));
  const missing = existing.filter((r) => !have.has(r.path)).slice(0, 40);
  if (missing.length) { const v = await embed(env, missing.map((r) => `${r.fm.title}. ${r.fm.organization || ''}. ${r.body.replace(/^---[\s\S]*?---/, '').slice(0, 1000)}`)); missing.forEach((r, i) => fps.push({ path: r.path, v: round(v[i]) })); }
  const live = new Set(existing.map((r) => r.path)); fps = fps.filter((f) => live.has(f.path));

  const since = Date.now() - 864e5;
  for (const c of Object.values(categories)) {
    if (!opCats.has(c.name) || cfg.disabled.includes(c.name)) continue;
    const today = existing.filter((r) => r.updated_by === 'autopost' && r.fm.category === c.name && new Date(r.updated_at).getTime() >= since).length;
    if (today >= cfg.autopost.perCategoryPerDay) { out.push({ category: c.name, skipped: 'daily limit reached' }); continue; }

    // Only stories whose page we can read (direct links), fresh, not seen before.
    // Opportunities stay open for weeks, so freshness is not a gate here: the AI decides what is a real open call.
    const cands = c.items.filter((i) => !used.has(key(i.title)) && !knownUrls.has(i.link)).slice(0, 6);
    if (!cands.length) { out.push({ category: c.name, skipped: 'no new stories this hour' }); continue; }
    const vecs = await embed(env, cands.map((s) => `${s.title}. ${s.summary || ''}`));

    let made = null;
    for (const [i, story] of cands.entries()) {
      used.add(key(story.title));
      const near = fps.reduce((m, f) => Math.max(m, cosine(vecs[i], f.v)), 0);
      if (near >= SAME) { out.push({ category: c.name, skipped: `already listed: ${story.title}`, similarity: +near.toFixed(3) }); continue; }
      let page;
      try {
        let link = story.link;
        if (/news\.google\.com/.test(link)) { link = await resolveGoogle(link).catch(() => null); if (!link) throw new Error('Google did not reveal the article address'); }
        if (knownUrls.has(link)) { out.push({ category: c.name, skipped: `already listed: ${story.title}` }); continue; }
        page = await readPage(link);
      } catch (e) { out.push({ category: c.name, skipped: `${story.title}: could not read page (${e.message})` }); continue; }
      if (knownUrls.has(page.url)) { out.push({ category: c.name, skipped: `already listed: ${story.title}` }); continue; }

      let o, note = '', why = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try { o = await extract(env, { page, category: c.name, story, retryNote: note }); } catch (e) { why = 'writer failed: ' + e.message; o = null; break; }
        if (!o?.ok) { why = 'not an open opportunity' + (o?.reason ? ` (${o.reason})` : ''); o = null; break; }
        o.about = (Array.isArray(o.about) ? o.about : [o.about]).filter(Boolean);
        for (const k of ['who_can_apply', 'what_you_get', 'how_to_apply']) o[k] = (Array.isArray(o[k]) ? o[k] : []).map(plain).filter(Boolean).slice(0, 12);
        const text = page.text.toLowerCase();
        // Grounding checks: facts must come from the page.
        if (!o.title || !o.organization || !o.about.length) { why = 'too little information on the page'; o = null; break; }
        const orgWord = String(o.organization).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['foundation', 'limited', 'company', 'group', 'trust', 'international', 'university', 'institute'].includes(w)).sort((x, y) => y.length - x.length)[0] || String(o.organization).toLowerCase();
        if (!text.includes(orgWord)) { why = `organisation "${o.organization}" not found on the page`; o = null; break; }
        if (!o.who_can_apply.length && !o.how_to_apply.length) { why = 'page does not say who can apply or how'; o = null; break; }
        o.deadline = validDeadline(o.deadline);
        if (o.deadline && new Date(o.deadline + 'T23:59:59Z') < new Date()) { why = 'deadline has passed'; o = null; break; }
        const copied = copiedShare(page.text, [...o.about, ...o.who_can_apply, ...o.what_you_get].join(' '));
        if (copied > MAX_COPIED) { note = 'Your last answer copied sentences from the page. Rewrite the "about" paragraphs fully in your own words.'; why = `too close to the source (${Math.round(copied * 100)}%)`; o = null; continue; }
        o.copied = copied; break;
      }
      if (!o) { out.push({ category: c.name, skipped: `${story.title}: ${why}` }); continue; }

      // The apply link must really be a link on the page; otherwise send readers to the source.
      const pageLinks = new Set(page.links.map((l) => l.href));
      const officialApply = Boolean(o.apply_url && pageLinks.has(o.apply_url));
      const apply = officialApply ? o.apply_url : page.url;
      if (knownUrls.has(apply) && officialApply) { out.push({ category: c.name, skipped: `already listed: ${o.title}` }); continue; }
      made = { story, page, o, apply, officialApply, vec: vecs[i] };
      break;
    }
    if (!made) continue;

    const { story, page, o, apply, officialApply } = made;
    const image = page.image || '';
    const fm = {
      title: o.title, category: c.name, organization: o.organization,
      deadline: o.deadline || '', location: o.location || '', type: o.type || OPPORTUNITY_TYPES[c.name] || 'Opportunity',
      image, organization_logo: '', og_image: image, apply_url: apply,
      source: story.source, source_url: page.url,
      draft: cfg.autopost.publish ? 'false' : 'true',
    };
    const md = '---\n' + Object.entries(fm).filter(([k, v]) => v !== '' || k === 'deadline').map(([k, v]) => `${k}: ${k === 'draft' ? v : yaml(v)}`).join('\n') + '\n---\n' + buildBody(o, { officialApply });
    const slug = slugify(o.title) || 'opportunity-' + Date.now();
    const path = `${DIR}/${slug}.md`;
    // Same title already listed (in any category) means the same opportunity: skip, never duplicate.
    try { await writeFile(env, { path, content: md }, 'autopost'); }
    catch { out.push({ category: c.name, skipped: `already listed: ${o.title}` }); continue; }
    fps.push({ path, v: round(made.vec) }); knownUrls.add(apply); knownUrls.add(page.url);
    out.push({ category: c.name, created: path, title: o.title, kind: 'opportunity', ai: true, deadline: o.deadline || 'none', official_apply: officialApply, score: story.score, copied: +o.copied.toFixed(2) });
  }
  await Promise.all([store(env).put(KEY_USED, JSON.stringify([...used].slice(-3000))), store(env).put(KEY_FP, JSON.stringify(fps.slice(-500)))]);
  return out;
}
