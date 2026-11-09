// Turns the highest-priority fresh story in each blog category into a blog post that
// follows the site's post template. Writing is done by Cloudflare Workers AI; if that fails,
// a plain template post is used instead. Every story is used at most once.
import { writeFile } from './db.js';

const KEY_USED = 'autopost:used';
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

// Blog categories = the categories of the posts in D1 right now.
export async function blogCategories(env) {
  if (!env.DB) return [];
  const { results } = await env.DB.prepare("SELECT body FROM content WHERE path LIKE 'src/content/posts/%.md'").all();
  const cats = results.map((r) => (r.body.match(/^category:\s*["']?([^"'\n]+)["']?\s*$/m) || [])[1]).filter(Boolean).map((s) => s.trim());
  return [...new Set(cats)];
}

// The newest post in the category (or any post) gives the field names and default images.
async function templateFor(env, category) {
  const { results } = await env.DB.prepare("SELECT body FROM content WHERE path LIKE 'src/content/posts/%.md' ORDER BY updated_at DESC").all();
  const parsed = results.map((r) => {
    const fm = (r.body.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
    const f = {}; for (const m of fm.matchAll(/^([A-Za-z0-9_]+):\s?(.*)$/gm)) f[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    return f;
  });
  return parsed.find((f) => f.category === category) || parsed[0] || {};
}

const yaml = (v) => JSON.stringify(String(v ?? ''));

async function write(env, story, category) {
  const prompt = `Write a blog post for a Nigerian-focused tech, AI and careers blog, in category "${category}".
Base it ONLY on this news item. Do not invent facts, figures, quotes or dates not given here.
Headline: ${story.title}
Publisher: ${story.source}
Published: ${story.published}
Summary: ${story.summary || '(none provided)'}

First decide: is this story genuinely useful to readers interested in "${category}" (AI, automation, tech skills, careers)? If not (e.g. sports, gossip, unrelated meanings of the word), return {"skip": true}.
Otherwise return JSON only: {"title": "...", "description": "one sentence under 160 characters", "body": "markdown"}.
Body: 300-500 words. Open with one short intro paragraph, then an italic line on why it matters to readers, then 2-3 "## " sections (what happened, what it means, what to do next). Plain, friendly British English. No hype. Do not include the title in the body.`;
  const res = await env.AI.run(MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: 1400, temperature: 0.4 });
  const text = String(res?.response ?? '');
  const json = JSON.parse((text.match(/\{[\s\S]*\}/) || [])[0]);
  if (json?.skip) return { skip: true };
  if (!json?.title || !json?.body || json.body.length < 400) throw new Error('AI output too short');
  return json;
}

function fallback(story, category) {
  return {
    title: story.title,
    description: (story.summary || story.title).slice(0, 158),
    body: `${story.summary || story.title}\n\n*Here is a quick look at a story in ${category} that is worth knowing about.*\n\n## What happened\n\n${story.source} reported: **${story.title}**.\n\n## Read more\n\nThe full report is on ${story.source}.`,
  };
}

export async function autoPost(env, cfg, categories) {
  const out = [];
  if (!cfg.autopost?.enabled || !env.DB) return out;
  const blogCats = new Set(await blogCategories(env));
  const used = new Set((await env.NEWS.get(KEY_USED, 'json')) || []);
  // Posts made in the last 24h per category, so we never flood a category.
  const since = new Date(Date.now() - 864e5).toISOString();
  const { results: recent } = await env.DB.prepare("SELECT body FROM content WHERE path LIKE 'src/content/posts/%.md' AND updated_by = 'autopost' AND updated_at >= ?").bind(since).all();

  for (const c of Object.values(categories)) {
    if (!blogCats.has(c.name)) continue;
    const today = recent.filter((r) => r.body.includes(`category: ${c.name}`)).length;
    if (today >= cfg.autopost.perCategoryPerDay) { out.push({ category: c.name, skipped: 'daily limit reached' }); continue; }
    // Try the top candidates in priority order; the AI rejects off-topic ones (max 4 tries per category).
    let story, post, ai = true;
    for (const cand of c.items.filter((i) => !used.has(key(i.title)) && i.score >= cfg.autopost.minScore).slice(0, 4)) {
      used.add(key(cand.title));
      try {
        if (!env.AI) throw new Error('no AI binding');
        const r = await write(env, cand, c.name);
        if (r.skip) continue;
        story = cand; post = r; ai = true; break;
      } catch { story = cand; post = fallback(cand, c.name); ai = false; break; }
    }
    if (!story) { out.push({ category: c.name, skipped: 'no relevant high-priority story yet' }); continue; }

    const tpl = await templateFor(env, c.name);
    const image = story.image || tpl.image || '';
    const fm = {
      title: post.title, date: new Date().toISOString(), category: c.name,
      image, og_image: story.image || tpl.og_image || image,
      description: post.description,
      source: story.source, source_url: story.link,
      draft: cfg.autopost.publish ? 'false' : 'true',
    };
    const body = `${post.body.trim()}\n\n---\n\n*Source: [${story.source}](${story.link})*\n`;
    const md = '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${k === 'draft' ? v : yaml(v)}`).join('\n') + '\n---\n' + body;
    const slug = slugify(post.title) || 'post-' + Date.now();
    let path = `src/content/posts/${slug}.md`;
    try { await writeFile(env, { path, content: md }, 'autopost'); }
    catch { path = `src/content/posts/${slug}-${Date.now().toString(36)}.md`; await writeFile(env, { path, content: md }, 'autopost'); }
    out.push({ category: c.name, created: path, title: post.title, ai, score: story.score });
  }
  await env.NEWS.put(KEY_USED, JSON.stringify([...used].slice(-3000)));
  return out;
}
