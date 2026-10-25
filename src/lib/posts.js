const m = import.meta.glob('../content/posts/*.md', { eager: true });
export const posts = Object.entries(m).map(([f, x]) => ({ slug: f.split('/').pop().replace(/\.md$/, ''), ...x.frontmatter, Content: x.Content, mins: Math.max(1, Math.round(((x.rawContent && x.rawContent()) || '').split(/\s+/).length / 200)) })).sort((a, b) => new Date(b.date) - new Date(a.date));
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
