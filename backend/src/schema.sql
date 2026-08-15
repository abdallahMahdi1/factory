-- Factory time-tracking system — database schema (SQLite)
-- Kept as plain SQL (no ORM) so it has zero external network dependency
-- beyond the npm/GitHub-hosted better-sqlite3 driver itself.

CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id                 TEXT PRIMARY KEY,
  name               TEXT UNIQUE NOT NULL,
  code               TEXT UNIQUE NOT NULL,
  api_key            TEXT UNIQUE NOT NULL,
  last_heartbeat_at  TEXT,
  last_synced_at     TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared master lists (Materials, Tools, Work Orders, ...) reused across machines.
CREATE TABLE IF NOT EXISTS option_lists (
  id   TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS option_items (
  id             TEXT PRIMARY KEY,
  option_list_id TEXT NOT NULL REFERENCES option_lists(id) ON DELETE CASCADE,
  value          TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1
);

-- A question on a given machine's Start or Stop form. Admin decides, per
-- machine: free text, a number, or a dropdown pulling from a shared option
-- list; which stage it's captured on; and an optional group_label used
-- purely to visually section the form (e.g. "Input", "Output", "Raw
-- Materials") — it has no effect on data, only on how the form is drawn.
CREATE TABLE IF NOT EXISTS machine_fields (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('text','number','select')),
  option_list_id TEXT REFERENCES option_lists(id),
  required       INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'start' CHECK (stage IN ('start','stop')),
  group_label    TEXT
);

CREATE TABLE IF NOT EXISTS operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  id_number  TEXT UNIQUE NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many: an operator can be authorized on several machines.
CREATE TABLE IF NOT EXISTS operator_machines (
  id          TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  UNIQUE(operator_id, machine_id)
);

CREATE TABLE IF NOT EXISTS pause_reasons (
  id     TEXT PRIMARY KEY,
  label  TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stop_reasons (
  id     TEXT PRIMARY KEY,
  label  TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- The actual time record. id is a UUID generated on the operator device
-- (so it can be created while offline) and reused verbatim here, which is
-- what makes re-sent sync batches safe to retry.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  machine_id          TEXT NOT NULL REFERENCES machines(id),
  operator_id         TEXT NOT NULL REFERENCES operators(id),
  field_values        TEXT NOT NULL, -- JSON: { [machineFieldId]: "text/number or option_item id" } — stage='start' fields, answered when the job begins
  stop_field_values    TEXT, -- JSON, same shape — stage='stop' fields, answered when the job ends (null until then)
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT NOT NULL DEFAULT 'running', -- running | paused | finished | incomplete
  stop_reason_id      TEXT REFERENCES stop_reasons(id),
  completion_note     TEXT,
  created_offline     INTEGER NOT NULL DEFAULT 0,
  synced_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pause_events (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  reason_id  TEXT REFERENCES pause_reasons(id),
  started_at TEXT NOT NULL,
  ended_at   TEXT
);

-- Audit trail: every manual admin correction to a session, never a silent overwrite.
CREATE TABLE IF NOT EXISTS session_edits (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  edited_by  TEXT NOT NULL,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  edited_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- De-duplication log for the sync endpoint. Every event a device sends
-- carries a client-generated event id; once processed it's recorded here,
-- so a retried batch (e.g. after a dropped connection) is never double-applied.
CREATE TABLE IF NOT EXISTS synced_events (
  id           TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
