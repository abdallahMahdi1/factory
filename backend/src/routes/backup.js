const express = require("express");
const db = require("../lib/db");

const router = express.Router();

// A restore payload is the whole database as JSON, which will exceed the
// modest global body limit once there's a year of sessions in it. Scoped
// to this route so the limit stays tight everywhere else.
const restoreBodyParser = express.json({ limit: "100mb" });

// Every table worth preserving, in an order that satisfies foreign keys on
// restore (parents before children). option_lists before option_items,
// machines before their fields, and so on.
const TABLES = [
  "settings",
  "admins",
  "operators",
  "machines",
  "machine_screens",
  "option_lists",
  "option_items",
  "machine_fields",
  "operator_machines",
  "pause_reasons",
  "stop_reasons",
  "scrap_codes",
  "work_orders",
  "sessions",
  "pause_events",
  "operator_attendance",
  "shift_scrap",
  "session_edits",
];

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

// A full dump of the database as JSON. Deliberately JSON rather than a
// binary SQLite file: it survives a schema change between backup and
// restore, and can be inspected or repaired by hand if it ever comes to
// that.
router.get("/", (req, res) => {
  const data = {};
  const counts = {};
  for (const table of TABLES) {
    if (!tableExists(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    data[table] = rows;
    counts[table] = rows.length;
  }

  const backup = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    counts,
    data,
  };

  // Content-Disposition so a browser or curl saves it with a dated
  // filename instead of rendering it.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="factory-tracker-backup-${stamp}.json"`);
  res.send(JSON.stringify(backup));
});

// A cheap summary, so the admin panel can show what a backup would contain
// (and how much there is to lose) without downloading the whole thing.
router.get("/status", (req, res) => {
  const counts = {};
  let total = 0;
  for (const table of TABLES) {
    if (!tableExists(table)) continue;
    const n = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    counts[table] = n;
    total += n;
  }
  const latestSession = db.prepare("SELECT MAX(started_at) as t FROM sessions").get()?.t || null;
  res.json({ counts, totalRows: total, latestSessionAt: latestSession });
});

// Restore from a backup file. Destructive by design: it replaces the
// current contents rather than merging, because merging two databases that
// both have a "CNC-01" would produce silent duplicates and broken links.
//
// Requires an explicit confirm flag so a stray POST can't wipe live data.
router.post("/restore", restoreBodyParser, (req, res) => {
  const { backup, confirm } = req.body || {};
  if (confirm !== "REPLACE ALL DATA") {
    return res.status(400).json({
      error: 'Restoring replaces everything currently in the database. Send confirm: "REPLACE ALL DATA" to proceed.',
    });
  }
  if (!backup || !backup.data || typeof backup.data !== "object") {
    return res.status(400).json({ error: "That doesn't look like a backup file — expected a { data: {...} } object." });
  }

  const restored = {};
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    // Delete children first (reverse order), then insert parents first.
    for (const table of [...TABLES].reverse()) {
      if (tableExists(table)) db.exec(`DELETE FROM ${table}`);
    }
    for (const table of TABLES) {
      const rows = backup.data[table];
      if (!tableExists(table) || !Array.isArray(rows) || rows.length === 0) continue;

      // Only restore columns this schema actually has, so a backup taken
      // before a migration still loads instead of failing outright.
      const liveCols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      const cols = Object.keys(rows[0]).filter((c) => liveCols.has(c));
      if (cols.length === 0) continue;

      const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
      );
      for (const row of rows) stmt.run(...cols.map((c) => row[c] ?? null));
      restored[table] = rows.length;
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* nothing to roll back */ }
    return res.status(500).json({ error: `Restore failed, nothing was changed: ${err.message}` });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }

  res.json({ restored, message: "Restore complete." });
});

// ---- Automatic hourly snapshots ----
// Kept in memory rather than on disk: on free hosting the disk is wiped
// with the database, so a snapshot saved beside it would be lost in the
// same event. This gives you a recent copy to download after a mistake
// (a bad restore, a deletion) — it does NOT survive a restart, which is
// why scripts/pull-backup.js exists to pull copies off the server.
const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SNAPSHOTS = 24;
const snapshots = [];

function takeSnapshot() {
  try {
    const data = {};
    const counts = {};
    for (const table of TABLES) {
      if (!tableExists(table)) continue;
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      data[table] = rows;
      counts[table] = rows.length;
    }
    snapshots.unshift({ createdAt: new Date().toISOString(), counts, data });
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.length = MAX_SNAPSHOTS;
  } catch (err) {
    console.warn("Hourly snapshot failed:", err.message);
  }
}

function startAutoBackup() {
  takeSnapshot();
  const timer = setInterval(takeSnapshot, SNAPSHOT_INTERVAL_MS);
  // Don't hold the process open just for backups.
  if (timer.unref) timer.unref();
}

router.get("/snapshots", (req, res) => {
  res.json(
    snapshots.map((s, i) => ({
      index: i,
      createdAt: s.createdAt,
      totalRows: Object.values(s.counts).reduce((a, b) => a + b, 0),
    }))
  );
});

router.get("/snapshots/:index", (req, res) => {
  const snap = snapshots[Number(req.params.index)];
  if (!snap) return res.status(404).json({ error: "No snapshot at that position." });
  const stamp = snap.createdAt.replace(/[:.]/g, "-").slice(0, 19);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="factory-tracker-snapshot-${stamp}.json"`);
  res.send(JSON.stringify({ formatVersion: 1, createdAt: snap.createdAt, counts: snap.counts, data: snap.data }));
});

module.exports = router;
module.exports.startAutoBackup = startAutoBackup;
