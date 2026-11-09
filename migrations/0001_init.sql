-- Content: every post, opportunity, page, project and settings file is one row.
CREATE TABLE IF NOT EXISTS content (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT 'admin'
);
-- Audit log of every admin change.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  path TEXT NOT NULL,
  user TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at);
