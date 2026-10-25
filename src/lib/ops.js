const m = import.meta.glob('../content/opportunities/*.md', { eager: true });
export const ops = Object.entries(m).map(([f, x]) => ({ slug: f.split('/').pop().replace(/\.md$/, ''), ...x.frontmatter, deadline: new Date(x.frontmatter.deadline).toISOString().slice(0, 10), Content: x.Content }));
export const CC = { Tech: '#14b8a6', Scholarships: '#d9a441', Jobs: '#5b8def', Fellowships: '#d9627f', Other: '#8b7cf6' };
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
