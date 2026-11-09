// Serves the site, the /administrator CMS (content in D1, media in R2) and the hourly auto-post cron.
// Also keeps the old Decap editor's GitHub sign-in (/api/auth and /api/callback).
import adminHtml from './worker/admin.html';
import { login, readSession, clearSession, sameOrigin, authConfigured } from './worker/auth.js';
import { listDir, readFile, writeFile, deleteFile, recentCommits, serveMedia, HttpError } from './worker/db.js';
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
      if (p === '/api/auth') return startSignIn(url, env);
      if (p === '/api/callback') return finishSignIn(request, url, env);
      if (p.startsWith('/uploads/')) { const r = await serveMedia(env, decodeURIComponent(p.slice(9))); if (r) return r; }
      if (p === '/administrator' || p.startsWith('/administrator/')) return await admin(request, env, ctx, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e?.stack || e);
      return json({ error: status === 500 ? 'Something went wrong.' : e.message }, status);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNews(env, { trigger: 'cron' }));
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
  if (route === 'me') return json({ user: session?.u || null, configured: authConfigured(env), db: Boolean(env.DB), media: Boolean(env.MEDIA), kv: Boolean(env.NEWS) });
  if (!session) return json({ error: 'Please sign in.' }, 401);

  let body = {};
  if (m !== 'GET') { try { body = await request.json(); } catch {} }

  switch (`${m} ${route}`) {
    case 'GET list': return json(await listDir(env, url.searchParams.get('dir')));
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

function startSignIn(url, env) {
  if (!env.GITHUB_CLIENT_ID) return new Response('Editor sign-in is not set up yet.', { status: 500 });
  const state = crypto.randomUUID();
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', url.origin + '/api/callback');
  gh.searchParams.set('scope', 'repo,user');
  gh.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: gh.toString(), 'Set-Cookie': `oauth_state=${state}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600` } });
}

async function finishSignIn(request, url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const saved = ((request.headers.get('Cookie') || '').match(/oauth_state=([^;]+)/) || [])[1];
  if (!code || !state || state !== saved) return new Response('Sign-in failed. Please close this window and try again.', { status: 400 });
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const data = await r.json();
  const msg = data.access_token
    ? 'authorization:github:success:' + JSON.stringify({ token: data.access_token, provider: 'github' })
    : 'authorization:github:error:' + JSON.stringify({ error: data.error || 'unknown' });
  const safe = JSON.stringify(msg).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><p>Signing you in…</p><script>(function(){function r(e){window.opener.postMessage(${safe},e.origin);window.removeEventListener('message',r,false);}window.addEventListener('message',r,false);window.opener.postMessage('authorizing:github','*');})();</script>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Set-Cookie': 'oauth_state=; Max-Age=0; Path=/; Secure' } });
}
