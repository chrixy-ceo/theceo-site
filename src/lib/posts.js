const m = import.meta.glob('../content/posts/*.md', { eager: true });
const raw = import.meta.glob('../content/posts/*.md', { query: '?raw', import: 'default', eager: true });
const ex = (t) => String(t || '').replace(/^---[\s\S]*?---/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export const posts = Object.entries(m).map(([f, x]) => ({ slug: f.split('/').pop().replace(/\.md$/, ''), ...x.frontmatter, Content: x.Content, excerpt: ex(raw[f]), mins: Math.max(1, Math.round(((x.rawContent && x.rawContent()) || '').split(/\s+/).length / 200)) })).sort((a, b) => new Date(b.date) - new Date(a.date));
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
