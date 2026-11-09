import { opportunityFiles } from './content.js';
const ex = (t) => String(t || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#>*_`~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
const iso = (d) => { const x = new Date(d); return isNaN(x) ? '' : x.toISOString().slice(0, 10); };

export function getOps() {
  return opportunityFiles.map(({ slug, fm, body }) => ({ slug, ...fm, deadline: iso(fm.deadline), body, excerpt: ex(body) })).filter((o) => o.title && o.draft !== true);
}
export const CC = { Tech: '#14b8a6', Scholarships: '#d9a441', Grants: '#e8763a', Jobs: '#5b8def', Fellowships: '#d9627f', Other: '#8b7cf6' };
export const fdate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
