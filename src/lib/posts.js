const m = import.meta.glob('../content/posts/*.md', { eager: true });
const raw = import.meta.glob('../content/posts/*.md', { query: '?raw', import: 'default', eager: true });
const ex = (t) => String(t || '').replace(/^---[\s\S]*?---/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export const posts = Object.entries(m).map(([f, x]) => ({ slug: f.split('/').pop().replace(/\.md$/, ''), ...x.frontmatter, category: x.frontmatter.category || 'General', Content: x.Content, excerpt: ex(raw[f]), mins: Math.max(1, Math.round(((x.rawContent && x.rawContent()) || '').split(/\s+/).length / 200)) })).filter((p) => p.draft !== true && p.draft !== 'true').sort((a, b) => new Date(b.date) - new Date(a.date));
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const cats = [...new Map(posts.map((p) => [slugify(p.category), p.category])).entries()].map(([slug, name]) => ({ slug, name, count: posts.filter((p) => slugify(p.category) === slug).length }));
