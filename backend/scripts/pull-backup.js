#!/usr/bin/env node
/**
 * Pulls a backup from a running Factory Tracker server and saves it to a
 * local folder. Run it on a schedule from a machine you control.
 *
 * This exists because free hosting can't reliably back itself up: the disk
 * is wiped on restart, and a sleeping service isn't running to trigger
 * anything. So the pull has to come from outside.
 *
 * Usage:
 *   node scripts/pull-backup.js --url https://your-app.onrender.com/api \
 *                               --user admin --password admin123 \
 *                               --out ./backups --keep 48
 *
 * Or set FT_URL / FT_USER / FT_PASSWORD / FT_OUT in the environment.
 *
 * Schedule it:
 *   Windows  Task Scheduler -> new task -> hourly -> run:
 *              node C:\path\to\scripts\pull-backup.js
 *   macOS/Linux  crontab -e, then:
 *              0 * * * * cd /path/to/backend && node scripts/pull-backup.js
 */

const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const API = (arg("url", process.env.FT_URL) || "http://localhost:4000/api").replace(/\/$/, "");
const USER = arg("user", process.env.FT_USER) || "admin";
const PASSWORD = arg("password", process.env.FT_PASSWORD) || "admin123";
const OUT_DIR = path.resolve(arg("out", process.env.FT_OUT) || "./backups");
// How many files to keep. Hourly backups for two days is a reasonable
// default: enough to recover from a wipe nobody noticed overnight, without
// filling a disk.
const KEEP = Number(arg("keep", process.env.FT_KEEP) || 48);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // A sleeping free-tier service takes ~30-60s to wake, so the first
  // request may simply hang for a while rather than fail. Retry a couple
  // of times before giving up.
  let token = null;
  for (let attempt = 1; attempt <= 3 && !token; attempt++) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USER, password: PASSWORD }),
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) throw new Error(`login failed (${res.status})`);
      token = (await res.json()).token;
    } catch (err) {
      console.error(`Attempt ${attempt}: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 15000));
    }
  }
  if (!token) {
    console.error("Could not reach the server. Nothing was written.");
    process.exit(1);
  }

  const res = await fetch(`${API}/backup`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error(`Backup request failed (${res.status}). Nothing was written.`);
    process.exit(1);
  }
  const text = await res.text();

  // Sanity-check before overwriting anything: an error page or truncated
  // response should never be saved as though it were a real backup.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("Server did not return valid JSON. Nothing was written.");
    process.exit(1);
  }
  if (!parsed.data || typeof parsed.data !== "object") {
    console.error("Response wasn't a backup file. Nothing was written.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(OUT_DIR, `factory-tracker-backup-${stamp}.json`);
  fs.writeFileSync(file, text);
  const rows = Object.values(parsed.counts || {}).reduce((a, b) => a + b, 0);
  console.log(`Saved ${file} (${rows} rows, ${(text.length / 1024).toFixed(1)} KB)`);

  // Prune old files, newest first.
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith("factory-tracker-backup-") && f.endsWith(".json"))
    .sort()
    .reverse();
  for (const old of files.slice(KEEP)) {
    fs.unlinkSync(path.join(OUT_DIR, old));
    console.log(`Removed old backup ${old}`);
  }
}

main().catch((err) => {
  console.error("Backup failed:", err.message);
  process.exit(1);
});
