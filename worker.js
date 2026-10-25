// Serves the site and handles the content editor's GitHub sign-in (/api/auth and /api/callback).
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/auth') return startSignIn(url, env);
    if (url.pathname === '/api/callback') return finishSignIn(request, url, env);
    return env.ASSETS.fetch(request);
  },
};

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
