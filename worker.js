// Serves the site, the /administrator CMS (content in D1, media in R2) and the hourly auto-post cron.
import adminHtml from './worker/admin.html';
import astro from './dist/_worker.js/index.js';
import { login, readSession, clearSession, sameOrigin, authConfigured } from './worker/auth.js';
import { listDir, listItems, readFile, writeFile, deleteFile, recentCommits, serveMedia, HttpError } from './worker/db.js';
import { ensureDatabase } from './worker/bootstrap.js';
import { runNews, newsStatus, getConfig, saveConfig } from './worker/news.js';

const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
};

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...SEC_HEADERS, ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      await ensureDatabase(env);
      if (p.startsWith('/uploads/')) { const r = await serveMedia(env, decodeURIComponent(p.slice(9))); if (r) return r; }
      if (p === '/administrator' || p.startsWith('/administrator/')) return await admin(request, env, ctx, url);
      if (p.startsWith('/uploads/')) return env.ASSETS.fetch(request);
      return astro.fetch(request, env, ctx); // public site, rendered live from D1
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e?.stack || e);
      return json({ error: status === 500 ? 'Something went wrong.' : e.message }, status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureDatabase(env).then(() => runNews(env, { trigger: 'cron' })));
  },
};

async function admin(request, env, ctx, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/administrator';
  const m = request.method;

  if (p === '/administrator') return new Response(adminHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8', ...SEC_HEADERS } });
  if (!p.startsWith('/administrator/api/')) return Response.redirect(url.origin + '/administrator', 302);

  const route = p.slice('/administrator/api/'.length);
  if (m !== 'GET' && !sameOrigin(request)) return json({ error: 'Blocked request.' }, 403);

  if (route === 'login' && m === 'POST') {
    const r = await login(request, env);
    return r.ok ? json({ ok: true }, 200, { 'Set-Cookie': r.cookie }) : json({ error: r.error }, r.status);
  }
  if (route === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearSession() });

  const session = await readSession(request, env);
  if (route === 'me') return json({ user: session?.u || null, configured: authConfigured(env), db: Boolean(env.DB), media: Boolean(env.MEDIA || env.FILES), kv: Boolean(env.NEWS) });
  if (!session) return json({ error: 'Please sign in.' }, 401);

  let body = {};
  if (m !== 'GET') { try { body = await request.json(); } catch {} }

  switch (`${m} ${route}`) {
    case 'GET list': return json(await listDir(env, url.searchParams.get('dir')));
    case 'GET items': return json(await listItems(env, url.searchParams.get('dir')));
    case 'GET file': return json(await readFile(env, url.searchParams.get('path')));
    case 'PUT file': return json(await writeFile(env, body, session.u));
    case 'DELETE file': return json(await deleteFile(env, body, session.u));
    case 'GET commits': return json(await recentCommits(env));
    case 'GET news/status': return json(await newsStatus(env));
    case 'GET news/config': return json(await getConfig(env));
    case 'PUT news/config': return json(await saveConfig(env, body));
    case 'POST news/run': return json(await runNews(env, { trigger: 'manual:' + session.u, force: true }));
  }
  return json({ error: 'Not found.' }, 404);
}
