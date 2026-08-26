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
