import { postFiles } from './content.js';
const ex = (t) => String(t || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Rebuilt from the live content on every call (cheap: a few dozen items).
export function getPosts() {
  return postFiles
    .map(({ slug, fm, body }) => ({ slug, ...fm, category: fm.category || 'General', body, excerpt: fm.description || ex(body), mins: Math.max(1, Math.round(body.split(/\s+/).length / 200)) }))
    .filter((p) => p.draft !== true && p.draft !== 'true' && p.title)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
export function getCats(posts = getPosts()) {
  return [...new Map(posts.map((p) => [slugify(p.category), p.category])).entries()].map(([slug, name]) => ({ slug, name, count: posts.filter((p) => slugify(p.category) === slug).length }));
}
