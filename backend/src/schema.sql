-- Factory time-tracking system — database schema (SQLite)
-- Kept as plain SQL (no ORM) so it has zero external network dependency
-- beyond the npm/GitHub-hosted better-sqlite3 driver itself.

CREATE TABLE IF NOT EXISTS admins (
  id            TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Global, system-wide settings. Single row (id = 1) rather than a
-- key/value table: there are only a handful of settings, they're always
-- read together, and one row means no risk of a half-configured system.
CREATE TABLE IF NOT EXISTS settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- IANA zone, e.g. "Asia/Riyadh". Everything the operator and supervisor
  -- see (shift boundaries, report days, clock times) is computed in this
  -- zone rather than the server's, which on a cloud host is usually UTC.
  timezone           TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  -- Local clock times, "HH:MM". A session belongs to the day shift if it
  -- started at/after day_shift_start and before night_shift_start.
  day_shift_start    TEXT NOT NULL DEFAULT '06:00',
  night_shift_start  TEXT NOT NULL DEFAULT '18:00',
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

-- Every operator sign-in and sign-out on a machine, so a supervisor can
-- see who was at which machine and whether they arrived and left on time.
CREATE TABLE IF NOT EXISTS operator_attendance (
  id           TEXT PRIMARY KEY,
  operator_id  TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  machine_id   TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  signed_in_at  TEXT NOT NULL,
  signed_out_at TEXT,
  shift        TEXT,   -- 'day' | 'night', resolved from signed_in_at
  synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Scrap recorded by an operator when finishing their shift. Tied to the
-- attendance row rather than to a session, because scrap is weighed at
-- end of shift across whatever was run, not per individual job.
CREATE TABLE IF NOT EXISTS shift_scrap (
  id             TEXT PRIMARY KEY,
  attendance_id  TEXT NOT NULL REFERENCES operator_attendance(id) ON DELETE CASCADE,
  material_id    TEXT,          -- option_items.id when picked from the list
  material_label TEXT NOT NULL, -- resolved label, kept so history survives list edits
  kg             REAL NOT NULL,
  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id                 TEXT PRIMARY KEY,
  name               TEXT UNIQUE NOT NULL,
  code               TEXT UNIQUE NOT NULL,
  api_key            TEXT UNIQUE NOT NULL,
  last_heartbeat_at  TEXT,
  last_synced_at     TEXT,
  -- Bumped when a supervisor publishes a queue change that actually
  -- affects the top of the list. The operator app compares this against
  -- the version it last acknowledged to decide whether to show the
  -- "Please Check - Plan Change" alert.
  plan_version       INTEGER NOT NULL DEFAULT 0,
  plan_changed_at    TEXT,
  -- Snapshot of the top work orders at the moment of the last publish, so
  -- the next publish can tell whether anything meaningful actually changed
  -- rather than alerting operators every time the button is pressed.
  plan_snapshot      TEXT,
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

-- A column on one of a machine's data tables. Admin decides, per machine:
-- free text, a number, or a dropdown pulling from a shared option list;
-- WHICH SCREEN (table) it appears on; and an optional group_label used
-- purely to visually section that table.
--
-- `stage` is the screen key. "start" and "stop" are the two built-in
-- screens (shown as Input and Output), but a machine can define any others
-- it needs — "scrap", "toolings", "raw-materials" — and each becomes its
-- own table in the operator app. Deliberately NOT constrained to a fixed
-- set: the whole point is that a factory defines its own screens.
CREATE TABLE IF NOT EXISTS machine_fields (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('text','number','select')),
  option_list_id TEXT REFERENCES option_lists(id),
  required       INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'start',
  group_label    TEXT
);

-- The screens (tables) a machine shows in the operator app, and in what
-- order. "start" and "stop" always exist implicitly; rows here let a
-- machine rename them ("Input" -> "Raw Material In") and add its own.
CREATE TABLE IF NOT EXISTS machine_screens (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,   -- stable id used by machine_fields.stage
  label       TEXT NOT NULL,   -- what the operator sees, e.g. "Scrap"
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(machine_id, key)
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
  code   TEXT UNIQUE,
  label  TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stop_reasons (
  id     TEXT PRIMARY KEY,
  code   TEXT UNIQUE,
  label  TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- A job planned by a supervisor for a specific machine, ahead of time.
-- Operators pick from this queue rather than typing everything from
-- scratch — sequence controls display/priority order (lower = do first).
-- status: pending (waiting to be picked up) -> in_progress (an operator
-- started it, session_id points at that session) -> finished (done) or
-- back to pending (operator stopped it "incomplete" — session_id is
-- cleared so it re-enters the queue for someone to pick up again; the
-- session itself stays in the sessions table as a permanent record of
-- that attempt).
CREATE TABLE IF NOT EXISTS work_orders (
  id                   TEXT PRIMARY KEY,
  machine_id           TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  sequence             INTEGER NOT NULL DEFAULT 0,
  job_no               TEXT NOT NULL,
  description          TEXT,
  process              TEXT,
  quantity             REAL,
  priority             TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','urgent')),
  due_date             TEXT,
  special_instruction  TEXT,
  remarks              TEXT,
  input_diameter       REAL,
  total_tolerance      TEXT,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','finished','cancelled')),
  session_id           TEXT REFERENCES sessions(id),
  created_by           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  started_at           TEXT,
  finished_at          TEXT
);

-- The actual time record. id is a UUID generated on the operator device
-- (so it can be created while offline) and reused verbatim here, which is
-- what makes re-sent sync batches safe to retry.
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  machine_id           TEXT NOT NULL REFERENCES machines(id),
  operator_id          TEXT NOT NULL REFERENCES operators(id),
  work_order_id        TEXT REFERENCES work_orders(id),
  -- Rows the operator entered, keyed by SCREEN name:
  --   { "start": [{fieldId: value}, ...], "output": [...], "scrap": [...] }
  -- One key per screen the machine defines, one array entry per row added
  -- to that screen's table. A machine can define any screens it likes
  -- (Input/Output/Scrap/Toolings/…), so this can't be a fixed set of
  -- columns.
  --
  -- field_values / stop_field_values below are the ORIGINAL two-screen
  -- storage, kept so sessions recorded before custom screens existed still
  -- read correctly. On read they're folded in as the "start"/"stop"
  -- screens when table_rows has nothing for those keys; on write they're
  -- also kept in sync for the built-ins. Nothing needs migrating.
  table_rows           TEXT NOT NULL DEFAULT '{}',
  field_values         TEXT NOT NULL DEFAULT '[]',
  stop_field_values     TEXT NOT NULL DEFAULT '[]',
  -- A machine counter/hour-meter reading the operator types in (not a
  -- wall-clock timestamp) — Operating Hours is start subtracted from end,
  -- computed wherever it's displayed rather than stored.
  running_hour_start   REAL,
  running_hour_end     REAL,
  started_at           TEXT NOT NULL,
  -- When the operator moved from setup into actual production. NULL means
  -- the job is still in setup. Setup time is (work_started_at -
  -- started_at); working time runs from work_started_at onward. A job
  -- started directly with "Start" sets this equal to started_at, so it has
  -- zero setup and every session is measured the same way.
  work_started_at      TEXT,
  -- 'day' or 'night', resolved from started_at in the configured timezone
  -- at the moment the session is recorded. Stored rather than computed on
  -- read so historic records keep the shift they actually ran in, even if
  -- the shift boundaries are changed later.
  shift                TEXT,
  ended_at             TEXT,
  status               TEXT NOT NULL DEFAULT 'running', -- setup | running | paused | finished | incomplete
  stop_reason_id       TEXT REFERENCES stop_reasons(id),
  completion_note      TEXT,
  created_offline      INTEGER NOT NULL DEFAULT 0,
  synced_at            TEXT NOT NULL DEFAULT (datetime('now'))
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
