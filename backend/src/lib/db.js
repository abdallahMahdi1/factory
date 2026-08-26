const path = require("path");
const fs = require("fs");
// Node's built-in SQLite (stable since Node 22+) — no native compiling, no
// Visual Studio / build-tools requirement on Windows, works out of the box
// with whatever Node you already have installed.
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, "..", "..", "data.db");
const SCHEMA_PATH = path.join(__dirname, "..", "schema.sql");

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL"); // safe for concurrent reads while a write is in flight
db.exec("PRAGMA foreign_keys = ON");

// Apply schema on every boot — every statement is CREATE TABLE IF NOT EXISTS,
// so this is a no-op once the tables already exist.
const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
db.exec(schema);

// CREATE TABLE IF NOT EXISTS never alters a table that already exists, so a
// column added to schema.sql after a database was first created (like this
// one) needs its own small, explicit, safe step here. Each call is
// independently wrapped: if the column is already there (a fresh install
// that got it from schema.sql directly, or this having already run once
// before), SQLite throws "duplicate column name" and we just ignore it —
// deliberately narrow and defensive rather than a general migration
// framework, so it's easy to read exactly what it does and why.
function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}
addColumnIfMissing("pause_reasons", "code TEXT");
addColumnIfMissing("stop_reasons", "code TEXT");
// Machine counter readings (an hour-meter/odometer reading the operator
// types in, not a wall-clock timestamp) — Operating Hours is computed as
// their difference, wherever it's shown, rather than stored.
addColumnIfMissing("sessions", "running_hour_start REAL");
addColumnIfMissing("sessions", "running_hour_end REAL");
addColumnIfMissing("work_orders", "input_diameter REAL");
addColumnIfMissing("work_orders", "total_tolerance TEXT");
// Per-screen row storage, keyed by screen name. Sessions predating custom
// screens keep their field_values/stop_field_values and read back fine.
addColumnIfMissing("sessions", "table_rows TEXT NOT NULL DEFAULT '{}'");

// Older databases created machine_fields with CHECK (stage IN
// ('start','stop')), which would reject any custom screen. SQLite can't
// drop a CHECK constraint with ALTER TABLE, so the table is rebuilt
// without it — but ONLY when the old constraint is actually present, so
// this is a no-op on fresh installs and on every boot after the first.
function relaxMachineFieldsStageConstraint() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'machine_fields'").get();
  if (!row || !row.sql) return;
  if (!/CHECK\s*\(\s*stage\s+IN/i.test(row.sql)) return; // already relaxed

  // Raw BEGIN/COMMIT rather than the db.transaction() helper — that helper
  // is defined further down this file and isn't available yet here.
  // foreign_keys must be off while swapping a referenced table, otherwise
  // the DROP cascades into dependent rows.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE machine_fields_new (
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
      INSERT INTO machine_fields_new
        SELECT id, machine_id, label, type, option_list_id, required, sort_order, stage, group_label
        FROM machine_fields;
      DROP TABLE machine_fields;
      ALTER TABLE machine_fields_new RENAME TO machine_fields;
    `);
    db.exec("COMMIT");
    console.log("Migrated machine_fields to allow custom screens.");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
relaxMachineFieldsStageConstraint();

// node:sqlite has no built-in `.transaction()` helper the way better-sqlite3
// does — this shim reproduces that exact API (`db.transaction(fn)` returns
// a callable that runs fn inside BEGIN/COMMIT, rolling back on error) so
// every route file that already uses `db.transaction(() => {...})()`
// keeps working unchanged.
db.transaction = (fn) => {
  return (...args) => {
    db.exec("BEGIN");
    try {
      const result = fn(...args);
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
};

module.exports = db;
