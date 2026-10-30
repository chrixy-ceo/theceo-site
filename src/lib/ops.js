const m = import.meta.glob('../content/opportunities/*.md', { eager: true });
const raw = import.meta.glob('../content/opportunities/*.md', { query: '?raw', import: 'default', eager: true });
const ex = (t) => String(t || '').replace(/^---[\s\S]*?---/, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

export const ops = Object.entries(m).map(([f, x]) => ({ slug: f.split('/').pop().replace(/\.md$/, ''), ...x.frontmatter, deadline: new Date(x.frontmatter.deadline).toISOString().slice(0, 10), Content: x.Content, excerpt: ex(raw[f]) }));
export const CC = { Tech: '#14b8a6', Scholarships: '#d9a441', Grants: '#e8763a', Jobs: '#5b8def', Fellowships: '#d9627f', Other: '#8b7cf6' };
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
