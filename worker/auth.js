// Admin authentication: password login, HMAC-signed session cookie, brute-force lockout.
const COOKIE = 'ceo_admin';
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function secretOf(env) {
  // SESSION_SECRET is preferred; fall back to a value derived from the password so login still works.
  return env.SESSION_SECRET || ('pw:' + (env.ADMIN_PASSWORD || ''));
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secretOf(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Constant-time comparison (hash both sides so lengths match).
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a))), crypto.subtle.digest('SHA-256', enc.encode(String(b)))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export function authConfigured(env) {
  return Boolean(env.ADMIN_PASSWORD);
}

export async function createSession(env, user) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = b64url(enc.encode(JSON.stringify({ u: user, exp })));
  const sig = await hmac(env, payload);
  return `${COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/administrator; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearSession() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/administrator; Max-Age=0`;
}

export async function readSession(request, env) {
  if (!authConfigured(env)) return null;
  const m = (request.headers.get('Cookie') || '').match(new RegExp(COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  if (!(await safeEqual(sig, await hmac(env, payload)))) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function ipOf(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function login(request, env) {
  if (!authConfigured(env)) return { ok: false, status: 503, error: 'Admin is not set up. Add the ADMIN_PASSWORD secret in Cloudflare.' };
  const kv = env.NEWS;
  const lockKey = 'auth:fail:' + ipOf(request);
  const fails = kv ? Number((await kv.get(lockKey)) || 0) : 0;
  if (fails >= MAX_FAILS) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };

  let body = {};
  try { body = await request.json(); } catch {}
  const userOk = await safeEqual(body.username || '', env.ADMIN_USERNAME || 'admin');
  const passOk = await safeEqual(body.password || '', env.ADMIN_PASSWORD);
  if (!(userOk && passOk)) {
    if (kv) await kv.put(lockKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400)); // slow down guessing
    return { ok: false, status: 401, error: 'Wrong username or password.' };
  }
  if (kv && fails) await kv.delete(lockKey);
  return { ok: true, cookie: await createSession(env, body.username || 'admin') };
}

// Mutating requests must be same-origin and carry our custom header (blocks CSRF).
export function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return false;
  return request.headers.get('X-Admin') === '1';
}
