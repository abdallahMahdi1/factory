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
