// Live sitemap built from D1 content, so new posts are discoverable straight away.
import { getPosts, getCats } from '../lib/posts.js';
import { getOps } from '../lib/ops.js';
import { pages, projects } from '../lib/content.js';

export function GET() {
  const O = 'https://theceo.dev';
  const posts = getPosts();
  const urls = [
    ['/', null], ['/blog/', posts[0]?.date], ['/infobytes/', null],
    ...pages.map((p) => [`/${p.slug}/`, p.fm.updated]),
    ...posts.map((p) => [`/blog/${p.slug}/`, p.date]),
    ...getCats(posts).map((c) => [`/blog/category/${c.slug}/`, null]),
    ...getOps().map((o) => [`/infobytes/${o.slug}/`, null]),
    ...projects.map((p) => [`/projects/${p.slug}/`, p.date]),
  ];
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lm = (d) => { const x = new Date(d); return d && !isNaN(x) ? `<lastmod>${x.toISOString().slice(0, 10)}</lastmod>` : ''; };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([u, d]) => `<url><loc>${esc(O + u)}</loc>${lm(d)}</url>`).join('')}</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, s-maxage=600' } });
}
