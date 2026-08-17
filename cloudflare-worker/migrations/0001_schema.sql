CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS workspace_backups_revision_idx
  ON workspace_backups(revision);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sent_notifications (
  notification_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_key TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_client_time_idx
  ON login_attempts(client_key, attempted_at);

INSERT OR IGNORE INTO workspace (id, revision, payload, updated_at)
VALUES (
  1,
  1,
  '{"version":"cloudflare-1","settings":{"monthly_goal":2},"projects":[],"tasks":[],"calendar_events":[],"checklists":[],"progress_logs":[],"project_messages":[],"history":[],"archives":[],"deleted_ids":{}}',
  '1970-01-01T00:00:00'
);
