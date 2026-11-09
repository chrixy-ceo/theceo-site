import { store } from './store.js';
// Admin authentication: password login, HMAC-signed session cookie, brute-force lockout,
// and password changes from the admin.
// The first password comes from the ADMIN_PASSWORD secret. Once changed in the admin, a salted
// PBKDF2 hash is stored in KV and used instead; the plain password is never stored.
// Every password change bumps a session version, which signs out all other devices.
const COOKIE = 'ceo_admin';
const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;
const KEY_CREDS = 'auth:creds';
const KEY_VER = 'auth:ver';
const ITER = 100000; // PBKDF2 iterations (the Workers maximum)
const MIN_LEN = 10;

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

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

async function pbkdf2(password, salt, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

async function storedCreds(env) {
  return env.DB ? await store(env).get(KEY_CREDS, 'json') : null;
}

async function sessionVersion(env) {
  return env.DB ? (await store(env).get(KEY_VER)) || '0' : '0';
}

export async function authConfigured(env) {
  return Boolean(env.ADMIN_PASSWORD || (await storedCreds(env)));
}

// Checks a username + password against the stored hash, or the Cloudflare secret if never changed.
async function checkCredentials(env, username, password) {
  const creds = await storedCreds(env);
  if (creds) {
    const [userOk, hash] = await Promise.all([safeEqual(username, creds.user), pbkdf2(password, unb64(creds.salt), creds.iter)]);
    return userOk && (await safeEqual(hash, creds.hash));
  }
  if (!env.ADMIN_PASSWORD) return false;
  const [userOk, passOk] = await Promise.all([safeEqual(username, env.ADMIN_USERNAME || 'admin'), safeEqual(password, env.ADMIN_PASSWORD)]);
  return userOk && passOk;
}

export async function currentUsername(env) {
  return (await storedCreds(env))?.user || env.ADMIN_USERNAME || 'admin';
}

export async function createSession(env, user) {
  const exp = Date.now() + SESSION_HOURS * 3600e3;
  const payload = b64url(enc.encode(JSON.stringify({ u: user, exp, v: await sessionVersion(env) })));
  const sig = await hmac(env, payload);
  return `${COOKIE}=${payload}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/administrator; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearSession() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/administrator; Max-Age=0`;
}

export async function readSession(request, env) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(COOKIE + '=([^;]+)'));
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  if (!(await safeEqual(sig, await hmac(env, payload)))) return null;
  try {
    const data = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!(data.exp > Date.now())) return null;
    if (String(data.v ?? '0') !== (await sessionVersion(env))) return null; // signed out by a password change
    return data;
  } catch {
    return null;
  }
}

function ipOf(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function login(request, env) {
  if (!(await authConfigured(env))) return { ok: false, status: 503, error: 'Admin is not set up. Add the ADMIN_PASSWORD secret in Cloudflare.' };
  const kv = env.NEWS;
  const lockKey = 'auth:fail:' + ipOf(request);
  const fails = kv ? Number((await kv.get(lockKey)) || 0) : 0;
  if (fails >= MAX_FAILS) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };

  let body = {};
  try { body = await request.json(); } catch {}
  const username = String(body.username || '').trim();
  if (!(await checkCredentials(env, username, String(body.password || '')))) {
    if (kv) await kv.put(lockKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 400)); // slow down guessing
    return { ok: false, status: 401, error: 'Wrong username or password.' };
  }
  if (kv && fails) await kv.delete(lockKey);
  return { ok: true, cookie: await createSession(env, username) };
}

// Change username and/or password. Requires the current password; signs out every other device
// and returns a fresh session cookie for this one.
export async function changePassword(request, env, session, body = {}) {
  if (!env.DB) return { ok: false, status: 503, error: 'The database is not connected.' };
  const current = String(body.current || '');
  const next = String(body.password || '');
  const user = String(body.username || session.u || '').trim();

  const lockKey = 'auth:fail:' + ipOf(request);
  const fails = env.NEWS ? Number((await env.NEWS.get(lockKey)) || 0) : 0;
  if (fails >= MAX_FAILS) return { ok: false, status: 429, error: 'Too many attempts. Try again in 15 minutes.' };
  if (!(await checkCredentials(env, await currentUsername(env), current))) {
    if (env.NEWS) await env.NEWS.put(lockKey, String(fails + 1), { expirationTtl: LOCK_SECONDS });
    return { ok: false, status: 400, error: 'Your current password is not correct.' };
  }
  if (!/^[A-Za-z0-9._@-]{3,40}$/.test(user)) return { ok: false, status: 400, error: 'Username: 3–40 letters, numbers, dots, dashes or @.' };
  if (next.length < MIN_LEN) return { ok: false, status: 400, error: `The new password must be at least ${MIN_LEN} characters.` };
  if (next === current && user === session.u) return { ok: false, status: 400, error: 'The new password is the same as the current one.' };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  await store(env).put(KEY_CREDS, JSON.stringify({ user, salt: b64(salt), iter: ITER, hash: await pbkdf2(next, salt), changed: new Date().toISOString() }));
  await store(env).put(KEY_VER, String(Date.now())); // invalidates all existing sessions
  return { ok: true, cookie: await createSession(env, user) };
}

export async function accountInfo(env) {
  const creds = await storedCreds(env);
  return { username: await currentUsername(env), changed: creds?.changed || null, source: creds ? 'admin' : 'cloudflare-secret' };
}

// Mutating requests must be same-origin and carry our custom header (blocks CSRF).
export function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return false;
  return request.headers.get('X-Admin') === '1';
}
