// Small key-value store on D1 for settings and status (auto-posting settings, run history,
// story memory, admin password, content version). D1 is consistent: what you save is what the
// next request reads. (Workers KV can serve an old copy for up to a minute, which made saved
// settings look like they had not saved.) Same API shape as KV: get(key, 'json'), put, delete.
let ensured = false;

async function ensure(env) {
  if (ensured) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)').run();
  ensured = true;
}

export function store(env) {
  return {
    async get(key, type) {
      if (!env.DB) return null;
      await ensure(env);
      const row = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first();
      if (!row) return null;
      if (type === 'json') { try { return JSON.parse(row.value); } catch { return null; } }
      return row.value;
    },
    async put(key, value) {
      if (!env.DB) return;
      await ensure(env);
      await env.DB.prepare('INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(key, typeof value === 'string' ? value : JSON.stringify(value), new Date().toISOString()).run();
    },
    async delete(key) {
      if (!env.DB) return;
      await ensure(env);
      await env.DB.prepare('DELETE FROM meta WHERE key = ?').bind(key).run();
    },
  };
}

// One-time copy of settings and memory saved in KV before this change, so nothing is lost.
const MIGRATE = ['news:config', 'news:runs', 'news:data', 'autopost:used', 'autopost:fingerprints', 'autopost:formats', 'autopost:fp:ops', 'auth:creds', 'auth:ver'];
export async function migrateFromKV(env) {
  if (!env.DB || !env.NEWS) return;
  const s = store(env);
  if (await s.get('meta:migrated')) return;
  for (const k of MIGRATE) {
    const v = await env.NEWS.get(k);
    if (v != null && (await s.get(k)) == null) await s.put(k, v);
  }
  await s.put('meta:migrated', new Date().toISOString());
}
