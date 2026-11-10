// Turns the highest-priority fresh story in each blog category into an original blog post that
// follows the site's post template. Everything runs on Cloudflare Workers AI:
//   1. Meaning-based de-duplication: each story gets an embedding ("meaning fingerprint") and is
//      skipped if it is about the same thing as anything posted in the last 30 days.
//   2. Varied writing: the post format rotates (explainer, list, how-to, quick take, Q&A) and the
//      writer is shown the blog's own human-written posts as style examples.
//   3. Originality check: drafts that reuse the source's phrasing, or read too much like an
//      existing post, are rewritten once and dropped if still too close.
// Every story is considered at most once. Posts are drafts unless auto-publish is switched on.
import { writeFile } from './db.js';
import { store } from './store.js';
import { autoOpportunities } from './infobytes.js';
import { aiRun, aiUsage, DAILY_BUDGET } from './ai.js';

const KEY_USED = 'autopost:used';
const KEY_FP = 'autopost:fingerprints';
const KEY_FMT = 'autopost:formats';
const WRITER = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const EMBED = '@cf/baai/bge-base-en-v1.5';
const SAME_STORY = 0.86;    // story vs. past posts: at or above = same story, skip
const SAME_POST = 0.93;     // draft vs. past posts: at or above = reads like a duplicate
const MAX_COPIED = 0.2;     // share of the source's 5-word phrases allowed in the draft
const FP_DAYS = 30;

const FORMATS = {
  explainer: 'An explainer. Short intro paragraph, then an italic line on why it matters, then 2-3 "## " sections that explain what happened, what it means and what to do next.',
  list: 'A "things to know" list post. One-paragraph intro, then a numbered list of 4-6 key points, each with a bold lead-in and 1-2 sentences, then a short "## The bottom line" section.',
  howto: 'A practical how-to angle. Intro that frames the opportunity or problem, then "## " steps or tips readers can act on this week, grounded in the story, then a one-line closing tip in italics.',
  take: 'A quick take / opinion-style piece in first person plural ("we"). Hook paragraph, then "## What we think" and "## Who should pay attention" sections. Keep claims tied to the facts given.',
  qa: 'A Q&A. Intro paragraph, then 4-5 "### " questions a curious reader would ask, each answered in 2-3 sentences using only the facts given.',
};

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
const yaml = (v) => JSON.stringify(String(v ?? ''));
const fmOf = (body) => { const fm = (body.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || ''; const f = {}; for (const m of fm.matchAll(/^([A-Za-z0-9_]+):\s?(.*)$/gm)) f[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); return f; };
const bodyOf = (md) => md.replace(/^---[\s\S]*?---\r?\n?/, '');
const plain = (t) => String(t || '').replace(/[#>*_`~\[\]()!]+/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x * y) || 1);
}

async function embed(env, texts) {
  const r = await aiRun(env, EMBED, { text: texts.map((t) => plain(t).slice(0, 2000)) });
  return r.data;
}

// Share of the source's 5-word phrases that appear word-for-word in the draft.
function copiedShare(source, draft) {
  const grams = (t) => { const w = plain(t).toLowerCase().split(' ').filter(Boolean); const g = new Set(); for (let i = 0; i + 5 <= w.length; i++) g.add(w.slice(i, i + 5).join(' ')); return g; };
  const s = grams(source), d = grams(draft);
  if (!s.size) return 0;
  let hit = 0; for (const g of s) if (d.has(g)) hit++;
  return hit / s.size;
}

// Blog categories = the categories of the posts in D1 right now.
export async function blogCategories(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare("SELECT body FROM content WHERE path LIKE 'src/content/posts/%.md'").all();
  return [...new Set(results.map((r) => fmOf(r.body).category).filter(Boolean))];
}

async function allPosts(env) {
  const { results } = await env.DB.prepare("SELECT path, body, updated_by, updated_at FROM content WHERE path LIKE 'src/content/posts/%.md' ORDER BY updated_at DESC").all();
  return results.map((r) => ({ ...r, fm: fmOf(r.body), text: bodyOf(r.body) }));
}

// Fingerprints of recent posts, kept in KV. Built from existing posts on first use.
async function loadFingerprints(env, posts) {
  const cutoff = Date.now() - FP_DAYS * 864e5;
  let fps = ((await store(env).get(KEY_FP, 'json')) || []).filter((f) => f.at >= cutoff);
  const known = new Set(fps.map((f) => f.path));
  const missing = posts.filter((p) => !known.has(p.path)).slice(0, 40);
  if (missing.length) {
    const vecs = await embed(env, missing.map((p) => `${p.fm.title}. ${p.fm.description || ''} ${p.text.slice(0, 1200)}`));
    missing.forEach((p, i) => fps.push({ path: p.path, at: Date.now(), v: vecs[i].map((x) => Math.round(x * 1e4) / 1e4) }));
  }
  return fps;
}

async function write(env, { story, category, format, examples, retryNote }) {
  const prompt = `You write for a Nigerian-focused blog about AI, automation, tech skills and careers. Category: "${category}".
Here is how the blog's own posts read (match this voice, not the structure):
${examples || '(no examples)'}

News item (the ONLY facts you may use; never invent figures, quotes, names or dates):
Headline: ${story.title}
Publisher: ${story.source}
Published: ${story.published}
Summary: ${story.summary || '(none provided)'}

First decide: is this genuinely useful to readers interested in "${category}"? If not (sports, gossip, celebrity, unrelated meanings of the word), return {"skip": true}.
Otherwise write an ORIGINAL post in your own words. Do not reuse sentences or phrases from the headline or summary. Give it a fresh, specific title (not the source headline).
Format: ${FORMATS[format]}
Length: 350-550 words. Plain, warm British English. No hype, no clichés like "in today's fast-paced world". Do not repeat the title in the body. End by telling readers what to watch for or do next.${retryNote ? '\n\nIMPORTANT: ' + retryNote : ''}
Return JSON only: {"title": "...", "description": "one sentence under 160 characters", "body": "markdown"}`;
  const res = await aiRun(env, WRITER, { messages: [{ role: 'user', content: prompt }], max_tokens: 1600, temperature: 0.7 });
  const json = JSON.parse((String(res?.response ?? '').match(/\{[\s\S]*\}/) || [])[0]);
  if (json?.skip) return { skip: true };
  if (!json?.title || !json?.body || json.body.length < 600) throw new Error('AI output too short');
  return json;
}

// Dispatcher: Infobytes opportunities, blog articles, or both (admin setting).
export async function autoPost(env, cfg, categories, budget) {
  if (!cfg.autopost?.enabled || !env.DB) return [];
  const target = cfg.autopost.target || 'infobytes';
  const out = [];
  if (target !== 'blog') out.push(...await autoOpportunities(env, cfg, categories, budget));
  if (target !== 'infobytes') out.push(...await autoBlog(env, cfg, categories));
  return out;
}

async function autoBlog(env, cfg, categories) {
  const out = [];
  if (!env.AI) return [{ skipped: 'Workers AI is not connected, so no posts were written' }];

  const posts = await allPosts(env);
  const blogCats = new Set(posts.map((p) => p.fm.category).filter(Boolean));
  const used = new Set((await store(env).get(KEY_USED, 'json')) || []);
  const lastFormats = (await store(env).get(KEY_FMT, 'json')) || {};
  const fps = await loadFingerprints(env, posts);
  const since = Date.now() - 864e5;
  // Style examples: the newest human-written posts (never auto-posts, to avoid drifting).
  const examples = posts.filter((p) => p.updated_by !== 'autopost' && p.text.length > 400).slice(0, 2).map((p, i) => `Example ${i + 1}: "${p.fm.title}"\n${p.text.slice(0, 700)}…`).join('\n\n');

  for (const c of Object.values(categories)) {
    if (!blogCats.has(c.name)) continue;
    const today = posts.filter((p) => p.updated_by === 'autopost' && p.fm.category === c.name && new Date(p.updated_at).getTime() >= since).length;
    if (today >= cfg.autopost.perCategoryPerDay) { out.push({ category: c.name, skipped: 'daily limit reached' }); continue; }

    const candidates = c.items.filter((i) => !used.has(key(i.title)) && i.score >= cfg.autopost.minScore).slice(0, 5);
    if (!candidates.length) { out.push({ category: c.name, skipped: 'no fresh high-priority story' }); continue; }

    // 1. Drop stories we have effectively covered already (same meaning, any wording).
    const vecs = await embed(env, candidates.map((s) => `${s.title}. ${s.summary || ''}`));
    const fresh = [];
    candidates.forEach((s, i) => {
      used.add(key(s.title));
      const best = fps.reduce((m, f) => Math.max(m, cosine(vecs[i], f.v)), 0);
      if (best >= SAME_STORY) out.push({ category: c.name, skipped: 'already covered: ' + s.title, similarity: +best.toFixed(3) });
      else fresh.push({ s, v: vecs[i] });
    });

    // 2 + 3. Write in a rotating format, then check originality.
    const order = Object.keys(FORMATS);
    const format = order[(order.indexOf(lastFormats[c.name]) + 1) % order.length];
    let made = null;
    for (const { s: story, v: storyVec } of fresh.slice(0, 3)) {
      let note = '', post = null, why = '';
      for (let attempt = 0; attempt < 2 && !post; attempt++) {
        let draft;
        try { draft = await write(env, { story, category: c.name, format, examples, retryNote: note }); } catch (e) { why = 'writer failed: ' + e.message; break; }
        if (draft.skip) { why = 'off-topic'; break; }
        const copied = copiedShare(`${story.title} ${story.summary || ''}`, draft.body + ' ' + draft.title);
        const [dv] = await embed(env, [`${draft.title}. ${draft.description} ${draft.body.slice(0, 1200)}`]);
        const closest = fps.reduce((m, f) => Math.max(m, cosine(dv, f.v)), 0);
        if (copied > MAX_COPIED) { note = 'Your last draft reused the source wording. Rewrite every sentence in your own words.'; why = `too close to source (${Math.round(copied * 100)}% phrases reused)`; continue; }
        if (closest >= SAME_POST) { note = 'Your last draft read too much like an existing post on this blog. Take a clearly different angle and structure.'; why = `too similar to an existing post (${closest.toFixed(2)})`; continue; }
        post = { ...draft, copied, closest, vec: dv };
      }
      if (!post) { out.push({ category: c.name, skipped: `${story.title}: ${why}` }); continue; }
      made = { story, post, storyVec };
      break;
    }
    if (!made) continue;

    const { story, post } = made;
    const tpl = posts.find((p) => p.fm.category === c.name)?.fm || posts[0]?.fm || {};
    const image = story.image || tpl.image || '';
    const fm = {
      title: post.title, date: new Date().toISOString(), category: c.name,
      image, og_image: story.image || tpl.og_image || image,
      description: post.description,
      source: story.source, source_url: story.link,
      draft: cfg.autopost.publish ? 'false' : 'true',
    };
    const body = `${post.body.trim()}\n\n---\n\n*Based on reporting by [${story.source}](${story.link}).*\n`;
    const md = '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${k === 'draft' ? v : yaml(v)}`).join('\n') + '\n---\n' + body;
    const slug = slugify(post.title) || 'post-' + Date.now();
    let path = `src/content/posts/${slug}.md`;
    try { await writeFile(env, { path, content: md }, 'autopost'); }
    catch { path = `src/content/posts/${slug}-${Date.now().toString(36)}.md`; await writeFile(env, { path, content: md }, 'autopost'); }

    fps.push({ path, at: Date.now(), v: post.vec.map((x) => Math.round(x * 1e4) / 1e4) });
    lastFormats[c.name] = format;
    out.push({ category: c.name, created: path, title: post.title, ai: true, format, score: story.score, copied: +post.copied.toFixed(2), closest: +post.closest.toFixed(2) });
  }

  await Promise.all([
    store(env).put(KEY_USED, JSON.stringify([...used].slice(-3000))),
    store(env).put(KEY_FP, JSON.stringify(fps.slice(-400))),
    store(env).put(KEY_FMT, JSON.stringify(lastFormats)),
  ]);
  return out;
}

// Quick health check for the AI writer and the duplicate checker (used by the admin's Test button).
export async function testAI(env) {
  if (!env.AI) return { ok: false, error: 'Workers AI is not connected to this Worker.' };
  if ((await aiUsage(env)) >= DAILY_BUDGET) return { ok: false, error: `Today's free AI budget is used up (${DAILY_BUDGET} of 10,000 neurons). It resets at midnight UTC (1am in Nigeria).` };
  const t = Date.now();
  try {
    const r = await aiRun(env, WRITER, { messages: [{ role: 'user', content: 'Reply with exactly: ready' }], max_tokens: 10 });
    const e = await aiRun(env, EMBED, { text: ['test'] });
    const reply = String(r?.response || '').trim();
    if (!reply) throw new Error('The writer returned an empty reply.');
    if (!e?.data?.[0]?.length) throw new Error('The duplicate checker returned no data.');
    return { ok: true, ms: Date.now() - t, reply: reply.slice(0, 40), used: Math.round(await aiUsage(env)), budget: DAILY_BUDGET };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, error: String(err?.message || err) };
  }
}
