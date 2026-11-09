// Makes sure the D1 database has its tables and content. On a brand-new database (first deploy)
// it creates the tables and loads the site's starting content, so no manual migration step is
// needed. Runs once per Worker instance; existing content is never overwritten.
import seed from './seed.json';
import { store, migrateFromKV } from './store.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS content (path TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'admin')`,
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, path TEXT NOT NULL, user TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS activity_at ON activity (at)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];

let ready = null;
const KEY_READY = 'db:ready:v2';

export function ensureDatabase(env) {
  if (!env.DB) return Promise.resolve();
  if (!ready) ready = (async () => {
    if (env.NEWS && (await env.NEWS.get(KEY_READY, { cacheTtl: 3600 }))) return;
    await setup(env);
    if (env.NEWS) await env.NEWS.put(KEY_READY, '1');
  })().catch((e) => { ready = null; console.error('Database setup failed:', e?.message || e); });
  return ready;
}

async function setup(env) {
  const has = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content'").first();
  if (has) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM content').first();
    if (row?.n > 0) { await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))); await migrateFromKV(env); return; }
  }
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  const now = new Date().toISOString();
  const insert = env.DB.prepare("INSERT OR IGNORE INTO content (path, body, version, updated_at, updated_by) VALUES (?, ?, 1, ?, 'seed')");
  for (let i = 0; i < seed.length; i += 50) await env.DB.batch(seed.slice(i, i + 50).map(([path, body]) => insert.bind(path, body, now)));
  console.log(`Database initialised with ${seed.length} items.`);
  await store(env).put('content:ver', String(Date.now()));
  await migrateFromKV(env);
}
