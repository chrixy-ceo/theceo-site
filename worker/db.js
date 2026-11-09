// Content store on Cloudflare D1 (SQL). Every item is a row keyed by its path, e.g.
// "src/content/posts/my-post.md", so the admin keeps the same shape as before.
// Versions give optimistic locking (no silent overwrites). Every change is written to `activity`.
// Media files go to R2 (binding MEDIA) when it is set up, otherwise to Workers KV (binding FILES,
// created automatically on deploy). Either way they are served at /uploads/*.
import { HttpError } from './errors.js';
export { HttpError };

const ALLOWED = /^(src\/content|public\/uploads)\/[A-Za-z0-9 _\-.()À-ɏ\/]+$/;

export function safePath(p) {
  const path = String(p || '').replace(/^\/+/, '');
  if (!ALLOWED.test(path) || path.includes('..') || path.includes('//')) throw new HttpError(400, 'That path is not editable.');
  return path;
}

const isMedia = (p) => p.startsWith('public/uploads/');
const mediaKey = (p) => p.slice('public/uploads/'.length);

function files(env) {
  if (!env.FILES) throw new HttpError(503, 'File storage (binding FILES) is not connected.');
  return env.FILES;
}

function db(env) {
  if (!env.DB) throw new HttpError(503, 'The D1 database (binding DB) is not connected.');
  return env.DB;
}

async function log(env, action, path, user) {
  await db(env).prepare('INSERT INTO activity (action, path, user, at) VALUES (?, ?, ?, ?)').bind(action, path, user || 'admin', new Date().toISOString()).run();
}

export async function listDir(env, dir) {
  const raw = String(dir || '').replace(/^\/+|\/+$/g, '');
  const d = raw === 'public/uploads' ? raw : safePath(raw);
  if (isMedia(d + '/')) {
    const out = []; let cursor;
    if (env.MEDIA) {
      do { const r = await env.MEDIA.list({ cursor, limit: 1000 }); cursor = r.truncated ? r.cursor : null; out.push(...r.objects.map((o) => ({ key: o.key, size: o.size, sha: o.etag }))); } while (cursor);
    } else {
      const kv = files(env);
      do { const r = await kv.list({ cursor, limit: 1000 }); cursor = r.list_complete ? null : r.cursor; out.push(...r.keys.map((k) => ({ key: k.name, size: k.metadata?.size || 0, sha: 'kv' }))); } while (cursor);
    }
    return out.map((o) => ({ name: o.key, path: 'public/uploads/' + o.key, sha: o.sha, size: o.size, type: 'file' }));
  }
  const { results } = await db(env).prepare("SELECT path, version, length(body) AS size FROM content WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").bind(d + '/%', d + '/%/%').all();
  return results.map((r) => ({ name: r.path.split('/').pop(), path: r.path, sha: String(r.version), size: r.size, type: 'file' }));
}

// Every item in a folder with its content, in one query (used for admin lists and search).
export async function listItems(env, dir) {
  const d = safePath(dir).replace(/\/$/, '');
  const { results } = await db(env).prepare("SELECT path, body, version, updated_at, updated_by FROM content WHERE path LIKE ? AND path NOT LIKE ? ORDER BY path").bind(d + '/%', d + '/%/%').all();
  return results.map((r) => ({ name: r.path.split('/').pop(), path: r.path, sha: String(r.version), content: r.body, updated: r.updated_at, by: r.updated_by }));
}

export async function readFile(env, path) {
  const p = safePath(path);
  const row = await db(env).prepare('SELECT path, body, version FROM content WHERE path = ?').bind(p).first();
  if (!row) throw new HttpError(404, 'Not found.');
  return { path: row.path, sha: String(row.version), content: row.body };
}

export async function writeFile(env, { path, content, sha, base64 }, user) {
  const p = safePath(path);
  if (isMedia(p)) {
    const bytes = Uint8Array.from(atob(base64 || ''), (c) => c.charCodeAt(0));
    if (bytes.length > 8 * 1024 * 1024) throw new HttpError(413, 'Max file size is 8 MB.');
    const ext = p.split('.').pop().toLowerCase();
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', pdf: 'application/pdf' };
    if (!types[ext]) throw new HttpError(400, 'Only images and PDFs can be uploaded.');
    if (env.MEDIA) await env.MEDIA.put(mediaKey(p), bytes, { httpMetadata: { contentType: types[ext], cacheControl: 'public, max-age=31536000, immutable' } });
    else await files(env).put(mediaKey(p), bytes, { metadata: { type: types[ext], size: bytes.length } });
    await log(env, 'upload', p, user);
    return { path: p, sha: env.MEDIA ? 'r2' : 'kv' };
  }
  const body = String(content ?? '');
  if (body.length > 1024 * 1024) throw new HttpError(413, 'Content is too large.');
  if (p.endsWith('.json')) { try { JSON.parse(body); } catch { throw new HttpError(400, 'Invalid JSON.'); } }
  const now = new Date().toISOString();
  if (sha) {
    const r = await db(env).prepare('UPDATE content SET body = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE path = ? AND version = ?').bind(body, now, user || 'admin', p, Number(sha)).run();
    if (!r.meta.changes) throw new HttpError(409, 'This item changed since you opened it. Reload and try again.');
  } else {
    const r = await db(env).prepare('INSERT INTO content (path, body, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?) ON CONFLICT(path) DO NOTHING').bind(p, body, now, user || 'admin').run();
    if (!r.meta.changes) throw new HttpError(409, 'Something with this name already exists. Choose another name.');
  }
  await log(env, sha ? 'update' : 'create', p, user);
  const row = await db(env).prepare('SELECT version FROM content WHERE path = ?').bind(p).first();
  return { path: p, sha: String(row.version) };
}

export async function deleteFile(env, { path }, user) {
  const p = safePath(path);
  if (isMedia(p)) { if (env.MEDIA) await env.MEDIA.delete(mediaKey(p)); else await files(env).delete(mediaKey(p)); }
  else await db(env).prepare('DELETE FROM content WHERE path = ?').bind(p).run();
  await log(env, 'delete', p, user);
  return { ok: true };
}

export async function recentCommits(env) {
  const { results } = await db(env).prepare('SELECT id, action, path, user, at FROM activity ORDER BY id DESC LIMIT 50').all();
  return results.map((r) => ({ sha: '#' + r.id, message: `${r.action} ${r.path.replace(/^(src\/content|public)\//, '')}`, author: r.user, date: r.at }));
}

// Serves R2 uploads at /uploads/<key>; returns null so the caller can fall back to bundled files.
export async function serveMedia(env, key) {
  if (!key) return null;
  const h = new Headers({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' });
  let body;
  if (env.MEDIA) {
    const obj = await env.MEDIA.get(key);
    if (!obj) return null;
    obj.writeHttpMetadata(h); h.set('ETag', obj.httpEtag); body = obj.body;
  } else if (env.FILES) {
    const { value, metadata } = await env.FILES.getWithMetadata(key, 'stream');
    if (!value) return null;
    h.set('Content-Type', metadata?.type || 'application/octet-stream'); body = value;
  } else return null;
  if (h.get('Content-Type') === 'image/svg+xml') h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  return new Response(body, { headers: h });
}
