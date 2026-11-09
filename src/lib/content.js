// Live content layer. Cloudflare D1 is the only source of content: every request loads it
// with one query, so admin edits and auto-posts show immediately. If D1 has a momentary
// failure, the last good copy held in memory is served instead.
// Values are exported as live bindings: pages read them while rendering, after middleware refreshed them.
import yaml from 'js-yaml';
import { marked } from 'marked';

export let settings = {};
export let site = {};
export let about = {};
export let services = [];
export let stack = [];
export let projects = [];
export let certifications = [];
export let experience = [];
export let pages = [];
export let postFiles = [];
export let opportunityFiles = [];
export let source = 'none';

let lastKey = '';

function parseMd(path, text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  let fm = {};
  if (m) { try { fm = yaml.load(m[1]) || {}; } catch (e) { console.error('Bad front matter in', path, e.message); } }
  return { slug: path.split('/').pop().replace(/\.md$/, ''), fm, body: m ? m[2] : String(text) };
}
const parseJson = (path, text) => { try { return JSON.parse(text); } catch { console.error('Bad JSON in', path); return null; } };

function apply(entries, from) {
  const files = new Map(entries);
  const key = from + ':' + [...files.entries()].map(([k, v]) => k + v.length).join('|');
  if (key === lastKey) return; // nothing changed since the last request
  lastKey = key;
  const one = (name, fallback) => (files.has('content/' + name) ? parseJson(name, files.get('content/' + name)) ?? fallback : fallback);
  const dir = (d, ext) => [...files.entries()].filter(([k]) => k.startsWith('content/' + d + '/') && k.endsWith(ext) && k.split('/').length === 3).sort(([a], [b]) => a.localeCompare(b));
  settings = one('settings.json', {});
  site = one('site.json', {});
  about = one('about.json', {});
  services = one('services.json', []);
  stack = one('stack.json', []);
  const jsonDir = (d) => dir(d, '.json').map(([k, v]) => ({ ...(parseJson(k, v) || {}), slug: k.split('/').pop().replace(/\.json$/, '') }));
  projects = jsonDir('projects');
  certifications = jsonDir('certifications');
  experience = jsonDir('experience');
  pages = dir('pages', '.md').map(([k, v]) => parseMd(k, v));
  postFiles = dir('posts', '.md').map(([k, v]) => parseMd(k, v));
  opportunityFiles = dir('opportunities', '.md').map(([k, v]) => parseMd(k, v));
  source = from;
}

export async function loadContent(env) {
  if (!env?.DB) throw new Error('D1 binding DB is missing.');
  try {
    const { results } = await env.DB.prepare("SELECT path, body FROM content WHERE path LIKE 'src/content/%'").all();
    if (!results.length) throw new Error('D1 has no content yet. Run the migrations.');
    apply(results.map((r) => [r.path.replace(/^src\//, ''), r.body]), 'd1');
  } catch (e) {
    console.error('Content load failed:', e.message);
    if (source !== 'd1') throw e; // nothing good in memory yet
  }
}

marked.setOptions({ gfm: true, breaks: false });
export const renderMarkdown = (text) => marked.parse(String(text || ''));

