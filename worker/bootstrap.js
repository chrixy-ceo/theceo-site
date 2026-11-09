// Makes sure the D1 database has its tables and content. On a brand-new database (first deploy)
// it creates the tables and loads the site's starting content, so no manual migration step is
// needed. Runs once per Worker instance; existing content is never overwritten.
import seed from './seed.json';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS content (path TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT 'admin')`,
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, path TEXT NOT NULL, user TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS activity_at ON activity (at)`,
];

let ready = null;

export function ensureDatabase(env) {
  if (!env.DB) return Promise.resolve();
  if (!ready) ready = setup(env).catch((e) => { ready = null; console.error('Database setup failed:', e?.message || e); });
  return ready;
}

async function setup(env) {
  const has = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content'").first();
  if (has) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM content').first();
    if (row?.n > 0) return;
  }
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  const now = new Date().toISOString();
  const insert = env.DB.prepare("INSERT OR IGNORE INTO content (path, body, version, updated_at, updated_by) VALUES (?, ?, 1, ?, 'seed')");
  for (let i = 0; i < seed.length; i += 50) await env.DB.batch(seed.slice(i, i + 50).map(([path, body]) => insert.bind(path, body, now)));
  console.log(`Database initialised with ${seed.length} items.`);
}
