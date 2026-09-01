require("dotenv").config();
const express = require("express");
const cors = require("cors");

const { requireAdmin } = require("./middleware/auth");
const authRoutes = require("./routes/auth");
const machineRoutes = require("./routes/machines");
const optionListRoutes = require("./routes/optionLists");
const operatorRoutes = require("./routes/operators");
const reasonRoutes = require("./routes/reasons");
const sessionRoutes = require("./routes/sessions");
const dashboardRoutes = require("./routes/dashboard");
const deviceRoutes = require("./routes/device");
const settingsRoutes = require("./routes/settings");
const attendanceRoutes = require("./routes/attendance");
const backupRoutes = require("./routes/backup");

// Auto-seed on boot if there's no admin login yet. This exists specifically
// for hosts like Render's free tier where Shell access (needed to run
// `node scripts/seed.js` by hand) isn't available — the seed script is
// fully idempotent (every insert checks for an existing row first), so
// calling it on every startup is safe even if the process restarts
// repeatedly; it's a no-op once real data already exists.
// Set SKIP_AUTO_SEED=1 to disable this (e.g. on a production deployment
// where you don't want any automatic writes to the database at boot).
function autoSeedIfEmpty() {
  if (process.env.SKIP_AUTO_SEED === "1") return;
  const db = require("./lib/db");
  const hasAdmin = db.prepare("SELECT 1 FROM admins LIMIT 1").get();
  if (hasAdmin) return;
  console.log("No admin login found — running first-time setup (scripts/seed.js)...");
  require("../scripts/seed.js");
}
autoSeedIfEmpty();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// Public
app.use("/api/auth", authRoutes);

// Operator devices authenticate with their own machine API key, not a JWT
app.use("/api/device", deviceRoutes);

// Everything else is the admin panel, protected by admin login
app.use("/api/machines", requireAdmin, machineRoutes);
app.use("/api/option-lists", requireAdmin, optionListRoutes);
app.use("/api/operators", requireAdmin, operatorRoutes);
app.use("/api", requireAdmin, reasonRoutes); // /api/pause-reasons, /api/stop-reasons
app.use("/api/sessions", requireAdmin, sessionRoutes);
app.use("/api/dashboard", requireAdmin, dashboardRoutes);
app.use("/api/settings", requireAdmin, settingsRoutes);
app.use("/api/attendance", requireAdmin, attendanceRoutes);
app.use("/api/backup", requireAdmin, backupRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Factory Tracker API listening on http://localhost:${PORT}`);
  // Hourly in-memory snapshots, so a recent copy is always downloadable.
  // Not a substitute for pulling backups off the server — see
  // scripts/pull-backup.js — since these die with the process.
  backupRoutes.startAutoBackup();
});
