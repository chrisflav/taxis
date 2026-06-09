import Issues.Db.Connection

/-!
# Schema and migrations

The schema is applied idempotently (`CREATE TABLE IF NOT EXISTS`) and versioned through a
`schema_version` table so it can evolve without manual database edits. Foreign keys carry
`ON DELETE CASCADE` so deleting an issue/actor/group cleans up its join rows. Every foreign-key
column is indexed to keep graph and assignment queries fast.

Full-text search is done with `LIKE` because the bundled SQLite amalgamation is built without
the FTS5 extension.
-/

namespace Issues.Db

/-- The schema version this build expects. -/
def schemaVersion : Int64 := 5

/-- The complete DDL, safe to run repeatedly. -/
def schemaSql : String :=
  "
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

  CREATE TABLE IF NOT EXISTS actors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    google_sub TEXT UNIQUE,
    admin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS actor_groups (
    actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (actor_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_actor_groups_group ON actor_groups(group_id);

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'open',
    locked INTEGER NOT NULL DEFAULT 0,
    label TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#6b7280'
  );

  CREATE TABLE IF NOT EXISTS issue_labels (
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
  );
  CREATE INDEX IF NOT EXISTS idx_issue_labels_label ON issue_labels(label_id);

  CREATE TABLE IF NOT EXISTS issue_parents (
    child_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    parent_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    PRIMARY KEY (child_id, parent_id)
  );
  CREATE INDEX IF NOT EXISTS idx_issue_parents_parent ON issue_parents(parent_id);

  CREATE TABLE IF NOT EXISTS issue_assignees (
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, actor_id)
  );
  CREATE INDEX IF NOT EXISTS idx_issue_assignees_actor ON issue_assignees(actor_id);

  CREATE TABLE IF NOT EXISTS issue_visibility (
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, group_id)
  );
  CREATE INDEX IF NOT EXISTS idx_issue_visibility_group ON issue_visibility(group_id);

  CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT 'null'
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_issue ON artifacts(issue_id);

  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT 'null',
    status TEXT NOT NULL DEFAULT 'pending',
    detail TEXT,
    last_run INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_checks_issue ON checks(issue_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_actor ON sessions(actor_id);
  "

/-- A single-column row holding the stored schema version. -/
private structure VersionRow where
  version : Int64
deriving SQLite.Row, Inhabited

/-- Apply the schema and record its version. Idempotent, and applies incremental column
    additions to databases created by an older schema version. -/
def migrate (db : Conn) : IO Unit := do
  db.exec schemaSql
  -- Later versions added columns to existing tables. `CREATE TABLE IF NOT EXISTS` won't add a
  -- column to an existing table, so ensure them here; each `ALTER` errors harmlessly if the
  -- column already exists.
  try db.exec "ALTER TABLE labels ADD COLUMN color TEXT NOT NULL DEFAULT '#6b7280'" catch _ => pure ()
  try db.exec "ALTER TABLE issues ADD COLUMN locked INTEGER NOT NULL DEFAULT 0" catch _ => pure ()
  try db.exec "ALTER TABLE actors ADD COLUMN admin INTEGER NOT NULL DEFAULT 0" catch _ => pure ()
  let rows ← (← db query!"SELECT version FROM schema_version LIMIT 1" as VersionRow).toArray
  if rows.isEmpty then
    db exec!"INSERT INTO schema_version (version) VALUES ({schemaVersion})"
  else
    db exec!"UPDATE schema_version SET version = {schemaVersion}"

end Issues.Db
